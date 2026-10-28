import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../lib/sync'
import { BRIDGE_HTTP_URL, LANG } from '../config'
import { t } from '../lib/i18n'
import { sky } from '../lib/weather'
import { proxied } from '../lib/briefing'
import { BarChart, LineChart } from './charts'
import { SkyIcon } from './glyphs'
import { Dot, Frame, Ring, Segments, Spark, SunArc, Ticker, type Lamp } from './hx'
import { bytes } from './format'
import { Constellation } from './Constellation'
import './monitors.css'

/**
 * The three side-monitor views, each meant to be worth a glance from across
 * the room:
 *
 *   Day   — what the next hours hold for him: the time and the sun, the sky in
 *           full, the drive, what is due, what is playing, what she has learned.
 *   World — the news, led by the story with a picture and checked against how
 *           many outlets carry each headline, the markets, and a running ticker.
 *   Core  — her and the machine: every service and whether it works, how the
 *           voice is doing, the conversation, and the processor, graphics card,
 *           memory, disks, network and heaviest processes.
 *
 * Everything is polled from the bridge, on a pace that suits what it shows.
 */

// ---------------------------------------------------------------- the data

type Weather = {
  city: string
  region: string
  now: { temp: number; feels: number; humidity: number; wind: number; code: number; uv: number | null; day: boolean }
  today: { min: number; max: number; rain: number }
  tomorrow: { min: number; max: number; rain: number }
  hours: { time: string; temp: number; rain: number }[]
  week?: { date: string; code: number; min: number; max: number; rain: number }[]
  sun?: { rise: string | null; set: string | null }
  uvMax?: number | null
  air?: { aqi: number | null; pm25: number | null; pm10: number | null } | null
}
type Outlook = { months: { month: string; mm: number; low: number; high: number }[] }
type Today = {
  reminders: { text: string; at: string | null; daily: string | null }[]
  habits: { time: string; desc: string; days: number }[]
  notes: { title: string; at: string }[]
  facts: string[]
  allFacts?: string[]
  diaryDays?: number
  playing: { app: string; status: string; artist: string; title: string } | null
  commute: { from: string; to: string; minutes: number; km: number; delay: number; usual: number | null; toWork: boolean } | null
  commuteSet: boolean
  agenda?: { configured: boolean; events: { title: string; start: string; end: string; allDay: boolean; location: string }[]; error?: string | null }
}
type Headline = { title: string; source: string; at: string; outlets?: string[] }
type Story = { topic: string; title: string; source: string; image: string | null; at: string }
type Quote = { name: string; last: number; dayPct: number; monthPct: number; points: { at: string; value: number }[] }
type Status = {
  model: string
  effort: string
  services: { id: string; label: string; state: Lamp; detail: string }[]
  stats: {
    since: string
    answers: { gemini: number; claude: number }
    heard: { local: number; elevenlabs: number; gemini: number }
    sttAvg: number | null
  }
  /** From the per-answer traces (bridge/traces.mjs). */
  traces?: { today: TraceDay; month: TraceDay }
}
type TraceDay = {
  answers: number
  claude: number
  quick: number
  cost: number
  saved: number
  msClaude: number | null
  msQuick: number | null
  tools: number
}
type System = {
  host: string
  uptime: number
  cpu: { now: number; cores: number; name: string; history: number[] }
  mem: { used: number; total: number }
  gpu: { name: string; util: number | null; memUsed: number | null; memTotal: number | null; temp: number | null; power: number | null } | null
  net: { down: number; up: number } | null
  netHistory: { down: number; up: number }[]
  disks: { name: string; total: number; free: number }[]
  top: { name: string; cpu: number; mem: number; count: number }[]
}

