import { useEffect, useMemo, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { setAmbientTint } from '../store'

/**
 * The sky outside, behind the glass — always there, never the same twice a day.
 *
 * The first version only showed at dawn, dusk, night or in the rain, so on an
 * ordinary overcast afternoon nothing at all had changed. Now there is always
 * a sky behind the reactor, and it is the real one:
 *
 *   - its colour follows the hour: rose at dawn, clear blue in the morning,
 *     bright haze at noon, gold in the late afternoon, violet and ember at
 *     dusk, deep navy at night with the stars out;
 *   - the sun crosses the top of the screen from sunrise to sunset, glowing
 *     when the sky is clear and hidden when it is not;
 *   - clouds drift across in as many layers as the forecast has cover;
 *     fog lies low; rain falls; a thunderstorm flashes;
 *   - the reactor's resting colour takes the light of the hour (only at rest:
 *     the colours that mean listening, thinking, speaking are left alone);
 *   - after ten at night everything dims, and an alert pulses the edges amber.
 *
 * All of it sits behind the 3D scene (which is transparent) and is CSS but
 * for two small canvases, the stars and the rain, drawn only when needed.
 */
type Sky = {
  now: { code: number; day?: boolean }
  sun?: { rise: string | null; set: string | null }
}

type Period = 'night' | 'dawn' | 'morning' | 'noon' | 'afternoon' | 'golden' | 'dusk'

const H = 3_600_000

/** Which part of the day it is, from today's sunrise and sunset. */
function periodOf(now: Date, sky: Sky | null): Period {
  const t = now.getTime()
  const rise = sky?.sun?.rise ? new Date(sky.sun.rise).getTime() : new Date(now).setHours(6, 0, 0, 0)
  const set = sky?.sun?.set ? new Date(sky.sun.set).getTime() : new Date(now).setHours(18, 0, 0, 0)
  if (t < rise - 0.6 * H || t >= set + 0.7 * H) return 'night'
  if (t < rise + 0.8 * H) return 'dawn'
  if (t >= set - 0.6 * H) return 'dusk'
  if (t >= set - 2 * H) return 'golden'
  const noon = (rise + set) / 2
  if (Math.abs(t - noon) < 1.6 * H) return 'noon'
  return t < noon ? 'morning' : 'afternoon'
}

/** The reactor's resting colour for each part of the day (null: its own cyan). */
const TINT: Record<Period, string | null> = {
  night: '#4b7cff',
  dawn: '#f0a07a',
  morning: '#43d9cf',
  noon: null,
  afternoon: '#5fd3e6',
  golden: '#f2b45a',
  dusk: '#e0784e',
}

/** Cloud cover 0–1, fog, rain 0–1 and storm, from the WMO weather code. */
function weatherOf(code: number) {
  const cloud =
    code === 0 ? 0 : code === 1 ? 0.25 : code === 2 ? 0.55 : code === 3 ? 0.9 : code >= 45 ? 0.95 : 0.6
  const fog = code === 45 || code === 48
  const rain =
    code >= 95 ? 1 : code >= 80 && code <= 82 ? 0.45 + (code - 80) * 0.25 : code >= 61 && code <= 67 ? 0.35 + ((code - 61) % 4) * 0.2 : code >= 51 && code <= 57 ? 0.18 : 0
  return { cloud, fog, rain, storm: code >= 95 }
}

export function Ambience() {
  const [sky, setSky] = useState<Sky | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [alert, setAlert] = useState(0)
  const [flash, setFlash] = useState(0)
  const rainCanvas = useRef<HTMLCanvasElement>(null)

  // For trying the look without waiting for the weather: ?sky=dusk&wx=95
  const preview = useMemo(() => {
    const q = new URLSearchParams(location.search)
    return { period: q.get('sky') as Period | null, code: q.has('wx') ? Number(q.get('wx')) : null }
  }, [])

  useEffect(() => {
    const read = () =>
      fetch(`${BRIDGE_HTTP_URL}/weather`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSky(d as Sky))
        .catch(() => {})
    void read()
    const a = setInterval(read, 10 * 60_000)
    const b = setInterval(() => setNow(new Date()), 30_000)
    const onAlert = () => setAlert(Date.now())
    window.addEventListener('jarvis-alert', onAlert)
    return () => {
      clearInterval(a)
      clearInterval(b)
      window.removeEventListener('jarvis-alert', onAlert)
    }
  }, [])

  const period = preview.period ?? periodOf(now, sky)
  const wx = weatherOf(preview.code ?? sky?.now.code ?? 0)
  const night = period === 'night'
  const late = now.getHours() >= 22 || now.getHours() < 6

  useEffect(() => {
    setAmbientTint(TINT[period])
  }, [period])

  // Where the sun is, 0 at sunrise to 1 at sunset.
  const sunAt = (() => {
    const rise = sky?.sun?.rise ? new Date(sky.sun.rise).getTime() : new Date(now).setHours(6, 0, 0, 0)
    const set = sky?.sun?.set ? new Date(sky.sun.set).getTime() : new Date(now).setHours(18, 0, 0, 0)
    return Math.max(0, Math.min(1, (now.getTime() - rise) / (set - rise)))
  })()
  const sunVisible = !night && wx.cloud < 0.7

  // A thunderstorm: a flash, sometimes doubled, every eight to twenty seconds.
  useEffect(() => {
    if (!wx.storm) return
    let timer: ReturnType<typeof setTimeout>
    const strike = () => {
      setFlash(Date.now())
      timer = setTimeout(strike, 8000 + Math.random() * 12000)
    }
    timer = setTimeout(strike, 3000)
    return () => clearTimeout(timer)
  }, [wx.storm])

  // The rain: streaks falling at a slant, redrawn only while it rains.
  useEffect(() => {
    const el = rainCanvas.current
    if (!el || wx.rain <= 0) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    let raf = 0
    const fit = () => {
      el.width = innerWidth
      el.height = innerHeight
    }
    fit()
    addEventListener('resize', fit)
    const drops = Array.from({ length: Math.round(60 + wx.rain * 260) }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      len: 10 + Math.random() * 18,
      speed: 7 + Math.random() * 9,
    }))
    const draw = () => {
      ctx.clearRect(0, 0, el.width, el.height)
      ctx.strokeStyle = `rgba(150, 220, 255, ${0.08 + wx.rain * 0.12})`
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const d of drops) {
        ctx.moveTo(d.x, d.y)
        ctx.lineTo(d.x - d.len * 0.18, d.y + d.len)
        d.y += d.speed
        d.x -= d.speed * 0.18
        if (d.y > el.height) {
          d.y = -d.len
          d.x = Math.random() * (el.width + 100)
        }
      }
      ctx.stroke()
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('resize', fit)
    }
  }, [wx.rain])

  // Stars: a fixed field, drawn once, twinkling by CSS in three groups.
  const stars = useMemo(
    () =>
      Array.from({ length: 140 }, (_, i) => ({
        x: Math.random() * 100,
        y: Math.random() * 70,
        r: Math.random() < 0.85 ? 1 : 1.8,
        g: i % 3,
      })),
    [],
  )

  return (
    <>
      <div className={`amb-sky amb-${period}`} aria-hidden>
        {night && (
          <div className="amb-stars" style={{ opacity: 1 - wx.cloud * 0.8 }}>
            {stars.map((s, i) => (
              <i
                key={i}
                className={`amb-star amb-tw${s.g}`}
                style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.r * 2, height: s.r * 2 }}
              />
            ))}
          </div>
        )}
        {!night && (
          <div
            className="amb-sun"
            style={{
              left: `${8 + sunAt * 84}%`,
              top: `${4 + 38 * (1 - Math.sin(sunAt * Math.PI))}%`,
              opacity: sunVisible ? 1 - wx.cloud * 0.9 : 0.08,
            }}
          >
            <i className="amb-rays" />
          </div>
        )}
        {wx.cloud > 0 && (
          <div className="amb-clouds" style={{ opacity: Math.min(1, 0.25 + wx.cloud) }}>
            <i className="amb-cloud amb-c1" />
            {wx.cloud > 0.4 && <i className="amb-cloud amb-c2" />}
            {wx.cloud > 0.7 && <i className="amb-cloud amb-c3" />}
          </div>
        )}
        {wx.fog && <div className="amb-fog" />}
      </div>
      {wx.rain > 0 && <canvas ref={rainCanvas} className="amb-rain" aria-hidden />}
      {flash > 0 && <div key={flash} className="amb-flash" aria-hidden />}
      {late && <div className="amb-late" aria-hidden />}
      {alert > 0 && <div key={alert} className="amb-alert" aria-hidden />}
    </>
  )
}
