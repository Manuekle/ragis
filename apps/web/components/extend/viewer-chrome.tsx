"use client"

import * as React from "react"

/**
 * The app puts its own chrome (file title on the left; Download + Close on the right) INTO each viewer's toolbar,
 * so there is a single bar. Viewers read it from here; screens without a toolbar (loading, images, plain text,
 * errors) render the same pieces in <ViewerBarFallback />.
 */
export type ViewerChrome = { lead: React.ReactNode; actions: React.ReactNode }

export const ViewerChromeContext = React.createContext<ViewerChrome | null>(null)

export function ViewerLead() {
  return <>{React.useContext(ViewerChromeContext)?.lead ?? null}</>
}

export function ViewerActions() {
  return <>{React.useContext(ViewerChromeContext)?.actions ?? null}</>
}

export function ViewerBarFallback() {
  const chrome = React.useContext(ViewerChromeContext)
  if (!chrome) return null
  return (
    <header className="flex min-h-12 flex-none items-center gap-2 border-b bg-background px-3 py-2">
      {chrome.lead}
      <div className="ml-auto flex items-center gap-1">{chrome.actions}</div>
    </header>
  )
}
