import { useEffect, useRef, useState } from 'react'

/**
 * The charts on the side monitors.
 *
 * Drawn by hand in SVG at the size of the box they are given, because a chart
 * stretched to fit has stretched text, and these are read from across a room.
 * Each shows one series against one axis: the title above the chart names what
 * it is, so there is no legend to look away to.
 *
 * Ink and data are kept apart on purpose. Numbers and labels are always in the
 * text colours; the series colour is only ever on the mark itself. That is
 * what lets the whole interface be retinted without a label becoming
 * unreadable against its own line.
 */

function useSize<T extends Element>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: Math.round(width), h: Math.round(height) })
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

/** Round an axis outward to a step people count in. */
function niceRange(min: number, max: number, step: number): [number, number] {
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  return hi === lo ? [lo, lo + step] : [lo, hi]
}

type Point = { label: string; value: number }

const PAD = { top: 22, right: 16, bottom: 28, left: 50 }

function Frame({
  w,
  h,
  ticks,
  scaleY,
  unit,
  labels,
  scaleX,
  format = String,
}: {
  w: number
  h: number
  ticks: number[]
  scaleY: (v: number) => number
  unit: string
  labels: { at: number; text: string }[]
  scaleX: (i: number) => number
  format?: (v: number) => string
}) {
  return (
    <g className="chart-frame">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={w - PAD.right} y1={scaleY(tick)} y2={scaleY(tick)} />
          <text x={PAD.left - 8} y={scaleY(tick)} dy="0.32em" textAnchor="end">
            {format(tick)}
            {unit}
          </text>
        </g>
      ))}
      {labels.map((label) => (
        <text key={label.at} x={scaleX(label.at)} y={h - 6} textAnchor="middle">
          {label.text}
        </text>
      ))}
    </g>
  )
}

/** Which labels to print along the bottom: as many as fit, evenly spaced. */
function pickLabels(points: Point[], w: number): { at: number; text: string }[] {
  const room = Math.max(2, Math.floor((w - PAD.left - PAD.right) / 76))
  const every = Math.max(1, Math.ceil(points.length / room))
  return points
    .map((p, i) => ({ at: i, text: p.label }))
    .filter((_, i) => i % every === 0)
}

/**
 * One series over time, as a line with a faint fill beneath it.
 *
 * The highest and lowest points are labelled where they fall and nothing else
 * is — a number on every point is a table drawn badly. Hovering gives any
 * other reading.
 */
