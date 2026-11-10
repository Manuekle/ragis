"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { useOrg } from "../layout";
import { AppErrorState, requestErrorKind, StateIllustration } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAlert, IconEye, IconFolder, IconSearch, IconSpinner, IconTrash, IconUpload, IconX } from "@/components/icons";
import { Skel, SkeletonStatus, SkeletonTable } from "@/components/skeletons";
import { useConfirm } from "@/components/ui";
import { FileTile } from "@/components/FileTile";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { Seg, SoftText } from "@/components/motion";
import { docError } from "@/lib/plain";

interface Doc {
  id: string;
  title: string;
  classification: string;
  latest_version_id: string;
  version_no: number;
  latest_status: string;
  filename: string;
  size_bytes: number | null;
  page_count: number | null;
  chunk_count: number | null;
  error_code: string | null;
  updated_at: string;
  /** Conector de origen (CON-01) o null si se subió a mano. */
  source_provider?: "gmail" | "slack" | "clickup" | null;
}

const SOURCE_NAMES = { gmail: "Gmail", slack: "Slack", clickup: "ClickUp" } as const;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
};
const PENDING = new Set(["pending_upload", "uploaded", "quarantined", "validated", "parsing", "enriched", "embedding"]);
// Everything between upload and "ready" is one step for people: the file is being prepared.
const STATUS_LABEL: Record<string, string> = {
  pending_upload: "Upload not finished",
  uploaded: "Processing",
  quarantined: "Safety check",
  validated: "Processing",
  parsing: "Reading text",
  enriched: "Processing",
  embedding: "Almost ready",
};

function statusBadge(s: string) {
  if (s === "indexed")
    return (
      <span className="badge ok">
        <span className="dot" />
        Ready
      </span>
    );
  if (s === "rejected" || s === "failed")
    return (
      <span className="badge err">
        <span className="dot" />
        {s === "rejected" ? "Not accepted" : "Failed"}
      </span>
    );
  return (
    <span className="badge warn">
      <span className="dot" />
      {STATUS_LABEL[s] ?? s}
    </span>
  );
}

const ext = (filename: string) => filename.split(".").pop()?.toLowerCase() ?? "";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(s)) return "—";
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [2629800, "week"],
    [31557600, "month"],
  ];
  if (Math.abs(s) < 45) return "just now";
  let prev = 1;
  for (const [limit, unit] of steps) {
    if (Math.abs(s) < limit) return rtf.format(Math.round(s / prev), unit);
    prev = limit;
  }
  return rtf.format(Math.round(s / 31557600), "year");
}

type View = "all" | "indexed" | "pending" | "failed";
type Listing = { orgId: string; workspaceId: string; filter: string; docs: Doc[] | null; error?: Error };
const DOCUMENT_COLUMNS = ["", "", "hide-sm", "num hide-sm", "num hide-sm", "hide-md", ""];

function LibrarySkeleton({ hasDocuments }: { hasDocuments: boolean | undefined }) {
  if (hasDocuments === undefined) {
    return <SkeletonStatus label="Loading documents…">{null}</SkeletonStatus>;
  }

  if (hasDocuments) {
    return (
      <SkeletonStatus label="Loading documents…" className="stack library-list-skeleton">
        <div className="drop compact library-skeleton">
          <Skel w={34} h={34} r={999} />
          <span className="drop-text" style={{ minWidth: 0 }}>
            <Skel className="lead" w={154} h={14} style={{ marginBlock: 4 }} />
            <span><Skel w={384} h={12} style={{ marginBlock: 4 }} /></span>
          </span>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="toolbar">
            <div className="seg library-skeleton library-skeleton-filters">
              {[42, 56, 68, 46].map((width) => <Skel key={width} w={width} h={12} />)}
            </div>
            <div className="search" style={{ width: 260, maxWidth: "100%" }}>
              <Skel h={38} r={999} />
            </div>
          </div>
          <SkeletonTable rows={5} columns={DOCUMENT_COLUMNS} leading="file" />
        </div>
      </SkeletonStatus>
    );
  }

  return (
    <SkeletonStatus label="Loading documents…" className="drop hero library-skeleton">
      <Skel w={196} h={119} r={16} />
      <Skel w={284} h={17} style={{ marginBlock: 4 }} />
      <Skel w={410} h={13} style={{ marginBlock: 4 }} />
      <Skel w={110} h={36} r={12} style={{ marginTop: 10 }} />
      <Skel w={370} h={11} style={{ marginBlock: "8px 4px" }} />
      <div className="pipeline" aria-hidden="true">
        {[118, 94, 102].map((width) => (
          <div className="library-skeleton-step" key={width}>
            <Skel w={20} h={20} r={999} />
            <Skel w={width} h={11} style={{ flexShrink: 1 }} />
          </div>
        ))}
      </div>
    </SkeletonStatus>
  );
}

