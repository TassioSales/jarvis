import { useEffect, useState } from 'react'
import { follow, type Snapshot } from '../lib/sync'
import { t } from '../lib/i18n'
import { LockRing, Padlock } from './Lock'
import './lock.css'
import { CoreView, DayView, WorldView } from './Monitors'
import { Ambience } from './Ambience'

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
      {/* The same sky as the main window, further back. */}
      <Ambience dim />
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
          <DayView />
        ) : kind === 'world' ? (
          <WorldView />
        ) : (
          <CoreView state={live} />
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
