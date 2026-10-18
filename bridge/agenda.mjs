import ical from 'node-ical'

/**
 * His calendar, read straight from Google Calendar's private iCal address.
 *
 * Every Google calendar has a "Secret address in iCal format" (Settings → the
 * calendar → Integrate calendar). Put one or more of them, comma separated, in
 * JARVIS_CALENDAR_ICS and the day monitor shows today and tomorrow, both
 * brains know what is on without spending a tool call, and the watcher can
 * say "your meeting is in fifteen minutes".
 *
 * The address is a credential — anyone with it reads the calendar — so it is
 * never logged and never sent anywhere but Google. Read-only: nothing here
 * can change an event.
 */
const URLS = (process.env.JARVIS_CALENDAR_ICS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^https:\/\//.test(s))

const TTL = 10 * 60_000
let cache = { at: 0, events: [], error: null }

export const agendaReady = () => URLS.length > 0

async function load() {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from.getTime() + 3 * 86_400_000)
  const events = []
  for (const url of URLS) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`calendar answered ${res.status}`)
    const data = ical.sync.parseICS(await res.text())
    const name = Object.values(data).find((v) => v?.type === 'VCALENDAR')?.['WR-CALNAME'] ?? ''
    for (const item of Object.values(data)) {
      if (item?.type !== 'VEVENT' || item.status === 'CANCELLED') continue
      try {
        instances = ical.expandRecurringEvent(item, { from, to })
      } catch {
        instances = []
      }
      if (!instances.length && item.start) {
        const s = new Date(item.start)
        const e = new Date(item.end ?? item.start)
        if (s <= to && e >= from) {
          instances = [{
            summary: item.summary,
            start: item.start,
            end: item.end ?? item.start,
            isFullDay: Boolean(item.datetype === 'date' || item.start?.dateOnly),
            location: item.location,
          }]
        }
      }
      for (const e of instances) {
        events.push({
          title: String(e.summary ?? item.summary ?? '').trim() || '(sem título)',
          start: new Date(e.start).toISOString(),
          end: new Date(e.end ?? e.start).toISOString(),
          allDay: Boolean(e.isFullDay),
          location: String(item.location ?? '').trim(),
          calendar: String(name),
        })
      }
    }
  }
  // Duplicates appear when the same event is on two of the calendars given.
  const seen = new Set()
  return events
    .filter((e) => {
      const k = `${e.title}|${e.start}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.start.localeCompare(b.start))
}

/** Today's, tomorrow's and the day after's events, oldest first. */
export async function agenda() {
  if (!URLS.length) return { configured: false, events: [] }
  if (Date.now() - cache.at > TTL) {
    try {
      cache = { at: Date.now(), events: await load(), error: null }
    } catch (err) {
      // Keep the last good list; say what went wrong without the address.
      cache = { ...cache, at: Date.now(), error: String(err?.message ?? err).replace(/https:\/\/\S+/g, '<calendar>') }
    }
  }
  return { configured: true, events: cache.events, error: cache.error }
}

/** The cached list, without waiting on the network — for prompts and the watcher. */
export const agendaNow = () => cache.events

const sameDay = (iso, d) => {
  const x = new Date(iso)
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate()
}

/** The block for both brains' prompts: today and tomorrow, as plain lines. */
export function agendaNote() {
  if (!URLS.length || !cache.events.length) return ''
  const now = new Date()
  const tomorrow = new Date(now.getTime() + 86_400_000)
  const line = (e) =>
    `- ${e.allDay ? 'dia todo' : new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}: ${e.title}${e.location ? ` (${e.location})` : ''}`
  const today = cache.events.filter((e) => sameDay(e.start, now) && (e.allDay || new Date(e.end) > now))
  const next = cache.events.filter((e) => sameDay(e.start, tomorrow))
  return (
    '\n\nTheir calendar, read live (use it; do not call a calendar tool for today or tomorrow):\n' +
    `Today, still ahead:\n${today.map(line).join('\n') || '- nothing'}\n` +
    `Tomorrow:\n${next.map(line).join('\n') || '- nothing'}`
  )
}
