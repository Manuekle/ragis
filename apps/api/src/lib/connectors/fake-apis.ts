/**
 * Emulador en memoria del subconjunto de APIs de Google (OAuth + Gmail), Slack y ClickUp que usan los conectores.
 * Lo usan los tests (mundo mutable: añadir, editar y borrar elementos) y el modo CONNECTORS_DEMO (datos de ejemplo
 * sin cuentas reales). Nunca se usa en producción (config.ts lo prohíbe).
 */
import type { Fetch } from "./types.js";

export interface FakePart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body: { data?: string; size?: number; attachmentId?: string };
  parts?: FakePart[];
}
export interface FakeGmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  payload: FakePart;
}
export interface FakeSlackMessage {
  ts: string;
  user?: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  replies?: FakeSlackMessage[];
}
export interface FakeTask {
  id: string;
  name: string;
  markdown_description?: string;
  status: { status: string };
  date_updated: string;
  space: { id: string };
  list: { id: string; name: string };
  url: string;
  assignees: { username: string }[];
  comments: { comment_text: string; user: { username: string }; date: string }[];
}
export interface FakeDoc {
  id: string;
  name: string;
  date_created: number;
  date_updated: number;
  parent: { id: string; type: number };
  deleted: boolean;
  archived: boolean;
  pages: { id: string; name: string; content: string; pages?: unknown[] }[];
}

