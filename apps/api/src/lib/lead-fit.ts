/**
 * Calificación comercial del alta (ADR-021). Determinista y sin LLM.
 *
 * Perfil objetivo: 15–150 empleados, 500+ documentos, 5–30 usuarios iniciales, compra decidida por gerencia
 * y señales de dolor (búsquedas repetidas, carpetas/servidores compartidos, información confidencial,
 * procesos con varias fuentes, pérdida medible). El puntaje es interno: la API no lo devuelve al cliente.
 */

import { z } from "zod";
import { SECTORS } from "./presets.js";

export const REFERRAL_SOURCES = ["google", "linkedin", "instagram", "x", "youtube", "facebook", "tiktok", "whatsapp", "referral", "event", "other"] as const;
export const BUYER_ROLES = ["management", "department_head", "it", "individual"] as const;
export const INITIAL_USERS = ["1-4", "5-30", "31-100", "100+"] as const;
export const TEAM_SIZES = ["1-14", "15-50", "51-150", "151-500", "500+"] as const;
export const VOLUMES = ["lt_500", "500_1k", "lt_1k", "1k_10k", "10k_100k", "gt_100k"] as const;
export const DOCUMENT_SOURCES = ["shared_folders", "servers", "sharepoint", "google_drive", "email", "other"] as const;
export const FIT_SIGNALS = ["repeated_search", "multi_source_process", "measurable_loss"] as const;

/**
 * Calificación que se pide ANTES de crear la organización (pantalla de alta, fuera de la app).
 * Es información comercial sobre la empresa, no configuración del producto: por eso vive en el alta y el wizard
 * interno (Setup) no la vuelve a pedir.
 */
export const Qualification = z
  .object({
    sector_primary: z.enum(SECTORS).optional(),
    team_size: z.enum(TEAM_SIZES).optional(),
    buyer_role: z.enum(BUYER_ROLES).optional(),
    initial_users: z.enum(INITIAL_USERS).optional(),
    volume_estimate: z.enum(VOLUMES).optional(),
    document_sources: z.array(z.enum(DOCUMENT_SOURCES)).max(6).default([]),
    fit_signals: z.array(z.enum(FIT_SIGNALS)).max(3).default([]),
    referral_source: z.enum(REFERRAL_SOURCES).optional(),
    referral_detail: z.string().trim().max(120).optional(),
  })
  .strict();
export type Qualification = z.infer<typeof Qualification>;

/** Fuentes que indican almacenamiento compartido (señal de buen cliente). */
const SHARED_STORAGE = new Set<string>(["shared_folders", "servers", "sharepoint", "google_drive"]);

export interface FitInput {
  team_size?: string | null;
  volume_estimate?: string | null;
  initial_users?: string | null;
  buyer_role?: string | null;
  document_sources?: string[] | null;
  fit_signals?: string[] | null;
  data_classification?: string | null;
}

export interface Fit {
  score: number;
  tier: "strong" | "possible" | "weak";
  /** Criterios que sumaron puntos, para depurar el puntaje. */
  matched: string[];
}

// team_size: 15–50 y 51–150 cubren exactamente el rango objetivo.
const TEAM_POINTS: Record<string, number> = { "15-50": 20, "51-150": 20, "151-500": 12, "500+": 6, "1-14": 5 };
const VOLUME_POINTS: Record<string, number> = { gt_100k: 20, "10k_100k": 20, "1k_10k": 20, "500_1k": 20, lt_1k: 10, lt_500: 3 };
const USERS_POINTS: Record<string, number> = { "5-30": 15, "31-100": 10, "100+": 6, "1-4": 4 };
const BUYER_POINTS: Record<string, number> = { management: 15, department_head: 9, it: 5, individual: 2 };

/** Devuelve null mientras no haya ninguna respuesta comercial: un perfil vacío no es "weak", es "sin datos". */
export function scoreLead(p: FitInput): Fit | null {
  const sources = p.document_sources ?? [];
  const signals = p.fit_signals ?? [];
  const answered = [p.team_size, p.volume_estimate, p.initial_users, p.buyer_role].filter(Boolean).length + (sources.length ? 1 : 0) + (signals.length ? 1 : 0);
  if (answered === 0) return null;

  const matched: string[] = [];
  let score = 0;
  const add = (key: string, pts: number | undefined) => {
    if (!pts) return;
    score += pts;
    matched.push(key);
  };

  if (p.team_size) add(`team:${p.team_size}`, TEAM_POINTS[p.team_size]);
  if (p.volume_estimate) add(`docs:${p.volume_estimate}`, VOLUME_POINTS[p.volume_estimate]);
  if (p.initial_users) add(`users:${p.initial_users}`, USERS_POINTS[p.initial_users]);
  if (p.buyer_role) add(`buyer:${p.buyer_role}`, BUYER_POINTS[p.buyer_role]);
  if (sources.some((s) => SHARED_STORAGE.has(s))) add("shared_storage", 6);
  if (signals.includes("repeated_search")) add("repeated_search", 7);
  if (signals.includes("multi_source_process")) add("multi_source_process", 6);
  if (signals.includes("measurable_loss")) add("measurable_loss", 6);
  if (p.data_classification === "confidential" || p.data_classification === "restricted") add("confidential", 5);

  score = Math.min(100, score);
  return { score, tier: score >= 70 ? "strong" : score >= 40 ? "possible" : "weak", matched };
}
