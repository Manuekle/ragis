/**
 * Gmail (conector personal, solo lectura). Un documento por hilo + un documento por adjunto admitido.
 *
 * Delta: carga inicial con threads.list (ventana anclada a la fecha de conexión) y después History API
 * (messageAdded/Deleted, labelAdded/Removed). Si el historyId caduca (404) se repite la carga inicial y se barren
 * los hilos que ya no aparecen. Nunca se indexan spam, papelera, borradores, promociones ni redes sociales.
 */
import { z } from "zod";
import { ProviderError } from "./http.js";
import { attachmentType, htmlToText, isoDay, isoMinute, md, slug, stripQuoted } from "./render.js";
import type { OptionGroup, ProviderAdapter, ProviderHttp, SyncItem, SyncRun, TokenSet } from "./types.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);
const SYSTEM_LABELS: Record<string, string> = { INBOX: "Inbox", SENT: "Sent", IMPORTANT: "Important", STARRED: "Starred" };
const MIN_IMAGE_BYTES = 30_000;

export const GmailSettings = z.object({
  backfill_months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).default(3),
  label_ids: z.array(z.string().min(1).max(120)).max(20).default([]),
  include_attachments: z.boolean().default(true),
});
export type GmailSettings = z.infer<typeof GmailSettings>;

interface Cursor {
  /** Fecha de conexión (epoch s): la ventana de importación se cuenta desde aquí, no desde hoy. */
  anchor?: number;
  phase?: "backfill" | "incremental";
  page_token?: string | null;
  offset?: number;
  started_at?: string;
  start_history_id?: string;
  history_id?: string;
  pending?: string[];
}

interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}
interface Thread {
  id: string;
  historyId?: string;
  messages?: Message[];
}

const b64 = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const header = (p: Part | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name)?.value?.trim() ?? "";

function walk(p: Part | undefined, out: Part[] = []): Part[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

function bodyText(msg: Message): string {
  const parts = walk(msg.payload).filter((p) => !p.filename && p.body?.data);
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain) return stripQuoted(b64(plain.body!.data!).toString("utf8"));
  const html = parts.find((p) => p.mimeType === "text/html");
  return html ? stripQuoted(htmlToText(b64(html.body!.data!).toString("utf8"))) : "";
}

interface Attachment {
  sourceId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
}

function attachments(msg: Message, maxBytes: number): Attachment[] {
  const out: Attachment[] = [];
  for (const p of walk(msg.payload)) {
    if (!p.filename || !p.body?.attachmentId) continue;
    const type = attachmentType(p.filename, p.mimeType ?? "");
    const size = p.body.size ?? 0;
    if (!type || size <= 0 || size > maxBytes) continue;
    const disposition = header(p, "content-disposition").toLowerCase();
    // Imágenes en línea (firmas, logos) no aportan: solo imágenes adjuntas de tamaño razonable (p. ej. escaneos).
    if (type.startsWith("image/") && (disposition.startsWith("inline") || header(p, "content-id") || size < MIN_IMAGE_BYTES)) continue;
    out.push({ sourceId: `att:${msg.id}:${p.partId ?? p.body.attachmentId.slice(0, 32)}`, messageId: msg.id, attachmentId: p.body.attachmentId, filename: p.filename, contentType: type, size });
  }
  return out;
}

export function renderThread(thread: Thread, messages: Message[]): { title: string; body: string; first: Date } {
  const subject = header(messages[0]!.payload, "subject") || "(no subject)";
  const dates = messages.map((m) => new Date(Number(m.internalDate ?? 0)));
  const lines = [`# ${subject}`, "", `Email conversation · ${messages.length} message${messages.length === 1 ? "" : "s"} · ${isoDay(dates[0]!)} – ${isoDay(dates[dates.length - 1]!)}`];
  messages.forEach((m, i) => {
    const p = m.payload;
    const files = walk(p).filter((x) => x.filename).map((x) => x.filename);
    lines.push("", "---", "", `## ${header(p, "from") || "Unknown sender"} · ${isoMinute(dates[i]!)}`, "");
    const to = header(p, "to");
    const cc = header(p, "cc");
    if (to) lines.push(`To: ${to}  `);
    if (cc) lines.push(`Cc: ${cc}  `);
    const subj = header(p, "subject");
    if (subj && subj !== subject) lines.push(`Subject: ${subj}  `);
    lines.push("", bodyText(m) || "(no text)");
    if (files.length) lines.push("", `Attachments: ${files.join(", ")}`);
  });
  return { title: subject.slice(0, 300), body: md(lines.join("\n")), first: dates[0]! };
}

function keep(msg: Message, labels: Set<string>): boolean {
  const ids = msg.labelIds ?? [];
  if (ids.some((l) => EXCLUDED_LABELS.has(l))) return false;
  return labels.size === 0 || ids.some((l) => labels.has(l));
}

