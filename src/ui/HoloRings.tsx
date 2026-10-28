import { useEffect, useMemo, useState } from 'react'
import { useStore, type Phase } from '../store'

/**
 * Concentric Stark Industries Holographic Reticles & Audio-reactive Ring.
 *
 * Drawn in pure SVG around the central arc reactor core. Renders the compass
 * calibration ticks, counter-rotating segmented telemetry rings, cardinal
 * reticles and real-time audio-frequency ripple waves.
 */

const SPEED_BY_PHASE: Record<Phase, number> = {
  offline: 120,
  boot: 18,
  dormant: 75,
  waking: 12,
  listening: 24,
  thinking: 8,
  tooling: 6,
  speaking: 14,
}

/** An arc from twelve o'clock, clockwise, over a fraction of the circle. */
function arc(r: number, f: number) {
  const k = Math.max(0, Math.min(0.9999, f))
  const a = k * Math.PI * 2 - Math.PI / 2
  const x = Math.cos(a) * r
  const y = Math.sin(a) * r
  return `M 0 ${-r} A ${r} ${r} 0 ${k > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`
}

export type RingData = {
  cpu: number | null
  ram: number | null
  gpuTemp: number | null
  /** The next thing on the agenda or the next reminder, if any. */
  next: { at: Date; text: string } | null
}

export function HoloRings({ data }: { data?: RingData }) {
  const phase = useStore((s) => s.phase)
  // Once a second, for the seconds arc. The voice used to be drawn here too, as
  // an arc re-rendered every frame; it is VoiceHalo's job now, on a canvas.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const dur = SPEED_BY_PHASE[phase] ?? 50
  const isOff = phase === 'offline'

  // Generate 72 degree tick marks (every 5 degrees)
  const ticks = useMemo(() => {
    const list = []
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180
      const isMajor = deg % 30 === 0
      const isCardinal = deg % 90 === 0
      const r1 = 232
      const r2 = isCardinal ? 246 : isMajor ? 242 : 237
      list.push({
        x1: Math.cos(rad) * r1,
        y1: Math.sin(rad) * r1,
        x2: Math.cos(rad) * r2,
        y2: Math.sin(rad) * r2,
        isMajor,
        deg,
      })
    }
    return list
  }, [])

  return (
    <div className={`holo-rings-wrap ${isOff ? 'holo-off' : ''}`} aria-hidden="true">
      <svg className="holo-rings" viewBox="-300 -300 600 600">
        <defs>
          <radialGradient id="holoGlow" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.0" />
            <stop offset="85%" stopColor="var(--accent)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.14" />
          </radialGradient>
        </defs>

        {/* Ambient Holographic Halo */}
        <circle cx="0" cy="0" r="248" fill="url(#holoGlow)" className="holo-halo" />

        {/* Outer Calibrated Ring (Clockwise) */}
        <g className="holo-spin-cw" style={{ animationDuration: `${dur}s` }}>
          <circle cx="0" cy="0" r="232" className="holo-ring-outer" />
          <circle cx="0" cy="0" r="248" className="holo-ring-outer-dash" />
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              className={`holo-tick ${t.isMajor ? 'holo-tick-major' : ''}`}
            />
          ))}
          {/* Compass degree numbers */}
          {[0, 90, 180, 270].map((deg) => {
            const rad = (deg * Math.PI) / 180
            const x = Math.cos(rad) * 258
            const y = Math.sin(rad) * 258 + 3
            return (
              <text key={deg} x={x} y={y} className="holo-text-deg" textAnchor="middle">
                {String(deg).padStart(3, '0')}°
              </text>
            )
          })}
        </g>

        {/* Middle Counter-Rotating Tech Ring (Counter-Clockwise) */}
        <g className="holo-spin-ccw" style={{ animationDuration: `${dur * 0.72}s` }}>
          <circle cx="0" cy="0" r="208" className="holo-ring-mid" />
          <circle cx="0" cy="0" r="198" className="holo-ring-mid-dash" />
          {/* Arc brackets */}
          <path d="M -155 -155 A 219 219 0 0 1 -130 -177" className="holo-bracket" />
          <path d="M 155 -155 A 219 219 0 0 0 130 -177" className="holo-bracket" />
          <path d="M -155 155 A 219 219 0 0 0 -130 177" className="holo-bracket" />
          <path d="M 155 155 A 219 219 0 0 1 130 177" className="holo-bracket" />
        </g>

        {/* Live instruments: the seconds of this minute, the processor and the
            memory, each an arc from twelve o'clock. */}
        <g className="holo-data">
          <circle cx="0" cy="0" r="222" className="holo-track" />
          <path d={arc(222, (Date.now() % 60_000) / 60_000)} className="holo-arc holo-arc-sec" />
          {data?.cpu != null && (
            <>
              <circle cx="0" cy="0" r="215" className="holo-track" />
              <path d={arc(215, data.cpu / 100)} className={`holo-arc ${data.cpu >= 85 ? 'holo-arc-hot' : ''}`} />
            </>
          )}
          {data?.ram != null && (
            <>
              <circle cx="0" cy="0" r="186" className="holo-track" />
              <path d={arc(186, data.ram / 100)} className="holo-arc holo-arc-dim" />
            </>
          )}
        </g>

        {/* Fixed Reticle Crosshairs and Stark Telemetry */}
        <g className="holo-fixed">
          {/* Reticle tick markers */}
          <line x1="-270" y1="0" x2="-252" y2="0" className="holo-reticle-cross" />
          <line x1="252" y1="0" x2="270" y2="0" className="holo-reticle-cross" />
          <line x1="0" y1="-270" x2="0" y2="-252" className="holo-reticle-cross" />
          <line x1="0" y1="252" x2="0" y2="270" className="holo-reticle-cross" />

          {/* Holographic labels */}
          {/* Real readings, where there used to be film props ("MK-VII",
              "CORE // OPTIMAL") that said nothing. */}
          <text x="-210" y="-218" className="holo-spec">
            CPU // {data?.cpu != null ? `${String(Math.round(data.cpu)).padStart(2, '0')}%` : '--'}
          </text>
          <text x="210" y="-218" textAnchor="end" className="holo-spec">
            RAM // {data?.ram != null ? `${String(Math.round(data.ram)).padStart(2, '0')}%` : '--'}
          </text>
          <text x="-210" y="228" className="holo-spec">
            {data?.gpuTemp != null ? `GPU // ${data.gpuTemp}°C` : 'AUDIO // 16kHz'}
          </text>
          <text x="210" y="228" textAnchor="end" className="holo-spec holo-spec-next">
            {data?.next
              ? `${String(data.next.at.getHours()).padStart(2, '0')}:${String(data.next.at.getMinutes()).padStart(2, '0')} // ${data.next.text.slice(0, 22).toUpperCase()}`
              : 'AGENDA // LIVRE'}
          </text>
        </g>
      </svg>
    </div>
  )
}
