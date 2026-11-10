/**
 * Slack (conector de organización, bot de solo lectura). Un documento por canal y día (UTC), con los hilos dentro
 * del mensaje que los abre. El admin elige los canales; el bot solo lee canales públicos a los que se une y privados
 * a los que lo invitan.
 *
 * Delta: avance día a día por canal; ayer y hoy se releen siempre para recoger ediciones, borrados y respuestas.
 * Límites: Slack no notifica borrados antiguos por esta API (requeriría Events API) y las apps distribuidas fuera
 * del Marketplace tienen conversations.history limitado a 1 llamada/min (ver ADR-025).
 */
import { z } from "zod";
import { ProviderError } from "./http.js";
import { decodeEntities, isoDay, md, slug } from "./render.js";
import type { OptionGroup, ProviderAdapter, ProviderHttp, SyncRun, TokenSet } from "./types.js";

const AUTH = "https://slack.com/oauth/v2/authorize";
const API = "https://slack.com/api";
export const SLACK_SCOPES = ["channels:read", "channels:history", "channels:join", "groups:read", "groups:history", "users:read", "team:read"];
const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "channel_archive", "channel_unarchive", "group_join", "group_leave"]);
const DAY = 86_400_000;

export const SlackSettings = z.object({
  channel_ids: z.array(z.string().regex(/^[CG][A-Z0-9]{2,30}$/)).max(200).default([]),
  backfill_days: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(90),
});
export type SlackSettings = z.infer<typeof SlackSettings>;

interface ChannelCursor {
  next_day?: string;
  problem?: "not_in_channel" | "channel_not_found";
}
interface Cursor {
  channels?: Record<string, ChannelCursor>;
}

interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: { name?: string; title?: string }[];
  bot_profile?: { name?: string };
}
interface Channel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
}

/** Llamada a la Web API: Slack responde 200 con ok:false; se traduce a ProviderError. */
async function call<T>(http: ProviderHttp, method: string, token: string, params: Record<string, string> = {}, post = false): Promise<T> {
  const qs = new URLSearchParams(params);
  const r = await http.json<{ ok: boolean; error?: string } & T>(post ? `${API}/${method}` : `${API}/${method}?${qs}`, post ? { method: "POST", token, body: qs } : { token });
  if (!r.ok) {
    const e = r.error ?? "unknown_error";
    const code = e === "ratelimited" ? "rate_limited" : ["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"].includes(e) ? "auth_revoked" : e === "channel_not_found" ? "not_found" : e === "missing_scope" ? "forbidden" : "provider_error";
    throw new ProviderError(code, `slack ${method}: ${e}`, undefined, code === "rate_limited" ? 60_000 : undefined, e);
  }
  return r;
}

async function paged<T>(http: ProviderHttp, method: string, token: string, key: string, params: Record<string, string>, cap: number): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  do {
    const r = await call<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(http, method, token, { ...params, ...(cursor ? { cursor } : {}) });
    out.push(...((r[key] as T[]) ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
  } while (cursor && out.length < cap);
  return out;
}

async function userNames(http: ProviderHttp, token: string): Promise<Map<string, string>> {
  const members = await paged<{ id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }>(http, "users.list", token, "members", { limit: "200" }, 20_000);
  return new Map(members.map((m) => [m.id, m.profile?.real_name || m.real_name || m.profile?.display_name || m.name || m.id]));
}

export function slackText(text: string, users: Map<string, string>): string {
  return decodeEntities(
    text
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${users.get(id) ?? "someone"}`)
      .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name}`)
      .replace(/<!(here|channel|everyone)>/g, "@$1")
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, name?: string) => name ?? "@group")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => `${label} (${url})`)
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1"),
  );
}

const clock = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(11, 16);

