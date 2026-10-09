import { useState } from 'react'
import { useStore } from '../store'
import { proxied, type BriefCard } from '../lib/briefing'
import { sky } from '../lib/weather'
import { LANG } from '../config'
import { t } from '../lib/i18n'
import './briefing.css'

/**
 * The briefing on screen.
 *
 * One card at a time comes up over the reactor while he speaks the sentence
 * that goes with it; when he moves on it drops into a row along the bottom, so
 * by the end the whole briefing is laid out to look back over. The sentence
 * being spoken runs underneath as a caption, because a figure is easier to
 * take in read and heard at once than heard alone.
 *
 * It takes no input. Like the lock it sits over the interface with pointer
 * events off, and goes when the next turn begins.
 */

const deg = (v: number) => `${Math.round(v)}°`
const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`
const money = (v: number) =>
  v.toLocaleString(LANG, {
    minimumFractionDigits: v >= 1000 ? 0 : 2,
    maximumFractionDigits: v >= 1000 ? 0 : 2,
  })

function Picture({ src }: { src: string }) {
  // A thumbnail the bridge could not fetch is left out, not shown broken.
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return <img className="brief-picture" src={proxied(src)} alt="" onError={() => setFailed(true)} />
}

function Body({ card, mini }: { card: BriefCard; mini: boolean }) {
  switch (card.kind) {
    case 'overview':
      return (
        <>
          <div className="brief-kicker">{t('OVERVIEW')}</div>
          <div className="brief-title">{card.date}</div>
          {!mini && (
            <div className="brief-chips">
              {card.parts.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </div>
          )}
        </>
      )
    case 'mail':
      return (
        <>
          <div className="brief-kicker">
            {t('MAIL')} · {card.unread} {t('unread')}
          </div>
          {card.items.length ? (
            <ul className="brief-list">
              {card.items.slice(0, mini ? 2 : 3).map((m) => (
                <li key={m.from + m.subject}>
                  <span>{m.from}</span>
                  {m.subject}
                </li>
              ))}
            </ul>
          ) : (
            <div className="brief-headline">{t('Nothing needs you')}</div>
          )}
        </>
      )
    case 'agenda':
      return (
        <>
          <div className="brief-kicker">{t('CALENDAR')}</div>
          {card.items.length ? (
            <ul className="brief-list">
              {card.items.slice(0, mini ? 2 : 5).map((e) => (
                <li key={e.when + e.title}>
                  <span>{e.when}</span>
                  {e.title}
                </li>
              ))}
            </ul>
          ) : (
            <div className="brief-headline">{t('Calendar clear')}</div>
          )}
        </>
      )
    case 'weather': {
      const w = card.weather
      return (
        <>
          <div className="brief-kicker">
            {t('WEATHER')} · {w.city}
          </div>
          <div className="brief-row">
            <b className="brief-hero">{deg(w.now.temp)}</b>
            <div className="brief-side">
              <span>{t(sky(w.now.code))}</span>
              <span>
                {deg(w.today.min)} – {deg(w.today.max)}
              </span>
              {!mini && (
                <span>
                  {t('rain')} {Math.round(w.today.rain)}% · {t('wind')} {Math.round(w.now.wind)} km/h
                </span>
              )}
            </div>
          </div>
        </>
      )
    }
    case 'markets':
      return (
        <>
          <div className="brief-kicker">{t('MARKETS')}</div>
          <div className="brief-quotes">
            {card.quotes.map((q) => (
              <div key={q.name}>
                <span>{q.name}</span>
                <b>R$ {money(q.last)}</b>
                {!mini && <i>{pct(q.dayPct)}</i>}
              </div>
            ))}
          </div>
        </>
      )
    case 'news':
      return (
        <>
          <div className="brief-kicker">
            {t('NEWS')} · {card.story.topic}
          </div>
          {card.story.image && <Picture src={card.story.image} />}
          <div className="brief-headline">{card.story.title}</div>
          {!mini && <div className="brief-source">{card.story.source}</div>}
        </>
      )
  }
}

export function Briefing() {
  const briefing = useStore((s) => s.briefing)
  if (!briefing) return null

  const active = briefing.cards[briefing.active] ?? null
  // Everything already spoken, oldest first; the one on show is not in the row.
  const shelved = briefing.cards.filter((_, i) => i !== briefing.active)

  return (
    <div className="brief">
      {active && (
        // Keyed on the card so each one plays its own entrance.
        <article key={active.id} className={`brief-card brief-main brief-${active.kind}`}>
          <Body card={active} mini={false} />
        </article>
      )}

      {shelved.length > 0 && (
        <div className="brief-shelf">
          {shelved.map((card) => (
            <article key={card.id} className={`brief-card brief-mini brief-${card.kind}`}>
              <Body card={card} mini />
            </article>
          ))}
        </div>
      )}

      {briefing.caption && <p className="brief-caption">{briefing.caption}</p>}
    </div>
  )
}
