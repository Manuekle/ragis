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
  kind?: "text" | "table" | "figure" | "equation";
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
}

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
