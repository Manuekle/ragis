/**
 * ClickUp (conector de organización). Un documento por tarea (descripción + comentarios) y uno por Doc.
 *
 * Delta de tareas con date_updated_gt; ClickUp no expone borrados, así que cada 24 h se reconcilia la lista completa
 * de IDs y se retiran las tareas que ya no existen. Los Docs se listan en cada pasada (barato) y solo se descargan
 * los que cambiaron. Por defecto se indexan los espacios no privados; los privados requieren selección explícita.
 */
import { z } from "zod";
import { ProviderError } from "./http.js";
import { isoMinute, md, slug } from "./render.js";
import type { OptionGroup, ProviderAdapter, ProviderHttp, SyncRun, TokenSet } from "./types.js";

const AUTH = "https://app.clickup.com/api";
const V2 = "https://api.clickup.com/api/v2";
const V3 = "https://api.clickup.com/api/v3";
const RECONCILE_MS = 24 * 3600_000;

export const ClickUpSettings = z.object({
  /** null = todos los espacios no privados (incluidos los que se creen después). */
  space_ids: z.array(z.string().regex(/^\d{1,20}$/)).max(200).nullable().default(null),
  include_docs: z.boolean().default(true),
});
export type ClickUpSettings = z.infer<typeof ClickUpSettings>;

interface Cursor {
  team_id?: string;
  tasks?: { since: number; page: number; max_seen: number };
  reconcile?: { started: string; page: number };
  last_reconcile?: number;
  docs?: { cursor?: string; started: string };
}

interface Space {
  id: string;
  name: string;
  private?: boolean;
}
interface Task {
  id: string;
  custom_id?: string | null;
  name: string;
  text_content?: string;
  description?: string;
  markdown_description?: string;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  date_updated?: string;
  date_closed?: string | null;
  due_date?: string | null;
  url?: string;
  assignees?: { username?: string; email?: string }[];
  tags?: { name?: string }[];
  list?: { id?: string; name?: string };
  folder?: { id?: string; name?: string; hidden?: boolean };
  space?: { id?: string };
}
interface Doc {
  id: string;
  name: string;
  date_created?: number;
  date_updated?: number;
  parent?: { id?: string; type?: number };
  deleted?: boolean;
  archived?: boolean;
}
interface Page {
  id?: string;
  name?: string;
  content?: string;
  pages?: Page[];
}

const auth = (t: TokenSet) => ({ token: t.access_token });
const date = (ms?: string | number | null) => (ms ? isoMinute(new Date(Number(ms))) : "");

async function spaces(http: ProviderHttp, tokens: TokenSet, team: string): Promise<Space[]> {
  const r = await http.json<{ spaces?: Space[] }>(`${V2}/team/${team}/space?archived=false`, auth(tokens));
  return (r.spaces ?? []).map((s) => ({ id: String(s.id), name: s.name, private: !!s.private }));
}

function selectedSpaces(all: Space[], settings: ClickUpSettings): Space[] {
  return settings.space_ids === null ? all.filter((s) => !s.private) : all.filter((s) => settings.space_ids!.includes(s.id));
}

