"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { AppErrorState, StateIllustration, requestErrorKind } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { FileTile } from "@/components/FileTile";
import { IconBriefcase, IconChat, IconEdit, IconPlus, IconSearch, IconTrash, IconX } from "@/components/icons";
import { Seg } from "@/components/motion";
import { Sheet } from "@/components/Sheet";
import { Skel, SkeletonStatus, SkeletonTable } from "@/components/skeletons";
import { useConfirm } from "@/components/ui";
import { useT } from "@/lib/use-t";
import { MatterDialog, StatusPill, askInMatterHref, matterSubtitle, useMatters, type Matter, type MatterDetail, type MatterStatus, type Person } from "./shared";
import "./matters.css";

type StatusView = MatterStatus | "all";

const ext = (filename: string | null) => filename?.split(".").pop()?.toLowerCase() ?? "";

export default function MattersPage() {
  const t = useT();
  const { org: orgId } = useParams<{ org: string }>();
  const { data, error, reload, setData } = useMatters(orgId);
  const [view, setView] = useState<StatusView>("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ matter: Matter | null } | null>(null);
  // `?open=<id>` opens an expediente's panel (links from the library and from Ask).
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => setOpenId(new URLSearchParams(window.location.search).get("open")), []);

  const open = (id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("open", id);
    else url.searchParams.delete("open");
    window.history.replaceState(window.history.state, "", url);
  };

  const all = useMemo(() => data?.matters ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<StatusView, number> = { all: all.length, active: 0, on_hold: 0, closed: 0, archived: 0 };
    for (const m of all) c[m.status]++;
    return c;
  }, [all]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (m) =>
        (view === "all" || m.status === view) &&
        (!q || [m.title, m.client_name, m.case_number, m.counterparty, m.court].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [all, view, query]);
  // One block per client: lawyers look a case up by who they represent.
  const byClient = useMemo(() => {
    const groups = new Map<string, Matter[]>();
    for (const m of shown) groups.set(m.client_name, [...(groups.get(m.client_name) ?? []), m]);
    return [...groups.entries()];
  }, [shown]);

  const saved = (m: Matter) => {
    setData((cur) => (cur ? { ...cur, matters: [...cur.matters.filter((x) => x.id !== m.id), m].sort((a, b) => a.client_name.localeCompare(b.client_name) || a.title.localeCompare(b.title)) } : cur));
    setEditing(null);
  };

  const errorKind = error ? requestErrorKind(error) : null;
  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={t("Matters")} icon={IconBriefcase} />
        {data?.can_edit && (
          <button type="button" className="primary small" onClick={() => setEditing({ matter: null })}>
            <IconPlus size={15} />
            {t("New expediente")}
          </button>
        )}
      </header>
      <div className="main">
        <header className="page-head">
          <div>
            <h1>{t("Matters")}</h1>
            <p className="sub">{t("Work by client and case. An expediente groups documents from any space and never changes who can read them.")}</p>
          </div>
        </header>

        {errorKind ? (
          <AppErrorState kind={errorKind} backHref={`/app/${orgId}/ask`} backLabel={t("Back to Ask")} onRetry={reload} />
        ) : !data ? (
          <SkeletonStatus label={t("Loading expedientes…")} className="stack">
            <div className="toolbar">
              <Skel w={320} h={34} r={999} />
              <Skel w={260} h={38} r={999} />
            </div>
            <SkeletonTable rows={4} columns={["", "hide-sm", "hide-md", "hide-sm", "hide-md", "", "num"]} />
          </SkeletonStatus>
        ) : all.length === 0 ? (
          <div className="card empty matter-empty">
            <StateIllustration kind="empty" />
            <strong>{t("No expedientes yet")}</strong>
            <span>{t("Create one per client case to ask only about its documents, wherever they are filed. You can also turn a library folder into an expediente.")}</span>
            {data.can_edit && (
              <button type="button" className="primary" onClick={() => setEditing({ matter: null })}>
                <IconPlus size={15} />
                {t("New expediente")}
              </button>
            )}
          </div>
        ) : (
          <section className="stack" style={{ gap: 12 }}>
            <div className="toolbar">
              <Seg role="group" aria-label={t("Filter by status")}>
                {(["active", "on_hold", "closed", "archived", "all"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>
                    {k === "all" ? t("All") : t({ active: "Active", on_hold: "On hold", closed: "Closed", archived: "Archived" }[k])}
                    <span className="count">{counts[k]}</span>
                  </button>
                ))}
              </Seg>
              <div className={`search${query ? " has-value" : ""}`}>
                <IconSearch size={15} />
                <input placeholder={t("Client, filing number or court")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Search expedientes")} />
                <button type="button" className="quiet icon small clear" onClick={() => setQuery("")} aria-label={t("Clear filter")} tabIndex={query ? 0 : -1}>
                  <IconX size={14} />
                </button>
              </div>
            </div>

            <div className="table-card">
              {shown.length === 0 ? (
                <div className="empty">
                  <StateIllustration kind="empty" />
                  <strong>{query ? t("No expedientes match") : t("Nothing in this status")}</strong>
                  <span>{query ? t("Try the client's name or part of the filing number.") : t("Change the filter to see the rest.")}</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="matter-table">
                    <thead>
                      <tr>
                        <th>{t("Expediente")}</th>
                        <th className="hide-sm">{t("Filing number")}</th>
                        <th className="hide-md">{t("Court")}</th>
                        <th className="hide-sm">{t("Stage")}</th>
                        <th className="hide-md">{t("Responsible")}</th>
                        <th>{t("Status")}</th>
                        <th className="num">{t("Documents")}</th>
                        <th>
                          <span className="sr-only">{t("Actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    {byClient.map(([client, list]) => (
                      <tbody key={client}>
                        <tr className="matter-client-row">
                          <th colSpan={8} scope="rowgroup">
                            <span className="matter-client">{client}</span>
                            <span className="count">{list.length}</span>
                          </th>
                        </tr>
                        {list.map((m) => (
                          <tr key={m.id} className="matter-row" aria-selected={openId === m.id}>
                            <td>
                              <button type="button" className="link matter-open" onClick={() => open(m.id)}>
                                {m.title}
                              </button>
                              {m.counterparty && <div className="mono">{t("vs. {name}", { name: m.counterparty })}</div>}
                            </td>
                            <td className="mono hide-sm nowrap">{m.case_number ?? "—"}</td>
                            <td className="muted hide-md">{m.court ?? "—"}</td>
                            <td className="hide-sm">{m.stage ?? "—"}</td>
                            <td className="muted hide-md">{m.owner?.name ?? "—"}</td>
                            <td>
                              <StatusPill status={m.status} />
                            </td>
                            <td className="num">{m.document_count}</td>
                            <td className="actions">
                              <Link href={askInMatterHref(orgId, m.id)} className="btn quiet small icon" aria-label={t("Ask in {title}", { title: m.title })} data-tip={t("Ask in this expediente")} data-tip-side="end">
                                <IconChat size={16} />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {openId && data && (
        <MatterPanel
          key={openId}
          orgId={orgId}
          matterId={openId}
          people={data.people}
          onClose={() => open(null)}
          onChanged={(m) => (m ? saved(m) : (setData((cur) => (cur ? { ...cur, matters: cur.matters.filter((x) => x.id !== openId) } : cur)), open(null)))}
        />
      )}
      {editing && data && <MatterDialog orgId={orgId} people={data.people} matter={editing.matter} onClose={() => setEditing(null)} onSaved={(m) => (saved(m), editing.matter ? undefined : open(m.id))} />}
    </div>
  );
}

/** Side panel: the expediente's facts, its documents across spaces, and Ask inside it. */
function MatterPanel({ orgId, matterId, people, onClose, onChanged }: { orgId: string; matterId: string; people: Person[]; onClose: () => void; onChanged: (m: Matter | null) => void }) {
  const t = useT();
  const confirm = useConfirm();
  const [m, setM] = useState<MatterDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  const closeDoc = useCallback(() => setViewing(null), []);

  const load = useCallback(async () => {
    try {
      setM(await api<MatterDetail>(`organizations/${orgId}/matters/${matterId}`));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, [orgId, matterId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(close: () => void) {
    if (!m) return;
    const ok = await confirm({
      title: t("Delete \"{title}\"?", { title: m.title }),
      body: t("Its documents are not deleted: they stay in their spaces, without an expediente."),
      confirmLabel: t("Delete"),
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`organizations/${orgId}/matters/${m.id}`, { method: "DELETE" });
      close();
      onChanged(null);
    } catch (e) {
      setError(e as Error);
    }
  }

  // Documents grouped by the space they are filed in: the expediente spans spaces, the library does not.
  const bySpace = useMemo(() => {
    const groups = new Map<string, MatterDetail["documents"]>();
    for (const d of m?.documents ?? []) groups.set(d.workspace_name, [...(groups.get(d.workspace_name) ?? []), d]);
    return [...groups.entries()];
  }, [m]);

  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <Sheet label={m ? t("Expediente {title}", { title: m.title }) : t("Expediente")} onClose={onClose}>
      {(close) => (
        <>
          <header className="sheet-head">
            <div className="row">
              {m ? <StatusPill status={m.status} /> : <span className="req-num">{t("Expediente")}</span>}
              {m?.case_number && <span className="mono matter-case">{m.case_number}</span>}
              <button type="button" className="quiet sheet-close" aria-label={t("Close")} onClick={close}>
                <IconX size={16} />
              </button>
            </div>
            {m && (
              <>
                <h2>{m.title}</h2>
                <div className="sheet-meta">{matterSubtitle(m)}</div>
              </>
            )}
          </header>
          <div className="sheet-body">
            {error && !m ? (
              <div className="card empty">
                <StateIllustration kind={notFound ? "notFound" : "server"} />
                <strong>{notFound ? t("This expediente isn't available") : t("Couldn't load this expediente")}</strong>
                <span>{notFound ? t("It was deleted, or it belongs to another organization.") : error.message}</span>
                {!notFound && (
                  <button type="button" className="ghost" onClick={load}>
                    {t("Try again")}
                  </button>
                )}
              </div>
            ) : !m ? (
              <SkeletonStatus label={t("Loading expediente…")}>
                <div className="stack" aria-hidden="true">
                  <Skel w="70%" h={26} />
                  <Skel h={140} r={14} />
                  <Skel h={180} r={14} />
                </div>
              </SkeletonStatus>
            ) : (
              <>
                <div className="move-actions" role="group" aria-label={t("Actions")}>
                  <Link href={askInMatterHref(orgId, m.id)} className="btn primary">
                    <IconChat size={15} />
                    {t("Ask in this expediente")}
                  </Link>
                  {m.can_edit && (
                    <button type="button" className="ghost" onClick={() => setEditing(true)}>
                      <IconEdit size={15} />
                      {t("Edit")}
                    </button>
                  )}
                  {m.can_delete && (
                    <button type="button" className="quiet end" onClick={() => remove(close)}>
                      <IconTrash size={15} />
                      {t("Delete")}
                    </button>
                  )}
                </div>

                <dl className="req-facts">
                  <dt>{t("Client")}</dt>
                  <dd>{m.client_name}</dd>
                  <dt>{t("Counterparty")}</dt>
                  <dd>{m.counterparty ?? "—"}</dd>
                  <dt>{t("Filing number")}</dt>
                  <dd className="mono">{m.case_number ?? "—"}</dd>
                  <dt>{t("Court")}</dt>
                  <dd>{m.court ?? "—"}</dd>
                  <dt>{t("Stage")}</dt>
                  <dd>{m.stage ?? "—"}</dd>
                  <dt>{t("Responsible")}</dt>
                  <dd>{m.owner?.name ?? t("Nobody yet")}</dd>
                </dl>

                <h3 className="sheet-section">{t("Documents ({count})", { count: m.documents.length })}</h3>
                {m.documents.length === 0 ? (
                  <p className="muted">{t("No documents you can read are linked yet. Link them from the library with the expediente button on each document.")}</p>
                ) : (
                  <div className="matter-docs">
                    {bySpace.map(([space, docs]) => (
                      <section key={space}>
                        <div className="matter-space">{t("In {space}", { space })}</div>
                        <ul>
                          {docs.map((d) => (
                            <li key={d.id}>
                              <FileTile ext={ext(d.filename)} />
                              <div style={{ minWidth: 0 }}>
                                {d.latest_status === "indexed" && d.latest_version_id ? (
                                  <button type="button" className="link doc-open" onClick={() => setViewing({ documentId: d.id, versionId: d.latest_version_id!, title: d.title, filename: d.filename ?? "" })}>
                                    {d.title}
                                  </button>
                                ) : (
                                  <strong>{d.title}</strong>
                                )}
                                <div className="mono">{d.folder_name ? t("Folder {name}", { name: d.folder_name }) : d.filename}</div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
                <p className="faint matter-privacy">{t("You see the documents you can read. Other people may see more or fewer, depending on each document's access.")}</p>
              </>
            )}
          </div>
          {editing && m && (
            <MatterDialog
              orgId={orgId}
              people={people}
              matter={m}
              onClose={() => setEditing(false)}
              onSaved={(updated) => {
                setEditing(false);
                setM((cur) => (cur ? { ...cur, ...updated } : cur));
                onChanged(updated);
              }}
            />
          )}
          <DocViewer doc={viewing} orgId={orgId} onClose={closeDoc} />
        </>
      )}
    </Sheet>
  );
}