export interface FakeWorld {
  calls: string[];
  gmail: {
    email: string;
    historyId: number;
    /** historyId mínimo disponible: pedir uno menor devuelve 404 (historial caducado). */
    minHistoryId: number;
    revoked: boolean;
    labels: { id: string; name: string; type: string }[];
    messages: Map<string, FakeGmailMessage>;
    attachments: Map<string, Buffer>;
    history: { id: number; threadId: string }[];
  };
  slack: {
    team: { id: string; name: string };
    revoked: boolean;
    users: { id: string; real_name: string }[];
    channels: Map<string, { id: string; name: string; is_private: boolean; is_member: boolean; num_members: number; messages: FakeSlackMessage[] }>;
  };
  clickup: {
    team: { id: string; name: string };
    spaces: { id: string; name: string; private: boolean }[];
    lists: { id: string; space: string; folder?: string }[];
    tasks: Map<string, FakeTask>;
    docs: Map<string, FakeDoc>;
  };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
let seq = 0;
const nextId = (p: string) => `${p}${(++seq).toString(16).padStart(8, "0")}`;

export function createFakeWorld(): FakeWorld {
  return {
    calls: [],
    gmail: {
      email: "demo.user@example.com",
      historyId: 1000,
      minHistoryId: 1,
      revoked: false,
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "SPAM", name: "SPAM", type: "system" },
        { id: "Label_clients", name: "Clientes", type: "user" },
      ],
      messages: new Map(),
      attachments: new Map(),
      history: [],
    },
    slack: {
      team: { id: "T0DEMO01", name: "Demo Workspace" },
      revoked: false,
      users: [
        { id: "U0ANA", real_name: "Ana Pérez" },
        { id: "U0LUIS", real_name: "Luis Gómez" },
      ],
      channels: new Map(),
    },
    clickup: {
      team: { id: "9001", name: "Demo ClickUp" },
      spaces: [
        { id: "101", name: "Operaciones", private: false },
        { id: "102", name: "Dirección", private: true },
      ],
      lists: [
        { id: "501", space: "101" },
        { id: "502", space: "102" },
      ],
      tasks: new Map(),
      docs: new Map(),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mutadores para tests y datos de ejemplo
// ---------------------------------------------------------------------------------------------------------------

export function addGmailMessage(
  w: FakeWorld,
  m: { threadId?: string; from: string; to: string; subject: string; text: string; labels?: string[]; date?: Date; attachment?: { filename: string; mimeType: string; data: Buffer } },
): FakeGmailMessage {
  const id = nextId("m");
  const threadId = m.threadId ?? nextId("t");
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    { name: "Subject", value: m.subject },
  ];
  const parts: FakePart[] = [{ partId: "0", mimeType: "text/plain", body: { data: b64url(m.text), size: m.text.length } }];
  if (m.attachment) {
    const attachmentId = nextId("att");
    w.gmail.attachments.set(attachmentId, m.attachment.data);
    parts.push({
      partId: "1",
      mimeType: m.attachment.mimeType,
      filename: m.attachment.filename,
      headers: [{ name: "Content-Disposition", value: `attachment; filename="${m.attachment.filename}"` }],
      body: { attachmentId, size: m.attachment.data.length },
    });
  }
  const msg: FakeGmailMessage = {
    id,
    threadId,
    labelIds: m.labels ?? ["INBOX"],
    internalDate: String((m.date ?? new Date()).getTime()),
    payload: { mimeType: "multipart/mixed", headers, body: {}, parts },
  };
  w.gmail.messages.set(id, msg);
  w.gmail.history.push({ id: ++w.gmail.historyId, threadId });
  return msg;
}

export function deleteGmailThread(w: FakeWorld, threadId: string) {
  for (const [id, m] of w.gmail.messages) if (m.threadId === threadId) w.gmail.messages.delete(id);
  w.gmail.history.push({ id: ++w.gmail.historyId, threadId });
}

export function addSlackChannel(w: FakeWorld, c: { id: string; name: string; is_private?: boolean; is_member?: boolean }) {
  w.slack.channels.set(c.id, { id: c.id, name: c.name, is_private: !!c.is_private, is_member: c.is_member ?? false, num_members: 5, messages: [] });
}

export function addSlackMessage(w: FakeWorld, channel: string, m: { user: string; text: string; date?: Date; replies?: { user: string; text: string; date?: Date }[] }) {
  const ts = ((m.date ?? new Date()).getTime() / 1000).toFixed(6);
  const replies = (m.replies ?? []).map((r, i) => ({ ts: (Math.max((r.date ?? new Date()).getTime() / 1000, Number(ts)) + (i + 1) * 0.001).toFixed(6), user: r.user, text: r.text, thread_ts: ts }));
  const msg: FakeSlackMessage = { ts, user: m.user, text: m.text, ...(replies.length ? { thread_ts: ts, reply_count: replies.length, replies } : {}) };
  w.slack.channels.get(channel)!.messages.push(msg);
  return msg;
}

export function upsertClickUpTask(w: FakeWorld, t: { id?: string; name: string; description?: string; space: string; status?: string; comments?: string[]; updated?: number }) {
  const id = t.id ?? nextId("cu");
  const list = w.clickup.lists.find((l) => l.space === t.space)!;
  const task: FakeTask = {
    id,
    name: t.name,
    markdown_description: t.description ?? "",
    status: { status: t.status ?? "to do" },
    date_updated: String(t.updated ?? Date.now()),
    space: { id: t.space },
    list: { id: list.id, name: "Tareas" },
    url: `https://app.clickup.com/t/${id}`,
    assignees: [{ username: "Ana Pérez" }],
    comments: (t.comments ?? []).map((c, i) => ({ comment_text: c, user: { username: "Luis Gómez" }, date: String(Date.now() - 1000 * (10 - i)) })),
  };
  w.clickup.tasks.set(id, task);
  return task;
}

export function upsertClickUpDoc(w: FakeWorld, d: { id?: string; name: string; space: string; content: string; updated?: number }) {
  const id = d.id ?? nextId("doc");
  const doc: FakeDoc = {
    id,
    name: d.name,
    date_created: Date.now(),
    date_updated: d.updated ?? Date.now(),
    parent: { id: d.space, type: 4 },
    deleted: false,
    archived: false,
    pages: [{ id: `${id}-p1`, name: d.name, content: d.content }],
  };
  w.clickup.docs.set(id, doc);
  return doc;
}

/** Datos de ejemplo del modo demo (despacho profesional). */
export function seedDemoWorld(w: FakeWorld): FakeWorld {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);
  const t1 = addGmailMessage(w, {
    from: "Marta Ruiz <marta@cliente-acme.example>",
    to: w.gmail.email,
    subject: "Renovación del contrato de mantenimiento 2027",
    text: "Hola,\n\nOs confirmamos que queremos renovar el contrato de mantenimiento por 12 meses desde el 1 de enero de 2027. El nuevo importe acordado es de 18.400 EUR anuales, pagaderos trimestralmente.\n\n¿Podéis enviarnos el borrador antes del 15 de diciembre?\n\nGracias,\nMarta",
    labels: ["INBOX", "Label_clients"],
    date: day(6),
  });
  addGmailMessage(w, {
    threadId: t1.threadId,
    from: `Demo User <${w.gmail.email}>`,
    to: "marta@cliente-acme.example",
    subject: "Re: Renovación del contrato de mantenimiento 2027",
    text: "Hola Marta,\n\nPerfecto. Os enviaremos el borrador el 10 de diciembre con la cláusula de revisión de precios según IPC.\n\nUn saludo",
    labels: ["SENT"],
    date: day(5),
  });
  addGmailMessage(w, {
    from: "Facturación <facturas@proveedor-luz.example>",
    to: w.gmail.email,
    subject: "Factura F-2026-1182 disponible",
    text: "Su factura F-2026-1182 por importe de 1.245,80 EUR vence el 30 de noviembre de 2026. Puede pagarla por transferencia a la cuenta habitual.",
    labels: ["INBOX"],
    date: day(3),
  });
  addGmailMessage(w, { from: "Ofertas <promo@tienda.example>", to: w.gmail.email, subject: "¡50% de descuento!", text: "Solo hoy.", labels: ["INBOX", "CATEGORY_PROMOTIONS"], date: day(2) });

