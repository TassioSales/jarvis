import { BRIDGE_HTTP_URL, LANG, LANG_BASE } from '../config'
import { sky } from './weather'
import { t } from './i18n'

/**
 * The briefing: "good morning" answered as a sequence of cards, each one
 * spoken as it appears.
 *
 * Built here rather than asked of the model, for three reasons. It is the same
 * every day, so there is nothing to reason about. It has to start at once —
 * the model would spend ten seconds searching before the first word. And it
 * has to be right: a forecast read off an API is the forecast, where one
 * recalled by a model is a guess with a confident voice.
 *
 * So the bridge gathers the data (feeds.mjs), this turns it into scenes — a
 * card and the sentence that goes with it — and App plays them in order.
 * Whatever could not be fetched is simply not a scene; he never announces a
 * gap.
 */

export type Weather = {
  city: string
  region: string
  now: { temp: number; feels: number; humidity: number; wind: number; code: number }
  today: { min: number; max: number; rain: number }
  tomorrow: { min: number; max: number; rain: number }
}

export type Quote = { name: string; last: number; dayPct: number; monthPct: number }

export type Story = { topic: string; title: string; source: string; image: string | null; at: string }

export type Mail = { from: string; subject: string }
export type Appointment = { when: string; title: string }

export type BriefCard =
  | { kind: 'overview'; id: string; date: string; parts: string[] }
  | { kind: 'mail'; id: string; unread: number; items: Mail[] }
  | { kind: 'agenda'; id: string; items: Appointment[] }
  | { kind: 'weather'; id: string; weather: Weather }
  | { kind: 'markets'; id: string; quotes: Quote[] }
  | { kind: 'news'; id: string; story: Story }

export type Scene = { card: BriefCard | null; line: string }

type Data = { weather: Weather | null; markets: Quote[] | null; stories: Story[] }

/** The parts of the bridge's /today the briefing reads. */
type Today = {
  commute: { minutes: number; delay: number; toWork: boolean } | null
  agenda: { events: { title: string; start: string; allDay: boolean }[] }
  reminders: { text: string; at: string }[]
}

const PT = LANG_BASE === 'pt'
const n = (v: number) => String(Math.round(v))
/** Money as it is said: two decimals below a thousand, none above. */
const cash = (v: number) =>
  v.toLocaleString(LANG, {
    minimumFractionDigits: v >= 1000 ? 0 : 2,
    maximumFractionDigits: v >= 1000 ? 0 : 2,
  })

