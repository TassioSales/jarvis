import { useEffect, useRef, useState } from 'react'
import { follow, type Snapshot } from '../lib/sync'
import { BRIDGE_HTTP_URL, LANG } from '../config'
import { t } from '../lib/i18n'
import { sky } from '../lib/weather'
import { LockRing, Padlock } from './Lock'
import { BarChart, LineChart } from './charts'
import { Gauge, SkyIcon } from './glyphs'
import { proxied } from '../lib/briefing'
import './lock.css'

/**
 * A side monitor.
 *
 * The same page as the main window, opened with `?sat=telemetry` or
 * `?sat=log`, showing a copy of what the main window knows (see sync.ts). It
 * listens to nothing and controls nothing; all it has of its own is a clock
 * and what it polls from the bridge.
 *
 * Locked, both look the same: the command centre, waiting. Unlocked, each has
 * a job that is worth a whole screen and would only crowd the reactor on the
 * main one — the world and the machine on one side, the conversation and the
 * news on the other.
 */
export type SatelliteKind = 'telemetry' | 'world' | 'log'

type Telemetry = {
  cpu: number
  memUsed: number
  memTotal: number
  uptime: number
  host: string
  model: string
  effort: string
  voice: string
  facts: string[]
}

type Weather = {
  city: string
  region: string
  now: { temp: number; feels: number; humidity: number; wind: number; code: number }
  today: { min: number; max: number; rain: number }
  tomorrow: { min: number; max: number; rain: number }
  hours: { time: string; temp: number; rain: number }[]
  week?: { date: string; code: number; min: number; max: number; rain: number }[]
}

type Story = { topic: string; title: string; source: string; image: string | null; at: string }

type Headline = { title: string; source: string; at: string; outlets?: string[]; summary?: string }

type Outlook = {
  city: string
  months: { month: string; mm: number; low: number; high: number }[]
}

type Quote = {
  name: string
  last: number
  dayPct: number
  monthPct: number
  points: { at: string; value: number }[]
}

/**
 * Poll one bridge endpoint. Keeps the last good answer when a read fails —
 * the bridge restarting should not blank a monitor, and the main window is
 * the one that reports a lost connection.
 */
function usePoll<T>(path: string, everyMs: number, active: boolean): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    if (!active) return
    let gone = false
    const read = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}${path}`)
        if (res.ok && !gone) setData((await res.json()) as T)
      } catch {
        // keep what we have
      }
    }
    void read()
    const timer = setInterval(read, everyMs)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [path, everyMs, active])
  return data
}

/** Two minutes of processor load, at the telemetry poll's two-second beat. */
const CPU_HISTORY = 60

function useCpuHistory(now: Telemetry | null): number[] {
  const history = useRef<number[]>([])
  const seen = useRef<Telemetry | null>(null)
  if (now && now !== seen.current) {
    seen.current = now
    history.current = [...history.current.slice(-(CPU_HISTORY - 1)), now.cpu]
  }
  return history.current
}

function useClock() {
  const [time, setTime] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return time
}

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

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)
const deg = (n: number) => `${Math.round(n)}°`
const hour = (iso: string) => `${iso.slice(11, 13)}h`

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`
}

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return t('now')
  if (minutes < 60) return `${minutes} ${t('min ago')}`
  return `${Math.round(minutes / 60)} ${t('h ago')}`
}

