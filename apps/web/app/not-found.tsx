import type { Metadata } from "next";
import { AppErrorState } from "@/components/AppState";

export const metadata: Metadata = { title: "Page not found · Ragis" };

export default function NotFound() {
  return (
    <main className="error-page">
      <AppErrorState kind="notFound" backHref="/" backLabel="Back to home" />
    </main>
  );
}
