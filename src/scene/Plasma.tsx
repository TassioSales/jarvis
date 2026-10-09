import { useEffect, useRef } from 'react'
import { useStore, accentFor } from '../store'

/**
 * The other orb: a ring of loose, drifting filaments instead of a machined
 * reactor. Selected with VITE_JARVIS_ORB=plasma.
 *
 * Each filament is a circle whose radius is nudged by a few slow sine waves
 * running round it at different speeds, so no two are ever the same shape and
 * none ever repeats. Drawn additively, where they cross they brighten, which
 * is what turns a dozen thin lines into something that reads as energy.
 *
 * It answers to the same things the reactor does: it takes the phase's colour,
 * swells with the voice — his or yours — and writhes harder while he is
 * working. On a 2D canvas rather than in the WebGL scene because it is lines,
 * not geometry, and a canvas the size of the orb costs far less than a
 * full-screen shader pass for the same picture.
 */

const STRANDS = 16
const POINTS = 150

type Strand = {
  /** Wave counts round the ring, their speeds and phases. */
  n: [number, number, number]
  speed: [number, number, number]
  phase: [number, number, number]
  /** How far this one strays, how it is tilted, how bright it is. */
  amp: number
  tilt: number
  squash: number
  alpha: number
  width: number
}

/** Fixed per session, so the ring has a character rather than a flicker. */
function makeStrands(): Strand[] {
  // A small deterministic generator: the same ring every time the page loads.
  let seed = 7
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  return Array.from({ length: STRANDS }, () => ({
    n: [2 + Math.floor(rnd() * 3), 4 + Math.floor(rnd() * 4), 7 + Math.floor(rnd() * 6)],
    speed: [0.25 + rnd() * 0.45, -(0.2 + rnd() * 0.5), 0.5 + rnd() * 0.8],
    phase: [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28],
    amp: 0.035 + rnd() * 0.075,
    tilt: rnd() * Math.PI,
    squash: 0.86 + rnd() * 0.14,
    alpha: 0.25 + rnd() * 0.55,
    width: 0.8 + rnd() * 1.1,
  }))
}

export function Plasma() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return

    const strands = makeStrands()
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.25 : 1
    let raf = 0
    let size = 0
    // Eased copies, so the ring swells and settles instead of twitching with
    // every sample of the microphone.
    let level = 0
    let energy = 0

    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      size = Math.round(el.clientWidth * dpr)
      el.width = size
      el.height = size
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)

    const draw = (ms: number) => {
      raf = requestAnimationFrame(draw)
      const s = useStore.getState()
      const hidden = s.phase === 'offline' || s.phase === 'boot' || !s.ui.reactor.visible
      ctx.clearRect(0, 0, size, size)
      if (hidden || !size) return

      const t = (ms / 1000) * calm
      const busy = s.phase === 'thinking' || s.phase === 'tooling'
      level += (s.level - level) * 0.18
      energy += ((busy ? 1 : s.phase === 'dormant' ? 0.15 : 0.5) - energy) * 0.04

      const colour = s.ui.reactor.color ?? accentFor(s.phase, s.ui)
      const c = size / 2
      const base = size * 0.29 * s.ui.reactor.scale * (1 + level * 0.16)
      const stray = 0.6 + energy * 0.9 + level * 1.4
      const spin = t * 0.08 * s.ui.reactor.spin

      ctx.globalCompositeOperation = 'lighter'
      ctx.lineJoin = 'round'
      ctx.shadowColor = colour
      ctx.shadowBlur = size * 0.022
      ctx.strokeStyle = colour

      for (const strand of strands) {
        const cos = Math.cos(strand.tilt + spin)
        const sin = Math.sin(strand.tilt + spin)
        ctx.beginPath()
        for (let i = 0; i <= POINTS; i++) {
          const a = (i / POINTS) * Math.PI * 2
          const wobble =
            Math.sin(strand.n[0] * a + t * strand.speed[0] + strand.phase[0]) +
            0.6 * Math.sin(strand.n[1] * a + t * strand.speed[1] + strand.phase[1]) +
            0.3 * Math.sin(strand.n[2] * a + t * strand.speed[2] + strand.phase[2])
          const r = base * (1 + strand.amp * stray * wobble)
          // Each strand lies in its own slightly tilted, slightly flattened
          // plane — the cheap trick that makes a flat drawing look wound.
          const x = Math.cos(a) * r
          const y = Math.sin(a) * r * strand.squash
          const px = c + x * cos - y * sin
          const py = c + x * sin + y * cos
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.globalAlpha = Math.min(1, strand.alpha * s.ui.reactor.intensity * (0.75 + level * 0.6))
        ctx.lineWidth = strand.width * (size / 620)
        ctx.stroke()
      }

      // A faint glow in the hollow, so the ring sits in light rather than on black.
      ctx.shadowBlur = 0
      ctx.globalAlpha = 0.1 + level * 0.14
      const glow = ctx.createRadialGradient(c, c, 0, c, c, base * 1.25)
      glow.addColorStop(0, colour)
      glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, size, size)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return <canvas ref={canvas} className="plasma" aria-hidden="true" />
}
