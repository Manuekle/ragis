"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const res = await fetch(`/api/proxy/${path.replace(/^\//, "")}`, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { ...(init?.body !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Citation {
  n: number;
  document_id: string;
  version_id: string;
  version_no: number;
  title: string;
  filename: string;
  section: string;
  page: number | null;
  effective_from: string | null;
  snippet: string;
  chunk_id: string;
  kind?: "text" | "table" | "figure" | "equation" | "audio" | "public_record" | "web";
  /**
   * ADR-036: a public record or web page looked up for this question, outside the organization's documents.
   * Document fields (document_id, version_id, chunk_id, filename…) are null on these.
   */
  external?: boolean;
  url?: string | null;
  source?: string;
  country?: string;
  country_name?: string;
  /** Date of the source's data (datasets), when Croma reports it. */
  as_of?: string | null;
  retrieved_at?: string;
  /** The search ran and found nothing in that register. */
  no_match?: boolean;
  demo?: boolean;
  /** Recordings: seconds from the start of the cited passage. */
  t_start?: number | null;
  t_end?: number | null;
  bbox?: [number, number, number, number] | null;
  caption?: string | null;
  has_asset?: boolean;
  ai_generated?: boolean;
}

export interface QueryResult {
  trace_id: string;
  answer: string;
  abstained: boolean;
  abstain_reason: string | null;
  citations: Citation[];
  retrieval_strategy: string;
  question_class: string;
  generation_model: string | null;
  latency_ms: number;
  /** Presente solo si el turno quedó guardado en el historial (ADR-028). */
  conversation_id?: string;
  /** The question asked for a file (ADR-034): `answer` is a short note and this is the card. */
  document?: GeneratedDocument | null;
  /** Present when the question asked for public records (ADR-036). */
  public_sources?: PublicSourcesSummary | null;
}

export interface PublicSourcesSummary {
  requested: boolean;
  lookups: number;
  countries: string[];
  sources: string[];
  /** Why nothing was looked up: off | limit | restricted | not_configured | credits_exhausted | rate_limited | source_unavailable | timeout | unavailable. */
  unavailable: string | null;
  demo: boolean;
}

/** Organization settings for public records (GET/PUT organizations/:org/public-sources). */
export interface PublicSourcesSettings {
  /** The platform has Croma set up (API key or demo mode). */
  available: boolean;
  demo: boolean;
  /** The organization's data is classified `restricted`: nothing may go to external services. */
  restricted?: boolean;
  enabled: boolean;
  /** Effective default country (explicit setting, else the organization profile). */
  country: string | null;
  country_setting: string | null;
  country_from_profile: string | null;
  web: boolean;
  monthly_limit: number;
  used_this_month: number;
  remaining: number;
  can_manage: boolean;
  countries: { code: string; name: string }[];
}

export type DocFormat = "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "md";

/** A file written from the person's documents (ADR-034). Markdown underneath; each format is made on download. */
export interface GeneratedDocument {
  id: string;
  title: string;
  format: DocFormat;
  kind: "report" | "presentation" | "table";
  filename: string;
  /** Only in the live answer; history keeps the card and loads the Markdown on demand. */
  markdown?: string;
  outline: string[];
  sections: number;
  words: number;
  sources: number;
  /** Distinct documents behind the citations (`sources` counts cited passages). */
  documents?: number;
  /** PowerPoint: slides in the deck (cover and sources included). */
  slides?: number;
  /** Rows across the document's tables. */
  rows?: number;
  formats: DocFormat[];
}

/** Same-origin URL of a generated file (through the BFF, which adds the session). */
export const generatedFileUrl = (org: string, id: string, format: DocFormat, inline = false) =>
  `/api/proxy/organizations/${org}/generated-documents/${id}/file?format=${format}${inline ? "&disposition=inline" : ""}`;

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: number;
}

export interface StoredTurn {
  id: string;
  workspace_id: string;
  question: string;
  as_of: string | null;
  created_at: string;
  feedback: 1 | -1 | null;
  /** El documento citado ya no es visible para esta persona: la respuesta no se muestra. */
  redacted: boolean;
  result: QueryResult | null;
}

export interface ConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: StoredTurn[];
}

export interface Workspace {
  id: string;
  name: string;
  my_role: string | null;
  has_documents?: boolean | null;
  /** Set when the workspace is a team's private space (ADR-035). */
  team_id?: string | null;
  team_color?: string | null;
}

export const formatBytes = (raw: number | string | null | undefined) => {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
};
