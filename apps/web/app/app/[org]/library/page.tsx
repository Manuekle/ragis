"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { useOrg } from "../layout";
import { AppErrorState, StateIllustration, requestErrorKind } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { IconAlert, IconChevronRight, IconEdit, IconEye, IconFolder, IconPlus, IconSearch, IconSparkles, IconTrash, IconUpload, IconX } from "@/components/icons";
import { FolderDrop, stageOf, UploadTracker, type UploadItem } from "@/components/UploadDrop";
import { Skel, SkeletonStatus, SkeletonTable } from "@/components/skeletons";
import { Select, TextField, useConfirm } from "@/components/ui";
import { clock } from "@/components/AudioView";
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
  folder_id: string | null;
  /** Recordings: length in seconds. */
  duration_seconds?: number | null;
}

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  document_count: number;
}
interface Suggestion {
  document_id: string;
  folder_id: string;
  folder_name: string;
  reason: "similar_content" | "name_match";
}
/** Which documents the list shows: everything, the ones without a folder, or one folder. */
type FolderView = "all" | "none" | string;

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
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
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

const READ_ERRORS = new Set(["no_extractable_text", "ocr_required", "transcription_required", "no_speech_detected", "audio_too_long"]);

/** Move uploads that are indexing to "Indexed" (or "failed") once the listing reports it. */
function trackIndexing(list: UploadItem[], docs: Doc[]): UploadItem[] {
  if (!list.some((u) => u.phase === "indexing")) return list;
  const byId = new Map(docs.map((d) => [d.id, d]));
  return list.map((u) => {
    const d = u.phase === "indexing" && u.docId ? byId.get(u.docId) : undefined;
    if (!d) return u;
    if (d.latest_status === "indexed") return { ...u, phase: "ready", stage: 3 };
    if (d.latest_status === "rejected" || d.latest_status === "failed") {
      // Rejected files stop at the safety check; text that can't be pulled out stops at the reading step.
      const stage = d.latest_status === "rejected" ? 1 : READ_ERRORS.has(d.error_code ?? "") ? 2 : Math.max(u.stage, 2);
      return { ...u, phase: "failed", stage, error: docError(d.error_code ?? "", d.filename) };
    }
    const stage = Math.max(u.stage, stageOf(d.latest_status));
    return stage === u.stage ? u : { ...u, stage };
  });
}

type View = "all" | "indexed" | "pending" | "failed";
type Listing = { orgId: string; workspaceId: string; filter: string; folder: FolderView; docs: Doc[] | null; error?: Error };

/** "Legal / Contracts": the folder's full path, for menus and the document's subtitle. */
function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  for (let cur = id ? byId.get(id) : undefined; cur && path.length < 8; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) path.unshift(cur);
  return path;
}
const pathLabel = (folders: Folder[], id: string | null) => folderPath(folders, id).map((f) => f.name).join(" / ");

