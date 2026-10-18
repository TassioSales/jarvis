/**
 * The building blocks of the side monitors: a framed panel, rings, segmented
 * meters, sparklines, the sun's arc, a status lamp and a news ticker.
 *
 * All SVG and CSS, no library: three monitors redraw these every second or
 * two for as long as the machine is on, and every one of them is a few dozen
 * nodes. The look is in monitors.css; these only lay out the geometry.
 */
import type { ReactNode } from 'react'

export function Frame({
  code,
  title,
  aside,
  className = '',
  children,
}: {
  code?: string
  title?: string
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`hx-card ${className}`}>
      {title && (
        <header className="hx-head">
          {code && <span className="hx-code">{code}</span>}
          <h2>{title}</h2>
          {aside != null && <span className="hx-aside">{aside}</span>}
        </header>
      )}
      <div className="hx-body">{children}</div>
      <i className="hx-scan" aria-hidden />
    </section>
  )
}

/** A value 0–100 as an arc, inside a slowly turning tick ring. */
export function Ring({
  value,
  label,
  sub,
  warn = 80,
  big,
}: {
  value: number | null
  label: string
  sub?: string
  warn?: number
  big?: string
}) {
  const v = Math.max(0, Math.min(100, value ?? 0))
  const r = 42
  const c = 2 * Math.PI * r
  const hot = value != null && v >= warn
  return (
    <figure className={`hx-ring ${hot ? 'hx-hot' : ''}`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle className="hx-ring-ticks" cx="50" cy="50" r="48" />
        <circle className="hx-ring-track" cx="50" cy="50" r={r} />
        <circle
          className="hx-ring-value"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={`${(v / 100) * c} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <circle className="hx-ring-inner" cx="50" cy="50" r="33" />
      </svg>
      <figcaption>
        <b>{value == null ? '—' : (big ?? `${Math.round(v)}`)}</b>
        {value != null && !big && <small>%</small>}
        <span>{label}</span>
        {sub && <em>{sub}</em>}
      </figcaption>
    </figure>
  )
}

/** A meter as a row of lit segments, the way an instrument panel draws it. */
export function Segments({ value, max = 100, n = 20, warn }: { value: number; max?: number; n?: number; warn?: number }) {
  const lit = Math.round((Math.max(0, Math.min(max, value)) / max) * n)
  const hot = warn != null && value >= warn
  return (
    <span className={`hx-seg ${hot ? 'hx-hot' : ''}`} aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
    </span>
  )
}

/** A small area chart with no axes: the shape of the last minute or two. */
export function Spark({ values, max, className = '' }: { values: number[]; max?: number; className?: string }) {
  if (values.length < 2) return <svg className={`hx-spark ${className}`} viewBox="0 0 100 30" aria-hidden />
  const top = max ?? Math.max(...values, 1)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 30 - (Math.min(v, top) / top) * 28 - 1])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return (
    <svg className={`hx-spark ${className}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path className="hx-spark-fill" d={`${line} L100,30 L0,30 Z`} />
      <path className="hx-spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Where the sun is between rising and setting, on a half circle. */
export function SunArc({ rise, set, now }: { rise: string | null; set: string | null; now: Date }) {
  if (!rise || !set) return null
  const a = new Date(rise).getTime()
  const b = new Date(set).getTime()
  const t = Math.max(0, Math.min(1, (now.getTime() - a) / (b - a)))
  const up = now.getTime() >= a && now.getTime() <= b
  const angle = Math.PI * (1 - t)
  const x = 50 + 44 * Math.cos(angle)
  const y = 48 - 40 * Math.sin(angle)
  const hhmm = (iso: string) => iso.slice(11, 16)
  return (
    <div className="hx-sun">
      <svg viewBox="0 0 100 52" aria-hidden>
        <path className="hx-sun-path" d="M6,48 A44,40 0 0 1 94,48" />
        <path
          className="hx-sun-done"
          d={`M6,48 A44,40 0 0 1 ${x.toFixed(2)},${y.toFixed(2)}`}
          style={{ opacity: up ? 1 : 0.25 }}
        />
        <line className="hx-sun-horizon" x1="0" y1="48" x2="100" y2="48" />
        {up && <circle className="hx-sun-dot" cx={x} cy={y} r="3.2" />}
      </svg>
      <div className="hx-sun-times">
        <span>▲ {hhmm(rise)}</span>
        <span>▼ {hhmm(set)}</span>
      </div>
    </div>
  )
}

export type Lamp = 'ok' | 'warn' | 'down' | 'off'

export function Dot({ state }: { state: Lamp }) {
  return <i className={`hx-dot hx-dot-${state}`} aria-hidden />
}

/** Text that runs across the bottom of the screen, forever, at reading pace. */
export function Ticker({ items }: { items: string[] }) {
  if (!items.length) return null
  // Twice over, so the loop has no visible seam.
  const run = [...items, ...items]
  return (
    <div className="hx-ticker" aria-hidden>
      <div className="hx-ticker-run" style={{ animationDuration: `${Math.max(40, items.length * 9)}s` }}>
        {run.map((text, i) => (
          <span key={i}>{text}</span>
        ))}
      </div>
    </div>
  )
}

