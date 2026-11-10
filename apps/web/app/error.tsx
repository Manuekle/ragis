"use client";

import { AppErrorState, requestErrorKind } from "@/components/AppState";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-page">
      <AppErrorState kind={requestErrorKind(error) === "offline" ? "offline" : "server"} onRetry={reset} />
    </main>
  );
}
