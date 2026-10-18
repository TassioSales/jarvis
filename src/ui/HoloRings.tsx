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

export function HoloRings() {
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  const [wave, setWave] = useState(0)

  // Audio wave generator that ripples with voice loudness
  useEffect(() => {
    let gone = false
    let frame = 0
    const step = () => {
      if (gone) return
      setWave((w) => (w + 0.08 + level * 0.18) % (Math.PI * 2))
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      gone = true
      cancelAnimationFrame(frame)
    }
  }, [level])

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

  // Audio-reactive waveform path around the lower arc (from 35° to 145°)
  const wavePath = useMemo(() => {
    const points = []
    const baseR = 194
    const count = 36
    const startAngle = (30 * Math.PI) / 180
    const endAngle = (150 * Math.PI) / 180
    for (let i = 0; i <= count; i++) {
      const t = i / count
      const angle = startAngle + t * (endAngle - startAngle)
      const ripple = Math.sin(t * 12 + wave * 3) * Math.cos(t * 7 - wave * 2) * (level * 18 + 2.5)
      const r = baseR + ripple
      const x = Math.cos(angle) * r
      const y = Math.sin(angle) * r
      points.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    }
    return points.join(' ')
  }, [level, wave])

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

        {/* Audio Reactive Waveform Oscilloscope Arc */}
        <path d={wavePath} className="holo-waveform" />

        {/* Fixed Reticle Crosshairs and Stark Telemetry */}
        <g className="holo-fixed">
          {/* Reticle tick markers */}
          <line x1="-270" y1="0" x2="-252" y2="0" className="holo-reticle-cross" />
          <line x1="252" y1="0" x2="270" y2="0" className="holo-reticle-cross" />
          <line x1="0" y1="-270" x2="0" y2="-252" className="holo-reticle-cross" />
          <line x1="0" y1="252" x2="0" y2="270" className="holo-reticle-cross" />

          {/* Holographic labels */}
          <text x="-210" y="-218" className="holo-spec">
            SYS // MK-VII
          </text>
          <text x="210" y="-218" textAnchor="end" className="holo-spec">
            CORE // OPTIMAL
          </text>
          <text x="-210" y="228" className="holo-spec">
            AUDIO // 16kHz
          </text>
          <text x="210" y="228" textAnchor="end" className="holo-spec">
            VAD // SILERO-ON
          </text>
        </g>
      </svg>
    </div>
  )
}
