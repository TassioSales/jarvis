import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { markets, weather } from './feeds.mjs'
import { system } from './system.mjs'
import { agendaNow } from './agenda.mjs'
import { mapsReady, routeSummary } from './maps.mjs'

const routeCache = new Map()
async function cachedRoute(from, to) {
  const k = `${from}::${to}`
  const now = Date.now()
  const hit = routeCache.get(k)
  if (hit && now - hit.at < 10 * 60_000) return hit.val
  try {
    const val = await routeSummary(from, to)
    routeCache.set(k, { at: now, val })
    return val
  } catch {
    return null
  }
}

/**
 * What she says without being asked.
 *
 * A butler who waits to be asked whether it will rain has not been paying
 * attention. Every minute this looks at what the bridge already knows — the
 * forecast, the calendar, the machine, the markets — and returns at most one
 * thing worth interrupting for. The bridge speaks it like a reminder.
 *
 * Restraint is most of the design. Each kind of alert has a cooldown, the
 * cooldowns survive a restart (alerts-state.json), nothing but the calendar
 * speaks between 22:00 and 07:00, and JARVIS_ALERTS=0 silences all of it.
 */
const OFF = process.env.JARVIS_ALERTS === '0'
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const STATE = join(DIR, 'alerts-state.json')

const HOUR = 3_600_000
const pct = (n) => Math.round(n)

function load() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}
function save(s) {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(STATE, JSON.stringify(s) + '\n')
  } catch {
    /* an alert said twice is better than a crash */
  }
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const quiet = (d = new Date()) => d.getHours() >= 22 || d.getHours() < 7

/**
 * The candidates, each with a key and how long until it may be said again.
 * Ordered by how much it matters right now; the first eligible one wins.
 */
async function candidates(now) {
  const out = []

  // A meeting about to start — the one alert that speaks at any hour.
  const origin = process.env.JARVIS_HOME_ADDRESS?.trim()
  for (const e of agendaNow()) {
    if (e.allDay) continue
    const startMs = new Date(e.start).getTime()
    const mins = (startMs - now.getTime()) / 60_000
    if (mins < 0) continue

    const loc = String(e.location ?? '').trim()
    const isVirtual = !loc || /^(https?:\/\/|meet\.|zoom\.|teams\.)/i.test(loc)
    if (!isVirtual && origin && mapsReady() && mins >= 15 && mins <= 120) {
      const trip = await cachedRoute(origin, loc)
      if (trip?.minutes) {
        const leaveInMins = mins - trip.minutes - 5 // 5 min safety buffer
        if (leaveInMins >= 5 && leaveInMins <= 15) {
          const timeStr = new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          out.push({
            key: `traffic:${e.title}:${e.start}`,
            cooldown: 24 * HOUR,
            always: true,
            text: `Senhor, para chegar a ${e.title} às ${timeStr}, são ${trip.minutes} minutos de trajeto${trip.delay > 3 ? ` com ${trip.delay} minutos de lentidão no trânsito` : ''}. Recomendo se preparar para sair em ${Math.round(leaveInMins)} minutos.`,
          })
        }
      }
    }

    if (mins >= 9 && mins <= 16) {
      out.push({
        key: `meeting:${e.title}:${e.start}`,
        cooldown: 24 * HOUR,
        always: true,
        text: `Senhor, ${e.title} começa em ${Math.round(mins)} minutos${e.location ? `, em ${e.location}` : ''}.`,
      })
    }
  }

  const sys = system()
  if (sys.gpu?.temp != null && sys.gpu.temp >= 85) {
    out.push({ key: 'gpu-hot', cooldown: 0.5 * HOUR, text: `Senhor, a placa de vídeo está a ${sys.gpu.temp} graus.` })
  }
  for (const d of sys.disks ?? []) {
    if (d.total && d.free / d.total < 0.05) {
      out.push({
        key: `disk:${d.name}:${dayKey(now)}`,
        cooldown: 24 * HOUR,
        text: `Senhor, o disco ${d.name.replace(':', '')} está com menos de cinco por cento livre.`,
      })
    }
  }

  const sky = await weather().catch(() => null)
  if (sky?.hours?.length >= 2) {
    const [thisHour, nextHour] = sky.hours
    if (nextHour.rain >= 70 && thisHour.rain < 70) {
      out.push({
        key: 'rain-soon',
        cooldown: 4 * HOUR,
        text: `Senhor, há ${pct(nextHour.rain)} por cento de chance de chuva na próxima hora.`,
      })
    }
  }
  if (sky?.uvMax != null && sky.uvMax >= 8 && now.getHours() >= 9 && now.getHours() < 11) {
    out.push({
      key: `uv:${dayKey(now)}`,
      cooldown: 24 * HOUR,
      text: `Senhor, o índice ultravioleta chega a ${Math.round(sky.uvMax)} hoje. Protetor solar, se for sair.`,
    })
  }

  const quotes = await markets().catch(() => null)
  const usd = quotes?.find((q) => /^USD/i.test(q.name))
  if (usd && Math.abs(usd.dayPct) >= 1.5) {
    out.push({
      key: `usd:${dayKey(now)}`,
      cooldown: 24 * HOUR,
      text: `Senhor, o dólar ${usd.dayPct > 0 ? 'sobe' : 'cai'} ${Math.abs(usd.dayPct).toFixed(1).replace('.', ',')} por cento hoje, a ${usd.last.toFixed(2).replace('.', ',')} reais.`,
    })
  }

  return out
}

/** The one thing to say now, or null. Marks it said. */
export async function dueAlert(now = new Date()) {
  if (OFF) return null
  const state = load()
  for (const c of await candidates(now)) {
    if (quiet(now) && !c.always) continue
    const last = state[c.key] ?? 0
    if (now.getTime() - last < c.cooldown) continue
    state[c.key] = now.getTime()
    // Forget keys older than two days, so the file does not grow forever.
    for (const [k, t] of Object.entries(state)) if (now.getTime() - t > 48 * HOUR) delete state[k]
    save(state)
    return c.text
  }
  return null
}