function greeting(now: Date): string {
  const h = now.getHours()
  if (PT) return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function movement(pct: number): string {
  const size = Math.abs(pct).toFixed(1).replace('.', PT ? ',' : '.')
  if (Math.abs(pct) < 0.05) return PT ? 'estável' : 'flat'
  if (PT) return `em ${pct > 0 ? 'alta' : 'queda'} de ${size} por cento`
  return `${pct > 0 ? 'up' : 'down'} ${size} percent`
}

export async function loadScenes(now = new Date()): Promise<Scene[]> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/briefing`, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`briefing ${res.status}`)
  const data = (await res.json()) as Data

  const scenes: Scene[] = []
  const date = now.toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' })

  const parts = [
    data.weather && t('WEATHER'),
    data.markets?.length && t('MARKETS'),
    data.stories.length && t('HEADLINES'),
  ].filter(Boolean) as string[]
  // Nothing came back at all: no scenes, and the caller falls back to the model.
  if (!parts.length) return []

  scenes.push({
    card: { kind: 'overview', id: 'overview', date, parts },
    line: PT ? `Bom dia, senhor Tássio. Sistemas Stark online. Hoje é ${date}.` : `${greeting(now)}, sir. All systems online. Today is ${date}.`,
  })

  if (data.weather) {
    const w = data.weather
    const condition = t(sky(w.now.code)).toLowerCase()
    scenes.push({
      card: { kind: 'weather', id: 'weather', weather: w },
      line: PT
        ? `Em ${w.city}, faz ${n(w.now.temp)} graus, com ${condition}. ` +
          `A mínima será de ${n(w.today.min)} e a máxima de ${n(w.today.max)}, ` +
          `com ${n(w.today.rain)} por cento de chance de chuva.`
        : `In ${w.city} it is ${n(w.now.temp)} degrees, ${condition}. ` +
          `A low of ${n(w.today.min)} and a high of ${n(w.today.max)}, ` +
          `with a ${n(w.today.rain)} percent chance of rain.`,
    })
  }

  // His own day: the drive, what is on the calendar, what he asked to be
  // reminded of. From the bridge's own sources (the ICS calendar, TomTom, the
  // reminders), so it needs no model and is there even with no mail connector.
  const today = await fetch(`${BRIDGE_HTTP_URL}/today`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? (r.json() as Promise<Today>) : null))
    .catch(() => null)
  if (today && PT) {
    const c = today.commute
    if (c) {
      scenes.push({
        card: null,
        line:
          `${c.toWork ? 'Até o trabalho' : 'Até em casa'} são ${c.minutes} minutos agora` +
          (c.delay >= 5 ? `, ${c.delay} a mais que o normal por causa do trânsito.` : ', trânsito tranquilo.'),
      })
    }
    const end = new Date(now)
    end.setHours(23, 59, 59, 999)
    const events = (today.agenda?.events ?? []).filter((e) => {
      const s = new Date(e.start)
      return s >= new Date(now.getTime() - 30 * 60_000) && s <= end
    })
    const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })
    if (events.length) {
      const first = events.find((e) => !e.allDay)
      scenes.push({
        card: {
          kind: 'agenda',
          id: 'agenda-ics',
          items: events.slice(0, 5).map((e) => ({ when: e.allDay ? 'dia todo' : hhmm(e.start), title: e.title })),
        },
        line:
          `Na agenda de hoje, ${events.length === 1 ? 'um compromisso' : `${events.length} compromissos`}` +
          (first ? `; o primeiro às ${hhmm(first.start)}: ${first.title}.` : '.'),
      })
    }
    const reminders = (today.reminders ?? [])
      .filter((r) => {
        const at = new Date(r.at)
        return at > now && at <= end && r.text !== 'Briefing do dia'
      })
      .sort((a, b) => a.at.localeCompare(b.at))
    if (reminders.length) {
      scenes.push({
        card: null,
        line:
          reminders.length === 1
            ? `E um lembrete, às ${hhmm(reminders[0].at)}: ${reminders[0].text}.`
            : `E ${reminders.length} lembretes hoje; o próximo às ${hhmm(reminders[0].at)}: ${reminders[0].text}.`,
      })
    }
  }

  if (data.markets?.length) {
    const by =Object.fromEntries(data.markets.map((q) => [q.name, q]))
    const said: string[] = []
    if (by.USD) {
      said.push(
        PT
          ? `o dólar está em ${cash(by.USD.last)} reais, ${movement(by.USD.dayPct)} no dia`
          : `the dollar is at ${cash(by.USD.last)} reais, ${movement(by.USD.dayPct)} on the day`,
      )
    }
    if (by.EUR) said.push(PT ? `o euro, em ${cash(by.EUR.last)}` : `the euro at ${cash(by.EUR.last)}`)
    if (by.BTC) {
      said.push(
        PT
          ? `e o bitcoin, em ${n(by.BTC.last / 1000)} mil reais`
          : `and bitcoin at ${n(by.BTC.last / 1000)} thousand reais`,
      )
    }
    scenes.push({
      card: { kind: 'markets', id: 'markets', quotes: data.markets },
      line: `${PT ? 'Nos mercados' : 'In the markets'}, ${said.join(', ')}.`,
    })
  }

  if (data.stories?.length) {
    for (const story of data.stories.slice(0, 3)) {
      // A headline that already ends in punctuation would otherwise be read
      // with a doubled stop, which the voice renders as an awkward pause.
      const title = story.title.replace(/[.!?…\s]+$/, '')
      scenes.push({
        card: { kind: 'news', id: `news-${story.topic}`, story },
        line: PT
          ? `Em notícias de ${story.topic}: ${title}. Informações do ${story.source}.`
          : `In ${story.topic}: ${title}. That is from ${story.source}.`,
      })
    }
  }

  scenes.push({
    card: null,
    line: PT
      ? 'Todos os sistemas e mineradoras Grass e DAWN operando com eficiência máxima, senhor.'
      : 'All systems and mining nodes operating at peak efficiency, sir.',
  })

  return scenes
}

export async function loadNightScenes(_now = new Date()): Promise<Scene[]> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/briefing`, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  const data = res?.ok ? ((await res.json()) as Data) : null

  const scenes: Scene[] = []

  scenes.push({
    card: {
      kind: 'overview',
      id: 'night-overview',
      date: 'Protocolo Noturno Stark',
      parts: ['Modo Standby Ativado', 'DePIN: Grass & DAWN em Execução', 'Sensores: Vigilância Contínua'],
    },
    line: PT
      ? 'Boa noite, senhor Tássio. Protocolo de encerramento noturno Stark executado.'
      : 'Good night, sir. Stark night protocol executed.',
  })

  if (data?.weather?.tomorrow) {
    const tm = data.weather.tomorrow
    scenes.push({
      card: { kind: 'weather', id: 'weather-night', weather: data.weather },
      line: PT
        ? `Para amanhã em ${data.weather.city}, previsão de mínima de ${n(tm.min)} e máxima de ${n(tm.max)} graus, com ${n(tm.rain)} por cento de probabilidade de chuva.`
        : `Tomorrow's forecast for ${data.weather.city}: low of ${n(tm.min)} and high of ${n(tm.max)} degrees.`,
    })
  }

  if (data?.markets?.length) {
    const by = Object.fromEntries(data.markets.map((q) => [q.name, q]))
    const said: string[] = []
    if (by.USD) said.push(`dólar a ${cash(by.USD.last)}`)
    if (by.EUR) said.push(`euro a ${cash(by.EUR.last)}`)
    if (by.BTC) said.push(`bitcoin a ${n(by.BTC.last / 1000)} mil`)
    scenes.push({
      card: { kind: 'markets', id: 'markets-night', quotes: data.markets },
      line: PT ? `No fechamento dos mercados: ${said.join(', ')}.` : `Market close: ${said.join(', ')}.`,
    })
  }

  if (data?.stories?.length) {
    for (const story of data.stories.slice(0, 3)) {
      const title = story.title.replace(/[.!?…\s]+$/, '')
      scenes.push({
        card: { kind: 'news', id: `night-news-${story.topic}`, story },
        line: PT
          ? `No resumo de notícias: em ${story.topic}, ${title}. Divulgado pelo ${story.source}.`
          : `In the evening news: in ${story.topic}, ${title}. Reported by ${story.source}.`,
      })
    }
  }

  scenes.push({
    card: null,
    line: PT
      ? 'Mineradoras Grass e DAWN mantidas ativas em segundo plano. Estação em repouso operacional, senhor.'
      : 'Grass and DAWN nodes active in background. Workstation entering sleep mode, sir.',
  })

  return scenes
}

