import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Phase } from '../store'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { HoloRings, type RingData } from './HoloRings'
import { HoloCaption, PhaseSweep, VoiceHalo } from './Living'
import { t as tr } from '../lib/i18n'
import { BRIDGE_HTTP_URL, LANG } from '../config'
import { sky as skyLabel } from '../lib/weather'

/** The hour, the date and the sky, under her name: the main screen had none. */
function BrandClock({ sky }: { sky: RailSky | null }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="brand-clock">
      <b>
        {String(now.getHours()).padStart(2, '0')}
        <i>:</i>
        {String(now.getMinutes()).padStart(2, '0')}
      </b>
      <span>
        {now.toLocaleDateString(LANG, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '')}
        {sky && (
          <>
            {' · '}
            {Math.round(sky.now.temp)}° {tr(skyLabel(sky.now.code)).toLowerCase()}
          </>
        )}
      </span>
    </div>
  )
}

/**
 * A bridge endpoint, read on a timer, for the rails. The main window keeps
 * these to a glance — every service and its lamp, the machine in three
 * numbers, the sky — and leaves the detail to the side monitors.
 */
function useBridge<T>(path: string, everyMs: number): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let gone = false
    const read = () =>
      fetch(`${BRIDGE_HTTP_URL}${path}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !gone && d && setData(d as T))
        .catch(() => {})
    void read()
    const timer = setInterval(read, everyMs)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [path, everyMs])
  return data
}

type RailStatus = { services: { id: string; label: string; state: 'ok' | 'warn' | 'down' | 'off'; detail: string }[] }
type RailSystem = { cpu: { now: number }; mem: { used: number; total: number }; gpu: { util: number | null; temp: number | null } | null }
type RailSky = { city: string; now: { temp: number; humidity: number; code: number } }
type RailToday = {
  reminders: { text: string; at: string }[]
  agenda: { events: { title: string; start: string; allDay: boolean }[] }
}

/** The next timed thing today or tomorrow: an event, or else a reminder. */
function nextUp(today: RailToday | null) {
  if (!today) return null
  const now = Date.now()
  const soon = (iso: string) => {
    const t = new Date(iso).getTime()
    return t > now && t - now < 36 * 3_600_000
  }
  const event = today.agenda?.events?.find((e) => !e.allDay && soon(e.start))
  if (event) return { at: new Date(event.start), text: event.title }
  const reminder = [...(today.reminders ?? [])].sort((a, b) => a.at.localeCompare(b.at)).find((r) => soon(r.at))
  return reminder ? { at: new Date(reminder.at), text: reminder.text } : null
}

const statusText: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: 'STANDBY — SAY “HEY JARVIS”',
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'RESPONDING',
}

function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <div className={`corner corner-${at}`} />
}

/* ------------------------------------------------------------------ decode */

/**
 * The glyphs the ghost is drawn from. Uppercase, digits and rules only: the
 * point is that the unresolved text reads as *machine*, so lowercase letters
 * and anything with a descender are left out — they look like badly rendered
 * words rather than an unfinished decode.
 */
const GLYPHS = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Characters of noise shown ahead of the resolved text. */
const GHOST = 22
/** Repaint interval for the scramble. ~24fps is plenty for glyph noise. */
const FRAME_MS = 42
/** Floor on the resolve rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

function scramble(s: string, seed: number) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Whitespace is left alone so word shapes and line breaks hold still while
    // the glyphs underneath churn.
    if (c === ' ' || c === '\n' || c === '\t') {
      out += c
      continue
    }
    out += GLYPHS[(seed * 7919 + i * 104729 + c.charCodeAt(0)) % GLYPHS.length]
  }
  return out
}

/**
 * JARVIS's lines, arriving the way a computer would produce them.
 *
 * The hard part is not the effect, it is that the text underneath is *live*.
 * The store appends a token at a time, so this component re-renders dozens of
 * times a second with a slightly longer string, and the naive implementation —
 * scramble the whole thing, resolve it over N milliseconds — restarts the
 * animation on every token and never finishes decoding anything.
 *
 * So the frontier is a ref and only ever moves forward. Everything behind it
 * has settled and is plain text that will never animate again; a short window
 * ahead of it is noise; the rest is present in the DOM but invisible, which
 * keeps the line wrapping identical to the finished paragraph and means the
 * accessibility tree always holds the real sentence. The rate scales with how
 * far behind the frontier has fallen, so a single token drips and a 300
 * character burst clears inside MAX_LAG_MS — the decode must never be the
 * reason the transcript trails the voice.
 *
 * The rAF loop repaints on a 42ms gate rather than every frame, and stops dead
 * the moment the frontier catches up.
 */
function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)

  useEffect(() => {
    // The running loop reads the length through this ref rather than through
    // its own closure, so a token landing mid-sweep simply extends the target
    // instead of leaving the loop chasing a length that is already stale.
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 120) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="decode-ghost">{scramble(text.slice(n, n + GHOST), tick)}</span>
      <span className="decode-veil">{text.slice(n + GHOST)}</span>
    </>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const connected = useStore((s) => s.connected)
  const muted = useStore((s) => s.muted)
  const focusUntil = useStore((s) => s.focusUntil)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!focusUntil) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [focusUntil])
  const focusLeft = focusUntil ? Math.max(0, focusUntil - Date.now()) : 0
  const railStatus = useBridge<RailStatus>('/status', 10_000)
  const railSystem = useBridge<RailSystem>('/system', 4000)
  const railSky = useBridge<RailSky>('/weather', 10 * 60_000)
  const railToday = useBridge<RailToday>('/today', 60_000)
  const rings: RingData = {
    cpu: railSystem ? railSystem.cpu.now : null,
    ram: railSystem ? (railSystem.mem.used / railSystem.mem.total) * 100 : null,
    gpuTemp: railSystem?.gpu?.temp ?? null,
    next: nextUp(railToday),
  }
  const error = useStore((s) => s.error)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const ui = useStore((s) => s.ui)
  const briefing = useStore((s) => s.briefing !== null)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  return (
    <div className="hud" style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />
      <HoloRings data={rings} />
      <VoiceHalo />
      <PhaseSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

      <header className="hud-top">
        {ui.chrome.brand && (
          <div className="brand">
            <span className="brand-mark">WEDNESDAY</span>
            <span className="brand-sub">{tr('Personal assistant · neural core')}</span>
            <BrandClock sky={railSky} />
          </div>
        )}

        {focusLeft > 0 && (
          <div className="focus-badge">
            {tr('FOCUS')} · {String(Math.floor(focusLeft / 60_000)).padStart(2, '0')}:
            {String(Math.floor((focusLeft % 60_000) / 1000)).padStart(2, '0')}
          </div>
        )}
        {muted && (
          <button className="mic-off" onClick={() => window.dispatchEvent(new Event('jarvis-unmute'))}>
            {tr('MIC OFF · PRESS M')}
          </button>
        )}

        <div className="status">
          <span className="dot" />
          <span className="status-text">
            {/* bootNote is the voice-model download readout. It is only ever
                the right thing to show during boot — as a general fallback a
                note that never got cleared (a stuck 'voice 97%') sits over
                LISTENING and PROCESSING for the rest of the session. */}
            {phase === 'boot' && bootNote ? bootNote : tr(statusText[phase])}
          </span>
        </div>
      </header>

      {/* Left rail: every part of her, and whether it is working. */}
      {ui.chrome.systems && (
        <aside className="rail rail-left">
          <div className="rail-title">{tr('SYSTEMS')}</div>
          {!railStatus && connected.length === 0 && <div className="rail-item dim">{tr('none linked')}</div>}
          {(railStatus?.services ?? []).map((s) => (
            <div key={s.id} className={`rail-item rail-svc rail-${s.state}`} title={s.detail}>
              <span className="tick" />
              <span>{s.label}</span>
            </div>
          ))}
        </aside>
      )}

      {/* Right rail: the microphone, and the machine and the sky at a glance. */}
      <aside className="rail rail-right">
        <div className="rail-title">{tr('SIGNAL')}</div>
        <div className="meter">
          <div className="meter-fill" style={{ transform: `scaleY(${level})` }} />
        </div>
        <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div>
        {railSystem && (
          <>
            <div className="rail-title rail-gap">{tr('MACHINE')}</div>
            <div className="rail-item mono">CPU {String(Math.round(railSystem.cpu.now)).padStart(3, '0')}%</div>
            <div className="rail-item mono">RAM {String(Math.round((railSystem.mem.used / railSystem.mem.total) * 100)).padStart(3, '0')}%</div>
            {railSystem.gpu && (
              <div className={`rail-item mono ${(railSystem.gpu.temp ?? 0) >= 80 ? 'rail-hot' : ''}`}>
                GPU {String(railSystem.gpu.util ?? 0).padStart(3, '0')}% · {railSystem.gpu.temp ?? '—'}°C
              </div>
            )}
          </>
        )}
        {railSky && (
          <>
            <div className="rail-title rail-gap">{railSky.city.toUpperCase()}</div>
            <div className="rail-item mono">{Math.round(railSky.now.temp)}° · {Math.round(railSky.now.humidity)}%</div>
          </>
        )}
      </aside>

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && (
          <motion.div
            className="tool-badge"
            // Anchored to the TOP of the frame, not the middle. The old home was
            // viewport-centre plus a fixed drop, which on a tall or square
            // window landed the headline straight on top of the bottom
            // transcript — two elements pinned to different edges of the screen
            // were always going to meet somewhere. Up here it sits in its own
            // band with the rest of the status chrome and can never collide with
            // the log. Framer owns `transform` on an animated element, so the
            // centring (x: -50%) lives in these props, not the stylesheet.
            initial={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          >
            <span className="tool-kicker">
              <span className="spinner" />
              accessing
            </span>
            <span className="tool-name">{activeTool.replace(/[_-]/g, ' ')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Conversation log — last few turns, fading upward */}
      {/* Not during a briefing: its caption is the transcript, and the two
          would be the same sentence printed twice, one over the other. */}
      {ui.chrome.transcript && !briefing && (
        <div className="log">
          <AnimatePresence initial={false}>
            {turns.slice(-4).map((t) => (
              <motion.div
                key={t.id}
                className={`log-line log-${t.role}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              >
                <span className="log-who">{t.role === 'user' ? tr('YOU') : 'WEDNESDAY'}</span>
                {/* Only his half decodes. What the user said was never
                    transmitted from anywhere — dressing it up as machine
                    output would be a lie about where the words came from. */}
                <span className="log-text">
                  {t.role === 'jarvis' ? <DecodeText text={t.text} /> : t.text}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* The caption on a sheet of glass, word by word (ui/Living.tsx). */}
      <HoloCaption />

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {ui.chrome.suggestions && <Suggestions />}

      {error && <div className="error">{error}</div>}

      <footer className="hud-bottom">
        <span className="hint">
          {tr('say')} <b>{tr('“hey jarvis”')}</b> · <kbd>Space</kbd> {tr('to talk')} · <kbd>G</kbd> {tr('hands')} · <kbd>F</kbd> {tr('face')} · <kbd>L</kbd> {tr('lock')} · <kbd>H</kbd> {tr('help')}
          {voice && (
            <>
              {' · '}
              <kbd>V</kbd> voice: {voice.replace(/\(.*?\)/g, '').trim()}
            </>
          )}
        </span>
      </footer>

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live">
          {looking ? `${tr('LOOKING')} — ${looking.toUpperCase()}` : tr('CAMERA ON · G TO STOP')}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}