  addSlackChannel(w, { id: "C0GENERAL", name: "general", is_member: true });
  addSlackChannel(w, { id: "C0LEGAL", name: "legal" });
  addSlackChannel(w, { id: "G0SOCIOS", name: "socios", is_private: true, is_member: true });
  addSlackMessage(w, "C0LEGAL", {
    user: "U0ANA",
    text: "Recordatorio: el plazo para presentar el recurso del expediente 2026/341 termina el viernes 20 de noviembre. <@U0LUIS> ¿tienes el borrador?",
    date: day(1),
    replies: [{ user: "U0LUIS", text: "Sí, lo subo hoy a la carpeta del cliente.", date: day(1) }],
  });
  addSlackMessage(w, "C0GENERAL", { user: "U0LUIS", text: "La oficina cierra el 8 de diciembre por festivo.", date: day(2) });

  upsertClickUpTask(w, {
    name: "Revisar NDA con Acme Logistics",
    description: "Revisar la cláusula de confidencialidad (duración 5 años) y la jurisdicción (Madrid). Entrega al cliente el 25/11.",
    space: "101",
    status: "in progress",
    comments: ["He marcado dos cambios en la cláusula 7.", "Cliente pide quitar la penalización."],
  });
  upsertClickUpTask(w, { name: "Preparar cierre trimestral Q4", description: "Conciliar bancos y provisiones antes del 10 de enero.", space: "101" });
  upsertClickUpTask(w, { name: "Plan de socios 2027", description: "Confidencial: reparto de objetivos.", space: "102" });
  upsertClickUpDoc(w, {
    name: "Procedimiento de alta de clientes",
    space: "101",
    content: "1. Solicitar DNI/CIF y escritura.\n2. Verificar titularidad real (KYC).\n3. Firmar hoja de encargo.\n4. Crear carpeta en el gestor documental.",
  });
  return w;
}

// ---------------------------------------------------------------------------------------------------------------
// fetch emulado
// ---------------------------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function formBody(init?: RequestInit): Promise<URLSearchParams> {
  if (!init?.body) return new URLSearchParams();
  return new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body));
}

function threadsOf(w: FakeWorld) {
  const threads = new Map<string, FakeGmailMessage[]>();
  for (const m of w.gmail.messages.values()) (threads.get(m.threadId) ?? threads.set(m.threadId, []).get(m.threadId)!).push(m);
  return threads;
}

