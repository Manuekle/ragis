"use client"

import { useEffect, useRef } from "react"

/**
 * A quiet wall of document text behind a section. Rows of monospace lines drift sideways;
 * now and then a phrase lights up in the accent with a soft highlight, as if the search
 * had just found it. Fills its positioned parent, never covers the parent's own copy:
 * highlights skip any spot that overlaps the section's text or buttons.
 * Colours come from --text and --accent-text, so it follows the theme.
 */

const LINES = [
  "Employees accrue 1.5 vacation days for each full month of service.",
  "Remote work requires written approval from the team lead.",
  "Expenses above 500 EUR need a receipt and a second approver.",
  "The contract renews automatically unless cancelled 60 days before term.",
  "New hires get laptop access on day one and building access on day two.",
  "Invoices are paid net 30 from the date of receipt.",
  "Customer data stays in the selected region at all times.",
  "Security incidents must be reported within 24 hours.",
  "Quarterly reviews cover goals, budget and open risks.",
  "Parental leave is 16 weeks at full pay.",
  "Travel is booked through the approved agency only.",
  "Access to finance folders is limited to the finance team.",
  "Section 4.2 sets the notice period at one calendar month.",
  "The onboarding checklist lives in the people handbook.",
  "Price changes apply from the next billing cycle.",
  "Overtime is compensated as time off within the same quarter.",
  "Supplier audits run once a year, or after any incident.",
  "Each project keeps its own folder of signed documents.",
]

/** Phrases worth lighting up: short spans that read like an answer. */
const HITS = [
  "1.5 vacation days", "written approval", "500 EUR", "60 days", "day one", "net 30",
  "selected region", "24 hours", "16 weeks", "finance team", "one calendar month",
  "next billing cycle", "once a year", "signed documents", "full pay", "second approver",
]

const FONT_PX = 12
const ROW_PX = 20
const SPEED = 7 // px per second, alternating direction per row
const HIT_LIFE = 3.2 // seconds
const MAX_HITS = 3

interface Row {
  text: string
  /** [start, end) char spans of HITS phrases in `text` */
  spans: [number, number][]
  dir: number
  phase: number
}

interface Hit {
  row: number
  start: number
  len: number
  born: number
}

