"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type QueryScopeInfo } from "@/lib/api";
import { FileTile } from "@/components/FileTile";
import { FormDialog } from "@/components/FormDialog";
import { IconBriefcase, IconChevronDown, IconFiles, IconFolder, IconGlobe, IconLayers, IconSearch, IconX } from "@/components/icons";
import { TextField } from "@/components/ui";
import { tNow, useT } from "@/lib/use-t";
import { matterSubtitle, type Matter } from "../matters/shared";
import { CommandGroup, CommandItem, ComposerMenu, useComposerMenu } from "./ComposerMenu";
import "../matters/matters.css";

/**
 * Where a question searches (ADR-037). The API signs it into the internal token; the rag-engine never reads it from the
 * request. Every scope is a subset of what the person can already read: the document ACL applies everywhere.
 */
export type AskScope =
  | { type: "space" }
  | { type: "matter"; id: string; label: string; sub?: string }
  | { type: "folder"; id: string; label: string }
  | { type: "documents"; ids: string[]; label: string }
  | { type: "all" };

export const SPACE_SCOPE: AskScope = { type: "space" };
const MAX_DOCUMENTS = 50;
const MENU_ITEMS = 8;

/** The `scope` field of POST …/query. */
export function scopeBody(s: AskScope) {
  switch (s.type) {
    case "matter":
    case "folder":
      return { type: s.type, id: s.id };
    case "documents":
      return { type: "documents", ids: s.ids };
    default:
      return { type: s.type };
  }
}

/** `?scope=matter:<id>`, `folder:<id>`, `documents:<id>,<id>` or `all` (deep links from Expedientes and the library). */
export function parseScopeParam(v: string | null): { type: AskScope["type"]; ids: string[] } | null {
  if (!v) return null;
  if (v === "all") return { type: "all", ids: [] };
  const [type, rest = ""] = v.split(":", 2);
  const ids = rest.split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if ((type === "matter" || type === "folder" || type === "documents") && ids.length) return { type, ids: ids.slice(0, MAX_DOCUMENTS) };
  return null;
}

/** The scope a past answer used, as a picker value (to ask a follow-up in the same place). */
export function scopeFromInfo(i: QueryScopeInfo | null | undefined): AskScope {
  if (!i) return SPACE_SCOPE;
  if (i.type === "matter" && i.id) return { type: "matter", id: i.id, label: i.label ?? tNow("Expediente"), sub: [i.client, i.case_number].filter(Boolean).join(" · ") };
  if (i.type === "folder" && i.id) return { type: "folder", id: i.id, label: i.label ?? tNow("Folder") };
  if (i.type === "documents" && i.ids?.length) return { type: "documents", ids: i.ids, label: i.label ?? tNow("Documents") };
  if (i.type === "all") return { type: "all" };
  return SPACE_SCOPE;
}

/** "Expediente Parra Rosas — D-16.857", "3 documents", "All my spaces"… */
export function scopeLabel(s: AskScope, wsName?: string | null): string {
  switch (s.type) {
    case "matter":
      return tNow("Expediente {name}", { name: s.label });
    case "folder":
      return tNow("Folder {name}", { name: s.label });
    case "documents":
      return s.ids.length === 1 ? s.label : tNow("{count} documents", { count: s.ids.length });
    case "all":
      return tNow("All my spaces");
    default:
      return wsName ?? tNow("This space");
  }
}

export function ScopeIcon({ type, size = 15 }: { type: AskScope["type"]; size?: number }) {
  if (type === "matter") return <IconBriefcase size={size} />;
  if (type === "folder") return <IconFolder size={size} />;
  if (type === "documents") return <IconFiles size={size} />;
  if (type === "all") return <IconGlobe size={size} />;
  return <IconLayers size={size} />;
}

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  document_count: number;
}