export function renderDay(channel: Channel, day: string, messages: SlackMessage[], replies: Map<string, SlackMessage[]>, users: Map<string, string>): string {
  const who = (m: SlackMessage) => (m.user ? users.get(m.user) ?? "Unknown" : m.bot_profile?.name ?? m.username ?? "App");
  const body = (m: SlackMessage) => {
    const files = (m.files ?? []).map((f) => f.title || f.name).filter(Boolean);
    return [slackText(m.text ?? "", users), files.length ? `[files: ${files.join(", ")}]` : ""].filter(Boolean).join("\n");
  };
  const lines = [`# #${channel.name} — ${day}`, "", `Slack conversation · #${channel.name} · ${messages.length} message${messages.length === 1 ? "" : "s"} (times in UTC)`];
  for (const m of messages) {
    lines.push("", `**${who(m)}** · ${clock(m.ts)}`, body(m) || "(no text)");
    for (const r of replies.get(m.ts) ?? []) {
      const d = isoDay(new Date(Number(r.ts) * 1000));
      lines.push("", `> **${who(r)}** · ${d === day ? clock(r.ts) : `${d} ${clock(r.ts)}`} (reply)`, ...body(r).split("\n").map((l) => `> ${l}`));
    }
  }
  return md(lines.join("\n"));
}

async function history(http: ProviderHttp, token: string, channel: string, day: string): Promise<SlackMessage[]> {
  const oldest = Date.parse(`${day}T00:00:00Z`) / 1000;
  const msgs = await paged<SlackMessage>(http, "conversations.history", token, "messages", { channel, oldest: String(oldest), latest: String(oldest + 86400), inclusive: "false", limit: "200" }, 20_000);
  return msgs.filter((m) => !(m.subtype && SKIP_SUBTYPES.has(m.subtype))).sort((a, b) => Number(a.ts) - Number(b.ts));
}

async function syncChannel(run: SyncRun<SlackSettings>, c: Cursor, id: string, users: () => Promise<Map<string, string>>): Promise<boolean> {
  const { http, sink, tokens, settings } = run;
  const token = tokens.access_token;
  const state: ChannelCursor = (c.channels![id] ??= {});
  let channel: Channel;
  try {
    channel = (await call<{ channel: Channel }>(http, "conversations.info", token, { channel: id })).channel;
    if (!channel.is_member) {
      if (channel.is_private) throw new ProviderError("forbidden", "not_in_channel", undefined, undefined, "not_in_channel");
      await call(http, "conversations.join", token, { channel: id }, true);
    }
  } catch (err) {
    if (err instanceof ProviderError && (err.providerCode === "not_in_channel" || err.providerCode === "channel_not_found" || err.code === "not_found" || err.providerCode === "method_not_supported_for_channel_type" || err.providerCode === "is_archived")) {
      state.problem = err.providerCode === "not_in_channel" || err.providerCode === "is_archived" ? "not_in_channel" : "channel_not_found";
      return true;
    }
    throw err;
  }
  delete state.problem;
  const today = isoDay(run.now);
  const yesterday = isoDay(new Date(run.now.getTime() - DAY));
  const first = isoDay(new Date(run.now.getTime() - settings.backfill_days * DAY));
  let day = state.next_day && state.next_day > first ? state.next_day : first;
  if (day > yesterday) day = yesterday;
  for (; day <= today; day = isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + DAY))) {
    if (sink.shouldYield()) return false;
    const sourceId = `day:${id}:${day}`;
    const msgs = await history(http, token, id, day);
    if (!msgs.length) {
      if (await sink.known(sourceId)) await sink.remove([sourceId]);
    } else {
      const names = await users();
      const replies = new Map<string, SlackMessage[]>();
      for (const m of msgs) {
        if (!m.reply_count || m.thread_ts !== m.ts) continue;
        const thread = await paged<SlackMessage>(http, "conversations.replies", token, "messages", { channel: id, ts: m.ts, limit: "200" }, 5_000);
        replies.set(m.ts, thread.filter((r) => r.ts !== m.ts && !(r.subtype && SKIP_SUBTYPES.has(r.subtype))));
      }
      await sink.upsert({
        sourceId,
        container: `ch:${id}`,
        title: `#${channel.name} — ${day}`,
        filename: `slack-${slug(channel.name, 60)}-${day}.md`,
        contentType: "text/markdown",
        body: Buffer.from(renderDay(channel, day, msgs, replies, names), "utf8"),
        classification: channel.is_private ? "confidential" : "internal",
        effectiveFrom: day,
      });
    }
    // Ayer y hoy se releen en cada pasada; los días anteriores quedan cerrados.
    const next = isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + DAY));
    state.next_day = next < yesterday ? next : yesterday;
    await sink.checkpoint({ ...c });
  }
  return true;
}

