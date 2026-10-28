import { useEffect, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { setAmbientTint } from '../store'

/**
 * The room outside, on the glass.
 *
 * The interface used to look the same at six in the morning, at midnight and
 * in a storm. Now, in the main window:
 *   - the reactor's resting colour follows the sky — gold at dawn, cyan by
 *     day, ember at dusk, deep blue at night (only at rest: the colours that
 *     mean listening, thinking, speaking are left alone);
 *   - when it is raining where he is, it rains across the screen, harder for
 *     a downpour than a drizzle;
 *   - after ten at night the whole interface dims;
 *   - an alert arriving pulses the edges amber, so it is seen as well as heard.
 *
 * One canvas, drawn only while it is raining; the rest is CSS.
 */
type Sky = { now: { code: number }; sun?: { rise: string | null; set: string | null } }

/** How hard it is raining, 0–1, from the WMO weather code. */
function rainOf(code: number): number {
  if (code >= 95) return 1 // thunderstorm
  if (code >= 80 && code <= 82) return 0.45 + (code - 80) * 0.25 // showers
  if (code >= 61 && code <= 67) return 0.35 + ((code - 61) % 4) * 0.2 // rain
  if (code >= 51 && code <= 57) return 0.18 // drizzle
  return 0
}

/** The resting tint for this moment, from sunrise and sunset. */
function tintOf(now: Date, sky: Sky | null): string | null {
  const rise = sky?.sun?.rise ? new Date(sky.sun.rise).getTime() : null
  const set = sky?.sun?.set ? new Date(sky.sun.set).getTime() : null
  const t = now.getTime()
  const H = 3_600_000
  if (rise && t >= rise - 0.5 * H && t < rise + H) return '#e8a45a' // dawn
  if (set && t >= set - H && t < set + 0.5 * H) return '#e0784e' // dusk
  if (rise && set && (t < rise - 0.5 * H || t >= set + 0.5 * H)) return '#3f6fd8' // night
  return null // day: the usual cyan
}

export function Ambience() {
  const [sky, setSky] = useState<Sky | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [alert, setAlert] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const read = () =>
      fetch(`${BRIDGE_HTTP_URL}/weather`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSky(d as Sky))
        .catch(() => {})
    void read()
    const a = setInterval(read, 10 * 60_000)
    const b = setInterval(() => setNow(new Date()), 60_000)
    const onAlert = () => setAlert(Date.now())
    window.addEventListener('jarvis-alert', onAlert)
    return () => {
      clearInterval(a)
      clearInterval(b)
      window.removeEventListener('jarvis-alert', onAlert)
    }
  }, [])

  useEffect(() => {
    setAmbientTint(tintOf(now, sky))
  }, [now, sky])

  const rain = sky ? rainOf(sky.now.code) : 0
  const night = now.getHours() >= 22 || now.getHours() < 6

  // The rain: a few hundred streaks falling at a slant, redrawn each frame
  // only while it is raining.
  useEffect(() => {
    const el = canvas.current
    if (!el || rain <= 0) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    let raf = 0
    const fit = () => {
      el.width = innerWidth
      el.height = innerHeight
    }
    fit()
    addEventListener('resize', fit)
    const drops = Array.from({ length: Math.round(60 + rain * 260) }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      len: 10 + Math.random() * 18,
      speed: 7 + Math.random() * 9,
    }))
    const draw = () => {
      ctx.clearRect(0, 0, el.width, el.height)
      ctx.strokeStyle = `rgba(150, 220, 255, ${0.08 + rain * 0.12})`
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
      ctx.clearRect(0, 0, el.width, el.height)
    }
  }, [rain])

  return (
    <>
      {rain > 0 && <canvas ref={canvas} className="amb-rain" aria-hidden />}
      {night && <div className="amb-night" aria-hidden />}
      {alert > 0 && <div key={alert} className="amb-alert" aria-hidden />}
    </>
  )
}