export function renderTask(t: Task, space: Space | undefined, comments: { comment_text?: string; user?: { username?: string }; date?: string }[]): string {
  const where = [space?.name, t.folder && !t.folder.hidden ? t.folder.name : undefined, t.list?.name].filter(Boolean).join(" / ");
  const facts = [
    t.status?.status ? `Status: ${t.status.status}` : "",
    t.priority?.priority ? `Priority: ${t.priority.priority}` : "",
    t.due_date ? `Due: ${date(t.due_date).slice(0, 10)}` : "",
    t.date_closed ? `Closed: ${date(t.date_closed).slice(0, 10)}` : "",
    t.assignees?.length ? `Assignees: ${t.assignees.map((a) => a.username || a.email).filter(Boolean).join(", ")}` : "",
    t.tags?.length ? `Tags: ${t.tags.map((x) => x.name).filter(Boolean).join(", ")}` : "",
  ].filter(Boolean);
  const lines = [`# ${t.name}`, "", `ClickUp task${t.custom_id ? ` ${t.custom_id}` : ""}${where ? ` · ${where}` : ""}`];
  if (facts.length) lines.push("", facts.join(" · "));
  if (t.url) lines.push("", `Link: ${t.url}`);
  const desc = (t.markdown_description || t.text_content || t.description || "").trim();
  lines.push("", "## Description", "", desc || "(no description)");
  if (comments.length) {
    lines.push("", "## Comments");
    for (const c of comments) lines.push("", `**${c.user?.username ?? "Someone"}** · ${date(c.date)}`, (c.comment_text ?? "").trim() || "(no text)");
  }
  return md(lines.join("\n"));
}

function flatten(pages: Page[], depth = 2, out: string[] = []): string[] {
  for (const p of pages) {
    if (p.name) out.push(`${"#".repeat(Math.min(depth, 6))} ${p.name}`, "");
    if (p.content?.trim()) out.push(p.content.trim(), "");
    if (p.pages?.length) flatten(p.pages, depth + 1, out);
  }
  return out;
}

async function teamId(run: SyncRun<ClickUpSettings>, c: Cursor): Promise<string> {
  if (c.team_id) return c.team_id;
  const r = await run.http.json<{ teams?: { id: string }[] }>(`${V2}/team`, auth(run.tokens));
  const id = r.teams?.[0]?.id;
  if (!id) throw new ProviderError("forbidden", "no ClickUp workspace was authorized");
  c.team_id = String(id);
  return c.team_id;
}

function taskUrl(team: string, params: Record<string, string>, spaceIds: string[]): string {
  const p = new URLSearchParams({ subtasks: "true", include_closed: "true", include_markdown_description: "true", order_by: "updated", ...params });
  for (const s of spaceIds) p.append("space_ids[]", s);
  return `${V2}/team/${team}/task?${p}`;
}

async function syncTasks(run: SyncRun<ClickUpSettings>, c: Cursor, team: string, chosen: Space[]): Promise<boolean> {
  const { http, sink, tokens } = run;
  const bySpace = new Map(chosen.map((s) => [s.id, s]));
  const st = (c.tasks ??= { since: 0, page: 0, max_seen: 0 });
  for (;;) {
    const params: Record<string, string> = { page: String(st.page) };
    if (st.since) params.date_updated_gt = String(st.since);
    const r = await http.json<{ tasks?: Task[]; last_page?: boolean }>(taskUrl(team, params, [...bySpace.keys()]), auth(tokens));
    const tasks = r.tasks ?? [];
    for (const t of tasks) {
      if (sink.shouldYield()) {
        await sink.checkpoint({ ...c });
        return false;
      }
      st.max_seen = Math.max(st.max_seen, Number(t.date_updated ?? 0));
      const sourceId = `task:${t.id}`;
      const known = await sink.known(sourceId);
      if (known?.sourceUpdatedAt === String(t.date_updated)) {
        await sink.touch([sourceId]);
        continue;
      }
      const space = bySpace.get(String(t.space?.id ?? ""));
      if (!space) continue;
      const comments = await http.json<{ comments?: { comment_text?: string; user?: { username?: string }; date?: string }[] }>(`${V2}/task/${encodeURIComponent(t.id)}/comment`, auth(tokens));
      const ordered = (comments.comments ?? []).sort((a, b) => Number(a.date ?? 0) - Number(b.date ?? 0));
      await sink.upsert({
        sourceId,
        container: `space:${space.id}`,
        title: t.name.slice(0, 300) || "Untitled task",
        filename: `clickup-${slug(t.name, 70)}.md`,
        contentType: "text/markdown",
        body: Buffer.from(renderTask(t, space, ordered), "utf8"),
        sourceUpdatedAt: String(t.date_updated),
        classification: space.private ? "confidential" : "internal",
      });
    }
    const last = r.last_page ?? tasks.length < 100;
    if (last) break;
    st.page += 1;
    await sink.checkpoint({ ...c });
  }
  // Solapamiento de 1 minuto: una tarea editada durante la paginación vuelve en la siguiente pasada (idempotente).
  c.tasks = { since: Math.max(st.since, st.max_seen - 60_000), page: 0, max_seen: 0 };
  await sink.checkpoint({ ...c });
  return true;
}

