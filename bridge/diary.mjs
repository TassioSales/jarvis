import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compose } from './gemini.mjs'
import { news, weather } from './feeds.mjs'
import { agendaNow } from './agenda.mjs'

/**
 * A diary she keeps for him, in his Obsidian vault.
 *
 * ~/.jarvis is the vault (it has the .obsidian folder). Through the day every
 * exchange is appended to Diário/.raw/<date>.jsonl — a dot-folder, which
 * Obsidian does not show. At 23:30, or the next time the bridge starts if the
 * machine was off, the day is written up as Diário/<date>.md: a short account
 * of the day, what he asked for, the calendar, the weather, what the news was,
 * and the numbers — with links to the days either side, so it reads as a
 * journal in the graph view. She reads these back when asked "what did I do
 * on Tuesday".
 *
 * JARVIS_DIARY=0 turns it off; nothing is written then, not even the raw log.
 */
const OFF = process.env.JARVIS_DIARY === '0'
const VAULT = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
export const DIARY_DIR = join(VAULT, 'Diário')
const RAW = join(DIARY_DIR, '.raw')

const pad = (n) => String(n).padStart(2, '0')
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const shift = (key, days) => {
  const d = new Date(`${key}T12:00:00`)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

/** One exchange, as it happens. */
export function logTurn(role, text) {
  if (OFF || !text) return
  try {
    mkdirSync(RAW, { recursive: true })
    appendFileSync(
      join(RAW, `${dateKey()}.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), role, text: String(text).slice(0, 800) }) + '\n',
    )
  } catch {
    /* a diary line lost is not worth an answer lost */
  }
}

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8')
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

/** Write up one day. Returns the path written, or null if there was nothing to write. */
export async function writeDay(key) {
  if (OFF) return null
  const turns = readJsonl(join(RAW, `${key}.jsonl`))
  const traces = readJsonl(join(VAULT, 'traces.jsonl')).filter((t) => dateKey(new Date(t.at)) === key)
  const isToday = key === dateKey()
  if (!turns.length && !traces.length) return null

  const sky = isToday ? await weather().catch(() => null) : null
  const heads = isToday ? ((await news().catch(() => null)) ?? []).slice(0, 6) : []
  const events = agendaNow().filter((e) => dateKey(new Date(e.start)) === key)
  const cost = traces.reduce((a, t) => a + (t.cost || 0), 0)
  const quick = traces.filter((t) => t.brain !== 'claude').length

  const talk = turns
    .map((t) => `[${new Date(t.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}] ${t.role === 'user' ? 'Ele' : 'Wednesday'}: ${t.text}`)
    .join('\n')
  const date = new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const facts = [
    events.length && `Agenda: ${events.map((e) => `${e.allDay ? 'dia todo' : new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ${e.title}`).join('; ')}`,
    sky && `Clima em ${sky.city}: mínima ${Math.round(sky.today.min)}°, máxima ${Math.round(sky.today.max)}°, chuva ${sky.today.rain}%`,
    heads.length && `Manchetes: ${heads.map((h) => h.title).join(' | ')}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = await compose(`Você é Wednesday, a assistente pessoal dele, escrevendo o diário do dia dele para o Obsidian.
Escreva em português do Brasil, em markdown, na terceira pessoa sobre ele ("ele pediu…"), tom sóbrio e útil.
Seções, nesta ordem, omitindo as que não tiverem conteúdo:
## Resumo — 2 a 4 frases sobre como foi o dia.
## O que ele pediu — tópicos curtos, agrupando pedidos parecidos; destaque decisões e pendências.
## Pendências — o que ficou para depois, se houver.
## Agenda — SOMENTE os itens da linha "Agenda:" dos dados, copiados; se essa linha não existir, omita a seção. Lembretes pedidos na conversa vão em Pendências, não aqui.
## Clima — só se houver a linha "Clima" nos dados.
## Notícias do dia — no máximo 4, uma linha cada, só das "Manchetes" dos dados.
Não invente nada que não esteja nos dados. Não inclua o título nem a data; eles já estão na nota.

Data: ${date}
${facts}

Conversa do dia:
${talk || '(nenhuma conversa)'}`)

  const numbers =
    `## Números\n- Respostas: ${traces.length} (${quick} pelo cérebro rápido, ${traces.length - quick} pelo Claude)\n` +
    `- Custo equivalente na API: US$ ${cost.toFixed(2)}\n`
  const header =
    `---\ndata: ${key}\ntipo: diario\n---\n# ${date[0].toUpperCase()}${date.slice(1)}\n\n` +
    `← [[${shift(key, -1)}]] · [[${shift(key, 1)}]] →\n\n`
  const fallback = turns.length
    ? `## O que ele pediu\n${turns
        .filter((t) => t.role === 'user')
        .map((t) => `- ${t.text}`)
        .join('\n')}\n\n${facts ? `## Contexto\n${facts}\n\n` : ''}`
    : ''

  mkdirSync(DIARY_DIR, { recursive: true })
  const file = join(DIARY_DIR, `${key}.md`)
  writeFileSync(file, header + (body ? `${body}\n\n` : fallback) + numbers)
  return file
}

/** Days with a raw log and no written page, oldest first — written on start-up. */
export async function catchUp() {
  if (OFF) return
  let raws = []
  try {
    raws = readdirSync(RAW).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''))
  } catch {
    return
  }
  for (const key of raws.sort()) {
    if (key === dateKey()) continue
    if (!existsSync(join(DIARY_DIR, `${key}.md`))) await writeDay(key).catch(() => null)
  }
}

let lastWritten = ''
/** Called every minute; writes today's page once, at 23:30. */
export function diaryTick(now = new Date()) {
  if (OFF) return
  const key = dateKey(now)
  if (now.getHours() === 23 && now.getMinutes() >= 30 && lastWritten !== key) {
    lastWritten = key
    void writeDay(key)
      .then((file) => file && console.log(`[jarvis] diary written: ${file}`))
      .catch(() => {})
  }
}

/** For the prompt: where the diary is, so she reads it when asked about a past day. */
export function diaryNote() {
  if (OFF) return ''
  return (
    `\n\nHis diary: one page per day at ${DIARY_DIR.replace(/\\/g, '/')}/AAAA-MM-DD.md, written by you each night. ` +
    'When asked what he did, decided or asked on an earlier day, Read that page before answering. ' +
    'When asked to write today\'s page now, call `write_diary`.'
  )
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

export function diaryServer() {
  return createSdkMcpServer({
    name: 'jarvis_diary',
    version: '1.0.0',
    instructions: "His diary in the Obsidian vault: one page a day, written by you.",
    alwaysLoad: true,
    tools: [
      tool('write_diary', "Write (or rewrite) today's diary page now, from today's conversation, calendar, weather and news.", {}, async () => {
        const file = await writeDay(dateKey()).catch(() => null)
        return { content: [{ type: 'text', text: file ? `Written: ${file}` : 'Nothing to write about today yet.' }] }
      }),
    ],
  })
}
