import Image from "next/image";
import Link from "next/link";
import { ApiError } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

// Each drawing ships a second file with light ink (`<file>-dark.svg`); CSS shows the one that matches the theme.
// Empty and error states carry a drawing, never an icon tile.
const errorFrame = { width: 224, height: 174 };
const workspaceFrame = { width: 264, height: 160 };

const illustrations = {
  empty: { file: "documents-empty", width: 216, height: 136 },
  forbidden: { file: "access-denied", ...errorFrame },
  server: { file: "server-error", ...errorFrame },
  offline: { file: "server-error", ...errorFrame },
  notFound: { file: "not-found", ...errorFrame },
  // empty states of the workspace pages
  activity: { file: "activity-empty", ...workspaceFrame },
  signatures: { file: "signatures-empty", ...workspaceFrame },
  inbox: { file: "inbox-empty", ...workspaceFrame },
  workflows: { file: "workflows-empty", ...workspaceFrame },
  agents: { file: "agents-empty", ...workspaceFrame },
  teams: { file: "teams-empty", ...workspaceFrame },
  groups: { file: "groups-empty", ...workspaceFrame },
  keys: { file: "keys-empty", ...workspaceFrame },
};

type ErrorKind = "forbidden" | "server" | "offline" | "notFound";

const copy: Record<ErrorKind, { title: string; text: string }> = {
  forbidden: { title: "Access denied", text: "Ask an organization admin if you need access to this page." },
  server: { title: "Something went wrong", text: "We couldn’t load this page. Please try again." },
  offline: { title: "You’re offline", text: "Check your connection and try again." },
  notFound: { title: "Page not found", text: "This page doesn’t exist or was moved." },
};

const copyEs: Record<ErrorKind, { title: string; text: string }> = {
  forbidden: { title: "Acceso denegado", text: "Pide acceso a esta página a un administrador de la organización." },
  server: { title: "Algo salió mal", text: "No pudimos cargar esta página. Inténtalo de nuevo." },
  offline: { title: "Sin conexión", text: "Comprueba tu conexión e inténtalo de nuevo." },
  notFound: { title: "Página no encontrada", text: "Esta página no existe o se movió." },
};

export function StateIllustration({ kind }: { kind: keyof typeof illustrations }) {
  const { file, width, height } = illustrations[kind];
  return (
    <span className="state-illustration" style={{ width, aspectRatio: `${width} / ${height}` }} aria-hidden="true">
      <Image className="si-light" src={`/illustrations/${file}.svg`} alt="" width={width} height={height} unoptimized loading="eager" />
      <Image className="si-dark" src={`/illustrations/${file}-dark.svg`} alt="" width={width} height={height} unoptimized loading="eager" />
    </span>
  );
}

/** `fetch` rejects with a TypeError when the network is down; the message differs per browser. */
function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return error instanceof TypeError && /failed to fetch|load failed|network ?error|network request failed/i.test(error.message);
}

export function requestErrorKind(error: unknown): ErrorKind | null {
  if (!(error instanceof ApiError)) return error && isNetworkFailure(error) ? "offline" : null;
  if (error.status === 403) return "forbidden";
  return error.status >= 500 ? "server" : null;
}

export function AppErrorState({ kind, backHref = "/app", backLabel = "Back to organizations", onRetry, locale = "en" }: {
  kind: ErrorKind;
  backHref?: string;
  backLabel?: string;
  onRetry?: () => void;
  /** Spanish on the public site's own error pages; the workspace is English. */
  locale?: Locale;
}) {
  const { title, text } = (locale === "es" ? copyEs : copy)[kind];
  const linkOnly = kind === "forbidden" || kind === "notFound";
  return (
    <div className="app-error-state">
      <StateIllustration kind={kind} />
      <div className="app-error-copy" role="alert">
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      {linkOnly ? (
        <Link className="btn ghost" href={backHref}>{backLabel}</Link>
      ) : (
        <button type="button" className="ghost" onClick={onRetry}>{locale === "es" ? "Reintentar" : "Try again"}</button>
      )}
    </div>
  );
}