/** ClickUp no informa de tareas borradas: cada 24 h se recorren todos los IDs y se barre lo que no apareció. */
async function reconcileTasks(run: SyncRun<ClickUpSettings>, c: Cursor, team: string, chosen: Space[]): Promise<boolean> {
  const { http, sink, tokens, now } = run;
  if (!c.reconcile) {
    if (c.last_reconcile && now.getTime() - c.last_reconcile < RECONCILE_MS) return true;
    c.reconcile = { started: now.toISOString(), page: 0 };
  }
  const rc = c.reconcile;
  for (;;) {
    if (sink.shouldYield()) {
      await sink.checkpoint({ ...c });
      return false;
    }
    const r = await http.json<{ tasks?: Task[]; last_page?: boolean }>(taskUrl(team, { page: String(rc.page) }, chosen.map((s) => s.id)), auth(tokens));
    const tasks = r.tasks ?? [];
    await sink.touch(tasks.map((t) => `task:${t.id}`));
    if (r.last_page ?? tasks.length < 100) break;
    rc.page += 1;
    await sink.checkpoint({ ...c });
  }
  await sink.sweep("task:", new Date(rc.started));
  delete c.reconcile;
  c.last_reconcile = now.getTime();
  await sink.checkpoint({ ...c });
  return true;
}

/** Mapa carpeta/lista/espacio → espacio, para saber a qué espacio pertenece cada Doc. */
async function parentMap(http: ProviderHttp, tokens: TokenSet, chosen: Space[]): Promise<Map<string, Space>> {
  const map = new Map<string, Space>();
  for (const s of chosen) {
    map.set(s.id, s);
    const folders = await http.json<{ folders?: { id: string; lists?: { id: string }[] }[] }>(`${V2}/space/${s.id}/folder?archived=false`, auth(tokens));
    for (const f of folders.folders ?? []) {
      map.set(String(f.id), s);
      for (const l of f.lists ?? []) map.set(String(l.id), s);
    }
    const lists = await http.json<{ lists?: { id: string }[] }>(`${V2}/space/${s.id}/list?archived=false`, auth(tokens));
    for (const l of lists.lists ?? []) map.set(String(l.id), s);
  }
  return map;
}