export const slack: ProviderAdapter<SlackSettings> = {
  id: "slack",
  name: "Slack",
  scope: "organization",
  initialStatus: "needs_setup",

  authorizeUrl({ client, redirectUri, state }) {
    const p = new URLSearchParams({ client_id: client.clientId, scope: SLACK_SCOPES.join(","), redirect_uri: redirectUri, state });
    return `${AUTH}?${p}`;
  },

  async exchange(http, { client, code, redirectUri }) {
    const r = await http.json<{ ok: boolean; error?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; team?: { id: string; name: string } }>(`${API}/oauth.v2.access`, {
      method: "POST",
      body: new URLSearchParams({ code, redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    if (!r.ok || !r.access_token || !r.team) throw new ProviderError(r.error === "invalid_code" ? "auth_revoked" : "provider_error", `slack oauth: ${r.error ?? "missing token"}`, undefined, undefined, r.error);
    const tokens: TokenSet = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined, scope: r.scope };
    return { tokens, account: { id: r.team.id, label: r.team.name } };
  },

  // Solo si la app tiene activada la rotación de tokens (por defecto los bots no caducan).
  async refresh(http, client, tokens) {
    if (!tokens.refresh_token) return tokens;
    const r = await http.json<{ ok: boolean; error?: string; access_token?: string; refresh_token?: string; expires_in?: number }>(`${API}/oauth.v2.access`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }),
    });
    if (!r.ok || !r.access_token) throw new ProviderError("auth_revoked", `slack refresh: ${r.error ?? "failed"}`, undefined, undefined, r.error);
    return { ...tokens, access_token: r.access_token, refresh_token: r.refresh_token ?? tokens.refresh_token, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined };
  },

  async revoke(http, _client, tokens) {
    await call(http, "auth.revoke", tokens.access_token, {}, true);
  },

  parseSettings: (raw) => SlackSettings.parse(raw ?? {}),
  defaultSettings: () => SlackSettings.parse({}),
  ready: (s) => s.channel_ids.length > 0,

  async options(http, tokens): Promise<OptionGroup[]> {
    const channels = await paged<Channel & { num_members?: number }>(http, "conversations.list", tokens.access_token, "channels", { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" }, 2_000);
    return [
      {
        key: "channel_ids",
        label: "Channels",
        multiple: true,
        options: channels
          .filter((ch) => !ch.is_private || ch.is_member)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((ch) => ({ id: ch.id, label: `#${ch.name}`, private: !!ch.is_private, detail: ch.num_members ? `${ch.num_members} members` : undefined })),
      },
    ];
  },

  async sync(run) {
    const c: Cursor = { channels: { ...((run.cursor as Cursor).channels ?? {}) } };
    const selected = run.settings.channel_ids;
    // Canales que el admin deseleccionó: se retiran de la búsqueda.
    await run.sink.keepContainers("ch:", selected.map((id) => `ch:${id}`));
    for (const id of Object.keys(c.channels!)) if (!selected.includes(id)) delete c.channels![id];
    let names: Map<string, string> | undefined;
    const users = async () => (names ??= await userNames(run.http, run.tokens.access_token));
    for (const id of selected) {
      const done = await syncChannel(run, c, id, users);
      await run.sink.checkpoint({ ...c });
      if (!done) return { more: true };
    }
    return { more: false };
  },
};
