import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { addReminder, cancelReminders, listReminders } from './reminders.mjs'

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

/**
 * Add one fact, unless it is empty, already there, or the file is full.
 * Shared by the `remember` tool and by what he learns on his own (learn.mjs).
 *
 * @returns {'empty' | 'known' | 'full' | 'added'}
 */
export function addFact(fact) {
  const clean = String(fact ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
  if (!clean) return 'empty'
  const list = facts()
  if (list.some((f) => f.toLowerCase() === clean.toLowerCase())) return 'known'
  if (list.length >= MAX_FACTS) return 'full'
  if (list.length) appendFileSync(FILE, `- ${clean}\n`)
  else save([clean])
  return 'added'
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

/**
 * Notes are the other half of memory: not facts about the user, but things the
 * user wants kept — a prompt, a list, an idea dictated across the room. One
 * markdown file each, in a `notes` folder beside the memory, which is also a
 * folder Obsidian can open as a vault.
 *
 * The same bargain as `remember`: it writes with writes off, and is allowed to
 * because of how little it can reach — one folder, a name it cannot use to
 * climb out of that folder, text only, a size cap.
 */
const NOTES = join(DIR, 'notes')

/** A title as a file name: no path separators, no dots to climb with. */
const slug = (title) =>
  String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || 'nota'

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

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
        async ({ fact }) =>
          text(
            {
              empty: 'Nothing to remember.',
              known: 'Already known.',
              full: 'Memory is full. Ask them what may be forgotten.',
              added: 'Remembered.',
            }[addFact(fact)],
          ),
      ),
      tool(
        'save_note',
        'Write something down for them: a note, a prompt, a list, an idea they ' +
          'dictated. Use it when they ask you to note, save, write down or keep ' +
          'a text — as opposed to `remember`, which is for short facts about ' +
          'them. Saved as a markdown file they can open in any editor. If a note ' +
          'with the same title exists, the new text is added beneath the old.',
        {
          title: z.string().describe('A short title; it becomes the file name.'),
          text: z.string().describe('The note itself, as markdown or plain text.'),
        },
        async ({ title, text: body }) => {
          const content = String(body ?? '').trim().slice(0, 20_000)
          if (!content) return text('Nothing to write down.')
          mkdirSync(NOTES, { recursive: true })
          const file = join(NOTES, `${slug(title)}.md`)
          let existing = ''
          try {
            existing = readFileSync(file, 'utf8')
          } catch {
            // a new note
          }
          writeFileSync(
            file,
            existing
              ? `${existing.trimEnd()}\n\n---\n*${stamp()}*\n\n${content}\n`
              : `# ${String(title).trim()}\n\n*${stamp()}*\n\n${content}\n`,
          )
          return text(`Saved to ${file}.`)
        },
      ),
      tool(
        'remind',
        'Arrange to say something later, or every day. Give `at` for a single ' +
          'time, as a local date and time like 2026-10-09T18:00, or `daily` for ' +
          'a time of day like 07:00 that repeats. Set `briefing` to true to run ' +
          'the morning briefing at that time instead of saying a sentence. He ' +
          'only speaks reminders while he is running; one that fell due while ' +
          'he was off is said when he is next started.',
        {
          text: z.string().optional().describe('What to say when the time comes, as he would say it.'),
          at: z.string().optional().describe('One time: local date and time, YYYY-MM-DDTHH:MM.'),
          daily: z.string().optional().describe('Every day at this time: HH:MM, 24-hour.'),
          briefing: z.boolean().optional().describe('Run the briefing instead of saying `text`.'),
        },
        async (args) => {
          try {
            const r = addReminder(args)
            return text(
              r.daily
                ? `Set: every day at ${r.daily}${r.briefing ? ', the briefing' : ''}. id ${r.id}`
                : `Set for ${new Date(r.at).toLocaleString()}. id ${r.id}`,
            )
          } catch (err) {
            return text(`Not set: ${err.message}`)
          }
        },
      ),
      tool(
        'list_reminders',
        'What he has been asked to say later, with the id of each.',
        {},
        async () => {
          const list = listReminders()
          if (!list.length) return text('No reminders are set.')
          return text(
            list
              .map(
                (r) =>
                  `${r.id}: ${r.daily ? `daily ${r.daily}` : new Date(r.at).toLocaleString()} — ` +
                  (r.briefing ? 'the briefing' : r.text),
              )
              .join('\n'),
          )
        },
      ),
      tool(
        'cancel_reminder',
        'Cancel reminders: by id, or every one whose text contains the given words.',
        { about: z.string().describe('An id, or words from the reminder.') },
        async ({ about }) => {
          const n = cancelReminders(about)
          return text(n ? `Cancelled: ${n}.` : 'No such reminder.')
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
