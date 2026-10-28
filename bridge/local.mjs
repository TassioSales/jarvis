import { clock } from './gemini.mjs'

/**
 * A third brain, on this machine (after OpenJarvis, Stanford: local first,
 * the cloud only when it is needed).
 *
 * Llama 3.2 3B through Ollama, on the graphics card beside the transcriber.
 * Measured here: about 0.6 s a warm answer, right on sums, percentages, dates
 * and small talk in Portuguese — and no internet, no allowance, no cost. It
 * is not the first choice (Gemini is as fast and knows more), it is what
 * keeps her talking when the others cannot: offline, out of quota, or down.
 *
 * Optional: if Ollama is not running or the model is not pulled, it does not
 * exist. JARVIS_LOCAL_MODEL picks another model; JARVIS_LOCAL_BRAIN=0 turns it off.
 */
const OFF = process.env.JARVIS_LOCAL_BRAIN === '0'
const MODEL = process.env.JARVIS_LOCAL_MODEL ?? 'llama3.2:3b'
const OLLAMA = process.env.OLLAMA_HOST?.replace(/\/+$/, '') || 'http://127.0.0.1:11434'

let ready = { at: 0, ok: false }

/** Whether the model is there to ask. Checked at most every half minute. */
export async function localReady() {
  if (OFF) return false
  if (Date.now() - ready.at < 30_000) return ready.ok
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) })
    const data = await res.json()
    ready = { at: Date.now(), ok: (data.models ?? []).some((m) => m.name === MODEL || m.model === MODEL) }
  } catch {
    ready = { at: Date.now(), ok: false }
  }
  return ready.ok
}
export const localReadyNow = () => ready.ok
export const localModel = () => MODEL

/** Load it into memory now, so the first real question is not the slow one. */
export async function warmLocal() {
  if (!(await localReady())) return
  fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '30m' }),
  }).catch(() => {})
}

const ESCALATE = /^\W*(ESCALATE|ESCALAR)\b/i

/** Requests to do something, by their opening verb (imperative or "me + verb"). */
const ACTION =
  /^(?:(?:por favor|wednesday|jarvis)[\s,]+)?(?:me\s+)?(?:anot|lembr|marc|agend|toc|coloc|bot|abr|fech|envi|mand|lig|deslig|cri|salv|apag|exclu|paus|pul|aument|abaix|desbloque|bloque|procur|pesquis|busc|abr|mostr|exib|grav|cancel|adi|responde|escrev|compr|pag)\w*\b/i

const LOCAL_PERSONA = `Você é Wednesday, assistente pessoal. Responda em português do Brasil.
Trate a pessoa por "senhor". No máximo duas frases curtas. Sem listas, sem emojis.
Faça contas com cuidado e diga só o resultado.`

const LOCAL_ROUTING = `${LOCAL_PERSONA}
Se a pergunta precisar de internet, notícias, clima, trânsito, agenda, lembretes, notas, e-mail, música, arquivos ou de alguma ação no computador, responda apenas: ESCALAR
Exemplos:
Pergunta: Quanto é 20% de 50? Resposta: Dez, senhor.
Pergunta: Como está o trânsito? Resposta: ESCALAR
Pergunta: Toca uma música do Queen. Resposta: ESCALAR
Pergunta: Abre o Spotify. Resposta: ESCALAR
Pergunta: Me lembra às seis de pagar a conta. Resposta: ESCALAR`

const LOCAL_STANDIN = `${LOCAL_PERSONA}
Os outros sistemas estão fora do ar e você responde sozinha, sem internet. Se a pergunta precisar de internet, agenda, e-mail ou de uma ação, diga em uma frase que isso está indisponível no momento.`

/**
 * Same contract as gemini.quick: an answer, or an escalation.
 * @param {{role: 'user' | 'model', text: string}[]} history
 * @param {{ standIn?: boolean, notes?: string, signal?: AbortSignal }} [opts]
 */
export async function localQuick(history, question, opts = {}) {
  if (!(await localReady())) return { escalate: true, why: 'no local model' }
  // A small model told it cannot act will still say "noted" to "note that…".
  // An order is never its to answer, so orders do not reach it: a claim to
  // have done something that was not done is worse than no answer.
  if (!opts.standIn && ACTION.test(question.trim())) return { escalate: true, why: 'needs the agent' }
  // Short on purpose. The long instruction the cloud models get — routing
  // rules, a page of persona — measurably confused a 3B model: with it, "15%
  // of 200" came back "three". A few plain lines and two examples do better.
  const system =
    (opts.standIn ? LOCAL_STANDIN : LOCAL_ROUTING) +
    clock() +
    (opts.notes ? `\nFatos que você sabe:${opts.notes.slice(0, 1500)}` : '')
  // Generous when it is not yet in memory: it is loaded on demand, and the
  // first question after a while pays for the load.
  const limit = AbortSignal.timeout(opts.standIn ? 20_000 : 15_000)
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      signal: opts.signal ? AbortSignal.any([opts.signal, limit]) : limit,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        keep_alive: '30m',
        messages: [
          { role: 'system', content: system },
          ...history.slice(-8).map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text })),
          { role: 'user', content: question },
        ],
        options: { temperature: 0.3, num_predict: 160 },
      }),
    })
    if (!res.ok) return { escalate: true, why: `ollama ${res.status}` }
    const text = String((await res.json()).message?.content ?? '').trim()
    if (!text) return { escalate: true, why: 'empty answer' }
    if (!opts.standIn && ESCALATE.test(text)) return { escalate: true, why: 'needs the agent' }
    return { text: text.replace(/\b(ESCALATE|ESCALAR)\b\W*/gi, '').trim() || text }
  } catch (err) {
    return { escalate: true, why: err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err) }
  }
}
