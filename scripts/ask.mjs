// Ask the running bridge one question by text, and print what comes back:
// the tools she used and the answer. For testing without speaking.
//   npm run ask -- "que horas são?"
//   npm run ask -- "primeira" "||" "segunda"   (several, on one connection, timed)
// Confirmation cards are left unanswered, so anything that needs a yes is
// refused after the usual wait — this cannot approve an action.
import WebSocket from 'ws'

// "||" separates questions asked in turn on the same connection — the way the
// HUD asks, with the session already open — each one timed.
const questions = process.argv
  .slice(2)
  .join(' ')
  .split('||')
  .map((q) => q.trim())
  .filter(Boolean)
const question = questions[0]
if (!question) {
  console.log('usage: npm run ask -- "your question"')
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8787', { origin: 'http://localhost:5173' })
const timer = setTimeout(() => {
  console.log('(no answer after 150 s)')
  process.exit(2)
}, 150_000)
let current = 0
let askedAt = 0
const next = () => {
  askedAt = Date.now()
  ws.send(JSON.stringify({ type: 'ask', text: questions[current] }))
}
ws.on('open', next)
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type === 'tool') console.log(`  tool: ${m.name}`)
  if (m.type === 'confirm') console.log(`  asks for consent: ${JSON.stringify(m.detail ?? m).slice(0, 160)}`)
  if (m.type === 'error') console.log(`  error: ${m.message}`)
  if (m.type === 'done') {
    console.log(`[${m.brain ?? 'claude'}] ${m.text}  (${((Date.now() - askedAt) / 1000).toFixed(1)} s)`)
    current++
    if (current < questions.length) return next()
    clearTimeout(timer)
    ws.close()
  }
})
ws.on('error', (e) => {
  console.log(`bridge not reachable: ${e.message}`)
  process.exit(1)
})
