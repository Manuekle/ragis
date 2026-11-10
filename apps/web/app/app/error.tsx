"use client";

import { AppErrorState, requestErrorKind } from "@/components/AppState";

export default function ApplicationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="main">
      <AppErrorState kind={requestErrorKind(error) === "offline" ? "offline" : "server"} onRetry={reset} />
    </main>
  );
}
