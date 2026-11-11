"use client"

import { useEffect, useRef } from "react"
import { LOGO_PATH, LogoMark } from "./Logo"

/**
 * The oversized "Ragis" that closes the footer, cut off by the page edge. Under the pointer the
 * letters break into an ordered dither in the hero's blue ramp: a canvas on top draws dots only
 * inside the glyphs, denser near the cursor, with a slow shimmer. Purely decorative.
 */

const CELL = 2 // CSS px per dither cell
const DOT = 2 // CSS px dot inside each cell (= CELL: pixels touch, like a true ordered dither)
const RADIUS = 210 // CSS px reach of the lit spot

// 8×8 Bayer matrix, normalised to (0, 1)
const BAYER = (() => {
  const m = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21]
  return m.map((v) => (v + 0.5) / 64)
})()

export function FooterWordmark() {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!host || !canvas || !ctx) return

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
    let w = 0
    let h = 0
    let cols = 0
    let rows = 0
    let mask = new Uint8Array(0)
    let ramp = ["#08254d", "#0a84ff", "#9fd0ff"]
    let raf = 0
    let hovering = false
    let lit = 0
    const target = { x: 0, y: 0 }
    const spot = { x: 0, y: 0 }

    const readColors = () => {
      const cs = getComputedStyle(host)
      ramp = ["--dither-low", "--dither-mid", "--dither-high"].map((v, i) => cs.getPropertyValue(v).trim() || ramp[i])
    }

    /** Rasterise the DOM wordmark (text + logo) into a per-cell inside/outside mask. */
    const buildMask = () => {
      const base = host.getBoundingClientRect()
      w = base.width
      h = base.height
      // hidden (e.g. the landing's "how it works" view not open yet): nothing to rasterise
      if (w < 1 || h < 1) {
        cols = rows = 0
        mask = new Uint8Array(0)
        return
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const word = host.querySelector<HTMLElement>(".sf-word")
      const logo = host.querySelector<SVGSVGElement>(".sf-word-mark")
      const text = word && Array.from(word.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
      if (!word || !logo || !text) return

      const off = document.createElement("canvas")
      off.width = Math.ceil(w)
      off.height = Math.ceil(h)
      const o = off.getContext("2d", { willReadFrequently: true })
      if (!o) return
      const cs = getComputedStyle(word)
      const size = parseFloat(cs.fontSize)
      o.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`
      o.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing
      o.fillStyle = "#fff"

      // the text node's content box starts at the font ascent above the baseline
      const range = document.createRange()
      range.selectNodeContents(text)
      const tr = range.getBoundingClientRect()
      const label = text.textContent!.trim()
      const ascent = o.measureText(label).fontBoundingBoxAscent
      o.fillText(label, tr.left - base.left, tr.top - base.top + ascent)

      // logo path in its viewBox (222 200 806 809), scaled into the svg's box
      const lr = logo.getBoundingClientRect()
      o.save()
      o.translate(lr.left - base.left, lr.top - base.top)
      o.scale(lr.width / 806, lr.height / 809)
      o.translate(-222, -200)
      o.fill(new Path2D(LOGO_PATH))
      o.restore()

      cols = Math.ceil(w / CELL)
      rows = Math.ceil(h / CELL)
      const data = o.getImageData(0, 0, off.width, off.height).data
      mask = new Uint8Array(cols * rows)
      for (let j = 0; j < rows; j++) {
        const y = Math.min(off.height - 1, Math.floor(j * CELL + CELL / 2))
        for (let i = 0; i < cols; i++) {
          const x = Math.min(off.width - 1, Math.floor(i * CELL + CELL / 2))
          mask[j * cols + i] = data[(y * off.width + x) * 4 + 3] > 110 ? 1 : 0
        }
      }
    }

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h)
      if (lit < 0.01) return
      const i0 = Math.max(0, Math.floor((spot.x - RADIUS) / CELL))
      const i1 = Math.min(cols - 1, Math.ceil((spot.x + RADIUS) / CELL))
      const j0 = Math.max(0, Math.floor((spot.y - RADIUS) / CELL))
      const j1 = Math.min(rows - 1, Math.ceil((spot.y + RADIUS) / CELL))
      const paths = [new Path2D(), new Path2D(), new Path2D()]
      const pad = Math.floor((CELL - DOT) / 2) // whole pixels keep the dots crisp
      for (let j = j0; j <= j1; j++) {
        const cy = j * CELL + CELL / 2
        for (let i = i0; i <= i1; i++) {
          if (!mask[j * cols + i]) continue
          const cx = i * CELL + CELL / 2
          const d = Math.hypot(cx - spot.x, cy - spot.y) / RADIUS
          if (d >= 1) continue
          const shimmer = 0.82 + 0.18 * Math.sin(cx * 0.045 + t * 1.6) * Math.cos(cy * 0.05 - t * 1.2)
          const v = Math.pow(1 - d, 1.3) * lit * shimmer * 1.4
          if (v <= BAYER[(j & 7) * 8 + (i & 7)]) continue
          const level = v > 0.8 ? 2 : v > 0.42 ? 1 : 0
          paths[level].rect(i * CELL + pad, j * CELL + pad, DOT, DOT)
        }
      }
      paths.forEach((p, k) => {
        ctx.fillStyle = ramp[k]
        ctx.fill(p)
      })
    }

    const frame = (now: number) => {
      const ease = reduce.matches ? 1 : 0.2
      spot.x += (target.x - spot.x) * ease
      spot.y += (target.y - spot.y) * ease
      lit += ((hovering ? 1 : 0) - lit) * (reduce.matches ? 1 : 0.1)
      draw(reduce.matches ? 0 : now / 1000)
      if (hovering || lit > 0.01) raf = requestAnimationFrame(frame)
      else {
        raf = 0
        ctx.clearRect(0, 0, w, h)
      }
    }

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      const r = host.getBoundingClientRect()
      target.x = e.clientX - r.left
      target.y = e.clientY - r.top
      if (!hovering) {
        // re-rasterise on each entry: cheap, and catches a font that finished loading late
        if (lit < 0.01) buildMask()
        if (lit < 0.01) {
          spot.x = target.x
          spot.y = target.y
        }
        hovering = true
      }
      kick()
    }
    const leave = () => {
      hovering = false
      kick()
    }

    const rebuild = () => {
      readColors()
      buildMask()
    }
    const ro = new ResizeObserver(rebuild)
    ro.observe(host)
    const mo = new MutationObserver(readColors)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    const dark = window.matchMedia("(prefers-color-scheme: dark)")
    dark.addEventListener("change", readColors)
    document.fonts?.ready.then(rebuild)
    document.fonts?.addEventListener("loadingdone", rebuild)
    host.addEventListener("pointermove", move)
    host.addEventListener("pointerleave", leave)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      dark.removeEventListener("change", readColors)
      document.fonts?.removeEventListener("loadingdone", rebuild)
      host.removeEventListener("pointermove", move)
      host.removeEventListener("pointerleave", leave)
    }
  }, [])

  return (
    <div ref={hostRef} className="sf-mark" aria-hidden="true">
      <span className="sf-word">
        <LogoMark className="sf-word-mark" size={100} />
        Ragis
      </span>
      <canvas ref={canvasRef} className="sf-mark-dither" />
    </div>
  )
}
