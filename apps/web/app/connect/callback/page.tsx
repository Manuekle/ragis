"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { IconAlert, IconSpinner } from "@/components/icons";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Vuelta de Google/Slack/ClickUp tras autorizar (CON-01). Página de cliente fuera de /app: la cookie de sesión
 * (SameSite=strict) no viaja en la navegación que llega desde el proveedor, pero sí en el fetch same-origin que hace
 * esta página para completar la conexión con la misma persona que la inició.
 */
function Callback() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const state = params.get("state") ?? "";
  const org = UUID.test(state.split(".")[0] ?? "") ? state.split(".")[0] : null;
  const back = org ? `/app/${org}/connections` : "/app";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code");
    const denied = params.get("error");
    if (denied || !code || !state) {
      setError(denied === "access_denied" ? "You cancelled the connection. Nothing was connected." : "The app didn't finish connecting. Please try again.");
      return;
    }
    api<{ organization_id: string; connector_id: string }>("connectors/oauth/complete", { method: "POST", body: { state, code } })
      .then((r) => router.replace(`/app/${r.organization_id}/connections?connected=${r.connector_id}`))
      .catch((e: Error) => setError(e.message));
  }, [params, router, state]);

  return (
    <main className="connect-callback">
      <div className="card" style={{ maxWidth: 420, margin: "18vh auto 0", display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
        {error ? (
          <>
            <span className="dialog-icon danger">
              <IconAlert size={20} />
            </span>
            <h1 style={{ fontSize: 18, fontWeight: 500 }}>Couldn&apos;t connect</h1>
            <p className="muted">{error}</p>
            <Link className="btn primary" href={back} style={{ padding: "0 14px", height: 34, display: "inline-flex", alignItems: "center", borderRadius: 10 }}>
              Back to connected apps
            </Link>
          </>
        ) : (
          <>
            <IconSpinner size={20} />
            <h1 style={{ fontSize: 18, fontWeight: 500 }}>Finishing the connection…</h1>
            <p className="muted">This only takes a moment.</p>
          </>
        )}
      </div>
    </main>
  );
}

export default function ConnectCallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