/** Remote pictures go through the bridge; the page's CSP allows nothing else. */
export const proxied = (url: string) => `${BRIDGE_HTTP_URL}/img?url=${encodeURIComponent(url)}`

/**
 * The part of the briefing only the model can do: reading the inbox and the
 * calendar, and deciding which of twenty unread messages is the one that
 * matters.
 *
 * It runs through the same session as any other question, using whatever mail
 * and calendar connectors Claude Code has. The reply is data for the screen,
 * not something to be spoken, so it asks for JSON and says so plainly — the
 * persona is otherwise forbidden from producing anything but prose. The
 * sentence he will say is asked for too: he words a summary of someone's mail
 * better than a template would.
 *
 * Everything in that mail is someone else's text. The bridge runs read-only by
 * default, which is what makes it safe to let a model read an inbox unattended.
 */
export const INBOX_PROMPT = PT
  ? 'DADOS PARA O PAINEL, NÃO PARA FALAR. Esta resposta não será lida em voz alta: responda ' +
    'somente com um objeto JSON, sem texto antes ou depois, sem markdown. Use as ferramentas de ' +
    'e-mail e de agenda (somente leitura). 1) E-mails: procure os não lidos na caixa de entrada ' +
    'das últimas 24 horas e escolha até 3 que realmente pedem ação da pessoa (ignore newsletters, ' +
    'promoções e notificações automáticas). 2) Agenda: liste os eventos de hoje e de amanhã. ' +
    'Formato exato: {"email":{"unread":número,"items":[{"from":"remetente curto","subject":' +
    '"assunto em até 70 caracteres"}],"line":"uma ou duas frases para o mordomo dizer, no estilo: ' +
    'Há N e-mails não lidos, dos quais M merecem atenção. O principal ..."},"agenda":{"items":' +
    '[{"when":"hoje 14h","title":"título curto"}],"line":"uma frase sobre a agenda"}}. As frases ' +
    'em "line" tratam a pessoa por senhor, sem ler endereços de e-mail nem links. Se uma ' +
    'ferramenta não estiver disponível, use null no lugar daquele bloco.'
  : 'DATA FOR THE DISPLAY, NOT FOR SPEECH. This reply will not be read aloud: answer with a single ' +
    'JSON object and nothing else, no markdown. Use the mail and calendar tools (read-only). ' +
    '1) Mail: find unread inbox messages from the last 24 hours and pick up to 3 that genuinely ' +
    'need the person to act (ignore newsletters, promotions and automated notifications). ' +
    '2) Calendar: list today\'s and tomorrow\'s events. Exact shape: {"email":{"unread":number,' +
    '"items":[{"from":"short sender","subject":"subject, 70 characters at most"}],"line":"one or ' +
    'two sentences for the butler to say"},"agenda":{"items":[{"when":"today 2pm","title":"short ' +
    'title"}],"line":"one sentence about the calendar"}}. The "line" sentences address the person ' +
    'as sir and never read out addresses or links. If a tool is unavailable, use null for that block.'

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Turn the model's reply into scenes. Returns none for anything that is not
 * the shape asked for — a briefing with the mail left out is fine, one that
 * reads a malformed reply aloud is not.
 */
export function inboxScenes(reply: string): Scene[] {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '') as Record<string, unknown>
  } catch {
    return []
  }
  const scenes: Scene[] = []

  const email = data.email as { unread?: unknown; items?: unknown; line?: unknown } | null
  if (email && text(email.line, 400)) {
    const items = (Array.isArray(email.items) ? email.items : [])
      .slice(0, 3)
      .map((m: Record<string, unknown>) => ({ from: text(m?.from, 40), subject: text(m?.subject, 90) }))
      .filter((m) => m.subject)
    scenes.push({
      card: { kind: 'mail', id: 'mail', unread: Number(email.unread) || items.length, items },
      line: text(email.line, 400),
    })
  }

  const agenda = data.agenda as { items?: unknown; line?: unknown } | null
  if (agenda && text(agenda.line, 300)) {
    const items = (Array.isArray(agenda.items) ? agenda.items : [])
      .slice(0, 5)
      .map((e: Record<string, unknown>) => ({ when: text(e?.when, 30), title: text(e?.title, 80) }))
      .filter((e) => e.title)
    scenes.push({ card: { kind: 'agenda', id: 'agenda', items }, line: text(agenda.line, 300) })
  }

  return scenes
}
