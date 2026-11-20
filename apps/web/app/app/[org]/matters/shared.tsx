"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { FormDialog } from "@/components/FormDialog";
import { IconBriefcase } from "@/components/icons";
import { Select, TextField } from "@/components/ui";
import { tNow, useT } from "@/lib/use-t";

/**
 * Expedientes (matters, ADR-037): a record of the firm per client and case that groups documents from any space.
 * Linking a document never changes who can read it; the record itself (client, counterparty, filing number) is
 * visible to everyone in the organization.
 */

export type MatterStatus = "active" | "on_hold" | "closed" | "archived";
export const MATTER_STATUSES: MatterStatus[] = ["active", "on_hold", "closed", "archived"];

export interface Person {
  id: string;
  name: string;
}

export interface Matter {
  id: string;
  title: string;
  client_name: string;
  counterparty: string | null;
  case_number: string | null;
  court: string | null;
  stage: string | null;
  status: MatterStatus;
  owner: Person | null;
  document_count: number;
  last_document_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  can_delete: boolean;
}

export interface MatterDocument {
  id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
  folder_id: string | null;
  folder_name: string | null;
  updated_at: string;
  latest_version_id: string | null;
  filename: string | null;
  latest_status: string | null;
}

export interface MatterDetail extends Matter {
  can_edit: boolean;
  documents: MatterDocument[];
}

export interface MatterList {
  matters: Matter[];
  people: Person[];
  can_edit: boolean;
}

export const STATUS_LABEL = (): Record<MatterStatus, string> => ({
  active: tNow("Active"),
  on_hold: tNow("On hold"),
  closed: tNow("Closed"),
  archived: tNow("Archived"),
});

/** Usual procedural stages, offered as suggestions; the field stays free text. */
export const STAGE_SUGGESTIONS = () => [
  tNow("Filing"),
  tNow("Admission"),
  tNow("Service of process"),
  tNow("Answer to the claim"),
  tNow("Initial hearing"),
  tNow("Evidence"),
  tNow("Closing arguments"),
  tNow("Judgment"),
  tNow("Appeal"),
  tNow("Second instance"),
  tNow("Enforcement"),
];

export function StatusPill({ status }: { status: MatterStatus }) {
  const t = useT();
  const tone = status === "active" ? "ok" : status === "on_hold" ? "accent" : "";
  return <span className={`badge matter-status${tone ? ` ${tone}` : ""}`} data-status={status}>{t(STATUS_LABEL()[status])}</span>;
}

/** Ask, limited to this expediente (ADR-037). */
export const askInMatterHref = (orgId: string, matterId: string) => `/app/${orgId}/ask?scope=matter:${matterId}`;

/** "Juan Felipe Parra Rosas · D-16.857": who and which case, for subtitles and menus. */
export const matterSubtitle = (m: Pick<Matter, "client_name" | "case_number">) => [m.client_name, m.case_number].filter(Boolean).join(" · ");