/** Poll one bridge endpoint; keep the last good answer through a failed read. */
function usePoll<T>(path: string, everyMs: number): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let gone = false
    const read = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}${path}`)
        if (res.ok && !gone) setData((await res.json()) as T)
      } catch {
        /* keep what we have */
      }
    }
    void read()
    const timer = setInterval(read, everyMs)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [path, everyMs])
  return data
}

function useClock(everyMs = 1000) {
  const [time, setTime] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return time
}

const deg = (n: number) => `${Math.round(n)}°`
const secs = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)
const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`)
const hour = (iso: string) => `${iso.slice(11, 13)}h`
const pad = (n: number) => String(n).padStart(2, '0')

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return t('now')
  if (minutes < 60) return `${minutes} ${t('min ago')}`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} ${t('h ago')}`
  return new Date(iso).toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' })
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${pad(m)}m`
}

/** UV, as the WHO bands it. */
function uvBand(uv: number): { label: string; lamp: Lamp } {
  if (uv < 3) return { label: t('low'), lamp: 'ok' }
  if (uv < 6) return { label: t('moderate'), lamp: 'ok' }
  if (uv < 8) return { label: t('high'), lamp: 'warn' }
  if (uv < 11) return { label: t('very high'), lamp: 'down' }
  return { label: t('extreme'), lamp: 'down' }
}

/** US AQI, as the EPA bands it. */
function aqiBand(aqi: number): { label: string; lamp: Lamp } {
  if (aqi <= 50) return { label: t('good'), lamp: 'ok' }
  if (aqi <= 100) return { label: t('moderate'), lamp: 'warn' }
  return { label: t('unhealthy'), lamp: 'down' }
}

/** A hint of what to say, where a card has nothing yet. */
/** Calendar events still ahead (or under way), today and tomorrow. */
function upcoming(today: Today, now: Date) {
  const end = new Date(now)
  end.setDate(end.getDate() + 2)
  end.setHours(0, 0, 0, 0)
  return (today.agenda?.events ?? []).filter((e) => new Date(e.end) > now && new Date(e.start) < end)
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <div className="hx-empty">
    <span className="hx-radar" aria-hidden>
      <i />
    </span>
    <p className="hx-hint">{children}</p>
  </div>
)

// ------------------------------------------------------------------- Day

