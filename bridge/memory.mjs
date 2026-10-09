import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * What JARVIS knows about the person he works for, kept between sessions.
 *
 * Every conversation otherwise starts from nothing: he asks which city the
 * weather is for on Monday and again on Tuesday. This is one markdown file of
 * short facts, read into the system prompt when a session opens and appended
 * to when he is told something worth keeping.
 *
 * A plain file, in the open, on purpose. It can be read, corrected or emptied
 * in any editor — or dropped into an Obsidian vault — and that is the whole
 * review mechanism: nothing he remembers is anywhere the user cannot see it.
 *
 * It is the one thing this bridge writes with ALLOW_WRITES off, which is
 * acceptable because of how little it can do: one fixed path, append or remove
 * a single line, a hard size cap. It cannot be pointed at another file.
 */
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const FILE = join(DIR, 'memory.md')

/** Past this the file stops growing; an unbounded prompt is a slow, dear one. */
const MAX_FACTS = 150
const MAX_FACT_CHARS = 240

function facts() {
  try {
    return readFileSync(FILE, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^[-*]\s+/, '').trim())
      .filter((l) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

function save(list) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, `# JARVIS memory\n\n${list.map((f) => `- ${f}`).join('\n')}\n`)
}

/** The stored facts, oldest first — what the side monitor lists. */
export const memoryFacts = () => facts()

/** The block appended to the system prompt, or '' when there is nothing yet. */
export function memoryNote() {
  const list = facts().slice(-MAX_FACTS)
  if (!list.length) return ''
  return (
    '\n\nWhat you already know about them, from earlier sessions. Use it ' +
    'without remarking that you remembered:\n' +
    list.map((f) => `- ${f}`).join('\n')
  )
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'Durable facts about the user, kept between sessions in a file they can read.',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Keep one durable fact about the user for future sessions: their city, ' +
          'their name for something, a standing preference, a recurring commitment. ' +
          'Use it when they tell you something that will still be true next week, ' +
          'or ask you to remember. One short sentence, written as a fact. Never ' +
          'store passwords, keys, card numbers or anything they said in confidence ' +
          'about someone else. Do not announce that you stored it unless they asked.',
        { fact: z.string().describe('The fact, as one short sentence.') },
        async ({ fact }) => {
          const clean = String(fact).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
          if (!clean) return text('Nothing to remember.')
          const list = facts()
          if (list.some((f) => f.toLowerCase() === clean.toLowerCase())) {
            return text('Already known.')
          }
          if (list.length >= MAX_FACTS) {
            return text('Memory is full. Ask them what may be forgotten.')
          }
          if (list.length) appendFileSync(FILE, `- ${clean}\n`)
          else save([clean])
          return text('Remembered.')
        },
      ),
      tool(
        'forget',
        'Remove what you know about something, when they ask you to forget it or ' +
          'correct it. Removes every stored fact containing the given words.',
        { about: z.string().describe('Words that identify the fact to drop.') },
        async ({ about }) => {
          const needle = String(about).toLowerCase().trim()
          if (!needle) return text('Nothing named.')
          const list = facts()
          const kept = list.filter((f) => !f.toLowerCase().includes(needle))
          if (kept.length === list.length) return text('No such fact on record.')
          save(kept)
          return text(`Forgotten: ${list.length - kept.length}.`)
        },
      ),
    ],
  })
}
