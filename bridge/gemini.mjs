/**
 * A second, lighter brain for the questions that do not need the first.
 *
 * Every turn through Claude Code carries the whole agent with it — the
 * persona, the tools, the connectors — whether the question is "draft a reply
 * to that email" or "what is twelve times twelve". That is the right machine
 * for the first and an expensive one for the second, and a subscription's
 * allowance does not tell them apart.
 *
 * So a small model gets first refusal. It is told plainly that it has no
 * tools, no inbox, no calendar and no news, and that the correct answer to
 * anything needing those is the single word ESCALATE — at which point the
 * question goes to Claude as if this had never been asked. It answers only
 * what it can answer from its own head: arithmetic, definitions, conversions,
 * conversation, the time.
 *
 * It is also the understudy. When Claude cannot answer at all — signed out,
 * over its limit, unreachable — this answers instead, saying what it cannot
 * do rather than leaving him silent.
 *
 * Optional throughout: with no GEMINI_API_KEY none of this exists.
 */

const KEY = process.env.GEMINI_API_KEY?.trim()
const MODEL = process.env.JARVIS_GEMINI_MODEL ?? 'gemini-flash-lite-latest'
const LANG = process.env.JARVIS_LANG ?? process.env.VITE_JARVIS_LANG ?? 'en-GB'
const PT = /^pt/i.test(LANG)

/** Long enough for a healthy answer, short enough that a hung request costs
 *  the user less than simply having asked Claude in the first place. */
const TIMEOUT_MS = 3500

export const geminiReady = () => Boolean(KEY)
export const geminiModel = () => MODEL

const ESCALATE = /^\W*(ESCALATE|ESCALAR)\b/i

const PERSONA = PT
  ? `Você é JARVIS, um mordomo de inteligência artificial. Fala em voz alta com uma pessoa.
- Sempre em português do Brasil. Trate por "senhor"; nunca use o nome da pessoa.
- No máximo duas frases curtas. Texto corrido: sem markdown, listas, emojis ou links.
- Números, datas e horas por extenso, como se fala: "oito e quinze", "vinte graus".
- Sem entusiasmo e sem pedir desculpas. Registro formal, seco, de mordomo.
- Responda só o que foi perguntado e pare. Nunca ofereça mais ajuda nem termine com uma pergunta.
- Perguntado pela hora, diga só a hora; pela data, só a data.`
  : `You are JARVIS, an AI butler, speaking aloud to one person.
- Address them as "sir"; never use their name.
- Two short sentences at most. Plain prose: no markdown, lists, emoji or links.
- Numbers, dates and times as spoken: "eight fifteen", "twenty degrees".
- No enthusiasm, no apology. A formal, dry, butler's register.
- Answer what was asked and stop. Never offer further help or end on a question.
- Asked the time, give only the time; asked the date, only the date.`

const ROUTING = PT
  ? `
VOCÊ NÃO TEM FERRAMENTAS. Não tem acesso a e-mail, agenda, arquivos, internet, notícias, clima, cotações, câmera, tela nem ao computador, e não pode abrir, criar, enviar, lembrar ou alterar nada.
Responda você mesmo APENAS o que sabe de cabeça com certeza: contas, conversões, definições, conhecimento geral estável, conversa, continuações do que já foi dito NESTA conversa, e os dados informados abaixo (data, hora, e leituras ao vivo de clima e câmbio quando houver).
Para QUALQUER outra coisa — algo que dependa de ferramenta, de fato atual, de algo pessoal do usuário, de uma ação, ou de algo dito antes que não esteja nesta conversa — responda somente com a palavra ESCALAR, sem mais nada. Tocar, colocar ou procurar uma música, artista ou playlist é sempre ESCALAR. Na dúvida, ESCALAR.`
  : `
YOU HAVE NO TOOLS. No mail, calendar, files, internet, news, weather, prices, camera, screen or computer access, and you cannot open, create, send, remember or change anything.
Answer yourself ONLY what you know for certain from memory: arithmetic, conversions, definitions, stable general knowledge, conversation, follow-ups to what was already said IN THIS conversation, and the data given below (date, time, and live weather and exchange readings when present).
For ANYTHING else — anything needing a tool, a current fact, something personal to the user, an action, or something said earlier that is not in this conversation — reply with the single word ESCALATE and nothing more. Playing or finding a song, artist or playlist is always ESCALATE. When in doubt, ESCALATE.`

const STANDING_IN = PT
  ? `
Seu sistema principal está indisponível agora e você responde no lugar dele, sem ferramentas. Se o pedido precisar de e-mail, agenda, internet, arquivos ou de alguma ação, diga em uma frase que isso está indisponível no momento. Caso contrário, responda normalmente.`
  : `
Your main system is unavailable and you are answering in its place, without tools. If the request needs mail, calendar, the internet, files or an action, say in one sentence that it is unavailable for the moment. Otherwise answer normally.`

function clock() {
  const now = new Date()
  return PT
    ? `\nAgora: ${now.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })}.`
    : `\nNow: ${now.toLocaleString(LANG, { dateStyle: 'full', timeStyle: 'short' })}.`
}

/**
 * Ask the small model.
 *
 * @param {{role: 'user' | 'model', text: string}[]} history  recent turns, oldest first
 * @param {string} question
 * @param {{ standIn?: boolean, notes?: string, signal?: AbortSignal }} [opts]
 *   standIn: answering because Claude cannot, so never escalate.
 *   notes: what he has been told to remember about the user.
 * @returns {Promise<{ text: string } | { escalate: true, why: string }>}
 */
export async function quick(history, question, opts = {}) {
  if (!KEY) return { escalate: true, why: 'no key' }

  const system = PERSONA + (opts.standIn ? STANDING_IN : ROUTING) + clock() + (opts.notes ?? '')
  const contents = [
    ...history.slice(-10).map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user', parts: [{ text: question }] },
  ]

  const limit = AbortSignal.timeout(opts.standIn ? 12_000 : TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: opts.signal ? AbortSignal.any([opts.signal, limit]) : limit,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 220 },
        }),
      },
    )
    if (!res.ok) return { escalate: true, why: `http ${res.status}` }
    const data = await res.json()
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    if (!text) return { escalate: true, why: 'empty answer' }
    if (!opts.standIn && ESCALATE.test(text)) return { escalate: true, why: 'needs the agent' }
    // A model told to say one word sometimes says it and then keeps going.
    return { text: text.replace(/\b(ESCALATE|ESCALAR)\b\W*/gi, '').trim() || text }
  } catch (err) {
    return { escalate: true, why: err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err) }
  }
}

/**
 * Turn a few seconds of speech into text.
 *
 * The understudy for hearing, as `quick` is for answering: used when the
 * speech service has no credit left, so that he does not go deaf the same
 * day he loses his voice.
 *
 * @param {Buffer} audio
 * @param {string} mime  as the recorder reported it
 * @returns {Promise<string | null>} null when it could not be done
 */
export async function transcribe(audio, mime) {
  if (!KEY) return null
  const instruction = PT
    ? 'Transcreva exatamente o que é dito neste áudio, em português do Brasil. Responda só com a transcrição, sem aspas nem comentários. O assistente se chama Jarvis. Se não houver fala, responda com nada.'
    : 'Transcribe exactly what is said in this audio. Reply with the transcript only, no quotes or comments. The assistant is called Jarvis. If there is no speech, reply with nothing.'
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: mime.split(';')[0].trim(), data: audio.toString('base64') } },
                { text: instruction },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 200 },
        }),
      },
    )
    if (!res.ok) return null
    const data = await res.json()
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()
  } catch {
    return null
  }
}
