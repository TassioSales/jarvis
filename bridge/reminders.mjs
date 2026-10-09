import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Things he has been asked to say later.
 *
 * A reminder is a sentence and a time. Some repeat daily, and one kind is not
 * a sentence at all but the morning briefing, which is how "give me the day at
 * seven" is done without anyone having to say good morning.
 *
 * Kept in a plain JSON file beside his memory, for the same reason the memory
 * is a plain file: it can be read and corrected by hand, and nothing he has
 * been told to do later is anywhere the user cannot see it. The bridge checks
 * it a few times a minute and hands what is due to whichever window is open —
 * so a reminder only speaks while JARVIS is running, and one that fell due
 * while he was off is said when he next comes up, late rather than never.
 */
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const FILE = join(DIR, 'reminders.json')

/** A one-off this far past due is stale news, not a reminder, and is dropped. */
const TOO_LATE_MS = 12 * 60 * 60_000

function load() {
  try {
    const list = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function save(list) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(list, null, 2) + '\n')
}

const pad = (n) => String(n).padStart(2, '0')
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function listReminders() {
  return load()
}

/**
 * @param {{ text: string, at?: string, daily?: string, briefing?: boolean }} r
 *   at: a local date and time, "2026-10-09T18:00". daily: a time of day, "07:00".
 */
export function addReminder(r) {
  const list = load()
  const text = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
  const daily = /^([01]\d|2[0-3]):[0-5]\d$/.test(r.daily ?? '') ? r.daily : null
  const at = !daily && r.at && !Number.isNaN(new Date(r.at).getTime()) ? new Date(r.at).toISOString() : null
  if (!daily && !at) throw new Error('a reminder needs a time: either `at` or `daily`')
  if (!text && !r.briefing) throw new Error('a reminder needs something to say')
  if (list.length >= 50) throw new Error('there are already fifty reminders; cancel some first')
  const item = {
    id: Math.random().toString(36).slice(2, 8),
    text,
    at,
    daily,
    briefing: Boolean(r.briefing),
    // A daily reminder set after today's time has passed starts tomorrow.
    lastFired: daily && daily <= `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}` ? today() : null,
  }
  list.push(item)
  save(list)
  return item
}

/** Remove every reminder whose id is, or whose text contains, the given words. */
export function cancelReminders(about) {
  const needle = String(about ?? '').toLowerCase().trim()
  if (!needle) return 0
  const list = load()
  const kept = list.filter(
    (r) => r.id !== needle && !r.text.toLowerCase().includes(needle) && !(needle === 'briefing' && r.briefing),
  )
  if (kept.length !== list.length) save(kept)
  return list.length - kept.length
}

/** What is due right now. Marks it as done, so each is returned once. */
export function dueReminders(now = new Date()) {
  const list = load()
  if (!list.length) return []
  const due = []
  const kept = []
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  for (const r of list) {
    if (r.daily) {
      if (r.lastFired !== today(now) && clock >= r.daily) {
        r.lastFired = today(now)
        due.push(r)
      }
      kept.push(r)
    } else if (r.at && new Date(r.at) <= now) {
      // One-offs are spent when they fire; one that is long overdue is spent
      // without firing.
      if (now - new Date(r.at) < TOO_LATE_MS) due.push(r)
    } else {
      kept.push(r)
    }
  }
  if (due.length || kept.length !== list.length) save(kept)
  return due
}
