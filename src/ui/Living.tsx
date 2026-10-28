import { useEffect, useRef, useState } from 'react'
import { useStore, type Phase } from '../store'
import { t as tr } from '../lib/i18n'

/**
 * The parts of the main screen that move with her, not with the clock:
 *
 *   - VoiceHalo: a full ring of bars round the reactor that follows her voice
 *     while she speaks and his while she listens, instead of only a pulse;
 *   - PhaseSweep: a ring of the new colour sweeping out from the centre each
 *     time she changes state, with the state's name, so a change is seen
 *     even out of the corner of an eye;
 *   - HoloCaption: what she is saying, word by word on a sheet of glass, with
 *     the tools she used for it beside it.
 */

/* ------------------------------------------------------------- voice halo */

const BARS = 120

/**
 * Drawn on a canvas, from the store read each frame rather than subscribed:
 * the level changes sixty times a second, and a re-render per frame of the
 * whole HUD for it is what made the old waveform arc expensive.
 */
export function VoiceHalo() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    let raf = 0
    let colour = '#19d8d2'
    let frame = 0
    let shown = 0
    const bars = new Float32Array(BARS)

    const fit = () => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(devicePixelRatio || 1, 1.5)
      el.width = Math.round(r.width * dpr)
      el.height = Math.round(r.height * dpr)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const { phase, level } = useStore.getState()
      // The colour is the HUD's own --accent, so the halo can never disagree
      // with the reactor it rings. Read now and then: it eases over 600 ms.
      if (frame++ % 12 === 0) colour = getComputedStyle(el).getPropertyValue('--accent').trim() || colour
      const live = phase === 'speaking' || phase === 'listening' || phase === 'waking'
      shown += ((live ? 1 : 0) - shown) * 0.08
      const { width: w, height: h } = el
      ctx.clearRect(0, 0, w, h)
      if (shown < 0.01) return

      const t = now / 1000
      const cx = w / 2
      const cy = h / 2
      const base = Math.min(w, h) * 0.305
      const reach = Math.min(w, h) * (phase === 'speaking' ? 0.085 : 0.05)
      ctx.strokeStyle = colour
      ctx.lineCap = 'round'
      ctx.lineWidth = Math.max(1.4, Math.min(w, h) / 320)
      ctx.shadowColor = colour
      ctx.shadowBlur = 10
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2
        // Three slow waves at different speeds round the ring, so it ripples
        // rather than every bar jumping together.
        const shape =
          0.55 +
          0.25 * Math.sin(a * 3 + t * 2.1) +
          0.2 * Math.sin(a * 7 - t * 3.3) +
          0.15 * Math.sin(a * 13 + t * 5.7)
        const want = Math.max(0.04, level * 1.6 * shape)
        // Up fast, down slowly, like a meter.
        bars[i] += (want - bars[i]) * (want > bars[i] ? 0.5 : 0.12)
        const len = 2 + bars[i] * reach
        ctx.globalAlpha = shown * (0.35 + Math.min(0.65, bars[i]))
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base)
        ctx.lineTo(cx + Math.cos(a) * (base + len), cy + Math.sin(a) * (base + len))
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvas} className="voice-halo" aria-hidden />
}

/* ------------------------------------------------------------ phase sweep */

const SWEPT: Partial<Record<Phase, string>> = {
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'THINKING',
  tooling: 'WORKING',
  speaking: 'SPEAKING',
}

export function PhaseSweep() {
  const phase = useStore((s) => s.phase)
  const [sweep, setSweep] = useState<{ at: number; label: string } | null>(null)
  const last = useRef<Phase>(phase)

  useEffect(() => {
    if (phase === last.current) return
    last.current = phase
    const label = SWEPT[phase]
    if (!label) return
    setSweep({ at: Date.now(), label })
    const timer = setTimeout(() => setSweep(null), 1500)
    return () => clearTimeout(timer)
  }, [phase])

  if (!sweep) return null
  return (
    <div key={sweep.at} className="phase-sweep" aria-hidden>
      <i className="phase-ring" />
      <i className="phase-ring phase-ring-2" />
      <span className="phase-label">{tr(sweep.label)}</span>
    </div>
  )
}

/* ----------------------------------------------------------- holo caption */

/** Tool names as she would say them, for the chips beside her words. */
function toolLabel(name: string) {
  return name
    .replace(/^mcp__/, '')
    .replace(/^jarvis_/, '')
    .split(/__|_/)
    .filter(Boolean)
    .slice(-2)
    .join(' ')
}

export function HoloCaption() {
  const caption = useStore((s) => s.caption)
  const phase = useStore((s) => s.phase)
  const tools = useStore((s) => {
    const last = s.turns[s.turns.length - 1]
    return last?.role === 'jarvis' ? last.tools : undefined
  })
  if (!caption) return null
  // Hers while she speaks; his words, transcribed as he says them, otherwise.
  const hers = phase === 'speaking' || phase === 'thinking' || phase === 'tooling'
  const words = caption.split(/\s+/).filter(Boolean)
  const chips = [...new Set((tools ?? []).map(toolLabel))].slice(0, 4)
  return (
    <div className={`holo-caption ${hers ? 'holo-hers' : 'holo-his'}`}>
      <span className="holo-who">{hers ? 'WEDNESDAY' : tr('YOU')}</span>
      <p>
        {/* Keyed by position: a word already shown keeps its node, so only the
            new ones animate in as the sentence grows. */}
        {words.map((w, i) => (
          <span key={i} className="holo-word" style={{ animationDelay: `${Math.min(i, 6) * 18}ms` }}>
            {w}{' '}
          </span>
        ))}
      </p>
      {hers && chips.length > 0 && (
        <div className="holo-chips">
          {chips.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
    </div>
  )
}