async function google(w: FakeWorld, url: URL, init?: RequestInit, auth?: string | null): Promise<Response> {
  if (url.host === "oauth2.googleapis.com") {
    const f = await formBody(init);
    if (url.pathname === "/revoke") {
      w.gmail.revoked = true;
      return json({});
    }
    if (f.get("grant_type") === "authorization_code") {
      if (f.get("code")?.startsWith("bad")) return json({ error: "invalid_grant" }, 400);
      w.gmail.revoked = false;
      return json({ access_token: "g-at-1", refresh_token: "g-rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    }
    if (f.get("grant_type") === "refresh_token") {
      if (w.gmail.revoked) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `g-at-${Date.now()}`, expires_in: 3600 });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  if (!auth?.startsWith("Bearer g-at-") || w.gmail.revoked) return json({ error: { status: "UNAUTHENTICATED" } }, 401);
  const path = url.pathname.replace("/gmail/v1/users/me", "");
  const threads = threadsOf(w);
  const historyOf = (msgs: FakeGmailMessage[]) => String(Math.max(...msgs.map((m) => w.gmail.history.filter((h) => h.threadId === m.threadId).at(-1)?.id ?? 0)));
  if (path === "/profile") return json({ emailAddress: w.gmail.email, historyId: String(w.gmail.historyId) });
  if (path === "/labels") return json({ labels: w.gmail.labels });
  if (path === "/threads") {
    const after = Number(/after:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? 0) * 1000;
    const all = [...threads.entries()]
      .filter(([, msgs]) => msgs.some((m) => Number(m.internalDate) >= after && !m.labelIds.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l))))
      .sort((a, b) => b[0].localeCompare(a[0]));
    const size = Number(url.searchParams.get("maxResults") ?? 100);
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const page = all.slice(offset, offset + size);
    return json({ threads: page.map(([id, msgs]) => ({ id, historyId: historyOf(msgs) })), ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {}) });
  }
  let m = /^\/threads\/([^/]+)$/.exec(path);
  if (m) {
    const msgs = threads.get(decodeURIComponent(m[1]!));
    return msgs ? json({ id: m[1], historyId: historyOf(msgs), messages: msgs }) : json({ error: { status: "NOT_FOUND" } }, 404);
  }
  m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
  if (m) {
    const data = w.gmail.attachments.get(decodeURIComponent(m[2]!));
    return data ? json({ data: b64url(data), size: data.length }) : json({ error: { status: "NOT_FOUND" } }, 404);
  }
  if (path === "/history") {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (start < w.gmail.minHistoryId) return json({ error: { status: "NOT_FOUND" } }, 404);
    const entries = w.gmail.history.filter((h) => h.id > start);
    return json({
      history: entries.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: "x", threadId: h.threadId } }] })),
      historyId: String(w.gmail.historyId),
    });
  }
  return json({ error: { status: "NOT_FOUND" } }, 404);
}

async function slackApi(w: FakeWorld, url: URL, init?: RequestInit, auth?: string | null): Promise<Response> {
  const method = url.pathname.replace("/api/", "");
  const params = method === "oauth.v2.access" || init?.method === "POST" ? await formBody(init) : url.searchParams;
  if (method === "oauth.v2.access") {
    if (params.get("code")?.startsWith("bad")) return json({ ok: false, error: "invalid_code" });
    w.slack.revoked = false;
    return json({ ok: true, access_token: "xoxb-fake", token_type: "bot", scope: "channels:read", team: w.slack.team });
  }
  if (auth !== "Bearer xoxb-fake" || w.slack.revoked) return json({ ok: false, error: "invalid_auth" });
  const ch = w.slack.channels.get(params.get("channel") ?? "");
  const page = <T>(items: T[], key: string) => {
    const limit = Number(params.get("limit") ?? 100);
    const offset = Number(params.get("cursor") || 0);
    const next = offset + limit < items.length ? String(offset + limit) : "";
    return json({ ok: true, [key]: items.slice(offset, offset + limit), response_metadata: { next_cursor: next }, has_more: !!next });
  };
  switch (method) {
    case "auth.revoke":
      w.slack.revoked = true;
      return json({ ok: true, revoked: true });
    case "users.list":
      return page(w.slack.users, "members");
    case "conversations.list":
      return page([...w.slack.channels.values()].map(({ messages: _m, ...c }) => c), "channels");
    case "conversations.info":
      if (!ch) return json({ ok: false, error: "channel_not_found" });
      return json({ ok: true, channel: { id: ch.id, name: ch.name, is_private: ch.is_private, is_member: ch.is_member } });
    case "conversations.join":
      if (!ch) return json({ ok: false, error: "channel_not_found" });
      if (ch.is_private) return json({ ok: false, error: "method_not_supported_for_channel_type" });
      ch.is_member = true;
      return json({ ok: true, channel: { id: ch.id } });
    case "conversations.history": {
      if (!ch) return json({ ok: false, error: "channel_not_found" });
      if (!ch.is_member) return json({ ok: false, error: "not_in_channel" });
      const oldest = Number(params.get("oldest") ?? 0);
      const latest = Number(params.get("latest") ?? Infinity);
      const msgs = ch.messages
        .filter((m) => Number(m.ts) > oldest && Number(m.ts) < latest)
        .sort((a, b) => Number(b.ts) - Number(a.ts))
        .map(({ replies: _r, ...m }) => m);
      return page(msgs, "messages");
    }
    case "conversations.replies": {
      const parent = ch?.messages.find((m) => m.ts === params.get("ts"));
      if (!parent) return json({ ok: false, error: "thread_not_found" });
      const { replies, ...p } = parent;
      return page([p, ...(replies ?? [])], "messages");
    }
    default:
      return json({ ok: false, error: "unknown_method" });
  }
}