async function labelNames(http: ProviderHttp, token: string): Promise<Map<string, string>> {
  const r = await http.json<{ labels?: { id: string; name: string; type?: string }[] }>(`${API}/labels`, { token });
  return new Map((r.labels ?? []).map((l) => [l.id, l.name]));
}

function query(since: number, labelIds: string[], names: Map<string, string>): string {
  const base = `-in:spam -in:trash -in:drafts -category:promotions -category:social after:${since}`;
  const terms = labelIds.map((id) => names.get(id)).filter((n): n is string => !!n).map((n) => `label:"${n.replace(/"/g, "")}"`);
  return terms.length ? `${base} {${terms.join(" ")}}` : base;
}

async function syncThread(run: SyncRun<GmailSettings>, threadId: string, knownHistory?: string): Promise<void> {
  const { http, sink, tokens, settings } = run;
  const container = `thread:${threadId}`;
  const sourceId = `thread:${threadId}`;
  if (knownHistory) {
    const k = await sink.known(sourceId);
    if (k?.sourceUpdatedAt === knownHistory) {
      // Hilo sin cambios: marca como vistos el hilo y sus adjuntos sin descargar nada.
      await sink.touchContainers([container]);
      return;
    }
  }
  let thread: Thread;
  try {
    thread = await http.json<Thread>(`${API}/threads/${encodeURIComponent(threadId)}?format=full`, { token: tokens.access_token });
  } catch (err) {
    if (err instanceof ProviderError && err.code === "not_found") {
      await sink.retain(container, []);
      return;
    }
    throw err;
  }
  const labels = new Set(settings.label_ids);
  const messages = (thread.messages ?? []).filter((m) => keep(m, labels)).sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  if (!messages.length) {
    await sink.retain(container, []);
    return;
  }
  const r = renderThread(thread, messages);
  const keepIds = [sourceId];
  const item: SyncItem = {
    sourceId,
    container,
    title: r.title,
    filename: `${slug(r.title)}.md`,
    contentType: "text/markdown",
    body: Buffer.from(r.body, "utf8"),
    sourceUpdatedAt: thread.historyId,
    classification: "confidential",
    effectiveFrom: isoDay(r.first),
  };
  const result = await sink.upsert(item);
  if (result === "skipped") return;
  if (settings.include_attachments) {
    for (const m of messages) {
      for (const a of attachments(m, run.maxBytes)) {
        keepIds.push(a.sourceId);
        if (await sink.known(a.sourceId)) {
          await sink.touch([a.sourceId]);
          continue;
        }
        const data = await http.json<{ data?: string }>(`${API}/messages/${m.id}/attachments/${encodeURIComponent(a.attachmentId)}`, { token: tokens.access_token });
        if (!data.data) continue;
        await sink.upsert({
          sourceId: a.sourceId,
          container,
          title: a.filename.slice(0, 300),
          filename: a.filename,
          contentType: a.contentType,
          body: b64(data.data),
          sourceUpdatedAt: m.id,
          classification: "confidential",
          effectiveFrom: isoDay(new Date(Number(m.internalDate ?? 0))),
        });
      }
    }
  }
  await sink.retain(container, keepIds);
}

async function backfill(run: SyncRun<GmailSettings>, c: Cursor): Promise<boolean> {
  const { http, sink, tokens, settings } = run;
  if (!c.start_history_id) {
    const profile = await http.json<{ historyId: string }>(`${API}/profile`, { token: tokens.access_token });
    c.start_history_id = String(profile.historyId);
    c.started_at = run.now.toISOString();
    c.page_token = null;
    c.offset = 0;
    await sink.checkpoint({ ...c });
  }
  const since = c.anchor! - settings.backfill_months * 31 * 86400;
  const names = settings.label_ids.length ? await labelNames(http, tokens.access_token) : new Map<string, string>();
  for (;;) {
    const params = new URLSearchParams({ q: query(since, settings.label_ids, names), maxResults: "100" });
    if (c.page_token) params.set("pageToken", c.page_token);
    const page = await http.json<{ threads?: { id: string; historyId?: string }[]; nextPageToken?: string }>(`${API}/threads?${params}`, { token: tokens.access_token });
    const threads = page.threads ?? [];
    for (let i = c.offset ?? 0; i < threads.length; i++) {
      if (sink.shouldYield()) {
        c.offset = i;
        await sink.checkpoint({ ...c });
        return false;
      }
      await syncThread(run, threads[i]!.id, threads[i]!.historyId);
    }
    if (!page.nextPageToken) break;
    c.page_token = page.nextPageToken;
    c.offset = 0;
    await sink.checkpoint({ ...c });
  }
  // Carga completa: lo que no apareció ya no existe o quedó fuera del filtro.
  await sink.sweep("", new Date(c.started_at!));
  c.phase = "incremental";
  c.history_id = c.start_history_id;
  delete c.page_token;
  delete c.offset;
  delete c.start_history_id;
  delete c.started_at;
  await sink.checkpoint({ ...c });
  return true;
}

