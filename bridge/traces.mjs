import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs'

/**
 * One line per answered question: which brain answered, how long the user
 * waited, what it cost, which tools ran. After OpenJarvis (Stanford), which
 * treats latency and cost as first-class alongside whether the answer was
 * right, and learns from exactly this kind of local trace.
 *
 * What it buys here: the core monitor can say how much the quick brain saved,
 * how long answers really take, and what a day of questions cost — numbers,
 * not impressions. The text of the question is not stored, only its length:
 * the trace is about the machine, not about what was said.
 *
 * ~/.jarvis/traces.jsonl, rolled over at 5 MB. JARVIS_TRACES=0 turns it off.
 */
const OFF = process.env.JARVIS_TRACES === '0'
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const FILE = join(DIR, 'traces.jsonl')

/**
 * @param {{ brain: 'gemini' | 'claude' | 'standin', ms: number, costUsd?: number | null,
 *           tools?: string[], ok?: boolean, chars?: number }} t
 */
export function recordTrace(t) {
  if (OFF) return
  try {
    mkdirSync(DIR, { recursive: true })
    try {
      if (statSync(FILE).size > 5 * 1024 * 1024) renameSync(FILE, `${FILE}.1`)
    } catch {
      /* no file yet */
    }
    appendFileSync(
      FILE,
      JSON.stringify({
        at: new Date().toISOString(),
        brain: t.brain,
        ms: Math.round(t.ms),
        cost: t.costUsd ?? 0,
        tools: t.tools ?? [],
        ok: t.ok !== false,
        chars: t.chars ?? 0,
      }) + '\n',
    )
  } catch {
    /* a lost trace is not worth a lost answer */
  }
}

function read() {
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Today and the last thirty days, by brain. `saved` is what the questions the
 * quick brain answered would have cost had Claude answered them, at Claude's
 * median cost per answer over the same period — an estimate, labelled as one.
 */
export function traceSummary(now = new Date()) {
  const all = read()
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const monthStart = now.getTime() - 30 * 86_400_000
  const sum = (list) => {
    const by = (b) => list.filter((t) => t.brain === b)
    const claude = by('claude')
    const quick = list.filter((t) => t.brain !== 'claude')
    const claudeCost = claude.reduce((a, t) => a + (t.cost || 0), 0)
    const perClaude = median(claude.map((t) => t.cost || 0).filter((c) => c > 0)) ?? 0
    return {
      answers: list.length,
      claude: claude.length,
      quick: quick.length,
      cost: Math.round(claudeCost * 1000) / 1000,
      saved: Math.round(quick.length * perClaude * 1000) / 1000,
      msClaude: median(claude.map((t) => t.ms)),
      msQuick: median(quick.map((t) => t.ms)),
      tools: claude.reduce((a, t) => a + (t.tools?.length || 0), 0),
    }
  }
  return {
    today: sum(all.filter((t) => new Date(t.at) >= dayStart)),
    month: sum(all.filter((t) => new Date(t.at).getTime() >= monthStart)),
  }
}