function Card({
  title,
  aside,
  className = '',
  children,
}: {
  title?: string
  aside?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`sat-card ${className}`}>
      {title && (
        <header className="sat-card-head">
          <h2>{title}</h2>
          {aside && <span>{aside}</span>}
        </header>
      )}
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sat-stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

/** Seven days as seven columns: the day, its sky, and where its temperatures
 *  sit within the week's whole range — so a warm day reads as a bar set high. */
function Week({ days }: { days: NonNullable<Weather['week']> }) {
  const lo = Math.min(...days.map((d) => d.min))
  const hi = Math.max(...days.map((d) => d.max))
  const span = hi - lo || 1
  return (
    <ol className="sat-days">
      {days.map((day, i) => (
        <li key={day.date}>
          <span className="sat-day-name">
            {i === 0
              ? t('today')
              : new Date(`${day.date}T12:00`).toLocaleDateString(LANG, { weekday: 'short' }).replace('.', '')}
          </span>
          <SkyIcon code={day.code} />
          <b>{deg(day.max)}</b>
          <div className="sat-day-range" title={`${deg(day.min)} – ${deg(day.max)}`}>
            <i
              style={{
                bottom: `${((day.min - lo) / span) * 100}%`,
                top: `${((hi - day.max) / span) * 100}%`,
              }}
            />
          </div>
          <span className="sat-day-min">{deg(day.min)}</span>
          <span className="sat-day-rain">{day.rain}%</span>
        </li>
      ))}
    </ol>
  )
}

function PhaseLine({ state }: { state: Snapshot }) {
  return (
    <div className={`sat-phase sat-phase-${state.phase}`}>
      <i />
      {t(PHASE[state.phase])}
    </div>
  )
}

function Dashboard({ state }: { state: Snapshot }) {
  const time = useClock()
  const machine = usePoll<Telemetry>('/telemetry', 2000, true)
  const weather = usePoll<Weather>('/weather', 5 * 60_000, true)
  const outlook = usePoll<Outlook>('/outlook', 30 * 60_000, true)
  const cpu = useCpuHistory(machine)
  const mem = machine ? (machine.memUsed / machine.memTotal) * 100 : 0

  return (
    <div className="sat-grid sat-dash">
      <Card className="sat-clock">
        <div className="sat-time">
          {time.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })}
          <span>{String(time.getSeconds()).padStart(2, '0')}</span>
        </div>
        <div className="sat-date">
          {time.toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
      </Card>

      <Card
        className="sat-weather"
        title={t('WEATHER')}
        aside={weather ? [weather.city, weather.region].filter(Boolean).join(' · ') : undefined}
      >
        {weather ? (
          <div className="sat-weather-body">
            <div className="sat-hero">
              <div className="sat-hero-top">
                <SkyIcon code={weather.now.code} />
                <b>{deg(weather.now.temp)}</b>
              </div>
              <span>{t(sky(weather.now.code))}</span>
            </div>
            <div className="sat-stats">
              <Stat label={t('feels like')} value={deg(weather.now.feels)} />
              <Stat label={t('humidity')} value={`${Math.round(weather.now.humidity)}%`} />
              <Stat label={t('wind')} value={`${Math.round(weather.now.wind)} km/h`} />
              <Stat
                label={t('today')}
                value={`${deg(weather.today.min)} – ${deg(weather.today.max)}`}
              />
              <Stat
                label={t('tomorrow')}
                value={`${deg(weather.tomorrow.min)} – ${deg(weather.tomorrow.max)}`}
              />
              <Stat label={`${t('rain')} · ${t('today')}`} value={`${weather.today.rain}%`} />
            </div>
          </div>
        ) : (
          <p className="sat-dim">{t('no data')}</p>
        )}
      </Card>

      <Card className="sat-week" title={t('THE WEEK')}>
        {weather?.week?.length ? (
          <Week days={weather.week} />
        ) : (
          <p className="sat-dim">{t('no data')}</p>
        )}
      </Card>

      <Card className="sat-chart-card sat-temp" title={t('TEMPERATURE · NEXT 24 H')}>
        <LineChart
          points={(weather?.hours ?? []).map((h) => ({ label: hour(h.time), value: h.temp }))}
          unit="°"
          step={2}
        />
      </Card>

      <Card className="sat-chart-card sat-rain" title={t('CHANCE OF RAIN · NEXT 24 H')}>
        <BarChart
          points={(weather?.hours ?? []).map((h) => ({ label: hour(h.time), value: h.rain }))}
          unit="%"
          empty={t('no rain expected')}
        />
      </Card>

      <Card
        className="sat-chart-card sat-outlook"
        title={t('RAIN · MONTHS AHEAD')}
        aside={t('mm, likely total')}
      >
        <BarChart
          points={(outlook?.months ?? []).map((m) => ({
            label: new Date(`${m.month}-15T12:00`).toLocaleDateString(LANG, { month: 'short' }).replace('.', ''),
            value: m.mm,
            note: `${m.low}–${m.high} mm`,
          }))}
          unit=""
          ceiling={Math.max(50, Math.ceil(Math.max(...(outlook?.months ?? []).map((m) => m.high), 0) / 50) * 50)}
          empty={t('no rain expected')}
        />
      </Card>

      <Card
        className="sat-chart-card sat-cpu"
        title={t('PROCESSOR · LAST 2 MIN')}
        aside={machine ? `${Math.round(machine.cpu)}%` : undefined}
      >
        <LineChart
          points={cpu.map((value, i) => ({
            label: `-${(cpu.length - 1 - i) * 2}s`,
            value,
          }))}
          unit="%"
          step={25}
          floor={0}
          ceiling={100}
        />
      </Card>

      <Card className="sat-machine" title={t('MACHINE')} aside={machine?.host}>
        <div className="sat-dials">
          <Gauge label="CPU" value={machine?.cpu ?? 0} />
          <Gauge
            label={t('MEMORY')}
            value={mem}
            detail={machine ? `${gb(machine.memUsed)} / ${gb(machine.memTotal)} GB` : undefined}
          />
        </div>
        <div className="sat-stats sat-stats-2">
          <Stat label={t('UPTIME')} value={machine ? uptime(machine.uptime) : '—'} />
          <Stat label={t('VOICE')} value={machine?.voice ?? '—'} />
        </div>
      </Card>

      <Card className="sat-jarvis" title="WEDNESDAY">
        <PhaseLine state={state} />
        <div className="sat-stats sat-stats-2">
          <Stat label={t('MODEL')} value={machine?.model.replace(/^claude-/, '') ?? '—'} />
          <Stat label={t('EFFORT')} value={machine?.effort ?? '—'} />
        </div>
        <p className="sat-tool">{state.activeTool ?? t('no tool in use')}</p>
      </Card>
    </div>
  )
}

