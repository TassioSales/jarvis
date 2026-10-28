import { useEffect, useRef } from 'react'

/**
 * What she has learned about him, as a constellation that turns slowly.
 *
 * He is the star in the middle. Each fact is a point on the inner shell, each
 * habit a brighter point on the outer one, each day in the diary a faint dust
 * mote; threads join every point to the centre and each to its neighbours.
 * It grows as she learns — the point of drawing it at all is that he can see
 * that happening — and the labels of whatever swings to the front are read
 * out on the glass.
 *
 * Drawn by hand on a canvas: a few dozen points in a fake 3D (rotation and
 * perspective), well under a millisecond a frame.
 */
type Node = { x: number; y: number; z: number; kind: 'fact' | 'habit' | 'day'; label: string }

/** Points spread evenly over a sphere (the Fibonacci lattice). */
function sphere(n: number, r: number, offset = 0): [number, number, number][] {
  const out: [number, number, number][] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const rad = Math.sqrt(1 - y * y)
    const th = golden * i + offset
    out.push([Math.cos(th) * rad * r, y * r, Math.sin(th) * rad * r])
  }
  return out
}

export function Constellation({
  facts,
  habits,
  days,
  centre,
}: {
  facts: string[]
  habits: string[]
  days: number
  centre: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // The poll hands over new arrays every few seconds; only a real change in
  // what is known should restart the drawing (and its rotation).
  const key = JSON.stringify([facts, habits, days, centre])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const nodes: Node[] = [
      ...sphere(Math.max(facts.length, 1), 0.55).map(([x, y, z], i) => ({ x, y, z, kind: 'fact' as const, label: facts[i] ?? '' })),
      ...sphere(habits.length, 0.85, 1.3).map(([x, y, z], i) => ({ x, y, z, kind: 'habit' as const, label: habits[i] })),
      ...sphere(Math.min(days, 60), 1.0, 2.1).map(([x, y, z]) => ({ x, y, z, kind: 'day' as const, label: '' })),
    ].filter((n) => n.kind !== 'fact' || n.label)

    const css = getComputedStyle(el)
    const accent = css.getPropertyValue('--interface').trim() || '#00e5ff'
    let raf = 0
    let angle = 0
    const draw = () => {
      const dpr = devicePixelRatio || 1
      // The box's size, never the canvas's own: a canvas sized from itself
      // grows a little every frame, without end.
      const w = box.current?.clientWidth ?? 0
      const h = box.current?.clientHeight ?? 0
      if (!w || !h) {
        raf = requestAnimationFrame(draw)
        return
      }
      if (el.width !== Math.round(w * dpr)) {
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const R = Math.min(w, h) * 0.6
      const cx = w / 2
      const cy = h / 2
      angle += 0.0022
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const tilt = 0.35
      // Rotate about the vertical axis, tilt towards the viewer, project.
      const placed = nodes.map((n) => {
        const x = n.x * cos - n.z * sin
        const z0 = n.x * sin + n.z * cos
        const y = n.y * Math.cos(tilt) - z0 * Math.sin(tilt)
        const z = n.y * Math.sin(tilt) + z0 * Math.cos(tilt)
        const p = 2.4 / (2.4 - z)
        return { ...n, sx: cx + x * R * p, sy: cy + y * R * p, depth: (z + 1) / 2, p }
      })
      // Threads: to the centre, and between near neighbours of the same kind.
      ctx.lineWidth = 0.6
      for (const a of placed) {
        if (a.kind === 'day') continue
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.05 + a.depth * 0.18})`
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(a.sx, a.sy)
        ctx.stroke()
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]
          const b = placed[j]
          if (a.kind !== b.kind || a.kind === 'day') continue
          const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          if (d > 0.62) continue
          ctx.strokeStyle = `rgba(0, 229, 255, ${0.04 + ((a.depth + b.depth) / 2) * 0.12})`
          ctx.beginPath()
          ctx.moveTo(a.sx, a.sy)
          ctx.lineTo(b.sx, b.sy)
          ctx.stroke()
        }
      }
      // Points, back to front.
      placed.sort((a, b) => a.depth - b.depth)
      for (const n of placed) {
        const r = (n.kind === 'habit' ? 3.4 : n.kind === 'fact' ? 2.6 : 1.1) * n.p
        ctx.globalAlpha = 0.25 + n.depth * 0.75
        ctx.fillStyle = n.kind === 'habit' ? '#ffb347' : n.kind === 'fact' ? '#3dffb5' : accent
        ctx.beginPath()
        ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      // The centre: him.
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.22)
      glow.addColorStop(0, 'rgba(255,255,255,0.95)')
      glow.addColorStop(0.25, accent)
      glow.addColorStop(1, 'transparent')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.22, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '600 10px "Chakra Petch", sans-serif'
      ctx.fillStyle = 'rgba(230, 251, 255, 0.85)'
      ctx.textAlign = 'center'
      ctx.fillText(centre, cx, cy + R * 0.22 + 12)
      // The label of the frontmost fact or habit, read off the glass.
      const front = placed.filter((n) => n.label).at(-1)
      if (front && front.depth > 0.72) {
        const text = front.label.length > 46 ? `${front.label.slice(0, 45)}…` : front.label
        ctx.font = '400 10px "JetBrains Mono", monospace'
        ctx.textAlign = front.sx > cx ? 'right' : 'left'
        ctx.fillStyle = front.kind === 'habit' ? 'rgba(255,179,71,0.9)' : 'rgba(61,255,181,0.9)'
        ctx.fillText(text, front.sx + (front.sx > cx ? -8 : 8), front.sy - 6)
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <div ref={box} className="hx-constellation">
      <canvas ref={canvas} aria-label="O que ela aprendeu" />
    </div>
  )
}
