import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { t } from '../lib/i18n'

/**
 * Rotating example commands, shown only while idle.
 *
 * A voice interface has no menus — nothing tells you what it can do. This is
 * the affordance. It disappears the moment JARVIS is doing anything, so it
 * never competes with the answer.
 *
 * Each line is phrased the way you'd actually say it, not as a feature name.
 */
// Things she does now, as he would say them — not the original demo's list,
// half of which (an image of the Mark VII suit, his phone's screen) she cannot.
const EXAMPLES = [
  'how is the traffic to work',
  "what's on my calendar today",
  'play something by Iron Maiden',
  'remind me at six to call João',
  'focus mode for 25 minutes',
  'what does this error on my screen say',
  "what's the weather this weekend",
  'learn my voice',
  'what did I do yesterday',
  'summarise the news of the day',
]

const ROTATE_MS = 4200

export function Suggestions() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Only while genuinely idle, and only until the first exchange — once the
  // user knows how it works, the prompt is just clutter.
  if (phase !== 'dormant' || turns.length > 0) return null

  return (
    <div className="suggest">
      <span className="suggest-lead">{t('try')}</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          “wednesday, {t(EXAMPLES[i])}”
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
