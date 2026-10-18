import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extractFacts, geminiReady } from './gemini.mjs'
import { addFact, memoryFacts } from './memory.mjs'

/**
 * What he learns by himself, without being told.
 *
 * Two kinds of learning, both kept in plain files under ~/.jarvis that the
 * user can read, edit or delete:
 *
 * 1. Facts. When a conversation goes quiet, the small model reads it back and
 *    picks out what the user said about themselves that will still be true
 *    next month — the same thing `remember` does when asked, done unasked.
 *    Marked "(aprendido)" in memory.md so it is clear which ones he inferred.
 *
 * 2. Habits. Every action he carries out is logged with the time. An action
 *    repeated at about the same time of day on three or more different days
 *    is a habit; he then offers to do it at that time, once a day, and stops
 *    offering as soon as it has been done that day or he is told to stop.
 *
 * Statistics, not a neural network: the evidence is a handful of events a
 * week, and a rule anyone can read beats a model nobody can audit at that
 * size. JARVIS_LEARN=0 turns all of it off.
 */
const OFF = process.env.JARVIS_LEARN === '0'
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const LOG = join(DIR, 'habits.jsonl')
const STATE = join(DIR, 'habits-state.json')

/** How close in time two occurrences must be to count as the same habit. */
const WINDOW_MIN = 40
/** Distinct days an action needs, at about the same time, to be a habit. */
const MIN_DAYS = 3
/** Only the recent past says anything about what he does now. */
const LOOKBACK_DAYS = 30
/** Offers in one day, at most. More than this is nagging. */
const MAX_OFFERS_A_DAY = 3

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const minuteOf = (d) => d.getHours() * 60 + d.getMinutes()
const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

// ------------------------------------------------------------------ actions

/**
 * The actions worth learning, and how each is described and offered.
 * A signature groups what is "the same thing": the same program, the same
 * routine, the same destination — but any song, since what repeats is putting
 * music on, not the track.
 */
function describe(toolName, input = {}) {
  const t = toolName.split('__').slice(2).join('__')
  const server = toolName.split('__')[1]
  if (server === 'jarvis_do' && t === 'play') {
    return { sig: 'play', desc: 'colocar música no Spotify', offer: 'Coloque para tocar no Spotify uma música de que eu goste.' }
  }
  if (server === 'jarvis_do' && t === 'open' && input.target) {
    const what = String(input.target).slice(0, 80)
    return { sig: `open:${what.toLowerCase()}`, desc: `abrir ${what}`, offer: `Abra ${what}.` }
  }
  if (server === 'jarvis_do' && t === 'run_routine' && input.name) {
    const name = String(input.name).slice(0, 60)
    return { sig: `routine:${name.toLowerCase()}`, desc: `rodar a rotina ${name}`, offer: `Rode a rotina ${name}.` }
  }
  if (server === 'jarvis_maps' && t === 'route' && input.to) {
    const to = String(input.to).slice(0, 80)
    return { sig: `route:${to.toLowerCase()}`, desc: `ver o trânsito até ${to}`, offer: `Como está o trânsito agora de ${input.from} até ${to}?` }
  }
  return null
}

/** Note that an action was carried out. Called by the bridge once it has run. */
export function recordAction(toolName, input) {
  if (OFF) return
  const d = describe(toolName, input)
  if (!d) return
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...d }) + '\n')
  } catch {
    /* learning is a nicety; never let it break an action */
  }
}

function events() {
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((e) => e && Date.parse(e.at) >= since)
  } catch {
    return []
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return { ignored: [], offered: {} }
  }
}
const saveState = (s) => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n')
}

/**
 * The habits in the log: for each action, the time of day around which it
 * happens on the most distinct days. Minutes are compared on a circle, so
 * 23:50 and 00:10 are twenty minutes apart, not a day.
 */
