// Ask the running bridge one question by text, and print what comes back:
// the tools she used and the answer. For testing without speaking.
//   npm run ask -- "que horas são?"
// Confirmation cards are left unanswered, so anything that needs a yes is
// refused after the usual wait — this cannot approve an action.
import WebSocket from 'ws'

const question = process.argv.slice(2).join(' ').trim()
if (!question) {
  console.log('usage: npm run ask -- "your question"')
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8787', { origin: 'http://localhost:5173' })
const timer = setTimeout(() => {
  console.log('(no answer after 150 s)')
  process.exit(2)
}, 150_000)
ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', text: question })))
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.type === 'tool') console.log(`  tool: ${m.name}`)
  if (m.type === 'confirm') console.log(`  asks for consent: ${JSON.stringify(m.detail ?? m).slice(0, 160)}`)
  if (m.type === 'error') console.log(`  error: ${m.message}`)
  if (m.type === 'done') {
    console.log(`[${m.brain ?? 'claude'}] ${m.text}`)
    clearTimeout(timer)
    ws.close()
  }
})
ws.on('error', (e) => {
  console.log(`bridge not reachable: ${e.message}`)
  process.exit(1)
})