function shuffle<T>(a: T[], seed: number): T[] {
  const out = a.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280
    const j = Math.floor((s / 233280) * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function buildRow(i: number, minChars: number): Row {
  const parts = shuffle(LINES, i * 7 + 3)
  let text = ""
  let k = 0
  while (text.length < minChars) text += parts[k++ % parts.length] + "   "
  const spans: [number, number][] = []
  for (const h of HITS) {
    let at = text.indexOf(h)
    while (at !== -1) {
      spans.push([at, at + h.length])
      at = text.indexOf(h, at + 1)
    }
  }
  return { text, spans, dir: i % 2 ? 1 : -1, phase: (i * 137) % 400 }
}

export function GlyphField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const host = canvas?.parentElement
    const ctx = canvas?.getContext("2d")
    if (!canvas || !host || !ctx) return

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
    let w = 0
    let h = 0
    let cw = 7.2
    let rows: Row[] = []
    let hits: Hit[] = []
    let ink = "#888"
    let inkAlpha = 0.11
    let accent = "#0a84ff"
    let font = `${FONT_PX}px ui-monospace, monospace`
    let keepOut: DOMRect[] = []
    let raf = 0
    let visible = false
    let t0 = performance.now()
    let nextSpawn = 0.6

    const readTheme = () => {
      const cs = getComputedStyle(host)
      ink = cs.getPropertyValue("--text").trim() || ink
      // light ink on a dark page reads fainter at the same alpha, so give it a touch more
      const m = /^#([0-9a-f]{2})/i.exec(ink)
      inkAlpha = m && parseInt(m[1], 16) > 128 ? 0.16 : 0.11
      accent = cs.getPropertyValue("--accent-text").trim() || accent
      const mono = cs.getPropertyValue("--mono").trim()
      if (mono) font = `${FONT_PX}px ${mono}`
    }

    /** Rects (canvas space) of the section's own copy and controls. */
    const readKeepOut = () => {
      const base = canvas.getBoundingClientRect()
      const out: DOMRect[] = []
      for (const el of Array.from(host.children)) {
        if (el === canvas) continue
        const range = document.createRange()
        range.selectNodeContents(el)
        for (const r of Array.from(range.getClientRects())) {
          out.push(new DOMRect(r.left - base.left - 16, r.top - base.top - 10, r.width + 32, r.height + 20))
        }
      }
      keepOut = out
    }

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      w = r.width
      h = r.height
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = font
      cw = ctx.measureText("M").width || 7.2
      const cols = Math.ceil(w / cw) + 2
      const n = Math.ceil(h / ROW_PX) + 1
      rows = Array.from({ length: n }, (_, i) => buildRow(i, cols * 3))
      hits = []
      readKeepOut()
    }

    /** Pixel offset of row i at time t (s), wrapped to the row length. */
    const offset = (row: Row, t: number) => {
      const len = row.text.length * cw
      const o = (row.phase + row.dir * SPEED * t) % len
      return o < 0 ? o + len : o
    }

    /** x of char `idx` in row at time t, picking the copy that lands nearest the view. */
    const charX = (row: Row, idx: number, t: number) => {
      const len = row.text.length * cw
      let x = idx * cw - offset(row, t)
      if (x < -len / 2) x += len
      return x
    }

    const clear = (x: number, y: number, ww: number, hh: number) =>
      x > w * 0.42 && x + ww < w - 12 && y > 6 && y + hh < h - 6 &&
      !keepOut.some((k) => x < k.right && x + ww > k.left && y < k.bottom && y + hh > k.top)

    const spawn = (t: number) => {
      for (let tries = 0; tries < 24; tries++) {
        const ri = Math.floor(Math.random() * rows.length)
        const row = rows[ri]
        if (!row.spans.length || hits.some((x) => Math.abs(x.row - ri) < 2)) continue
        const [s, e] = row.spans[Math.floor(Math.random() * row.spans.length)]
        // the phrase must stay clear for its whole life, so test where it starts and ends up
        const y = ri * ROW_PX + 4
        const ww = (e - s) * cw
        const x0 = charX(row, s, t)
        const x1 = x0 - row.dir * SPEED * HIT_LIFE
        if (clear(x0, y - 2, ww, ROW_PX) && clear(x1, y - 2, ww, ROW_PX)) {
          hits.push({ row: ri, start: s, len: e - s, born: t })
          return
        }
      }
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h)
      ctx.font = font
      ctx.textBaseline = "top"
      ctx.fillStyle = ink
      ctx.globalAlpha = inkAlpha
      rows.forEach((row, i) => {
        const o = offset(row, t)
        const first = Math.floor(o / cw)
        const frac = o - first * cw
        const doubled = row.text + row.text
        const count = Math.ceil(w / cw) + 2
        ctx.fillText(doubled.slice(first % row.text.length, (first % row.text.length) + count), -frac, i * ROW_PX + 4)
      })

      for (const hit of hits) {
        const age = (t - hit.born) / HIT_LIFE
        const a = Math.min(1, age / 0.14, (1 - age) / 0.3)
        if (a <= 0) continue
        const row = rows[hit.row]
        const x = charX(row, hit.start, t)
        const y = hit.row * ROW_PX + 4
        ctx.globalAlpha = a * 0.14
        ctx.fillStyle = accent
        ctx.beginPath()
        ctx.roundRect(x - 4, y - 3, hit.len * cw + 8, FONT_PX + 6, 3)
        ctx.fill()
        ctx.globalAlpha = a
        ctx.fillText(row.text.slice(hit.start, hit.start + hit.len), x, y)
      }
      ctx.globalAlpha = 1
    }

    const frame = (now: number) => {
      const t = (now - t0) / 1000
      hits = hits.filter((x) => t - x.born < HIT_LIFE)
      if (t >= nextSpawn && hits.length < MAX_HITS) {
        spawn(t)
        nextSpawn = t + 0.9 + Math.random() * 1.4
      }
      draw(t)
      raf = requestAnimationFrame(frame)
    }

    /** Reduced motion: one still frame with a couple of phrases lit and held. */
    const still = () => {
      cancelAnimationFrame(raf)
      hits = []
      for (let i = 0; i < 6 && hits.length < 2; i++) spawn(0)
      hits.forEach((x) => (x.born = -HIT_LIFE * 0.4))
      draw(0)
    }

    const run = () => {
      cancelAnimationFrame(raf)
      if (reduce.matches) return still()
      if (!visible || document.hidden) return
      raf = requestAnimationFrame(frame)
    }

    const restart = () => {
      readTheme()
      resize()
      t0 = performance.now()
      nextSpawn = 0.6
      canvas.dataset.ready = ""
      if (reduce.matches) still()
      else run()
    }

    const ro = new ResizeObserver(restart)
    ro.observe(host)
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      run()
    })
    io.observe(canvas)
    const mo = new MutationObserver(() => {
      readTheme()
      if (reduce.matches) still()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] })
    const dark = window.matchMedia("(prefers-color-scheme: dark)")
    const onScheme = () => {
      readTheme()
      if (reduce.matches) still()
    }
    dark.addEventListener("change", onScheme)
    reduce.addEventListener("change", run)
    document.addEventListener("visibilitychange", run)
    document.fonts?.ready.then(restart)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      dark.removeEventListener("change", onScheme)
      reduce.removeEventListener("change", run)
      document.removeEventListener("visibilitychange", run)
    }
  }, [])

  return <canvas ref={ref} className={`glyph-field${className ? ` ${className}` : ""}`} aria-hidden="true" />
}
