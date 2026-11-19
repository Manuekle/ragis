"use client";

import { AppErrorState, requestErrorKind } from "@/components/AppState";
import { useLocale } from "@/components/LocaleProvider";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const locale = useLocale();
  return (
    <main className="error-page">
      <AppErrorState kind={requestErrorKind(error) === "offline" ? "offline" : "server"} onRetry={reset} locale={locale} />
    </main>
  );
}