async function clickupApi(w: FakeWorld, url: URL, init?: RequestInit, auth?: string | null): Promise<Response> {
  const p = url.pathname;
  if (p === "/api/v2/oauth/token" && init?.method === "POST") {
    return url.searchParams.get("code")?.startsWith("bad") ? json({ err: "Code not found", ECODE: "OAUTH_014" }, 400) : json({ access_token: "cu-fake" });
  }
  if (auth !== "Bearer cu-fake") return json({ err: "Token invalid", ECODE: "OAUTH_025" }, 401);
  const team = w.clickup.team;
  if (p === "/api/v2/team") return json({ teams: [team] });
  if (p === `/api/v2/team/${team.id}/space`) return json({ spaces: w.clickup.spaces });
  let m = /^\/api\/v2\/space\/(\d+)\/(folder|list)$/.exec(p);
  if (m) return json(m[2] === "folder" ? { folders: [] } : { lists: w.clickup.lists.filter((l) => l.space === m![1]).map((l) => ({ id: l.id })) });
  if (p === `/api/v2/team/${team.id}/task`) {
    const spaces = url.searchParams.getAll("space_ids[]");
    const gt = Number(url.searchParams.get("date_updated_gt") ?? 0);
    const page = Number(url.searchParams.get("page") ?? 0);
    const all = [...w.clickup.tasks.values()]
      .filter((t) => (!spaces.length || spaces.includes(t.space.id)) && Number(t.date_updated) > gt)
      .sort((a, b) => Number(b.date_updated) - Number(a.date_updated))
      .map(({ comments: _c, ...t }) => t);
    const slice = all.slice(page * 100, page * 100 + 100);
    return json({ tasks: slice, last_page: page * 100 + 100 >= all.length });
  }
  m = /^\/api\/v2\/task\/([^/]+)\/comment$/.exec(p);
  if (m) return json({ comments: w.clickup.tasks.get(decodeURIComponent(m[1]!))?.comments ?? [] });
  if (p === `/api/v3/workspaces/${team.id}/docs`) {
    return json({ docs: [...w.clickup.docs.values()].filter((d) => !d.deleted).map(({ pages: _p, ...d }) => d) });
  }
  m = /^\/api\/v3\/workspaces\/\d+\/docs\/([^/]+)\/pages$/.exec(p);
  if (m) {
    const d = w.clickup.docs.get(decodeURIComponent(m[1]!));
    return d ? json(d.pages) : json({ err: "not found" }, 404);
  }
  return json({ err: "Route not found" }, 404);
}

export function fakeFetch(w: FakeWorld): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    w.calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.host === "oauth2.googleapis.com" || url.host === "gmail.googleapis.com") return google(w, url, init, auth);
    if (url.host === "slack.com") return slackApi(w, url, init, auth);
    if (url.host === "api.clickup.com") return clickupApi(w, url, init, auth);
    return json({ error: "unknown host" }, 404);
  }) as Fetch;
}