export default function LibraryPage() {
  const { org: orgId } = useParams<{ org: string }>();
  const { loading: loadingOrg, workspaceId, workspaces, setWorkspaceHasDocuments } = useOrg();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const wsName = workspace?.name;
  const confirm = useConfirm();
  const [listing, setListing] = useState<Listing>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [filters, setFilters] = useState({ orgId, workspaceId, title: "", view: "all" as View });
  if (filters.orgId !== orgId || filters.workspaceId !== workspaceId) {
    setFilters({ orgId, workspaceId, title: "", view: "all" });
  }
  const { title: filter, view } = filters;
  const workspaceListing = listing?.orgId === orgId && listing.workspaceId === workspaceId ? listing : undefined;
  const filteredListing = workspaceListing?.filter === filter ? workspaceListing : undefined;
  const docs = filteredListing?.docs;
  const listError = filteredListing?.error;
  const errorKind = docs === null ? requestErrorKind(listError) : null;
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const r = await api<{ documents: Doc[] }>(
          `organizations/${orgId}/documents?workspace_id=${workspaceId}${filter ? `&q=${encodeURIComponent(filter)}` : ""}`,
        );
        if (!active) return;
        setListing({ orgId, workspaceId, filter, docs: r.documents });
        if (!filter || r.documents.length > 0) {
          setWorkspaceHasDocuments(workspaceId, r.documents.length > 0);
        }
        pending = r.documents.some((d) => PENDING.has(d.latest_status));
      } catch (e) {
        if (!active) return;
        setListing((current) => ({
          orgId,
          workspaceId,
          filter,
          docs: current?.orgId === orgId && current.workspaceId === workspaceId && current.filter === filter ? current.docs : null,
          error: e as Error,
        }));
      }
      if (pending) timer = setTimeout(load, 2500);
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [orgId, workspaceId, filter, revision, setWorkspaceHasDocuments]);

  async function uploadOne(file: File) {
    const contentType = TYPES[ext(file.name)];
    if (!contentType) throw new Error(`${file.name}: this file type isn't supported`);
    const start = await api<{ document_id: string; version_id: string; upload: { url: string; headers: Record<string, string> } }>(
      `organizations/${orgId}/documents/uploads`,
      { method: "POST", body: { workspace_id: workspaceId, filename: file.name, content_type: contentType, size_bytes: file.size, title: file.name.replace(/\.[^.]+$/, "") } },
    );
    // Direct browser → S3 upload via presigned URL; the file never passes through the API.
    const put = await fetch(start.upload.url, { method: "PUT", headers: start.upload.headers, body: file });
    if (!put.ok) throw new Error(`${file.name}: upload failed — check your connection and try again`);
    await api(`organizations/${orgId}/documents/${start.document_id}/versions/${start.version_id}/complete`, { method: "POST" });
  }

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    for (const f of Array.from(files)) {
      setUploading((u) => [...u, f.name]);
      try {
        await uploadOne(f);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
    setRevision((value) => value + 1);
  }

  const openDoc = (d: Doc) => setViewing({ documentId: d.id, versionId: d.latest_version_id, title: d.title, filename: d.filename });
  const closeDoc = useCallback(() => setViewing(null), []);

  async function remove(d: Doc) {
    const ok = await confirm({
      title: `Delete "${d.title}"?`,
      body: "It will no longer be used in answers. This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`organizations/${orgId}/documents/${d.id}`, { method: "DELETE" });
      setRevision((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const all = docs ?? [];
  const counts = {
    all: all.length,
    indexed: all.filter((d) => d.latest_status === "indexed").length,
    pending: all.filter((d) => PENDING.has(d.latest_status)).length,
    failed: all.filter((d) => d.latest_status === "rejected" || d.latest_status === "failed").length,
  };
  const shown = all.filter((d) =>
    view === "all"
      ? true
      : view === "indexed"
        ? d.latest_status === "indexed"
        : view === "pending"
          ? PENDING.has(d.latest_status)
          : d.latest_status === "rejected" || d.latest_status === "failed",
  );
  const loadingDocs = loadingOrg || (!!workspaceId && docs === undefined);
  const blank = docs?.length === 0 && !filter;
  const hasListing = workspaceListing?.docs != null;
  const showToolbar = !blank && (hasListing || (!!workspaceId && !!filter));
  const loadingLayout = loadingDocs && !showToolbar;
  const loadingHasDocuments = loadingOrg ? undefined : workspace?.has_documents ?? true;
  const alert = error ?? (errorKind ? null : listError?.message);
  const browse = () => fileRef.current?.click();

  function dismissAlert() {
    if (error) setError(null);
    else setListing((current) => current && { ...current, error: undefined });
  }

  function retryListing() {
    setListing(undefined);
    setRevision((value) => value + 1);
  }

  // The whole page is a drop target; the drop zone only shows where it lands.
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragDepth.current++;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && e.preventDefault(),
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setOver(false);
      if (!errorKind && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    },
  };

  return (
    <div className="page" {...dragProps}>
      <header className="page-bar">
        <PageBreadcrumbs section="Library" context={wsName} icon={IconFolder} />
        {loadingLayout && loadingHasDocuments && (
          <Skel className="library-skeleton-upload" w="var(--library-upload-width, 115px)" h={30} r={12} />
        )}
        {workspaceId && !blank && !errorKind && (!loadingDocs || hasListing) && (
          <button type="button" className="primary small" onClick={browse}>
            <IconUpload size={15} />
            Upload files
          </button>
        )}
      </header>

      <div className="main">
        <header className="page-head">
          <div>
            <h1>Library</h1>
            <p className="sub">Documents are used in answers once they show as Ready.</p>
          </div>
        </header>

        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.md,.markdown,.txt,.csv,.html,.htm" onChange={(e) => e.target.files && handleFiles(e.target.files)} />

        <div className="stack" style={{ gap: 20 }}>
          {loadingLayout && <LibrarySkeleton hasDocuments={loadingHasDocuments} />}
          {blank ? (
            <div className={`drop hero${over ? " over" : ""}`}>
              <StateIllustration kind="empty" />
              <span className="lead">{over ? "Drop to upload" : `Upload your first document${wsName ? ` to ${wsName}` : ""}`}</span>
              <span>Drag files anywhere on this page or choose them from your computer.</span>
              <button type="button" className="ghost" onClick={browse} disabled={!workspaceId}>
                Choose files
              </button>
              <span className="formats">PDF · DOCX · PPTX · XLSX · PNG/JPEG · Markdown · TXT · CSV · HTML</span>
              <ol className="pipeline" aria-label="What happens on upload">
                <li>
                  <span>1</span>Uploaded and validated
                </li>
                <li>
                  <span>2</span>We read the text
                </li>
                <li>
                  <span>3</span>Ready to answer questions
                </li>
              </ol>
            </div>
          ) : hasListing && (
            <div className={`drop compact${over ? " over" : ""}`}>
              <span className="up">
                <IconUpload size={17} variant={over ? "duotone" : "stroke"} />
              </span>
              <span className="drop-text">
                <span className="lead">
                  {over ? (
                    "Drop to upload"
                  ) : (
                    <>
                      Drop files here or{" "}
                      <button type="button" className="link" onClick={browse}>
                        browse
                      </button>
                    </>
                  )}
                </span>
                <span>PDF, DOCX, PPTX, XLSX, PNG/JPEG, Markdown, TXT, CSV or HTML</span>
              </span>
            </div>
          )}

          {uploading.length > 0 && (
            <div className="uploads">
              {uploading.map((n) => (
                <div key={n} className="upload-row">
                  <IconSpinner size={15} />
                  <span className="t-shimmer" data-text={`Uploading ${n}`}>
                    Uploading {n}
                  </span>
                </div>
              ))}
            </div>
          )}

          {alert && (
            <div className="alert" role="alert">
              <IconAlert size={16} />
              <span style={{ flex: 1 }}>{alert}</span>
              <button type="button" className="quiet icon small" onClick={dismissAlert} aria-label="Dismiss">
                <IconX size={14} />
              </button>
            </div>
          )}

          {(showToolbar || errorKind) && (
            <section className="stack" style={{ gap: 12 }}>
              {showToolbar && <div className="toolbar">
                <Seg role="group" aria-label="Filter by status">
                  {(
                    [
                      ["all", "All", counts.all],
                      ["indexed", "Ready", counts.indexed],
                      ["pending", "Processing", counts.pending],
                      ["failed", "Errors", counts.failed],
                    ] as const
                  ).map(([k, label, n]) => (
                    <button key={k} type="button" aria-pressed={view === k} onClick={() => setFilters({ ...filters, view: k })} data-kind={k}>
                      {label}
                      {loadingDocs ? <Skel w={16} h={13} r={999} /> : <span className="count"><SoftText text={String(n)} /></span>}
                    </button>
                  ))}
                </Seg>
                <div className={`search${filter ? " has-value" : ""}`}>
                  <IconSearch size={15} />
                  <input placeholder="Filter by title" value={filter} onChange={(e) => setFilters({ ...filters, title: e.target.value })} aria-label="Filter by title" />
                  <button type="button" className="quiet icon small clear" onClick={() => setFilters({ ...filters, title: "" })} aria-label="Clear filter" tabIndex={filter ? 0 : -1}>
                    <IconX size={14} />
                  </button>
                </div>
              </div>}

              {errorKind && (
                <AppErrorState kind={errorKind} backHref={`/app/${orgId}/ask`} backLabel="Back to Ask" onRetry={retryListing} />
              )}
              {loadingDocs && (
                <SkeletonStatus label="Loading documents…">
                  <SkeletonTable rows={5} columns={DOCUMENT_COLUMNS} leading="file" />
                </SkeletonStatus>
              )}
              {docs != null && <div className="table-card">
                {shown.length === 0 ? (
                  <div className="empty">
                    <span className="bubble">
                      <IconSearch size={20} />
                    </span>
                    <strong>{filter ? "No titles match" : "Nothing in this status"}</strong>
                    <span>{filter ? "Try a different word from the title." : "Change the filter to see the rest of the documents."}</span>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Status</th>
                          <th className="hide-sm">Version</th>
                          <th className="num hide-sm">Size</th>
                          <th className="num hide-sm">Pages</th>
                          <th className="hide-md">Updated</th>
                          <th>
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((d) => (
                          <tr key={d.id}>
                            <td>
                              <div className="cell-title">
                                <FileTile ext={ext(d.filename)} />
                                <div style={{ minWidth: 0 }}>
                                  {d.latest_status === "indexed" ? (
                                    <button type="button" className="link doc-open" onClick={() => openDoc(d)}>
                                      {d.title}
                                    </button>
                                  ) : (
                                    <strong>{d.title}</strong>
                                  )}
                                  <div className="mono">
                                    {d.source_provider && <span className="doc-source">From {SOURCE_NAMES[d.source_provider]} · </span>}
                                    {d.filename}
                                  </div>
                                  {d.error_code && (
                                    <span className="badge err" style={{ marginTop: 4 }}>
                                      {docError(d.error_code)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td>{statusBadge(d.latest_status)}</td>
                            <td className="muted hide-sm">v{d.version_no}</td>
                            <td className="num hide-sm">{formatBytes(d.size_bytes)}</td>
                            <td className="num hide-sm">{d.page_count ?? "—"}</td>
                            <td className="muted hide-md nowrap">{ago(d.updated_at)}</td>
                            <td className="actions">
                              {d.latest_status === "indexed" && (
                                <button type="button" className="quiet icon" onClick={() => openDoc(d)} aria-label={`Open ${d.title}`} data-tip="Open" data-tip-side="end">
                                  <IconEye size={16} />
                                </button>
                              )}
                              <button type="button" className="danger icon" onClick={() => remove(d)} aria-label={`Delete ${d.title}`} data-tip="Delete" data-tip-side="end">
                                <IconTrash size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>}
            </section>
          )}
        </div>
      </div>
      <DocViewer doc={viewing} orgId={orgId} onClose={closeDoc} />
    </div>
  );
}