export function LineChart({
  points,
  unit = '',
  step = 5,
  floor,
  ceiling,
  fill = true,
  format,
}: {
  points: Point[]
  unit?: string
  step?: number
  /** How to write a value — money wants its decimals, a temperature does not. */
  format?: (v: number) => string
  /** Pin the axis instead of fitting it — percentages want 0 to 100. */
  floor?: number
  ceiling?: number
  fill?: boolean
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  if (points.length < 2 || w < 80 || h < 60) {
    return <div ref={ref} className="chart" />
  }

  const values = points.map((p) => p.value)
  const [lo, hi] = niceRange(
    floor ?? Math.min(...values),
    ceiling ?? Math.max(...values),
    step,
  )
  const innerW = w - PAD.left - PAD.right
  const innerH = h - PAD.top - PAD.bottom
  const scaleX = (i: number) => PAD.left + (i / (points.length - 1)) * innerW
  const scaleY = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH

  const ticks: number[] = []
  const tickStep = (hi - lo) / step > 5 ? step * 2 : step
  // Counted, not accumulated: adding 0.02 to itself drifts, and the top
  // gridline of a currency chart went missing by a rounding error.
  for (let i = 0; lo + i * tickStep <= hi + tickStep / 1000; i++) ticks.push(lo + i * tickStep)
  const show = format ?? ((v: number) => String(Math.round(v)))

  const line = points.map((p, i) => `${scaleX(i).toFixed(1)},${scaleY(p.value).toFixed(1)}`).join(' ')
  const area = `${PAD.left},${scaleY(lo)} ${line} ${scaleX(points.length - 1)},${scaleY(lo)}`

  const maxAt = values.indexOf(Math.max(...values))
  const minAt = values.indexOf(Math.min(...values))
  // On a pinned axis the extremes are the axis; labelling them says nothing.
  const marked = floor === undefined ? [...new Set([maxAt, minAt])] : []

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - box.left - PAD.left) / innerW) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }

  return (
    <div ref={ref} className="chart">
      <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <Frame
          w={w}
          h={h}
          ticks={ticks}
          scaleY={scaleY}
          unit={unit}
          labels={pickLabels(points, w)}
          scaleX={scaleX}
          format={format}
        />
        {fill && <polygon className="chart-area" points={area} />}
        <polyline className="chart-line" points={line} />
        {marked.map((i) => (
          <g key={i}>
            <circle className="chart-dot" cx={scaleX(i)} cy={scaleY(values[i])} r="4" />
            <text
              className="chart-value"
              x={scaleX(i)}
              y={scaleY(values[i]) + (i === maxAt ? -9 : 16)}
              textAnchor={i < 2 ? 'start' : i > points.length - 3 ? 'end' : 'middle'}
            >
              {show(values[i])}
              {unit}
            </text>
          </g>
        ))}
        {hover !== null && (
          <g className="chart-hover">
            <line x1={scaleX(hover)} x2={scaleX(hover)} y1={PAD.top} y2={h - PAD.bottom} />
            <circle className="chart-dot" cx={scaleX(hover)} cy={scaleY(values[hover])} r="4" />
            <text
              className="chart-value"
              x={scaleX(hover)}
              y={PAD.top - 7}
              textAnchor={hover < 3 ? 'start' : hover > points.length - 4 ? 'end' : 'middle'}
            >
              {points[hover].label} · {show(values[hover])}
              {unit}
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}

/**
 * One value per slot, as bars from a fixed baseline. Used for things that are
 * an amount in each hour rather than a level that moves between them.
 */
export function BarChart({
  points,
  unit = '',
  ceiling = 100,
  empty,
}: {
  points: Point[]
  unit?: string
  ceiling?: number
  /** What to say across the plot when every value is zero. */
  empty?: string
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  if (!points.length || w < 80 || h < 60) return <div ref={ref} className="chart" />

  const innerW = w - PAD.left - PAD.right
  const innerH = h - PAD.top - PAD.bottom
  const slot = innerW / points.length
  // A two-pixel gap between neighbours, so twenty-four bars read as
  // twenty-four hours and not as one jagged shape.
  const bar = Math.max(2, slot - 2)
  const scaleX = (i: number) => PAD.left + i * slot + slot / 2
  const scaleY = (v: number) => PAD.top + (1 - v / ceiling) * innerH
  const ticks = [0, ceiling / 2, ceiling]
  const flat = points.every((p) => p.value <= 0)

  return (
    <div ref={ref} className="chart">
      <svg width={w} height={h} onMouseLeave={() => setHover(null)}>
        <Frame
          w={w}
          h={h}
          ticks={ticks}
          scaleY={scaleY}
          unit={unit}
          labels={pickLabels(points, w)}
          scaleX={scaleX}
        />
        {points.map((p, i) => {
          const top = scaleY(Math.min(ceiling, p.value))
          const height = Math.max(0, scaleY(0) - top)
          return (
            <g key={p.label + i} onMouseEnter={() => setHover(i)}>
              {/* The hit area is the whole column: a bar two pixels tall is
                  otherwise impossible to point at. */}
              <rect className="chart-hit" x={scaleX(i) - slot / 2} y={PAD.top} width={slot} height={innerH} />
              <rect
                className={`chart-bar ${hover === i ? 'chart-bar-on' : ''}`}
                x={scaleX(i) - bar / 2}
                y={top}
                width={bar}
                height={height}
                rx={Math.min(3, bar / 2, height / 2)}
              />
            </g>
          )
        })}
        {/* Twenty-four bars of nothing look like a chart that failed to load,
            so an empty forecast says so in words. */}
        {flat && empty && (
          <text className="chart-empty" x={PAD.left + innerW / 2} y={PAD.top + innerH / 2} textAnchor="middle">
            {empty}
          </text>
        )}
        {hover !== null && (
          <text
            className="chart-value"
            x={scaleX(hover)}
            y={PAD.top - 7}
            textAnchor={hover < 3 ? 'start' : hover > points.length - 4 ? 'end' : 'middle'}
          >
            {points[hover].label} · {Math.round(points[hover].value)}
            {unit}
          </text>
        )}
      </svg>
    </div>
  )
}