async function syncDocs(run: SyncRun<ClickUpSettings>, c: Cursor, team: string, chosen: Space[]): Promise<boolean> {
  const { http, sink, tokens, now } = run;
  const dc = (c.docs ??= { started: now.toISOString() });
  const parents = await parentMap(http, tokens, chosen);
  for (;;) {
    const p = new URLSearchParams({ limit: "100", deleted: "false", archived: "false" });
    if (dc.cursor) p.set("cursor", dc.cursor);
    const r = await http.json<{ docs?: Doc[]; next_cursor?: string }>(`${V3}/workspaces/${team}/docs?${p}`, auth(tokens));
    for (const d of r.docs ?? []) {
      if (sink.shouldYield()) {
        await sink.checkpoint({ ...c });
        return false;
      }
      const space = parents.get(String(d.parent?.id ?? ""));
      if (!space || d.deleted || d.archived) continue;
      const sourceId = `doc:${d.id}`;
      const version = String(d.date_updated ?? d.date_created ?? "");
      const known = await sink.known(sourceId);
      if (known && version && known.sourceUpdatedAt === version) {
        await sink.touch([sourceId]);
        continue;
      }
      const pages = await http.json<Page[] | { pages?: Page[] }>(`${V3}/workspaces/${team}/docs/${encodeURIComponent(d.id)}/pages?max_page_depth=-1&content_format=text/md`, auth(tokens));
      const list = Array.isArray(pages) ? pages : pages.pages ?? [];
      const body = md([`# ${d.name}`, "", `ClickUp doc · ${space.name}`, "", ...flatten(list)].join("\n"));
      await sink.upsert({
        sourceId,
        container: `space:${space.id}`,
        title: d.name.slice(0, 300) || "Untitled doc",
        filename: `clickup-doc-${slug(d.name, 70)}.md`,
        contentType: "text/markdown",
        body: Buffer.from(body, "utf8"),
        sourceUpdatedAt: version || undefined,
        classification: space.private ? "confidential" : "internal",
      });
    }
    if (!r.next_cursor) break;
    dc.cursor = r.next_cursor;
    await sink.checkpoint({ ...c });
  }
  await sink.sweep("doc:", new Date(dc.started));
  delete c.docs;
  await sink.checkpoint({ ...c });
  return true;
}

export const clickup: ProviderAdapter<ClickUpSettings> = {
  id: "clickup",
  name: "ClickUp",
  scope: "organization",
  initialStatus: "active",

  authorizeUrl({ client, redirectUri, state }) {
    return `${AUTH}?${new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, state })}`;
  },

  async exchange(http, { client, code }) {
    const t = await http.json<{ access_token?: string }>(`${V2}/oauth/token?${new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code })}`, { method: "POST" });
    if (!t.access_token) throw new ProviderError("provider_error", "clickup oauth: missing token");
    const tokens: TokenSet = { access_token: t.access_token };
    const teams = await http.json<{ teams?: { id: string; name: string }[] }>(`${V2}/team`, auth(tokens));
    const team = teams.teams?.[0];
    if (!team) throw new ProviderError("forbidden", "no ClickUp workspace was authorized");
    return { tokens, account: { id: String(team.id), label: team.name } };
  },

  parseSettings: (raw) => ClickUpSettings.parse(raw ?? {}),
  defaultSettings: () => ClickUpSettings.parse({}),
  // Un espacio nuevo en la selección necesita sus tareas antiguas: se recarga desde cero (lo ya indexado no se re-descarga).
  needsResync: (prev, next) => JSON.stringify([...(prev.space_ids ?? ["*"])].sort()) !== JSON.stringify([...(next.space_ids ?? ["*"])].sort()),

  async options(http, tokens): Promise<OptionGroup[]> {
    const teams = await http.json<{ teams?: { id: string }[] }>(`${V2}/team`, auth(tokens));
    const team = teams.teams?.[0]?.id;
    if (!team) return [];
    const all = await spaces(http, tokens, String(team));
    return [{ key: "space_ids", label: "Spaces", multiple: true, options: all.map((s) => ({ id: s.id, label: s.name, private: s.private })) }];
  },

  async sync(run) {
    const c: Cursor = { ...(run.cursor as Cursor) };
    const team = await teamId(run, c);
    const all = await spaces(run.http, run.tokens, team);
    const chosen = selectedSpaces(all, run.settings);
    await run.sink.keepContainers("space:", chosen.map((s) => `space:${s.id}`));
    if (!chosen.length) {
      await run.sink.checkpoint({ ...c });
      return { more: false };
    }
    if (!(await syncTasks(run, c, team, chosen))) return { more: true };
    if (!(await reconcileTasks(run, c, team, chosen))) return { more: true };
    if (run.settings.include_docs) {
      if (!(await syncDocs(run, c, team, chosen))) return { more: true };
    } else {
      // Docs desactivados: se retiran todos los ya indexados.
      await run.sink.sweep("doc:", new Date(Date.now() + 86_400_000));
    }
    return { more: false };
  },
};
