import { useStore } from '../store'
import { t } from '../lib/i18n'
import './briefing.css'

/**
 * The question on screen while he waits for leave to act.
 *
 * Asking aloud is not enough on its own: "shall I proceed" says nothing about
 * what with. This shows the action itself — the command, the recipient, the
 * file — for exactly as long as the question is open, and how to answer it.
 */
export function Consent() {
  const consent = useStore((s) => s.consent)
  if (!consent) return null

  return (
    <div className="brief consent">
      <article className="brief-card brief-main consent-card" role="alertdialog" aria-live="assertive">
        <div className="brief-kicker">{t('CONFIRMATION REQUIRED')}</div>
        <div className="brief-title">{consent.tool}</div>
        {consent.detail && <pre className="consent-detail">{consent.detail}</pre>}
        <div className="consent-keys">
          <span>
            <kbd>S</kbd> {t('say yes')}
          </span>
          <span>
            <kbd>N</kbd> {t('say no')}
          </span>
        </div>
      </article>
    </div>
  )
}