/** Composer chip: «Search in · General ▾». A narrower scope shows as a tinted chip with × to go back to the space. */
export function ScopePicker({ orgId, workspaceId, wsName, value, onChange, disabled }: { orgId: string; workspaceId: string; wsName?: string | null; value: AskScope; onChange: (s: AskScope) => void; disabled?: boolean }) {
  const t = useT();
  const state = useComposerMenu();
  const { menu, onTriggerKey } = state;
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [folders, setFolders] = useState<{ ws: string; list: FolderRow[] } | null>(null);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);

  // Loaded when the menu first opens (and again for another space's folders): most questions never open it.
  useEffect(() => {
    if (!menu.isOpen) return;
    if (!matters) api<{ matters: Matter[] }>(`organizations/${orgId}/matters`).then((r) => setMatters(r.matters)).catch(() => setMatters([]));
    if (workspaceId && folders?.ws !== workspaceId)
      api<{ folders: FolderRow[] }>(`organizations/${orgId}/folders?workspace_id=${workspaceId}`)
        .then((r) => setFolders({ ws: workspaceId, list: r.folders }))
        .catch(() => setFolders({ ws: workspaceId, list: [] }));
  }, [menu.isOpen, orgId, workspaceId, matters, folders?.ws]);

  const pick = (s: AskScope) => {
    onChange(s);
    menu.close();
    setQuery("");
  };
  const q = query.trim().toLowerCase();
  const openMatters = useMemo(
    () =>
      (matters ?? [])
        .filter((m) => m.status !== "archived" || (value.type === "matter" && value.id === m.id))
        .filter((m) => !q || [m.title, m.client_name, m.case_number].some((v) => v?.toLowerCase().includes(q))),
    [matters, q, value],
  );
  const folderList = useMemo(() => {
    const list = folders?.ws === workspaceId ? folders.list : [];
    const byId = new Map(list.map((f) => [f.id, f]));
    const path = (f: FolderRow) => {
      const parts = [f.name];
      for (let p = f.parent_id ? byId.get(f.parent_id) : undefined, i = 0; p && i < 6; p = p.parent_id ? byId.get(p.parent_id) : undefined, i++) parts.unshift(p.name);
      return parts.join(" / ");
    };
    return list.map((f) => ({ ...f, path: path(f) })).filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [folders, workspaceId, q]);

  const narrowed = value.type !== "space";
  return (
    <div className="cmenu-host" ref={menu.ref}>
      <span className={`date-chip fmt-chip scope-chip${narrowed ? " is-set" : ""}`} data-tip={narrowed || menu.isOpen ? undefined : t("Choose where this question searches")}>
        <button type="button" className="date-trigger" aria-haspopup="menu" aria-expanded={menu.isOpen} onClick={menu.toggle} onKeyDown={onTriggerKey} disabled={disabled}>
          <ScopeIcon type={value.type} />
          {t("Search in")}
          <span className="date-value">{scopeLabel(value, wsName)}</span>
          <IconChevronDown size={13} />
        </button>
        {narrowed && (
          <button type="button" className="scope-clear" aria-label={t("Search this space again")} data-tip={t("Back to {name}", { name: wsName ?? t("this space") })} onClick={() => onChange(SPACE_SCOPE)} disabled={disabled}>
            <IconX size={13} />
          </button>
        )}
      </span>
      <ComposerMenu state={state} label={t("Search in")} footer={t("Answers only use documents you can read, wherever you search.")}>
        <CommandGroup>
          <CommandItem icon={<IconLayers size={16} />} title={wsName ?? t("This space")} hint={t("Only this space, as before")} checked={value.type === "space"} onClick={() => pick(SPACE_SCOPE)} />
          <CommandItem icon={<IconGlobe size={16} />} title={t("All my spaces")} hint={t("Every space you belong to")} checked={value.type === "all"} onClick={() => pick({ type: "all" })} />
          <CommandItem icon={<IconFiles size={16} />} title={value.type === "documents" ? scopeLabel(value) : t("Choose documents…")} hint={t("Only the documents you pick from this space")} checked={value.type === "documents"} onClick={() => (menu.close(), setPicking(true))} />
        </CommandGroup>
        {((matters?.length ?? 0) > 5 || (folders?.list.length ?? 0) > 5) && (
          <div className="search scope-search">
            <IconSearch size={15} />
            <input placeholder={t("Find an expediente or folder")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Find an expediente or folder")} onKeyDown={(e) => e.stopPropagation()} />
          </div>
        )}
        <CommandGroup label={t("Matters")}>
          {matters === null ? (
            <div className="scope-empty">{t("Loading…")}</div>
          ) : openMatters.length === 0 ? (
            <div className="scope-empty">{q ? t("No expediente matches") : t("No expedientes yet. Create them in Matters.")}</div>
          ) : (
            openMatters.slice(0, MENU_ITEMS).map((m) => (
              <CommandItem
                key={m.id}
                icon={<IconBriefcase size={16} />}
                title={m.title}
                hint={[matterSubtitle(m), t("{count} documents", { count: m.document_count })].filter(Boolean).join(" · ")}
                checked={value.type === "matter" && value.id === m.id}
                onClick={() => pick({ type: "matter", id: m.id, label: m.title, sub: matterSubtitle(m) })}
              />
            ))
          )}
        </CommandGroup>
        {folderList.length > 0 && (
          <CommandGroup label={t("Folders in {name}", { name: wsName ?? t("this space") })}>
            {folderList.slice(0, MENU_ITEMS).map((f) => (
              <CommandItem key={f.id} icon={<IconFolder size={16} />} title={f.path} hint={t("{count} documents, with its subfolders", { count: f.document_count })} checked={value.type === "folder" && value.id === f.id} onClick={() => pick({ type: "folder", id: f.id, label: f.name })} />
            ))}
          </CommandGroup>
        )}
      </ComposerMenu>
      {picking && <DocumentPicker orgId={orgId} workspaceId={workspaceId} wsName={wsName} initial={value.type === "documents" ? value.ids : []} onClose={() => setPicking(false)} onPick={(s) => (setPicking(false), onChange(s))} />}
    </div>
  );
}

interface DocRow {
  id: string;
  title: string;
  filename: string;
  latest_status: string;
}

/** Pick up to 50 documents of the active space to ask about only those. */
function DocumentPicker({ orgId, workspaceId, wsName, initial, onClose, onPick }: { orgId: string; workspaceId: string; wsName?: string | null; initial: string[]; onClose: () => void; onPick: (s: AskScope) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [chosen, setChosen] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api<{ documents: DocRow[] }>(`organizations/${orgId}/documents?workspace_id=${workspaceId}&limit=100${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`)
        .then((r) => {
          if (!alive) return;
          setDocs(r.documents.filter((d) => d.latest_status === "indexed"));
          setChosen((cur) => {
            if (cur.size || !initial.length) return cur;
            return new Map(r.documents.filter((d) => initial.includes(d.id)).map((d) => [d.id, d.title]));
          });
        })
        .catch(() => alive && setDocs([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [orgId, workspaceId, q, initial]);
  const toggle = (d: DocRow) =>
    setChosen((cur) => {
      const next = new Map(cur);
      if (next.has(d.id)) next.delete(d.id);
      else if (next.size < MAX_DOCUMENTS) next.set(d.id, d.title);
      return next;
    });
  const submit = () => {
    const ids = [...chosen.keys()];
    if (ids.length) onPick({ type: "documents", ids, label: chosen.get(ids[0]) ?? t("Documents") });
  };
  return (
    <FormDialog
      title={t("Ask about specific documents")}
      description={t("The answer will only use the documents you pick from {name}.", { name: wsName ?? t("this space") })}
      icon={IconFiles}
      submitLabel={chosen.size ? t("Use {count} documents", { count: chosen.size }) : t("Pick documents")}
      disabled={!chosen.size}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField label={t("Find by title")} icon={IconSearch} value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      {docs === null ? (
        <p className="muted">{t("Loading…")}</p>
      ) : docs.length === 0 ? (
        <p className="muted">{q ? t("No ready documents match.") : t("This space has no ready documents yet.")}</p>
      ) : (
        <ul className="doc-pick">
          {docs.map((d) => (
            <li key={d.id}>
              <label>
                <input type="checkbox" checked={chosen.has(d.id)} onChange={() => toggle(d)} disabled={!chosen.has(d.id) && chosen.size >= MAX_DOCUMENTS} />
                <FileTile ext={d.filename.split(".").pop()?.toLowerCase() ?? ""} />
                <span className="ellipsis">{d.title}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}

/** Under each answer: where it searched. */
export function AnswerScope({ scope }: { scope: QueryScopeInfo | null | undefined }) {
  const t = useT();
  if (!scope || scope.type === "space") return null;
  const s = scopeFromInfo(scope);
  return (
    <div className="answer-scope">
      <ScopeIcon type={s.type} size={14} />
      <span>{t("Searched in {where}", { where: scopeLabel(s) })}{scope.type !== "documents" && scope.workspaces > 1 ? ` · ${t("{count} spaces", { count: scope.workspaces })}` : ""}</span>
    </div>
  );
}