/** Small form dialog (same surface as the confirm dialog). Esc or a click outside cancels. */
function FormDialog({ title, description, submitLabel, busy, onSubmit, onClose, children }: { title: string; description?: string; submitLabel: string; busy: boolean; onSubmit: () => void; onClose: () => void; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className={`dialog-layer${shown ? " is-open" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
          <IconX size={16} />
        </button>
        <span className="dialog-icon">
          <IconFolder size={20} variant="duotone" />
        </span>
        <h2>{title}</h2>
        {description && <p className="dialog-desc">{description}</p>}
        {children}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy} aria-busy={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
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
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [over, setOver] = useState(false);
  const [filters, setFilters] = useState({ orgId, workspaceId, title: "", view: "all" as View, folder: "all" as FolderView });
  if (filters.orgId !== orgId || filters.workspaceId !== workspaceId) {
    setFilters({ orgId, workspaceId, title: "", view: "all", folder: "all" });
  }
  const { title: filter, view, folder: folderView } = filters;
  const [tree, setTree] = useState<{ workspaceId: string; folders: Folder[]; unfiled: number }>();
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [naming, setNaming] = useState<{ mode: "create" | "rename"; value: string; error?: string } | null>(null);
  const [moving, setMoving] = useState<{ doc: Doc; target: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = useMemo(() => (tree?.workspaceId === workspaceId ? tree.folders : []), [tree, workspaceId]);
  const currentFolder = folders.find((f) => f.id === folderView);
  const workspaceListing = listing?.orgId === orgId && listing.workspaceId === workspaceId ? listing : undefined;
  const filteredListing = workspaceListing?.filter === filter && workspaceListing.folder === folderView ? workspaceListing : undefined;
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
          `organizations/${orgId}/documents?workspace_id=${workspaceId}${filter ? `&q=${encodeURIComponent(filter)}` : ""}${folderView !== "all" ? `&folder_id=${folderView}` : ""}`,
        );
        if (!active) return;
        setListing({ orgId, workspaceId, filter, folder: folderView, docs: r.documents });
        setUploads((list) => trackIndexing(list, r.documents));
        if (folderView === "all" && (!filter || r.documents.length > 0)) {
          setWorkspaceHasDocuments(workspaceId, r.documents.length > 0);
        }
        pending = r.documents.some((d) => PENDING.has(d.latest_status));
      } catch (e) {
        if (!active) return;
        setListing((current) => ({
          orgId,
          workspaceId,
          filter,
          folder: folderView,
          docs: current?.orgId === orgId && current.workspaceId === workspaceId && current.filter === filter && current.folder === folderView ? current.docs : null,
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
  }, [orgId, workspaceId, filter, folderView, revision, setWorkspaceHasDocuments]);

  // Folders and, for documents without one, the folder suggested from their content. Neither blocks the list.
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    api<{ folders: Folder[]; unfiled_count: number }>(`organizations/${orgId}/folders?workspace_id=${workspaceId}`)
      .then((r) => active && setTree({ workspaceId, folders: r.folders, unfiled: r.unfiled_count }))
      .catch(() => undefined);
    api<{ suggestions: Suggestion[] }>(`organizations/${orgId}/documents/folder-suggestions?workspace_id=${workspaceId}`)
      .then((r) => active && setSuggestions(Object.fromEntries(r.suggestions.map((s) => [s.document_id, s]))))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [orgId, workspaceId, revision, listing?.docs]);

  const patchUpload = (key: string, patch: Partial<UploadItem>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  async function uploadOne(file: File, key: string) {
    const contentType = TYPES[ext(file.name)];
    if (!contentType) throw new Error("This file type isn't supported");
    const start = await api<{ document_id: string; version_id: string; upload: { url: string; headers: Record<string, string> } }>(
      `organizations/${orgId}/documents/uploads`,
      { method: "POST", body: { workspace_id: workspaceId, filename: file.name, content_type: contentType, size_bytes: file.size, title: file.name.replace(/\.[^.]+$/, ""), ...(currentFolder ? { folder_id: currentFolder.id } : {}) } },
    );
    // Direct browser → S3 upload via presigned URL; the file never passes through the API.
    // XHR rather than fetch: it is the only browser API that reports upload progress.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", start.upload.url);
      for (const [k, v] of Object.entries(start.upload.headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && patchUpload(key, { progress: e.loaded / e.total });
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed — check your connection and try again")));
      xhr.onerror = () => reject(new Error("Upload failed — check your connection and try again"));
      xhr.send(file);
    });
    await api(`organizations/${orgId}/documents/${start.document_id}/versions/${start.version_id}/complete`, { method: "POST" });
    return start.document_id;
  }

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    const batch = Array.from(files).map((f) => ({ file: f, key: `${f.name}-${f.size}-${crypto.randomUUID()}` }));
    setUploads((list) => [
      ...list.filter((u) => !u.leaving),
      ...batch.map(({ file, key }) => ({
        key,
        name: file.name,
        size: file.size,
        ext: ext(file.name),
        phase: "uploading" as const,
        stage: 0,
        progress: 0,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ]);
    for (const { file, key } of batch) {
      try {
        const docId = await uploadOne(file, key);
        patchUpload(key, { phase: "indexing", stage: 1, progress: 1, docId });
        // Refresh now so the list shows the file and starts polling its status.
        setRevision((value) => value + 1);
      } catch (e) {
        patchUpload(key, { phase: "failed", error: (e as Error).message });
      }
    }
  }

  const dismissUploads = useCallback((keys: string[]) => {
    const gone = new Set(keys);
    setUploads((list) => list.map((u) => (gone.has(u.key) ? { ...u, leaving: true } : u)));
    setTimeout(
      () =>
        setUploads((list) =>
          list.filter((u) => {
            if (!gone.has(u.key)) return true;
            if (u.preview) URL.revokeObjectURL(u.preview);
            return false;
          }),
        ),
      360,
    );
  }, []);
  const dismissUpload = useCallback((key: string) => dismissUploads([key]), [dismissUploads]);

  // Rows stay together until the whole batch settles, so the counts never jump; then the indexed
  // ones fold away. Files that couldn't be added stay until they are dismissed.
  const settledKey = uploads.some((u) => u.phase === "uploading" || u.phase === "indexing")
    ? ""
    : uploads.filter((u) => u.phase === "ready" && !u.leaving).map((u) => u.key).join(",");
  useEffect(() => {
    if (!settledKey) return;
    const t = setTimeout(() => dismissUploads(settledKey.split(",")), 3200);
    return () => clearTimeout(t);
  }, [settledKey, dismissUploads]);

  async function removeUpload(it: UploadItem) {
    if (!it.docId) return dismissUpload(it.key);
    const ok = await confirm({
      title: `Delete "${it.name}"?`,
      body: "It couldn't be added, so it isn't used in answers. This removes it from the library.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`organizations/${orgId}/documents/${it.docId}`, { method: "DELETE" });
      dismissUpload(it.key);
      setRevision((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    }
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

  const refresh = () => setRevision((value) => value + 1);
  const goFolder = (folder: FolderView) => setFilters({ ...filters, folder, view: "all" });

  async function saveFolderName() {
    if (!naming || !workspaceId) return;
    const name = naming.value.trim();
    if (!name) return setNaming({ ...naming, error: "Give the folder a name." });
    setBusy(true);
    try {
      if (naming.mode === "create") {
        await api(`organizations/${orgId}/folders`, { method: "POST", body: { workspace_id: workspaceId, name, ...(currentFolder ? { parent_id: currentFolder.id } : {}) } });
      } else if (currentFolder) {
        await api(`organizations/${orgId}/folders/${currentFolder.id}`, { method: "PATCH", body: { name } });
      }
      setNaming(null);
      refresh();
    } catch (e) {
      setNaming({ ...naming, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function removeFolder(f: Folder) {
    const ok = await confirm({
      title: `Delete the folder "${f.name}"?`,
      body: "Folders inside it are deleted too. No document is deleted: they go back to “No folder”.",
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`organizations/${orgId}/folders/${f.id}`, { method: "DELETE" });
      goFolder(f.parent_id ?? "all");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function moveTo(docIds: string[], folderId: string | null) {
    setBusy(true);
    try {
      await api(`organizations/${orgId}/documents/move`, { method: "POST", body: { document_ids: docIds, folder_id: folderId } });
      setMoving(null);
      refresh();
    } catch (e) {
      setMoving(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function dismissSuggestion(d: Doc) {
    setSuggestions(({ [d.id]: _gone, ...rest }) => rest);
    try {
      await api(`organizations/${orgId}/documents/${d.id}/folder-suggestion/dismiss`, { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const trail = folderPath(folders, currentFolder?.id ?? null);
  const childFolders = folders.filter((f) => (currentFolder ? f.parent_id === currentFolder.id : f.parent_id === null));
  const folderOptions = [
    { value: "none", label: "No folder" },
    ...folders.map((f) => ({ value: f.id, label: pathLabel(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label)),
  ];

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
  const blank = docs?.length === 0 && !filter && folderView === "all" && folders.length === 0;
  const hasListing = workspaceListing?.docs != null;
  const showToolbar = !blank && (hasListing || (!!workspaceId && (!!filter || folderView !== "all")));
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

        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.md,.markdown,.txt,.csv,.html,.htm,.mp3,.wav,.m4a,.ogg,.flac" onChange={(e) => e.target.files && handleFiles(e.target.files)} />

        <div className="stack" style={{ gap: 20 }}>
          {loadingLayout && <LibrarySkeleton hasDocuments={loadingHasDocuments} />}
          {blank ? (
            <div className={`drop hero${over ? " over" : ""}`}>
              <span className="drop-glow" aria-hidden="true" />
              <FolderDrop size={96} open={over} />
              <span className="lead">{over ? "Drop to upload" : `Upload your first document${wsName ? ` to ${wsName}` : ""}`}</span>
              <span>Drag files anywhere on this page or choose them from your computer.</span>
              <button type="button" className="ghost" onClick={browse} disabled={!workspaceId}>
                Choose files
              </button>
              <span className="formats">PDF · DOCX · PPTX · XLSX · PNG/JPEG · Markdown · TXT · CSV · HTML · Audio (MP3, WAV, M4A)</span>
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
              <span className="drop-glow" aria-hidden="true" />
              <FolderDrop size={44} open={over} />
              <span className="drop-text">
                <span className="lead">
                  {over ? (
                    "Drop to upload"
                  ) : (
                    <>Drop files {currentFolder ? `into ${currentFolder.name}` : "here"}</>
                  )}
                </span>
                <span>PDF, DOCX, PPTX, XLSX, PNG/JPEG, Markdown, TXT, CSV, HTML or audio recordings</span>
              </span>
              <button type="button" className="ghost small drop-cta" onClick={browse}>
                <IconUpload size={15} />
                Choose files
              </button>
            </div>
          )}

          <UploadTracker items={uploads} onDismiss={dismissUpload} onRemove={removeUpload} />

          {alert && (
            <div className="alert" role="alert">
              <IconAlert size={16} />
              <span style={{ flex: 1 }}>{alert}</span>
              <button type="button" className="quiet icon small" onClick={dismissAlert} aria-label="Dismiss">
                <IconX size={14} />
              </button>
            </div>
          )}

          {showToolbar && tree?.workspaceId === workspaceId && (
            <nav className="folder-bar" aria-label="Folders">
              <div className="folder-trail">
                <button type="button" className="folder-crumb" aria-current={folderView === "all" ? "page" : undefined} onClick={() => goFolder("all")}>
                  All files
                </button>
                {folderView === "none" && (
                  <>
                    <IconChevronRight size={14} />
                    <span className="folder-crumb" aria-current="page">No folder</span>
                  </>
                )}
                {trail.map((f, i) => (
                  <span key={f.id} className="folder-step">
                    <IconChevronRight size={14} />
                    <button type="button" className="folder-crumb" aria-current={i === trail.length - 1 ? "page" : undefined} onClick={() => goFolder(f.id)}>
                      {f.name}
                    </button>
                  </span>
                ))}
                <span className="folder-tools">
                  {currentFolder && (
                    <>
                      <button type="button" className="quiet icon small" onClick={() => setNaming({ mode: "rename", value: currentFolder.name })} aria-label={`Rename ${currentFolder.name}`} data-tip="Rename folder">
                        <IconEdit size={15} />
                      </button>
                      <button type="button" className="quiet icon small" onClick={() => removeFolder(currentFolder)} aria-label={`Delete ${currentFolder.name}`} data-tip="Delete folder">
                        <IconTrash size={15} />
                      </button>
                    </>
                  )}
                  {folderView !== "none" && (
                    <button type="button" className="ghost small" onClick={() => setNaming({ mode: "create", value: "" })}>
                      <IconPlus size={14} />
                      New folder
                    </button>
                  )}
                </span>
              </div>
              {folderView !== "none" && (childFolders.length > 0 || (folderView === "all" && folders.length > 0)) && (
                <div className="folder-chips">
                  {childFolders.map((f) => (
                    <button key={f.id} type="button" className="folder-chip" onClick={() => goFolder(f.id)}>
                      <IconFolder size={15} />
                      <span className="name">{f.name}</span>
                      <span className="count">{f.document_count}</span>
                    </button>
                  ))}
                  {folderView === "all" && tree.unfiled > 0 && (
                    <button type="button" className="folder-chip plain" onClick={() => goFolder("none")}>
                      <span className="name">No folder</span>
                      <span className="count">{tree.unfiled}</span>
                    </button>
                  )}
                </div>
              )}
            </nav>
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
                    <StateIllustration kind="empty" />
                    <strong>{filter ? "No titles match" : all.length === 0 && folderView !== "all" ? "No documents here yet" : "Nothing in this status"}</strong>
                    <span>
                      {filter
                        ? "Try a different word from the title."
                        : all.length === 0 && folderView !== "all"
                          ? "Drop files on this page to upload them here, or move documents in from All files."
                          : "Change the filter to see the rest of the documents."}
                    </span>
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
                                    {d.duration_seconds != null && ` · ${clock(d.duration_seconds)}`}
                                    {folderView === "all" && d.folder_id && pathLabel(folders, d.folder_id) && ` · in ${pathLabel(folders, d.folder_id)}`}
                                  </div>
                                  {!d.folder_id && suggestions[d.id] && (
                                    <div className="folder-hint">
                                      <IconSparkles size={13} />
                                      <span>
                                        Looks like it belongs in <strong>{pathLabel(folders, suggestions[d.id]!.folder_id) || suggestions[d.id]!.folder_name}</strong>
                                      </span>
                                      <button type="button" className="link" disabled={busy} onClick={() => moveTo([d.id], suggestions[d.id]!.folder_id)}>
                                        Move there
                                      </button>
                                      <button type="button" className="link subtle" onClick={() => dismissSuggestion(d)}>
                                        No thanks
                                      </button>
                                    </div>
                                  )}
                                  {d.error_code && (
                                    <span className="badge err doc-error">
                                      {docError(d.error_code, d.filename)}
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
                              <button type="button" className="quiet icon" onClick={() => setMoving({ doc: d, target: d.folder_id ?? "none" })} aria-label={`Move ${d.title} to a folder`} data-tip="Move to folder" data-tip-side="end">
                                <IconFolder size={16} />
                              </button>
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
      {naming && (
        <FormDialog title={naming.mode === "create" ? (currentFolder ? `New folder in ${currentFolder.name}` : "New folder") : "Rename folder"} description={naming.mode === "create" ? "Group related documents so they're easier to find." : "Give this folder a name people will recognize."} submitLabel={naming.mode === "create" ? "Create folder" : "Save"} busy={busy} onSubmit={saveFolderName} onClose={() => setNaming(null)}>
          <TextField label="Name" value={naming.value} maxLength={120} autoFocus error={naming.error} onChange={(e) => setNaming({ mode: naming.mode, value: e.target.value })} />
        </FormDialog>
      )}
      {moving && (
        <FormDialog title={`Move "${moving.doc.title}"`} submitLabel="Move" busy={busy} onSubmit={() => moveTo([moving.doc.id], moving.target === "none" ? null : moving.target)} onClose={() => setMoving(null)}>
          <p className="muted">Folders only organize the library. Moving a document doesn't change who can see it.</p>
          <Select ariaLabel="Folder" value={moving.target} onChange={(target) => setMoving({ doc: moving.doc, target })} options={folderOptions} />
        </FormDialog>
      )}
    </div>
  );
}
