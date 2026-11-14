/* eslint-disable no-eval */
// Checks the patterns that decide what he hears, against phrases that must and
// must not match. Run with `npm run test:voice`.
//
// These patterns are read out of the source rather than imported, because the
// files they live in also touch the microphone and the DOM. That is fragile in
// one way — rename a constant and this fails loudly — and that is the point.
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const voice = read('lib/voice.ts')
const app = read('App.tsx')

/** The source text of `const NAME = <expression>`, up to the next declaration. */
function source(text, name) {
  const m = new RegExp(`const ${name}(?::[^=]+)? =\\s*([\\s\\S]*?)\\n(?=/\\*\\*|const |export |\\n)`).exec(text)
  if (!m) throw new Error(`could not find ${name}`)
  return m[1].trim()
}

const NAME_PATTERN = eval(source(voice, 'NAME_PATTERN'))
const HAIL_PATTERN = eval(source(voice, 'HAIL_PATTERN'))
const WAKE = eval(source(voice, 'WAKE'))
const GREETING = eval(source(voice, 'GREETING'))

// App.tsx builds some of its patterns from these two.
const NAME = NAME_PATTERN
const HAIL = HAIL_PATTERN
void HAIL
const THING = eval(source(app, 'THING'))
void THING
const patterns = { WAKE, GREETING }
for (const name of ['UP_TO_NAME', 'STOP_CMD', 'BARE_STOP', 'LOCK_CMD', 'UNLOCK_CMD', 'ENROL_CMD', 'IDENTIFY_CMD', 'BRIEF_CMD', 'NIGHT_CMD', 'HELP_CMD', 'YES_CMD', 'NO_CMD', 'VOICE_ENROL_CMD', 'VOICE_FORGET_CMD', 'MUTE_CMD', 'FOCUS_CMD', 'FOCUS_END_CMD']) {
  patterns[name] = eval(source(app, name))
}
void NAME

const cases = {
  WAKE: {
    yes: ['Jarvis', 'jarvis, que horas são?', 'Ei, Jarvis', 'Jarves', 'Jarvez', 'Jarviz', 'Jarbis', 'Javis', 'Jervis', 'Jairvis', 'Djarvis', 'Járvis', 'Jarbas', 'Charvis', 'Travis', 'ô Jarvis', 'Oi Jarvis, bom dia', 'Daves', 'Dávis', 'Charles', 'Jaz', 'James, Spotify já tá ativo', 'Tá pensando, seu Java?', 'Java', 'Wednesday', 'Wednesday, que horas são?', 'Winsdy, toca uma música', 'Ei Wensday', 'Uênsdei', 'oi Wendsday', 'Wednesdey'],
    no: ['já vi esse filme', 'a jarra está cheia', 'vou viajar amanhã', 'que horas são', 'chaves do carro', 'o javali', 'java é uma linguagem', 'jardim', 'a televisão está alta', 'serviço', 'devo ir', 'as vendas de quarta', 'o castelo de Windsor', 'quarta-feira tem reunião', 'vende sabão'],
  },
  GREETING: {
    yes: ['Bom dia.', 'Boa tarde', 'boa noite, senhor', 'Good morning'],
    no: ['e boa noite para vocês', 'bom dia a todos os ouvintes do programa', 'que dia bom'],
  },
  BARE_STOP: {
    yes: ['Chega.', 'Pare', 'pode parar', 'cancela', 'silêncio'],
    no: ['para', 'isso é para você', 'pare de falar sobre o tempo e me diga as horas'],
  },
  LOCK_CMD: { yes: ['bloquear', 'Bloquear os monitores.', 'travar tudo'], no: ['bloquear o site da concorrência', 'bloqueio'] },
  UNLOCK_CMD: { yes: ['ativar monitor', 'Ativar os monitores.', 'desbloquear'], no: ['ativar o modo noturno', 'ativa o alarme das seis'] },
  ENROL_CMD: { yes: ['cadastrar meu rosto', 'Cadastrar o meu rosto.', 'registrar rosto', 'cadastrar reconhecimento facial'], no: ['cadastrar um cliente', 'meu rosto está cansado'] },
  IDENTIFY_CMD: { yes: ['sou eu', 'confirmar identidade'], no: ['sou eu que mando aqui e quero saber as horas'] },
  BRIEF_CMD: { yes: ['Bom dia', 'bom dia, Jarvis', 'boa tarde', 'briefing', 'resumo do dia'], no: ['bom dia, que horas são?', 'me dá um resumo do e-mail do banco'] },
  NIGHT_CMD: { yes: ['boa noite', 'boa noite, Jarvis', 'hora de dormir', 'modo noturno', 'descansar'], no: ['boa noite a todos', 'durmo às dez'] },
  HELP_CMD: { yes: ['ajuda', 'comandos', 'o que você sabe fazer?', 'help'], no: ['me ajuda a escrever um e-mail', 'ajuda o cliente'] },
  YES_CMD: { yes: ['sim', 'Sim, pode.', 'confirmo', 'prossiga'], no: ['não', 'talvez', 'espera'] },
  NO_CMD: { yes: ['não', 'Não, cancela.', 'negativo'], no: ['sim', 'pode'] },
  VOICE_ENROL_CMD: { yes: ['aprende a minha voz', 'Aprenda minha voz.', 'cadastrar minha voz', 'reconhecer a minha voz'], no: ['aprende a tocar violão', 'minha voz está rouca', 'cadastrar meu rosto'] },
  MUTE_CMD: { yes: ['desliga o microfone', 'Desligue o microfone.', 'para de me ouvir', 'silencia o microfone'], no: ['desliga a luz', 'mudo', 'o microfone está ruim', 'para de tocar'] },
  FOCUS_CMD: { yes: ['modo foco', 'Modo foco por 25 minutos.', 'entra em modo foco por uma hora', 'foco', 'me deixa concentrar meia hora'], no: ['foco no trabalho amanhã', 'o foco da câmera está ruim'] },
  FOCUS_END_CMD: { yes: ['sair do modo foco', 'termina o foco', 'fim do foco'], no: ['modo foco', 'termina o e-mail'] },
  VOICE_FORGET_CMD: { yes: ['esquece a minha voz', 'Apague minha voz.', 'esquecer minha voz'], no: ['esquece isso', 'apaga a luz'] },
}