/** The organization's expedientes, the people who can be responsible for one, and whether this person can edit. */
export function useMatters(orgId: string) {
  const [data, setData] = useState<MatterList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<MatterList>(`organizations/${orgId}/matters`));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, [orgId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

interface FormState {
  client_name: string;
  title: string;
  counterparty: string;
  case_number: string;
  court: string;
  stage: string;
  owner_id: string;
  status: MatterStatus;
}

const blank: FormState = { client_name: "", title: "", counterparty: "", case_number: "", court: "", stage: "", owner_id: "", status: "active" };

/** Fields of an expediente as the API takes them (empty strings clear optional fields). */
function payload(f: FormState) {
  return {
    client_name: f.client_name.trim(),
    ...(f.title.trim() ? { title: f.title.trim() } : {}),
    counterparty: f.counterparty.trim() || null,
    case_number: f.case_number.trim() || null,
    court: f.court.trim() || null,
    stage: f.stage.trim() || null,
    owner_id: f.owner_id || null,
    status: f.status,
  };
}

/**
 * Create or edit an expediente. With `folder`, creates it from that library folder and links the folder's documents
 * (and its subfolders') to it; the folder stays where it is.
 */
export function MatterDialog({
  orgId,
  people,
  matter,
  folder,
  initial,
  onClose,
  onSaved,
}: {
  orgId: string;
  people: Person[];
  matter?: Matter | null;
  folder?: { id: string; name: string } | null;
  initial?: Partial<FormState>;
  onClose: () => void;
  onSaved: (m: Matter, info?: { linked: number; skipped: number }) => void;
}) {
  const t = useT();
  const stagesId = useId();
  const [f, setF] = useState<FormState>(() =>
    matter
      ? {
          client_name: matter.client_name,
          title: matter.title,
          counterparty: matter.counterparty ?? "",
          case_number: matter.case_number ?? "",
          court: matter.court ?? "",
          stage: matter.stage ?? "",
          owner_id: matter.owner?.id ?? "",
          status: matter.status,
        }
      : { ...blank, title: folder?.name ?? "", ...initial },
  );
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ client?: string; case_number?: string; form?: string }>({});
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  async function submit() {
    if (!f.client_name.trim()) {
      setErrors({ client: t("Enter the client's name.") });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      if (matter) {
        const body = { ...payload(f), title: f.title.trim() || matter.title };
        onSaved(await api<Matter>(`organizations/${orgId}/matters/${matter.id}`, { method: "PATCH", body }));
      } else if (folder) {
        const r = await api<{ matter: Matter; linked: number; skipped: number }>(`organizations/${orgId}/matters/from-folder`, {
          method: "POST",
          body: { ...payload(f), folder_id: folder.id },
        });
        onSaved(r.matter, { linked: r.linked, skipped: r.skipped });
      } else {
        onSaved(await api<Matter>(`organizations/${orgId}/matters`, { method: "POST", body: payload(f) }));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErrors({ case_number: t("Another expediente already has this filing number.") });
      else setErrors({ form: e instanceof ApiError && e.status === 403 ? t("You don't have permission to change expedientes.") : (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const titlePlaceholder = f.client_name.trim() ? [f.client_name.trim(), f.case_number.trim()].filter(Boolean).join(" — ") : t("Client — filing number");
  return (
    <FormDialog
      title={matter ? t("Edit expediente") : folder ? t("Turn \"{name}\" into an expediente", { name: folder.name }) : t("New expediente")}
      description={
        folder
          ? t("Its documents, and those in its subfolders, are linked to the expediente. The folder stays as it is.")
          : t("Group a client's case so you can ask about it, wherever its documents are filed.")
      }
      icon={IconBriefcase}
      submitLabel={matter ? t("Save") : t("Create expediente")}
      busy={busy}
      wide
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="matter-form">
        <TextField label={t("Client")} value={f.client_name} maxLength={160} data-autofocus error={errors.client} onChange={set("client_name")} placeholder={t("Person or company you represent")} />
        <TextField label={t("Expediente name")} value={f.title} maxLength={160} onChange={set("title")} placeholder={titlePlaceholder} />
        <TextField label={t("Counterparty")} value={f.counterparty} maxLength={160} onChange={set("counterparty")} placeholder={t("Optional")} />
        <TextField label={t("Filing number")} value={f.case_number} maxLength={60} error={errors.case_number} onChange={set("case_number")} placeholder={t("e.g. 11001310300120260012300")} />
        <TextField label={t("Court")} value={f.court} maxLength={160} onChange={set("court")} placeholder={t("e.g. Juzgado 1 Civil del Circuito de Bogotá")} />
        <TextField label={t("Stage")} value={f.stage} maxLength={80} onChange={set("stage")} list={stagesId} placeholder={t("e.g. Evidence")} />
        <datalist id={stagesId}>
          {STAGE_SUGGESTIONS().map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="field">
          <label>{t("Responsible")}</label>
          <Select ariaLabel={t("Responsible")} value={f.owner_id} onChange={(v) => setF((cur) => ({ ...cur, owner_id: v }))} placeholder={t("Nobody yet")} options={[{ value: "", label: t("Nobody yet") }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        </div>
        <div className="field">
          <label>{t("Status")}</label>
          <Select ariaLabel={t("Status")} value={f.status} onChange={(v) => setF((cur) => ({ ...cur, status: v as MatterStatus }))} options={MATTER_STATUSES.map((s) => ({ value: s, label: t(STATUS_LABEL()[s]) }))} />
        </div>
      </div>
      <p className="faint matter-privacy">{t("Everyone in the firm sees the client, counterparty and filing number. Each document stays visible only to the people who could already read it.")}</p>
      {errors.form && (
        <div className="alert" role="alert">
          {errors.form}
        </div>
      )}
    </FormDialog>
  );
}

/** Pick an expediente for a document (or none). Linking never changes who can read the document. */
export function LinkMatterDialog({
  orgId,
  title,
  documentIds,
  current,
  matters,
  onClose,
  onLinked,
  onCreate,
}: {
  orgId: string;
  title: string;
  documentIds: string[];
  current: string | null;
  matters: Matter[];
  onClose: () => void;
  onLinked: (matterId: string | null) => void;
  onCreate?: () => void;
}) {
  const t = useT();
  const [target, setTarget] = useState(current ?? "none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const matterId = target === "none" ? null : target;
      await api(`organizations/${orgId}/documents/matter`, { method: "POST", body: { document_ids: documentIds, matter_id: matterId } });
      onLinked(matterId);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t("You need editor access to this space to change it.") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const open = matters.filter((m) => m.status !== "archived" || m.id === current);
  return (
    <FormDialog title={title} icon={IconBriefcase} submitLabel={t("Save")} busy={busy} onSubmit={submit} onClose={onClose}>
      <p className="muted">{t("Linking a document to an expediente doesn't change who can see it.")}</p>
      <Select
        ariaLabel={t("Expediente")}
        value={target}
        onChange={setTarget}
        options={[{ value: "none", label: t("No expediente") }, ...open.map((m) => ({ value: m.id, label: m.title, hint: matterSubtitle(m) }))]}
      />
      {onCreate && (
        <button type="button" className="link matter-create-link" onClick={onCreate}>
          {t("Create a new expediente")}
        </button>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
    </FormDialog>
  );
}