export function habits() {
  const ignored = new Set(loadState().ignored)
  const bySig = new Map()
  for (const e of events()) {
    if (ignored.has(e.sig)) continue
    const at = new Date(e.at)
    const list = bySig.get(e.sig) ?? []
    list.push({ ...e, day: dayOf(at), min: minuteOf(at) })
    bySig.set(e.sig, list)
  }
  const gap = (a, b) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b))
  const found = []
  for (const [sig, list] of bySig) {
    let best = null
    for (const centre of list) {
      const near = list.filter((e) => gap(e.min, centre.min) <= WINDOW_MIN)
      const days = new Set(near.map((e) => e.day))
      if (!best || days.size > best.days.size) best = { near, days }
    }
    if (!best || best.days.size < MIN_DAYS) continue
    // The typical time: the median of the occurrences in the cluster.
    const mins = best.near.map((e) => e.min).sort((a, b) => a - b)
    const at = mins[Math.floor(mins.length / 2)]
    const last = list[list.length - 1]
    found.push({ sig, desc: last.desc, offer: last.offer, at, time: clock(at), days: best.days.size, lastDay: last.day })
  }
  return found.sort((a, b) => a.at - b.at)
}

/** The block added to the system prompt, or '' with nothing learned yet. */
export function habitsNote() {
  if (OFF) return ''
  const list = habits()
  if (!list.length) return ''
  return (
    '\n\nHabits you have noticed (from what you did for them, not from what they said):\n' +
    list.map((h) => `- Around ${h.time}: ${h.desc} (${h.days} days in the last month).`).join('\n') +
    '\nYou may mention one when it is useful; if they say to stop suggesting one, call `ignore_habit`.'
  )
}

/**
 * The habit to offer right now, if any: its time is within a few minutes,
 * it has not been done today, has not been offered today, and today's
 * allowance of offers is not spent. Marks it offered.
 *
 * @returns {{ text: string, offer: string } | null}
 */
export function dueOffer(now = new Date()) {
  if (OFF) return null
  const today = dayOf(now)
  const minute = minuteOf(now)
  const state = loadState()
  const offeredToday = Object.values(state.offered).filter((d) => d === today).length
  if (offeredToday >= MAX_OFFERS_A_DAY) return null
  for (const h of habits()) {
    if (Math.abs(minute - h.at) > 3) continue
    if (h.lastDay === today || state.offered[h.sig] === today) continue
    state.offered[h.sig] = today
    saveState(state)
    return {
      text: `Senhor, por volta deste horário o senhor costuma ${h.desc}. Deseja que eu faça isso agora?`,
      offer: h.offer,
    }
  }
  return null
}

// --------------------------------------------------------------------- facts

/**
 * Read a finished conversation back and keep what it taught. Returns what was
 * added, so the bridge can log it.
 */
export async function learnFromConversation(history) {
  if (OFF || !geminiReady()) return []
  const users = history.filter((t) => t.role === 'user')
  if (!users.length) return []
  const found = await extractFacts(history, memoryFacts())
  const added = []
  for (const fact of found) {
    if (addFact(`${fact.trim()} (aprendido)`) === 'added') added.push(fact)
  }
  return added
}

// ---------------------------------------------------------------------- tools

export function learnServer() {
  return createSdkMcpServer({
    name: 'jarvis_learn',
    version: '1.0.0',
    instructions: 'The habits he has noticed in what he does for the user, and the means to drop one.',
    alwaysLoad: true,
    tools: [
      tool('list_habits', 'The habits noticed so far: what, at about what time, on how many days.', {}, async () => {
        const list = habits()
        return {
          content: [
            {
              type: 'text',
              text: list.length
                ? list.map((h) => `${h.time} — ${h.desc} (${h.days} dias)`).join('\n')
                : 'No habits noticed yet.',
            },
          ],
        }
      }),
      tool(
        'ignore_habit',
        'Stop noticing and offering a habit, when they say they do not want it suggested. ' +
          'Give words from its description ("spotify", "trânsito", "vs code").',
        { about: z.string() },
        async ({ about }) => {
          const needle = String(about).toLowerCase()
          const hit = habits().filter((h) => h.desc.toLowerCase().includes(needle) || h.sig.includes(needle))
          if (!hit.length) return { content: [{ type: 'text', text: 'No habit matches that.' }] }
          const state = loadState()
          state.ignored = [...new Set([...(state.ignored ?? []), ...hit.map((h) => h.sig)])]
          saveState(state)
          return { content: [{ type: 'text', text: `Will no longer suggest: ${hit.map((h) => h.desc).join(', ')}.` }] }
        },
      ),
    ],
  })
}