let failures = 0
let checks = 0

// Her name, come back as a weekday.
const WEEKDAY_AS_NAME = eval(source(voice, 'WEEKDAY_AS_NAME'))
for (const [text, expected] of [
  ['a sexta-feira, no dia de janeiro.', 'Wednesday, no dia de janeiro.'],
  ['Ei, sexta-feira, qual é a hora?', 'Ei, Wednesday, qual é a hora?'],
  ['Quarta-feira, toca uma música', 'Wednesday, toca uma música'],
  ['quinta-feira!', 'Wednesday!'],
  ['sexta-feira tem jogo do Flamengo', 'sexta-feira tem jogo do Flamengo'],
  ['a reunião é na quarta-feira, às dez', 'a reunião é na quarta-feira, às dez'],
  ['vou sexta-feira ao médico', 'vou sexta-feira ao médico'],
]) {
  checks++
  const got = text.replace(WEEKDAY_AS_NAME, '$1Wednesday')
  if (got !== expected) {
    failures++
    console.log(`weekday: ${JSON.stringify(text)} gave ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
  }
}

// The media shortcuts: each phrase must reach the right key, and ordinary
// sentences must reach none.
const MEDIA_CMDS = eval(source(app, 'MEDIA_CMDS'))
const mediaFor = (text) => MEDIA_CMDS.find(([re]) => re.test(text.trim()))?.[1] ?? null
for (const [text, expected] of [
  ['pausa', 'pause'],
  ['Pausa a música.', 'pause'],
  ['para a música', 'pause'],
  ['play', 'play'],
  ['toca', 'play'],
  ['Toca Bloody Groove', null],
  ['toca uma música do Sepultura', null],
  ['próxima', 'next'],
  ['pula essa música', 'next'],
  ['anterior', 'previous'],
  ['aumenta o volume', 'volume_up'],
  ['abaixa um pouco o som', 'volume_down'],
  ['mudo', 'mute'],
  ['qual é a próxima reunião?', null],
  ['pausa para o café às três', null],
  ['o volume de vendas aumentou?', null],
  ['toca aí no assunto do contrato', null],
]) {
  checks++
  if (mediaFor(text) !== expected) {
    failures++
    console.log(`media: ${JSON.stringify(text)} gave ${mediaFor(text)}, expected ${expected}`)
  }
}
for (const [name, { yes, no }] of Object.entries(cases)) {
  const re = patterns[name]
  for (const text of yes) {
    checks++
    if (!re.test(text)) {
      failures++
      console.log(`${name} should match:      ${JSON.stringify(text)}`)
    }
  }
  for (const text of no) {
    checks++
    if (re.test(text)) {
      failures++
      console.log(`${name} should NOT match:  ${JSON.stringify(text)}`)
    }
  }
}

// While he is busy, only what is addressed to him by name gets through.
for (const [text, expected] of [
  ['a televisão está alta', 'ignored'],
  ['Jarvis, pare.', 'stop'],
  ['ei Jarvis cancela isso', 'stop'],
  ['então Jarvis, que horas são?', 'order: que horas são?'],
]) {
  checks++
  const order = patterns.UP_TO_NAME.test(text) ? text.replace(patterns.UP_TO_NAME, '').trim() : null
  const got = order === null ? 'ignored' : !order || patterns.STOP_CMD.test(order) ? 'stop' : `order: ${order}`
  if (got !== expected) {
    failures++
    console.log(`while busy, ${JSON.stringify(text)} gave "${got}", expected "${expected}"`)
  }
}

console.log(failures ? `${failures} of ${checks} checks failed` : `all ${checks} checks pass`)
process.exit(failures ? 1 : 0)