const money = (n: number) =>
  n.toLocaleString(LANG, {
    minimumFractionDigits: n >= 1000 ? 0 : 2,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  })

/** Six-figure prices, short enough to fit an axis: "412 mil", not "412.172". */
const compact = (n: number) =>
  n.toLocaleString(LANG, { notation: 'compact', maximumFractionDigits: 0 })

/** A signed percentage with a real minus sign, so the direction is in the text. */
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`

function Headlines({ items, now, count }: { items: Headline[] | null; now: Date; count: number }) {
  if (!items?.length) return <p className="sat-dim">{t('no data')}</p>
  return (
    <ol className="sat-headlines">
      {items.slice(0, count).map((item, i) => (
        <li key={item.title}>
          <i>{String(i + 1).padStart(2, '0')}</i>
          <div>
            <p>{item.title}</p>
            <span>
              {item.source} · {ago(item.at, now)}
              {/* Said in words, not by colour: how many outlets carry it. */}
              {(item.outlets?.length ?? 1) > 1 && (
                <em title={item.outlets!.join(', ')}>
                  {' '}
                  · {item.outlets!.length} {t('outlets')}
                </em>
              )}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The second monitor: what is happening outside the room. Headlines down one
 * side, and beside them the three rates a Brazilian desk tends to glance at,
 * each with the month that led to it.
 */
function World() {
  const time = useClock()
  const headlines = usePoll<Headline[]>('/news', 5 * 60_000, true)
  const quotes = usePoll<Quote[]>('/markets', 5 * 60_000, true)
  const stories = usePoll<Story[]>('/stories', 5 * 60_000, true)
  // The lead is whichever subject story came with a picture; a lead without
  // one is just a headline set in larger type.
  const lead = stories?.find((story) => story.image) ?? null

  return (
    <div className="sat-grid sat-world">
      <Card className="sat-news" title={t('HEADLINES')}>
        {lead?.image && (
          <figure className="sat-lead">
            <img src={proxied(lead.image)} alt="" />
            <figcaption>
              <span>
                {lead.topic} · {lead.source} · {ago(lead.at, time)}
              </span>
              <p>{lead.title}</p>
            </figcaption>
          </figure>
        )}
        <Headlines items={headlines} now={time} count={lead?.image ? 5 : 8} />
      </Card>

      {(quotes ?? []).map((quote) => (
        <Card
          key={quote.name}
          className="sat-chart-card sat-quote"
          title={`${quote.name} · BRL`}
          aside={`30 ${t('days')} ${signed(quote.monthPct)}`}
        >
          <div className="sat-quote-head">
            <b>R$ {money(quote.last)}</b>
            <span>
              {t('today')} {signed(quote.dayPct)}
            </span>
          </div>
          <LineChart
            points={quote.points.map((p) => ({
              label: new Date(p.at).toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }),
              value: p.value,
            }))}
            step={niceStep(quote.points.map((p) => p.value))}
            format={quote.last >= 10_000 ? compact : money}
          />
        </Card>
      ))}
      {!quotes && (
        <Card className="sat-quote" title={t('MARKETS')}>
          <p className="sat-dim">{t('no data')}</p>
        </Card>
      )}
    </div>
  )
}

/** An axis step that gives a handful of gridlines whatever the scale. */
function niceStep(values: number[]): number {
  const span = Math.max(...values) - Math.min(...values) || Math.max(...values) || 1
  const raw = span / 3
  const pow = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / pow
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * pow
}

function Log({ state }: { state: Snapshot }) {
  const time = useClock()
  const machine = usePoll<Telemetry>('/telemetry', 10_000, true)
  const headlines = usePoll<Headline[]>('/news', 5 * 60_000, true)
  const end = useRef<HTMLDivElement>(null)
  const last = state.turns.at(-1)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [last?.id, last?.text, state.caption])

  return (
    <div className="sat-grid sat-log-grid">
      <Card className="sat-talk" title={t('CONVERSATION')} aside={t(PHASE[state.phase])}>
        <div className="sat-lines">
          {state.turns.length === 0 && !state.caption && (
            <p className="sat-dim">{t('nothing said yet')}</p>
          )}
          {state.turns.map((turn) => (
            <p key={turn.id} className={`sat-line sat-line-${turn.role}`}>
              <b>{turn.role === 'user' ? t('YOU') : 'WEDNESDAY'}</b>
              {turn.text}
            </p>
          ))}
          {state.caption && (
            <p className="sat-line sat-line-user sat-line-live">
              <b>{t('YOU')}</b>
              {state.caption}
            </p>
          )}
          <div ref={end} />
        </div>
      </Card>

      <Card className="sat-news" title={t('HEADLINES')}>
        <Headlines items={headlines} now={time} count={6} />
      </Card>

      <Card className="sat-memory" title={t('MEMORY')}>
        {machine?.facts.length ? (
          <ul className="sat-list">
            {machine.facts.slice(-5).map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        ) : (
          <p className="sat-dim">{t('nothing remembered yet')}</p>
        )}
      </Card>
    </div>
  )
}

const VIEWS: Record<SatelliteKind, string> = {
  telemetry: 'TELEMETRY',
  world: 'WORLD',
  log: 'LOG',
}

export function Satellite({ kind }: { kind: SatelliteKind }) {
  // undefined: never heard from the main window. null: heard, then lost it.
  const [state, setState] = useState<Snapshot | null | undefined>(undefined)

  // The window is named for its place, not for what it is showing. The
  // launcher finds windows by title to put each on its monitor, and a title
  // that changed when you followed a link to another view would leave it
  // opening a duplicate next time.
  const slot = new URLSearchParams(location.search).get('slot') ?? (kind === 'telemetry' ? 'A' : 'B')
  useEffect(() => {
    document.title = `WEDNESDAY · ${slot}`
    return follow(setState)
  }, [slot])

  // No main window means nothing here can be trusted to be current, and
  // nothing should be on show — so it reads as locked, whatever it was.
  const live = state ?? null
  const open = live !== null && !live.locked && live.phase !== 'offline' && live.phase !== 'boot'
  const identity = live?.identity ?? 'idle'

  return (
    <div className={`sat ${open ? 'sat-open' : 'sat-locked'}`}>
      <header className="sat-top">
        <span className="sat-status">
          {open ? t(VIEWS[kind]) : t(live ? 'STANDBY' : 'NO SIGNAL')}
        </span>
        {open ? (
          // Every view is a link away from every other, on either monitor. The
          // conversation log lives here rather than on a screen of its own:
          // worth having when you want it, not worth a monitor the rest of the
          // time.
          <nav className="sat-nav">
            {(Object.keys(VIEWS) as SatelliteKind[]).map((view) => (
              <a
                key={view}
                href={`?sat=${view}&slot=${slot}`}
                aria-current={view === kind ? 'page' : undefined}
              >
                {t(VIEWS[view])}
              </a>
            ))}
          </nav>
        ) : (
          <span className="sat-sub">{t('voice · calendar · mail · telemetry')}</span>
        )}
      </header>

      {open ? (
        kind === 'telemetry' ? (
          <Dashboard state={live} />
        ) : kind === 'world' ? (
          <World />
        ) : (
          <Log state={live} />
        )
      ) : (
        <LockRing identity={identity} title="Command Centre">
          <Padlock />
        </LockRing>
      )}

      <i className="sat-corner sat-tl" />
      <i className="sat-corner sat-tr" />
      <i className="sat-corner sat-bl" />
      <i className="sat-corner sat-br" />
    </div>
  )
}