export function DayView() {
  const now = useClock()
  const weather = usePoll<Weather>('/weather', 5 * 60_000)
  const outlook = usePoll<Outlook>('/outlook', 30 * 60_000)
  const today = usePoll<Today>('/today', 15_000)
  const uv = weather?.now.uv ?? null

  return (
    <div className="hx-grid hx-day">
      <Frame className="hx-clock" code="01" title={t('LOCAL TIME')} aside={weather?.city}>
        <div className="hx-time">
          {pad(now.getHours())}
          <span className="hx-colon">:</span>
          {pad(now.getMinutes())}
          <small>{pad(now.getSeconds())}</small>
        </div>
        <div className="hx-date">{now.toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <SunArc rise={weather?.sun?.rise ?? null} set={weather?.sun?.set ?? null} now={now} />
      </Frame>

      <Frame className="hx-sky" code="02" title={t('WEATHER')} aside={weather ? [weather.city, weather.region].filter(Boolean).join(' · ') : undefined}>
        {weather ? (
          <div className="hx-sky-body">
            <div className="hx-sky-hero">
              <SkyIcon code={weather.now.code} />
              <b>{deg(weather.now.temp)}</b>
              <span>{t(sky(weather.now.code))}</span>
              <em>
                {deg(weather.today.min)} / {deg(weather.today.max)}
              </em>
            </div>
            <dl className="hx-facts">
              <div>
                <dt>{t('feels like')}</dt>
                <dd>{deg(weather.now.feels)}</dd>
              </div>
              <div>
                <dt>{t('humidity')}</dt>
                <dd>{Math.round(weather.now.humidity)}%</dd>
                <Segments value={weather.now.humidity} n={14} />
              </div>
              <div>
                <dt>{t('wind')}</dt>
                <dd>{Math.round(weather.now.wind)} km/h</dd>
              </div>
              <div>
                <dt>{t('rain')} · {t('today')}</dt>
                <dd>{weather.today.rain}%</dd>
                <Segments value={weather.today.rain} n={14} />
              </div>
              {uv != null && (
                <div>
                  <dt>{t('UV index')}</dt>
                  <dd>
                    <Dot state={uvBand(weather.uvMax ?? uv).lamp} /> {uv.toFixed(1)}
                    <small> · {t('peak')} {weather.uvMax?.toFixed(0) ?? '—'} {uvBand(weather.uvMax ?? uv).label}</small>
                  </dd>
                  <Segments value={uv} max={12} n={14} warn={6} />
                </div>
              )}
              {weather.air?.aqi != null && (
                <div>
                  <dt>{t('air quality')}</dt>
                  <dd>
                    <Dot state={aqiBand(weather.air.aqi).lamp} /> {weather.air.aqi}
                    <small> · {aqiBand(weather.air.aqi).label} · PM2.5 {weather.air.pm25?.toFixed(0)}</small>
                  </dd>
                  <Segments value={weather.air.aqi} max={150} n={14} warn={51} />
                </div>
              )}
            </dl>
          </div>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      <Frame className="hx-drive" code="03" title={t('THE DRIVE')} aside={today?.commute ? (today.commute.toWork ? t('to work') : t('home')) : undefined}>
        {today?.commute ? (
          <div className="hx-drive-body">
            <Ring
              value={Math.min(100, (today.commute.minutes / Math.max(1, (today.commute.usual ?? today.commute.minutes) * 2)) * 100)}
              label={t('minutes')}
              big={String(today.commute.minutes)}
              warn={65}
            />
            <dl className="hx-facts hx-facts-1">
              <div>
                <dt>{t('distance')}</dt>
                <dd>{today.commute.km} km</dd>
              </div>
              <div>
                <dt>{t('traffic delay')}</dt>
                <dd>
                  <Dot state={today.commute.delay >= 10 ? 'down' : today.commute.delay >= 4 ? 'warn' : 'ok'} /> {today.commute.delay} min
                </dd>
              </div>
              <div>
                <dt>{t('empty roads')}</dt>
                <dd>{today.commute.usual ?? '—'} min</dd>
              </div>
            </dl>
          </div>
        ) : (
          <Hint>
            {today?.commuteSet ? t('Reading the traffic…') : t('Put JARVIS_HOME_ADDRESS and JARVIS_WORK_ADDRESS in .env.local, or ask: "how is the traffic to …"')}
          </Hint>
        )}
      </Frame>

      <Frame className="hx-temp" code="04" title={t('TEMPERATURE · NEXT 24 H')}>
        <LineChart points={(weather?.hours ?? []).map((h) => ({ label: hour(h.time), value: h.temp }))} unit="°" step={2} />
      </Frame>

      <Frame className="hx-rain" code="05" title={t('CHANCE OF RAIN · NEXT 24 H')}>
        <BarChart
          points={(weather?.hours ?? []).map((h) => ({ label: hour(h.time), value: h.rain }))}
          unit="%"
          empty={t('no rain expected')}
        />
      </Frame>

      <Frame className="hx-week" code="06" title={t('THE WEEK')} aside={outlook?.months.length ? t('and the months ahead') : undefined}>
        {weather?.week?.length ? (
          <>
            <ol className="hx-days">
              {weather.week.map((day, i) => {
                const lo = Math.min(...weather.week!.map((d) => d.min))
                const hi = Math.max(...weather.week!.map((d) => d.max))
                const span = hi - lo || 1
                return (
                  <li key={day.date}>
                    <span>{i === 0 ? t('today') : new Date(`${day.date}T12:00`).toLocaleDateString(LANG, { weekday: 'short' }).replace('.', '')}</span>
                    <SkyIcon code={day.code} />
                    <b>{deg(day.max)}</b>
                    <i className="hx-day-range">
                      <i style={{ bottom: `${((day.min - lo) / span) * 100}%`, top: `${((hi - day.max) / span) * 100}%` }} />
                    </i>
                    <em>{deg(day.min)}</em>
                    <small>{day.rain}%</small>
                  </li>
                )
              })}
            </ol>
            {outlook?.months.length ? (
              <div className="hx-months">
                {outlook.months.map((m) => (
                  <span key={m.month} title={`${m.low}–${m.high} mm`}>
                    <i style={{ height: `${Math.min(100, (m.mm / Math.max(...outlook.months.map((x) => x.high), 1)) * 100)}%` }} />
                    <em>{new Date(`${m.month}-15T12:00`).toLocaleDateString(LANG, { month: 'short' }).replace('.', '')}</em>
                    <small>{m.mm}</small>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      <Frame
        className="hx-due"
        code="07"
        title={today?.agenda?.configured ? t('AGENDA') : t('REMINDERS')}
        aside={today?.agenda?.configured ? `${upcoming(today, now).length} ${t('ahead')}` : today?.reminders.length ? String(today.reminders.length) : undefined}
      >
        {today?.agenda?.configured && upcoming(today, now).length ? (
          <ol className="hx-list hx-agenda">
            {upcoming(today, now).slice(0, 6).map((e) => {
              const start = new Date(e.start)
              const live = !e.allDay && start <= now && new Date(e.end) > now
              const soon = !e.allDay && start > now && start.getTime() - now.getTime() < 60 * 60_000
              return (
                <li key={e.title + e.start} className={live ? 'is-live' : soon ? 'is-soon' : ''}>
                  <b>
                    {start.toDateString() === now.toDateString() ? '' : `${t('tomorrow')} `}
                    {e.allDay ? t('all day') : start.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })}
                  </b>
                  <span>
                    {e.title}
                    {e.location && (
                      <small>
                        {' · '}
                        {/^https?:\/\//i.test(e.location) || /(?:meet\.google|zoom\.us|teams\.microsoft)/i.test(e.location) ? (
                          <a
                            href={e.location.startsWith('http') ? e.location : `https://${e.location}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hx-meet-link"
                          >
                            [ {t('JOIN')} ]
                          </a>
                        ) : (
                          e.location
                        )}
                      </small>
                    )}
                    {live && <small className="hx-tag"> {t('NOW')}</small>}
                  </span>
                </li>
              )
            })}
          </ol>
        ) : today?.reminders.length ? (
          <ol className="hx-list">
            {today.reminders.map((r, i) => (
              <li key={i}>
                <b>{r.daily ? `${r.daily} · ${t('daily')}` : r.at ? new Date(r.at).toLocaleString(LANG, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</b>
                <span>{r.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Hint>
            {today?.agenda?.configured
              ? t('Nothing on the calendar until tomorrow night.')
              : t('Nothing due. Say: "Wednesday, remind me at six to call João".')}
          </Hint>
        )}
        {today?.notes.length ? (
          <div className="hx-notes">
            <h3>{t('NOTES')}</h3>
            {today.notes.slice(0, 3).map((n) => (
              <p key={n.title}>
                {n.title} <small>{ago(n.at, now)}</small>
              </p>
            ))}
          </div>
        ) : null}
      </Frame>

      <Frame className="hx-play" code="08" title={t('NOW PLAYING')} aside={today?.playing?.app?.replace(/Music$/, '')}>
        {today?.playing ? (
          <div className={`hx-play-body ${today.playing.status === 'Playing' ? 'is-on' : ''}`}>
            <div className="hx-eq" aria-hidden>
              {Array.from({ length: 16 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
              ))}
            </div>
            <b>{today.playing.title}</b>
            <span>{today.playing.artist}</span>
            <em>{today.playing.status === 'Playing' ? t('playing') : t('paused')}</em>
          </div>
        ) : (
          <Hint>{t('Silence. Say: "Wednesday, play something by Iron Maiden".')}</Hint>
        )}
      </Frame>

      <Frame
        className="hx-learn"
        code="09"
        title={t('LEARNED')}
        aside={today ? `${today.habits.length} ${t('habits')} · ${(today.allFacts ?? today.facts).length} ${t('facts')} · ${today.diaryDays ?? 0} ${t('diary days')}` : undefined}
      >
        {today && (today.habits.length || today.facts.length || today.diaryDays) ? (
          <div className="hx-learn-body">
          <Constellation
            facts={(today.allFacts ?? today.facts).map((f) => f.replace(/\s*\(aprendido\)$/, ''))}
            habits={today.habits.map((h) => `~${h.time} ${h.desc}`)}
            days={today.diaryDays ?? 0}
            centre={t('YOU')}
          />
          <ul className="hx-list hx-list-tight">
            {today.habits.map((h) => (
              <li key={h.desc}>
                <b>~{h.time}</b>
                <span>
                  {h.desc} <small>· {h.days} {t('days')}</small>
                </span>
              </li>
            ))}
            {today.facts.map((f) => (
              <li key={f} className="hx-fact">
                <b>◆</b>
                <span>{f.replace(/\s*\(aprendido\)$/, '')}</span>
              </li>
            ))}
          </ul>
          </div>
        ) : (
          <Hint>{t('She learns your habits and what you tell her about yourself. In a few days, they appear here.')}</Hint>
        )}
      </Frame>
    </div>
  )
}

// ------------------------------------------------------------------ World

const money = (n: number) =>
  n.toLocaleString(LANG, { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : 2 })
const compact = (n: number) => n.toLocaleString(LANG, { notation: 'compact', maximumFractionDigits: 0 })
const signed = (n: number) => `${n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}${Math.abs(n).toFixed(2)}%`

function niceStep(values: number[]): number {
  const span = Math.max(...values) - Math.min(...values) || Math.max(...values) || 1
  const raw = span / 3
  const pow = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / pow
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * pow
}

export function WorldView() {
  const now = useClock(30_000)
  const headlines = usePoll<Headline[]>('/news', 5 * 60_000)
  const quotes = usePoll<Quote[]>('/markets', 5 * 60_000)
  const stories = usePoll<Story[]>('/stories', 5 * 60_000)
  const lead = stories?.find((s) => s.image) ?? null
  const others = (stories ?? []).filter((s) => s !== lead).slice(0, 4)
  const confirmed = (headlines ?? []).filter((h) => (h.outlets?.length ?? 1) > 1).length

  return (
    <div className="hx-grid hx-world">
      <Frame className="hx-lead" code="01" title={t('LEAD STORY')} aside={lead ? `${lead.topic} · ${lead.source}` : undefined}>
        {lead?.image ? (
          <figure className="hx-lead-fig">
            <img src={proxied(lead.image)} alt="" />
            <figcaption>
              <span>{ago(lead.at, now)}</span>
              <p>{lead.title}</p>
            </figcaption>
            <i className="hx-lead-grid" aria-hidden />
          </figure>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      <Frame
        className="hx-heads"
        code="02"
        title={t('HEADLINES')}
        aside={headlines ? `${confirmed}/${headlines.length} ${t('confirmed by 2+ outlets')}` : undefined}
      >
        {headlines?.length ? (
          <ol className="hx-headlines">
            {headlines.slice(0, 9).map((h, i) => {
              const n = h.outlets?.length ?? 1
              return (
                <li key={h.title}>
                  <i>{pad(i + 1)}</i>
                  <div>
                    <p>{h.title}</p>
                    <span>
                      {h.source} · {ago(h.at, now)}
                    </span>
                  </div>
                  <em className={n > 1 ? 'is-confirmed' : ''} title={h.outlets?.join(', ')}>
                    {n > 1 ? `✓ ${n}` : '1'}
                  </em>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      <Frame className="hx-topics" code="03" title={t('BY SUBJECT')}>
        {others.length ? (
          <ul className="hx-topic-list">
            {others.map((s) => (
              <li key={s.title}>
                {s.image && <img src={proxied(s.image)} alt="" />}
                <div>
                  <b>{s.topic}</b>
                  <p>{s.title}</p>
                  <span>
                    {s.source} · {ago(s.at, now)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      {(quotes ?? []).slice(0, 3).map((q, i) => (
        <Frame key={q.name} className={`hx-quote hx-quote-${i}`} code={pad(4 + i)} title={`${q.name} · BRL`} aside={`30 ${t('days')} ${signed(q.monthPct)}`}>
          <div className="hx-quote-head">
            <b>R$ {money(q.last)}</b>
            <span className={q.dayPct >= 0 ? 'is-up' : 'is-down'}>
              {t('today')} {signed(q.dayPct)}
            </span>
          </div>
          <LineChart
            points={q.points.map((p) => ({
              label: new Date(p.at).toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }),
              value: p.value,
            }))}
            step={niceStep(q.points.map((p) => p.value))}
            format={q.last >= 10_000 ? compact : money}
          />
        </Frame>
      ))}

      <div className="hx-tickerbar">
        <span className="hx-tickerbar-tag">{t('LIVE')}</span>
        <Ticker
          items={[
            ...(quotes ?? []).map((q) => `${q.name} R$ ${money(q.last)} ${signed(q.dayPct)}`),
            ...(headlines ?? []).slice(0, 14).map((h) => `${h.title} — ${h.source}`),
          ]}
        />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- Core

const PHASE: Record<Snapshot['phase'], string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: 'STANDBY',
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'RESPONDING',
}

export function CoreView({ state }: { state: Snapshot }) {
  const status = usePoll<Status>('/status', 5000)
  // The phone page's pairing code (bridge/mobile.mjs). The SVG is made by the
  // bridge from its own key — nothing from outside is rendered here.
  const phone = usePoll<{ enabled: boolean; address?: string; qr?: string }>('/mobile', 5 * 60_000)
  const [qrBig, setQrBig] = useState(false)
  const sys = usePoll<System>('/system', 3000)
  const end = useRef<HTMLDivElement>(null)
  const last = state.turns.at(-1)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [last?.id, last?.text, state.caption])

  const mem = sys ? (sys.mem.used / sys.mem.total) * 100 : null
  const gpuMem = sys?.gpu?.memUsed != null && sys.gpu.memTotal ? (sys.gpu.memUsed / sys.gpu.memTotal) * 100 : null
  const heard = status ? status.stats.heard.local + status.stats.heard.elevenlabs + status.stats.heard.gemini : 0
  const answers = status ? status.stats.answers.claude + status.stats.answers.gemini : 0

  return (
    <div className="hx-grid hx-core">
      <Frame className="hx-reactor" code="01" title="WEDNESDAY" aside={status?.model.replace(/^claude-/, '')}>
        <div className={`hx-reactor-body hx-phase-${state.phase}`}>
          <div className="hx-orb" aria-hidden>
            <i />
            <i />
            <i />
            <b />
          </div>
          <div className="hx-reactor-text">
            <strong>{t(PHASE[state.phase])}</strong>
            <span>{state.activeTool ?? t('no tool in use')}</span>
            <dl className="hx-facts">
              <div>
                <dt>{t('answers today')}</dt>
                <dd>
                  {status?.traces?.today.answers ?? answers}
                  <small> · {t('quick')} {status?.traces?.today.quick ?? status?.stats.answers.gemini ?? 0} · Claude {status?.traces?.today.claude ?? status?.stats.answers.claude ?? 0}</small>
                </dd>
                {status?.traces && status.traces.today.answers > 0 && (
                  <Segments value={status.traces.today.quick} max={status.traces.today.answers} n={14} />
                )}
              </div>
              <div>
                <dt>{t('typical wait')}</dt>
                <dd>
                  {secs(status?.traces?.month.msQuick)}
                  <small> {t('quick')} · {secs(status?.traces?.month.msClaude)} Claude</small>
                </dd>
              </div>
              <div>
                <dt>{t('API-equivalent cost')}</dt>
                <dd>
                  {usd(status?.traces?.today.cost)}
                  <small> · 30d {usd(status?.traces?.month.cost)}</small>
                </dd>
              </div>
              <div>
                <dt>{t('saved by the quick brain')}</dt>
                <dd className="hx-saved">
                  ~{usd(status?.traces?.month.saved)}
                  <small> · 30d</small>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Frame>

      <Frame className="hx-services" code="02" title={t('SYSTEMS')} aside={status ? `${status.services.filter((s) => s.state === 'ok').length}/${status.services.length} ${t('online')}` : undefined}>
        <ul className="hx-svc">
          {(status?.services ?? []).map((s) => (
            <li key={s.id} className={`hx-svc-${s.state}`}>
              <Dot state={s.state} />
              <b>{s.label}</b>
              <span>{s.detail}</span>
            </li>
          ))}
        </ul>
      </Frame>

      <Frame className="hx-ears" code="03" title={t('HEARING')} aside={status ? `${t('since')} ${new Date(status.stats.since).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })}` : undefined}>
        <div className="hx-big-num">
          <b>{heard}</b>
          <span>{t('phrases heard')}</span>
        </div>
        <dl className="hx-facts hx-facts-1">
          <div>
            <dt>{t('local · this PC')}</dt>
            <dd>{status?.stats.heard.local ?? 0}</dd>
            <Segments value={status?.stats.heard.local ?? 0} max={Math.max(1, heard)} n={16} />
          </div>
          <div>
            <dt>{t('cloud fallback')}</dt>
            <dd>{(status?.stats.heard.elevenlabs ?? 0) + (status?.stats.heard.gemini ?? 0)}</dd>
          </div>
          <div>
            <dt>{t('average transcription')}</dt>
            <dd>{status?.stats.sttAvg != null ? `${(status.stats.sttAvg / 1000).toFixed(2)} s` : '—'}</dd>
          </div>
        </dl>
      </Frame>

      <Frame className="hx-cpu" code="04" title={t('PROCESSOR')} aside={sys ? `${sys.cpu.cores} ${t('threads')} · ${sys.cpu.name.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim()}` : undefined}>
        <div className="hx-cpu-body">
          <Ring value={sys?.cpu.now ?? null} label="CPU" />
          <LineChart
            points={(sys?.cpu.history ?? []).map((value, i, all) => ({ label: `-${(all.length - 1 - i) * 2}s`, value }))}
            unit="%"
            step={25}
            floor={0}
            ceiling={100}
          />
        </div>
      </Frame>

      <Frame className="hx-gpu" code="05" title={t('GRAPHICS')} aside={sys?.gpu?.name.replace(/^NVIDIA GeForce /, '')}>
        {sys?.gpu ? (
          <div className="hx-gpu-body">
            <Ring value={sys.gpu.util} label="GPU" />
            <Ring value={gpuMem} label="VRAM" sub={`${bytes((sys.gpu.memUsed ?? 0) * 1024 ** 2)} / ${bytes((sys.gpu.memTotal ?? 0) * 1024 ** 2)}`} />
            <dl className="hx-facts hx-facts-1">
              <div>
                <dt>{t('temperature')}</dt>
                <dd>
                  <Dot state={(sys.gpu.temp ?? 0) >= 80 ? 'down' : (sys.gpu.temp ?? 0) >= 70 ? 'warn' : 'ok'} /> {sys.gpu.temp ?? '—'}°C
                </dd>
                <Segments value={sys.gpu.temp ?? 0} max={100} n={14} warn={75} />
              </div>
              <div>
                <dt>{t('power')}</dt>
                <dd>{sys.gpu.power != null ? `${sys.gpu.power.toFixed(0)} W` : '—'}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="hx-dim">{t('no data')}</p>
        )}
      </Frame>

      <Frame className="hx-mem" code="06" title={t('MEMORY & DISKS')} aside={sys ? `${t('on for')} ${uptime(sys.uptime)}` : undefined}>
        <div className="hx-mem-body">
          <Ring value={mem} label="RAM" sub={sys ? `${bytes(sys.mem.used)} / ${bytes(sys.mem.total)}` : undefined} />
          <ul className="hx-disks">
            {(sys?.disks ?? []).map((d) => {
              const used = ((d.total - d.free) / d.total) * 100
              return (
                <li key={d.name}>
                  <b>{d.name}</b>
                  <Segments value={used} n={18} warn={90} />
                  <span>
                    {bytes(d.free)} {t('free')}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </Frame>

      <Frame className="hx-talk" code="07" title={t('CONVERSATION')} aside={t(PHASE[state.phase])}>
        <div className="hx-lines">
          {state.turns.length === 0 && !state.caption && <p className="hx-dim">{t('nothing said yet')}</p>}
          {state.turns.map((turn) => (
            <p key={turn.id} className={`hx-line hx-line-${turn.role}`}>
              <b>{turn.role === 'user' ? t('YOU') : 'WEDNESDAY'}</b>
              {turn.text}
            </p>
          ))}
          {state.caption && (
            <p className="hx-line hx-line-user hx-line-live">
              <b>{t('YOU')}</b>
              {state.caption}
            </p>
          )}
          <div ref={end} />
        </div>
      </Frame>

      <Frame className="hx-procs" code="08" title={t('HEAVIEST PROCESSES')}>
        {sys?.top.length ? (
          <table className="hx-table">
            <thead>
              <tr>
                <th>{t('process')}</th>
                <th>CPU</th>
                <th>{t('memory')}</th>
              </tr>
            </thead>
            <tbody>
              {sys.top.map((p) => (
                <tr key={p.name}>
                  <td>
                    {p.name}
                    {p.count > 1 && <small> ×{p.count}</small>}
                  </td>
                  <td>
                    <Segments value={p.cpu} max={Math.max(25, ...sys.top.map((x) => x.cpu))} n={10} />
                    <em>{p.cpu.toFixed(1)}%</em>
                  </td>
                  <td>{bytes(p.mem)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hx-dim">{t('measuring…')}</p>
        )}
      </Frame>

      <Frame className="hx-net" code="09" title={phone?.qr ? t('NETWORK · PHONE') : t('NETWORK')}>
        <div className={`hx-net-body ${phone?.qr ? 'has-phone' : ''}`}>
          {phone?.qr && (
            <figure className="hx-phone" title={phone.address}>
              <span dangerouslySetInnerHTML={{ __html: phone.qr }} onClick={() => setQrBig(true)} />
              <figcaption>{t('scan to pair')}</figcaption>
              {qrBig && (
                <div className="hx-qr-big" onClick={() => setQrBig(false)}>
                  <span dangerouslySetInnerHTML={{ __html: phone.qr }} />
                  <p>{phone.address}</p>
                </div>
              )}
            </figure>
          )}
          <div>
            <span>▼ {t('down')}</span>
            <b>{bytes(sys?.net?.down, '/s')}</b>
            <Spark values={(sys?.netHistory ?? []).map((x) => x.down)} className="hx-spark-down" />
          </div>
          <div>
            <span>▲ {t('up')}</span>
            <b>{bytes(sys?.net?.up, '/s')}</b>
            <Spark values={(sys?.netHistory ?? []).map((x) => x.up)} className="hx-spark-up" />
          </div>
        </div>
      </Frame>
    </div>
  )
}