async function incremental(run: SyncRun<GmailSettings>, c: Cursor): Promise<boolean> {
  const { http, sink, tokens } = run;
  const pending = new Set(c.pending ?? []);
  let pageToken: string | undefined;
  let latest = c.history_id!;
  try {
    do {
      const params = new URLSearchParams({ startHistoryId: c.history_id!, maxResults: "500" });
      for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) params.append("historyTypes", t);
      if (pageToken) params.set("pageToken", pageToken);
      const r = await http.json<{ history?: Record<string, { message?: { threadId?: string } }[] | string>[]; historyId?: string; nextPageToken?: string }>(`${API}/history?${params}`, { token: tokens.access_token });
      for (const h of r.history ?? []) {
        for (const key of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) {
          const list = h[key];
          if (Array.isArray(list)) for (const e of list) if (e.message?.threadId) pending.add(e.message.threadId);
        }
      }
      if (r.historyId) latest = String(r.historyId);
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof ProviderError && err.code === "not_found") {
      // historyId demasiado antiguo: repetir la carga inicial (conserva el ancla de la ventana).
      run.log("gmail history expired; full resync");
      await sink.checkpoint({ anchor: c.anchor, phase: "backfill" });
      return false;
    }
    throw err;
  }
  c.history_id = latest;
  const queue = [...pending].sort();
  for (let i = 0; i < queue.length; i++) {
    if (sink.shouldYield()) {
      c.pending = queue.slice(i);
      await sink.checkpoint({ ...c });
      return false;
    }
    await syncThread(run, queue[i]!);
  }
  delete c.pending;
  await sink.checkpoint({ ...c });
  return true;
}

export const gmail: ProviderAdapter<GmailSettings> = {
  id: "gmail",
  name: "Gmail",
  scope: "personal",
  initialStatus: "active",

  authorizeUrl({ client, redirectUri, state, codeChallenge }) {
    const p = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTH}?${p}`;
  },

  async exchange(http, { client, code, redirectUri, codeVerifier }) {
    const t = await http.json<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>(TOKEN, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: codeVerifier }),
    });
    if (!t.scope?.split(" ").includes(GMAIL_SCOPE)) throw new ProviderError("forbidden", "Gmail read access was not granted");
    const tokens: TokenSet = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, scope: t.scope };
    const profile = await http.json<{ emailAddress: string }>(`${API}/profile`, { token: tokens.access_token });
    return { tokens, account: { id: profile.emailAddress.toLowerCase(), label: profile.emailAddress } };
  },

  async refresh(http, client, tokens) {
    if (!tokens.refresh_token) throw new ProviderError("auth_revoked", "no refresh token");
    const t = await http.json<{ access_token: string; expires_in?: number; refresh_token?: string; scope?: string }>(TOKEN, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    return { access_token: t.access_token, refresh_token: t.refresh_token ?? tokens.refresh_token, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, scope: t.scope ?? tokens.scope };
  },

  async revoke(http, _client, tokens) {
    await http.json(REVOKE, { method: "POST", body: new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token }) });
  },

  parseSettings: (raw) => GmailSettings.parse(raw ?? {}),
  defaultSettings: () => GmailSettings.parse({}),
  resetCursor: (cursor) => ({ anchor: cursor.anchor }),
  needsResync: (prev, next) => prev.backfill_months !== next.backfill_months || [...prev.label_ids].sort().join() !== [...next.label_ids].sort().join(),

  async options(http, tokens): Promise<OptionGroup[]> {
    const r = await http.json<{ labels?: { id: string; name: string; type?: string }[] }>(`${API}/labels`, { token: tokens.access_token });
    const labels = (r.labels ?? [])
      .filter((l) => l.type === "user" || l.id in SYSTEM_LABELS)
      .map((l) => ({ id: l.id, label: SYSTEM_LABELS[l.id] ?? l.name }))
      .sort((a, b) => (a.id in SYSTEM_LABELS ? 0 : 1) - (b.id in SYSTEM_LABELS ? 0 : 1) || a.label.localeCompare(b.label));
    return [{ key: "label_ids", label: "Only emails with these labels", multiple: true, options: labels }];
  },

  async sync(run) {
    const c = { ...(run.cursor as Cursor) };
    c.anchor ??= Math.floor(run.now.getTime() / 1000);
    c.phase ??= "backfill";
    if (c.phase === "backfill") {
      const done = await backfill(run, c);
      if (!done) return { more: true };
    }
    const done = await incremental(run, c);
    return { more: !done };
  },
};
