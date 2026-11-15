import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Plasma } from './scene/Plasma'
import { Hud } from './ui/Hud'
import { Ambience } from './ui/Ambience'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Lock } from './ui/Lock'
import { Briefing } from './ui/Briefing'
import { Consent } from './ui/Consent'
import { Help } from './ui/Help'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import {
  HAIL_PATTERN,
  NAME_PATTERN,
  setVoiceEnrolling,
  startVoice,
  voiceLog,
  type Voice,
  type VoiceMode,
} from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as face from './lib/face'
import { publish } from './lib/sync'
import {
  INBOX_PROMPT,
  inboxScenes,
  loadScenes,
  loadNightScenes,
  type Scene as BriefScene,
} from './lib/briefing'
import * as kokoro from './lib/kokoro'
import { BRIDGE_HTTP_URL, ORB, PRESENCE, TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchConfirm,
  watchReminders,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel, releaseMic } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'
import { t as tr } from './lib/i18n'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** Once someone has started speaking, how long he will wait for the words.
 *  Longer than the longest segment the detector records, plus the round trip
 *  to transcribe it — this is a safety net for speech that never becomes a
 *  transcript, not a limit on how long a sentence may be. */
const SPEAKING_GRACE_MS = 28000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
// Short: a longer window let the rest of the house become questions ("parabéns
// para o meu esposo" was answered). After it, her name starts a new turn.
const FOLLOW_UP_MS = 8000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = NAME_PATTERN
const HAIL = HAIL_PATTERN
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^${HAIL}?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** His name anywhere in what was said, and everything up to and including it. */
const UP_TO_NAME = new RegExp(`^.*?\\b${NAME}\\b[\\s,.:!?-]*`, 'i')
/** "Jarvis, stop" — an order to be quiet, not a new question. */
const STOP_CMD =
  /^(?:pare|para|parar|chega|cancela|cancelar|cancele|sil[eê]ncio|quieto|stop|cancel|quiet|enough)\b[\s\S]{0,24}$/i
/** The whole of what was said is an order to be quiet. */
const BARE_STOP =
  /^(?:pare|parar|pode parar|chega|j[aá] chega|cancela|cancelar|sil[eê]ncio|quieto|stop|enough|quiet|shut up)[\s.!]*$/i
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^${HAIL}?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/**
 * Orders he carries out himself, without asking the model.
 *
 * Locking and unlocking have to work while the model is unreachable, and they
 * have to be instant — a lock that takes four seconds and a round trip to
 * engage is not one. So these three are matched on the words. Each accepts the
 * bare verb or the verb with an object ("bloquear", "bloquear os monitores"),
 * and nothing longer: "bloquear o site da concorrência" is a question for the
 * model, not a command to the lock.
 */
const THING =
  '(?:\\s+(?:os?|as?|the|my|meus?|minhas?))?\\s+(?:monitor(?:es|s)?|sistemas?|systems?|telas?|screens?|tudo|everything|centro de comando)'
const LOCK_CMD = new RegExp(
  `^(?:bloquear|bloqueie|bloqueia|travar|trave|lock)(?:${THING})?[\\s.!]*$`,
  'i',
)
const UNLOCK_CMD = new RegExp(
  `^(?:ativar|ative|ativa|desbloquear|desbloqueie|destravar|liberar|libere|unlock|activate)(?:${THING})?[\\s.!]*$`,
  'i',
)
const ENROL_CMD =
  /^(?:cadastrar|cadastre|cadastra|registrar|registre|registra|gravar|grave|salvar|salve|aprender|aprenda|reconhecer|reconhe[cç]a|enrol|enroll|register|learn)\s+(?:o\s+|a\s+)?(?:(?:meu|minha|my)\s+)?(?:rosto|face|cara|reconhecimento facial|biometria)[\s.!]*$/i
/** "Aprende a minha voz" / "esquece a minha voz". */
const VOICE_ENROL_CMD =
  /^(?:cadastrar|cadastre|cadastra|registrar|registre|registra|gravar|grave|aprender|aprenda|aprende|reconhecer|reconhe[cç]a|learn)\s+(?:a\s+)?(?:(?:minha|my)\s+)?(?:voz|voice)[\s.!]*$/i
const VOICE_FORGET_CMD =
  /^(?:esque[cç]a|esquece|esquecer|apague|apaga|apagar|forget|delete)\s+(?:a\s+)?(?:(?:minha|my)\s+)?(?:voz|voice)[\s.!]*$/i
/** "Desliga o microfone" — the voice way in to the mute. The way out is M, or the badge. */
const MUTE_CMD =
  /^(?:desliga|desligue|desligar|desativa|desative|desativar|corta|corte|silencia|silencie)\s+(?:o\s+)?microfone[\s.!]*$|^(?:para|pare)\s+de\s+(?:me\s+)?ouvir[\s.!]*$|^(?:mute|turn off)\s+(?:the\s+)?(?:mic|microphone)[\s.!]*$/i
/** "Modo foco por 50 minutos", "foco", "me deixa concentrar meia hora". */
const FOCUS_CMD =
  /^(?:(?:entra(?:r)?\s+(?:em|no)\s+)?modo\s+foco|foco|me\s+deixa\s+(?:focar|concentrar)|concentra[çc][aã]o|focus mode)(?:\s+(?:por|durante|de))?(?:\s+(\d+|uma|meia)\s*(minutos?|min|horas?|hora))?[\s.!]*$/i
const FOCUS_END_CMD =
  /^(?:sai(?:r)?\s+do\s+(?:modo\s+)?foco|termina(?:r)?\s+o\s+foco|fim\s+do\s+foco|acabou\s+o\s+foco|end focus)[\s.!]*$/i
/** How long he listens to learn a voice. */
const VOICE_ENROL_MS = 25_000
/** Answers to "shall I proceed". Anything that is neither is not an answer. */
const YES_CMD =
  /^(?:sim|pode|podes|confirmo|confirmado|confirmar?|prossiga|prosseguir|autorizo|autorizado|fa[cç]a|manda|vai|claro|isso|yes|yeah|go ahead|do it|proceed|confirm)\b/i
const NO_CMD = /^(?:n[aã]o|nunca|cancela|cancelar|cancele|negativo|pare|para|deixa|esquece|no|nope|cancel|stop|don'?t)\b/i
/**
 * What is playing, controlled on the words.
 *
 * Asking the model to pause the music means the music keeps playing for the
 * four seconds it takes to decide to. These are whole utterances and nothing
 * longer, each mapped to a media key and a number of presses.
 */
const MEDIA_CMDS: [RegExp, string, number][] = [
  [/^(?:pausa|pausar|pause|(?:pausa|pausar|para|parar) (?:a m[uú]sica|o v[ií]deo|o som))[\s.!]*$/i, 'pause', 1],
  [/^(?:play|toca|tocar|continua(?:r)? (?:a m[uú]sica|o v[ií]deo)|retoma(?:r)?(?: a m[uú]sica)?|(?:toca|tocar|solta) (?:a m[uú]sica|o v[ií]deo|o som))[\s.!]*$/i, 'play', 1],
  [/^(?:pr[oó]xima(?: m[uú]sica| faixa)?|pula(?:r)?(?: (?:essa|esta|a) (?:m[uú]sica|faixa))?|next(?: (?:song|track))?)[\s.!]*$/i, 'next', 1],
  [/^(?:(?:m[uú]sica |faixa )?anterior|volta(?:r)? (?:a|uma) (?:m[uú]sica|faixa)|previous(?: (?:song|track))?)[\s.!]*$/i, 'previous', 1],
  [/^(?:aumenta(?:r)?|sobe|subir)(?: um pouco)?(?: o)? (?:volume|som)|^(?:mais alto|volume up)[\s.!]*$/i, 'volume_up', 5],
  [/^(?:abaixa(?:r)?|baixa(?:r)?|diminui(?:r)?|reduz(?:ir)?)(?: um pouco)?(?: o)? (?:volume|som)|^(?:mais baixo|volume down)[\s.!]*$/i, 'volume_down', 5],
  [/^(?:mudo|silenciar|muta(?:r)?|tira(?:r)? o som|mute)[\s.!]*$/i, 'mute', 1],
]

/** Fast-path application launchers */
const APP_CMDS: [RegExp, string, string][] = [
  [/^(?:abre|abrir|iniciar|inicie|coloque|toca|tocar|solta|soltar|bota|botar|roda|rodar)(?: no| o| a)? (?:spotify|m[uú]sica)[\s.!]*$/i, 'spotify', 'Iniciando o Spotify para você, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie)(?: o)? (?:vs\s*code|vscode|c[oó]digo)[\s.!]*$/i, 'vscode', 'Abrindo o Visual Studio Code, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie)(?: a)? calculadora[\s.!]*$/i, 'calc', 'Calculadora pronta, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie)(?: o)? (?:bloco de notas|notepad)[\s.!]*$/i, 'notepad', 'Abrindo o Bloco de Notas, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie)(?: o)? (?:terminal|powershell|cmd)[\s.!]*$/i, 'terminal', 'Terminal pronto, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie|status)(?: o)? (?:biopulse|agrovision|ten[eé]brio)[\s.!]*$/i, 'biopulse', 'Abrindo a plataforma BioPulse AI na porta 5050, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie|status)(?: o)? (?:marketpulse|painel econ[oô]mico)[\s.!]*$/i, 'marketpulse', 'Abrindo o MarketPulse AI na porta 8080, senhor.'],
  [/^(?:abre|abrir|iniciar|inicie)(?: o)? (?:chrome|navegador|browser|google)[\s.!]*$/i, 'chrome', 'Abrindo o navegador, senhor.'],
]

/** Asking what he can do, which is answered on screen rather than by the model. */
const HELP_CMD =
  /^(?:ajuda|me ajuda|socorro|comandos|quais (?:s[aã]o )?os comandos|o que (?:voc[eê]|o senhor) (?:sabe|pode|consegue) fazer|help|commands|what can you do)[\s.?!]*$/i
/** A greeting on its own is a request for the day (see briefing.ts). */
const BRIEF_CMD =
  /^(?:(?:muito\s+)?bom dia|boa tarde|good (?:morning|afternoon)|briefing|resumo(?: do dia)?|como est[aá] o dia)(?:[\s,]+(?:senhor|jarvis|sir))?[\s.!?]*$/i
/** Night routine protocol: bedtime, good night, standby. */
const NIGHT_CMD =
  /^(?:boa noite|good night|hora de dormir|modo noturno|descansar|dormir|encerrar o dia)(?:[\s,]+(?:senhor|jarvis|sir))?[\s.!?]*$/i
/** "It's me" — asking to be let in without naming the monitors. */
const IDENTIFY_CMD =
  /^(?:sou eu|confirmar?(?:\s+(?:a\s+)?minha)?\s+identidade|me\s+reconhe[cç]a|reconhecimento facial|it'?s me|identify me)[\s.!]*$/i

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)
  // What the voice loop was started with, so a mute can start it again the same way.
  const voiceHandlers = useRef<Parameters<typeof startVoice>[0] | null>(null)
  // The badge on the HUD unmutes by event, since it lives outside this component.
  const unmuteRef = useRef<() => void>(() => {})
  // Ends focus mode when its time is up; held in a ref so the timer below,
  // set once, always calls the current closure.
  const endFocusRef = useRef<(early: boolean) => void>(() => {})
  // Presence by camera: when he was last seen, and whether this morning's
  // briefing has been given (remembered across reloads for the day).
  const presence = useRef({
    lastSeen: 0,
    morning: (() => {
      try {
        return localStorage.getItem('jarvis.morning') ?? ''
      } catch {
        return ''
      }
    })(),
  })
  const presenceRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!PRESENCE) return
    const timer = setInterval(() => presenceRef.current(), 45_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const timer = setInterval(() => {
      const until = store.getState().focusUntil
      if (until && Date.now() >= until) endFocusRef.current(false)
    }, 5000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const on = () => unmuteRef.current()
    window.addEventListener('jarvis-unmute', on)
    return () => window.removeEventListener('jarvis-unmute', on)
  }, [])

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the on-device detector last heard his name, so the transcript of
   *  that same breath can be told from a name said mid-conversation. */
  const nameAt = useRef(0)
  /** Reminders that fell due while he was busy, said once he is free. */
  const dueQueue = useRef<{ text: string; briefing: boolean; offer?: string }[]>([])
  // A habit he has just offered to carry out, and until when a bare "sim"
  // counts as accepting it.
  const offer = useRef<{ ask: string; until: number } | null>(null)
  /** Settles the open "shall I proceed" question, if there is one. */
  const consent = useRef<((ok: boolean) => void) | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setBriefing(null)
    s.setHelp(false)
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : tr('Something went wrong.'))
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- the lock -------------------------------------------------------------

  /** Say one line and wait for it to finish. */
  const announce = async (line: string) => {
    const spk = createSpeaker()
    speaker.current = spk
    spk.say(tr(line))
    await spk.end()
    if (speaker.current === spk) speaker.current = null
  }

  /** Let the lock's last state show for a moment, then clear it. */
  const settleIdentity = () =>
    setTimeout(() => store.getState().setIdentity('idle'), 2400)

  /**
   * Check who is asking, and let them in if it is the person who enrolled.
   * `pending` is whatever they said along with his name; once they are through
   * it is answered as if the lock had never been there.
   */
  const unlock = async (pending: string) => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    clearIdle()
    silence()

    const s = store.getState()
    s.setPhase('thinking')
    s.setIdentity('scanning')

    // Spoken while he looks, not before: the scan is the slow part, and a
    // sentence of warning is exactly how long it usually takes.
    const speaking = announce('One moment while I confirm your identity.')
    let verdict: face.Verdict | 'error'
    try {
      verdict = await face.verify(8000, stale)
    } catch (err) {
      console.error('[jarvis] identity check failed:', err)
      verdict = 'error'
    }
    await speaking
    if (stale()) {
      store.getState().setIdentity('idle')
      return
    }

    if (verdict === 'match') {
      s.setLocked(false)
      s.setIdentity('granted')
      s.fireEffect('scan')
      sfx.play('done')
      await announce('Biometric identity confirmed, sir. Systems unlocked.')
      settleIdentity()
      if (stale()) return
      if (pending && !UNLOCK_CMD.test(pending) && !IDENTIFY_CMD.test(pending)) handle(pending)
      else listen(FOLLOW_UP_MS)
      return
    }

    s.setIdentity('denied')
    s.fireEffect('glitch')
    sfx.play('error')
    await announce(
      verdict === 'stranger'
        ? 'I do not recognise you. Access denied.'
        : verdict === 'nobody'
          ? 'I cannot see anyone, sir. Systems remain locked.'
          : 'The camera is unavailable, sir. Systems remain locked.',
    )
    settleIdentity()
    if (!stale()) goDormant()
  }

  const lock = async () => {
    if (!face.enrolled()) {
      ++turn.current
      store.getState().setPhase('speaking')
      await announce('There is no face on record, sir. Say: register my face.')
      listen(FOLLOW_UP_MS)
      return
    }
    const mine = ++turn.current
    clearIdle()
    const s = store.getState()
    // What was on screen goes with it; a locked room does not leave the
    // conversation up on the wall.
    s.clearScreen('all')
    s.setBriefing(null)
    s.setLocked(true)
    s.setIdentity('idle')
    s.setPhase('speaking')
    await announce('Systems locked, sir.')
    if (mine === turn.current) goDormant()
  }

  /**
   * Learn the owner's voice: twenty-odd seconds of him talking, each clip
   * summarised by the local helper and averaged into a voiceprint. From then
   * on a wake word in anyone else's voice is ignored.
   */
  /**
   * The microphone off, for real: the voice loop stopped and every track given
   * back, so the browser's and the system's recording lights go out. Nothing
   * is transcribed, by anyone, until M is pressed or the badge clicked.
   */
  const mute = async () => {
    const s = store.getState()
    if (s.muted) return
    sfx.play('done')
    ++turn.current
    clearIdle()
    s.setPhase('speaking')
    await announce('Microphone off, sir. Press M when you want me back.')
    voice.current?.stop()
    voice.current = null
    releaseMic()
    s.setMuted(true)
    goDormant()
  }

  const unmute = async () => {
    const s = store.getState()
    if (!s.muted || !voiceHandlers.current) return
    sfx.play('wake')
    s.setMuted(false)
    try {
      await startAnalyser()
    } catch {
      /* the reactor just will not pulse */
    }
    voice.current = await startVoice(voiceHandlers.current)
    s.setPhase('speaking')
    await announce('Microphone on, sir.')
    goDormant()
  }
  unmuteRef.current = () => void unmute()

  const enrolVoice = async () => {
    const mine = ++turn.current
    clearIdle()
    const s = store.getState()
    try {
      const status = await (await fetch(`${BRIDGE_HTTP_URL}/voice`)).json()
      if (!status.available) {
        s.setPhase('speaking')
        await announce('Voice recognition is not available on this machine, sir.')
        if (mine === turn.current) goDormant()
        return
      }
    } catch {
      /* the finish call below reports it */
    }
    s.setPhase('speaking')
    await announce('I shall learn your voice, sir. For the next twenty seconds, talk normally, without saying my name. Begin.')
    if (mine !== turn.current) return
    setVoiceEnrolling(true)
    s.setPhase('listening')
    const startEnrol = Date.now()
    const enrolTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((VOICE_ENROL_MS - (Date.now() - startEnrol)) / 1000))
      store.getState().setCaption(`[ ${tr('VOICE BIOMETRICS')} // ${left}s ]`)
    }, 400)
    await new Promise((r) => setTimeout(r, VOICE_ENROL_MS))
    clearInterval(enrolTimer)
    store.getState().setCaption('')
    setVoiceEnrolling(false)
    // The last clip may still be on its way to the helper.
    await new Promise((r) => setTimeout(r, 2500))
    let clips = 0
    try {
      clips = (await (await fetch(`${BRIDGE_HTTP_URL}/voice/finish`, { method: 'POST' })).json()).clips ?? 0
    } catch {
      clips = 0
    }
    if (mine !== turn.current) return
    s.setPhase('speaking')
    await announce(
      clips
        ? 'Your voice is learned, sir. From now on I answer only to you.'
        : 'I did not hear enough to learn your voice, sir. Nothing was saved.',
    )
    if (mine === turn.current) goDormant()
  }

  const forgetVoice = async () => {
    const mine = ++turn.current
    clearIdle()
    try {
      await fetch(`${BRIDGE_HTTP_URL}/voice/forget`, { method: 'POST' })
    } catch {
      /* nothing to forget */
    }
    store.getState().setPhase('speaking')
    await announce('Your voice is forgotten, sir. I answer to anyone again.')
    if (mine === turn.current) goDormant()
  }

  const enrolFace = async () => {
    const mine = ++turn.current
    clearIdle()
    const s = store.getState()
    s.setPhase('thinking')
    s.setIdentity('scanning')
    const speaking = announce('Look at the camera, sir.')
    let kept = 0
    try {
      kept = await face.enrol()
    } catch (err) {
      console.error('[jarvis] enrolment failed:', err)
    }
    await speaking
    s.setIdentity(kept ? 'granted' : 'denied')
    settleIdentity()
    if (mine !== turn.current) return
    s.setPhase('speaking')
    await announce(
      kept
        ? 'Face registered, sir. Say: lock, whenever you want me to stand guard.'
        : 'I could not see your face clearly, sir. Nothing was registered.',
    )
    if (mine === turn.current) listen(FOLLOW_UP_MS)
  }

  /**
   * The day, as a run of cards. Each is put up, its sentence spoken, and then
   * shelved for the next. Interrupting him by name stops it where it is and
   * leaves what has been shown on screen.
   */
  const brief = async (said: string) => {
    // Asked for or given on sight, it counts as this morning's briefing.
    if (new Date().getHours() < 11) {
      presence.current.morning = new Date().toDateString()
      try {
        localStorage.setItem('jarvis.morning', presence.current.morning)
      } catch {
        /* private window */
      }
    }
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    clearIdle()
    silence()

    const s = store.getState()
    s.clearPanels()
    s.clearBlades()
    s.setBriefing(null)
    s.setHelp(false)
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    let scenes: Awaited<ReturnType<typeof loadScenes>> = []
    try {
      scenes = await loadScenes()
    } catch (err) {
      console.warn('[jarvis] briefing data unavailable:', err)
    }
    if (stale()) return
    // Nothing to show — the bridge's feeds are down. The model can still make
    // something of "good morning"; an empty briefing cannot.
    if (!scenes.length) {
      turn.current--
      return void respond(said)
    }

    // The inbox and the calendar need the model, and the model needs several
    // seconds. Asked for now and joined in when they arrive, they cost the
    // briefing nothing: he is busy reading the weather while it works.
    let extra: BriefScene[] | null = null
    const inbox = usingBridge
      ? ask(INBOX_PROMPT, [], { onText: () => {}, onTool: () => {} })
          .then(({ text }) => inboxScenes(text))
          .catch(() => [] as BriefScene[])
          .then((found) => (extra = found))
      : Promise.resolve((extra = []))

    s.setPhase('speaking')
    sfx.duck(true)
    music.duck(true)
    s.pushTurn({ id: newId(), role: 'jarvis', text: '' })

    const cards: NonNullable<BriefScene['card']>[] = []
    const queue = [...scenes]
    let joined = false
    let told = 0
    while (queue.length) {
      // After the weather at the earliest, and before the closing line at the
      // latest — where it is worth a short wait rather than leaving them out.
      if (!joined && told >= 2) {
        if (extra === null && queue.length === 1) {
          await Promise.race([inbox, new Promise((r) => setTimeout(r, 7000))])
          if (stale()) return
        }
        if (extra !== null) {
          joined = true
          queue.unshift(...(extra as BriefScene[]))
        }
      }
      const scene = queue.shift()!
      told++
      if (scene.card) cards.push(scene.card)
      store.getState().setBriefing({
        cards: [...cards],
        // The closing line has no card of its own: everything goes to the shelf.
        active: scene.card ? cards.length - 1 : -1,
        caption: scene.line,
      })
      store.getState().appendToLastTurn(`${scene.line} `)

      const spk = createSpeaker()
      speaker.current = spk
      spk.say(scene.line)
      // A voice engine that never reports the end of a sentence must not
      // freeze the briefing on one card for ever.
      await Promise.race([
        spk.end(),
        new Promise((r) => setTimeout(r, 8000 + scene.line.length * 110)),
      ])
      if (stale()) return
    }

    speaker.current = null
    sfx.duck(false)
    music.duck(false)
    sfx.play('done')
    const shown = store.getState().briefing
    if (shown) store.getState().setBriefing({ ...shown, active: -1, caption: '' })
    listen(FOLLOW_UP_MS)
  }

  /**
   * Night Routine Protocol (Stark Industries Standby & Security)
   */
  const nightRoutine = async (said: string) => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    clearIdle()
    silence()

    const s = store.getState()
    s.clearPanels()
    s.clearBlades()
    s.setBriefing(null)
    s.setHelp(false)
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    let scenes: Awaited<ReturnType<typeof loadNightScenes>> = []
    try {
      scenes = await loadNightScenes()
    } catch (err) {
      console.warn('[jarvis] night routine unavailable:', err)
    }
    if (stale()) return
    if (!scenes.length) {
      turn.current--
      return void respond(said)
    }

    s.setPhase('speaking')
    sfx.duck(true)
    music.duck(true)
    s.pushTurn({ id: newId(), role: 'jarvis', text: '' })

    const cards: NonNullable<BriefScene['card']>[] = []
    for (const scene of scenes) {
      if (scene.card) cards.push(scene.card)
      store.getState().setBriefing({
        cards: [...cards],
        active: scene.card ? cards.length - 1 : -1,
        caption: scene.line,
      })
      store.getState().appendToLastTurn(`${scene.line} `)

      const spk = createSpeaker()
      speaker.current = spk
      spk.say(scene.line)
      await Promise.race([
        spk.end(),
        new Promise((r) => setTimeout(r, 8000 + scene.line.length * 110)),
      ])
      if (stale()) return
    }

    speaker.current = null
    sfx.duck(false)
    music.duck(false)
    sfx.play('done')
    const shown = store.getState().briefing
    if (shown) store.getState().setBriefing({ ...shown, active: -1, caption: '' })

    // Lock monitors automatically without asking
    setTimeout(() => {
      if (!stale() && !store.getState().locked) {
        void lock()
      }
    }, 1500)
  }

  /**
   * Deliver whatever reminders are waiting, if this is a moment he can speak.
   * Locked, he holds them: a reminder is for one person, and the lock means he
   * does not yet know that person is the one in the room.
   */
  const sayDue = async () => {
    const s = store.getState()
    if (!dueQueue.current.length || s.locked) return
    // Focus mode holds everything until it ends; then it all comes at once.
    if (s.focusUntil > Date.now()) return
    if (s.phase !== 'dormant' && s.phase !== 'listening') return
    const reminder = dueQueue.current.shift()!
    if (reminder.briefing) return void brief(tr('Good morning'))

    const mine = ++turn.current
    clearIdle()
    s.setPhase('speaking')
    sfx.play('wake')
    // He usually words a reminder as he would say it, vocative included; the
    // lead-in is only for the ones that arrive as a bare note.
    const line = /^(senhor|sir)/i.test(reminder.text)
      ? reminder.text
      : `${tr('Sir, a reminder')}: ${reminder.text}`
    s.pushTurn({ id: newId(), role: 'jarvis', text: line })
    offer.current = reminder.offer ? { ask: reminder.offer, until: Date.now() + FOLLOW_UP_MS + 15_000 } : null
    const spk = createSpeaker({ local: true })
    speaker.current = spk
    spk.say(line)
    await spk.end()
    if (mine !== turn.current) return
    speaker.current = null
    // Open afterwards, so "obrigado" or "adia dez minutos" needs no name.
    listen(FOLLOW_UP_MS)
  }

  /**
   * Press a media key, and say nothing about it. Whoever asked for the music
   * to pause wants quiet, not a butler confirming that it is now quiet.
   */
  const pressMedia = async (action: string, times: number) => {
    ++turn.current
    clearIdle()
    let ok = false
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, times }),
      })
      ok = res.ok
    } catch {
      ok = false
    }
    sfx.play(ok ? 'done' : 'error')
    // Open for a moment longer, so "mais um pouco" or "próxima" follows on.
    listen(FOLLOW_UP_MS)
  }

  const launchApp = async (appId: string, announceText: string) => {
    ++turn.current
    clearIdle()
    silence()
    const s = store.getState()
    s.setPhase('speaking')
    s.pushTurn({ id: newId(), role: 'user', text: `Abrir ${appId}` })
    s.pushTurn({ id: newId(), role: 'jarvis', text: announceText })
    s.setCaption(announceText)

    const spk = createSpeaker()
    speaker.current = spk
    spk.say(announceText)

    try {
      await fetch(`${BRIDGE_HTTP_URL}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: appId }),
      })
      sfx.play('done')
    } catch (err) {
      console.warn('[jarvis] app launch failed:', err)
      sfx.play('error')
    }

    await Promise.race([spk.end(), new Promise((r) => setTimeout(r, 4000))])
    speaker.current = null
    goDormant()
  }

  /** Put the list of things to say on screen, and say that it is there. */
  /**
   * Focus mode: a countdown on the HUD, every reminder, alert and offer held
   * until it ends, and at the end one sentence on what arrived meanwhile.
   */
  const startFocus = async (said: string) => {
    const m = FOCUS_CMD.exec(said)
    const n = m?.[1] === 'meia' ? 30 : m?.[1] === 'uma' ? 1 : Number(m?.[1] ?? 0)
    const minutes = !n ? 50 : /hora/i.test(m?.[2] ?? '') ? (m?.[1] === 'meia' ? 30 : n * 60) : n
    const s = store.getState()
    ++turn.current
    clearIdle()
    s.setFocusUntil(Date.now() + minutes * 60_000)
    s.setPhase('speaking')
    await announce(`${tr('Focus mode for')} ${minutes} ${tr('minutes, sir. I shall hold everything until then.')}`)
    goDormant()
  }

  const endFocus = async (early: boolean) => {
    const s = store.getState()
    if (!s.focusUntil) return
    s.setFocusUntil(0)
    const held = dueQueue.current.length
    ++turn.current
    clearIdle()
    s.setPhase('speaking')
    await announce(
      held
        ? `${tr(early ? 'Focus mode ended, sir.' : 'Focus time is over, sir.')} ${held} ${tr(held === 1 ? 'thing arrived meanwhile.' : 'things arrived meanwhile.')}`
        : tr(early ? 'Focus mode ended, sir. Nothing arrived.' : 'Focus time is over, sir. Nothing arrived meanwhile.'),
    )
    goDormant()
    void sayDue()
  }
  endFocusRef.current = (early: boolean) => void endFocus(early)

  /**
   * Presence. Every 45 s, while she is idle, one short glance through the
   * camera. Back after ten minutes away: unlocked if locked, welcomed, and
   * told what arrived meanwhile. Gone for ten minutes: locked. The first time
   * he is seen on a morning: the briefing, once a day.
   */
  const presenceTick = async () => {
    const s = store.getState()
    if (!PRESENCE || s.muted || document.hidden) return
    if (s.phase !== 'dormant' || s.identity === 'scanning' || speaker.current) return
    if (s.focusUntil > Date.now()) return
    let seen: 'match' | 'face' | 'nobody'
    try {
      seen = await face.glance()
    } catch {
      return // no camera, or it is busy: nothing to conclude
    }
    const now = Date.now()
    const isHim = seen === 'match' || (seen === 'face' && !face.enrolled())
    const st = store.getState()
    if (isHim) {
      const away = presence.current.lastSeen ? now - presence.current.lastSeen : 0
      presence.current.lastSeen = now
      const today = new Date().toDateString()
      const hour = new Date().getHours()
      if (presence.current.morning !== today && hour >= 5 && hour < 11) {
        presence.current.morning = today
        try {
          localStorage.setItem('jarvis.morning', today)
        } catch {
          /* private window */
        }
        if (st.locked) await unlock('')
        return void brief(tr('Good morning'))
      }
      if (away >= 10 * 60_000) {
        if (st.locked) await unlock('')
        const held = dueQueue.current.length
        ++turn.current
        st.setPhase('speaking')
        await announce(
          held
            ? `${tr('Welcome back, sir.')} ${held} ${tr(held === 1 ? 'thing arrived while you were away.' : 'things arrived while you were away.')}`
            : tr('Welcome back, sir.'),
        )
        goDormant()
        void sayDue()
      }
    } else if (
      face.enrolled() &&
      !st.locked &&
      presence.current.lastSeen &&
      now - presence.current.lastSeen >= 10 * 60_000
    ) {
      void lock()
    }
  }
  presenceRef.current = () => void presenceTick()

  const showHelp = async () => {
    const mine = ++turn.current
    clearIdle()
    const s = store.getState()
    s.setBriefing(null)
    s.setHelp(true)
    s.setPhase('speaking')
    await announce('These are the things you can ask me, sir.')
    if (mine !== turn.current) return
    // Left up while he listens, so the next thing said can be read off it.
    listen(AWAIT_SPEECH_MS)
  }

  /** Everything he hears goes through here: the lock first, then the model. */
  const handle = (said: string) => {
    if (store.getState().locked) return void unlock(said)
    if (LOCK_CMD.test(said)) return void lock()
    if (ENROL_CMD.test(said)) return void enrolFace()
    if (MUTE_CMD.test(said)) return void mute()
    if (FOCUS_END_CMD.test(said)) return void endFocus(true)
    if (FOCUS_CMD.test(said)) return void startFocus(said)
    if (VOICE_ENROL_CMD.test(said)) return void enrolVoice()
    if (VOICE_FORGET_CMD.test(said)) return void forgetVoice()
    if (NIGHT_CMD.test(said)) return void nightRoutine(said)
    if (BRIEF_CMD.test(said)) return void brief(said)
    if (HELP_CMD.test(said)) return void showHelp()
    const media = MEDIA_CMDS.find(([re]) => re.test(said.trim()))
    if (media) return void pressMedia(media[1], media[2])
    const appMatch = APP_CMDS.find(([re]) => re.test(said.trim()))
    if (appMatch) return void launchApp(appMatch[1], appMatch[2])
    if ((UNLOCK_CMD.test(said) || IDENTIFY_CMD.test(said)) && face.enrolled()) {
      return void (async () => {
        ++turn.current
        store.getState().setPhase('speaking')
        await announce('The systems are already active, sir.')
        listen(FOLLOW_UP_MS)
      })()
    }
    void respond(said)
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      handle(trailing)
      return
    }

    // Locked, his name alone is a request to be let in.
    if (store.getState().locked) {
      void unlock('')
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * The on-device detector heard his name. No words exist yet — only that he
   * was called — so this opens the microphone and shows that he is listening,
   * and lets the transcript that follows say what was wanted. Declined while
   * locked: there the whole sentence matters, and the transcript carries it.
   */
  const onName = () => {
    const s = store.getState()
    if (s.locked || s.phase !== 'dormant') return false
    s.setError(null)
    sfx.play('wake')
    nameAt.current = Date.now()
    listen(AWAIT_SPEECH_MS)
    return true
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    // Someone finishing "…ativar monitor" as the scan starts is not an
    // interruption, and treating it as one cancels the check they just asked for.
    if (store.getState().identity === 'scanning') return

    // While he is working or answering, a sound in the room is not an order.
    // It used to be: a cough, the television or a second voice cut a search
    // off half way, every time. Now he finishes what he started, and stopping
    // him takes his name — which is decided on the words, in onUtterance.
    if (isBusy(phase)) return

    silence()
    store.getState().setPhase('listening')
    // The request has begun, so the countdown to standing by starts again
    // from here. Not simply cancelled: a cough is speech to the detector and
    // never becomes a sentence, and he must still stand down after one.
    idleTimer.current = setTimeout(goDormant, SPEAKING_GRACE_MS)
  }

  const isBusy = (phase: string) =>
    phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  /** Abandon the answer in flight. */
  const cutOff = () => {
    silence()
    turn.current++
    interrupt()
    store.getState().setActiveTool(null)
    music.working(false)
    sfx.duck(false)
    music.duck(false)
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // He has asked whether to go ahead, and this is the answer. It needs no
    // name — he asked — and anything that is neither yes nor no is ignored
    // rather than guessed at, since guessing wrong here sends the email.
    if (consent.current) {
      const answer = text.replace(UP_TO_NAME, '').trim() || text.trim()
      if (YES_CMD.test(answer)) consent.current(true)
      else if (NO_CMD.test(answer)) consent.current(false)
      return
    }

    // The answer to a habit he offered. Yes becomes the request itself, as if
    // it had been asked; no is taken quietly; anything else is an ordinary
    // turn and the offer lapses.
    if (offer.current) {
      const pending = offer.current
      offer.current = null
      if (Date.now() < pending.until) {
        const answer = text.replace(UP_TO_NAME, '').trim() || text.trim()
        if (YES_CMD.test(answer)) return void handle(pending.ask)
        if (NO_CMD.test(answer)) return void listen(AWAIT_SPEECH_MS)
      }
    }

    // Busy: only something addressed to him by name gets through. Everything
    // else heard meanwhile is dropped, not queued — an overheard remark that
    // surfaced as a question a minute later would be worse than a missed one.
    if (isBusy(phase)) {
      // "Chega." needs no name. It is the one order that has to work when he
      // is the one making the noise, and the whole utterance must be the order
      // — "para" inside a sentence is a preposition, not a command.
      if (phase === 'speaking' && BARE_STOP.test(text.trim())) {
        cutOff()
        listen(AWAIT_SPEECH_MS)
        return
      }
      if (store.getState().identity === 'scanning' || !UP_TO_NAME.test(text)) {
        voiceLog('ignored', { why: `busy (${phase}), not addressed by name`, text })
        return
      }
      const order = text.replace(UP_TO_NAME, '').trim()
      cutOff()
      if (!order || STOP_CMD.test(order)) listen(AWAIT_SPEECH_MS)
      else handle(order)
      return
    }

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      // His name and nothing else. If this is the breath that woke him, he
      // answers to it; said again mid-conversation, it is only a vocative.
      if (Date.now() - nameAt.current < 8000) {
        nameAt.current = 0
        const greeting = createSpeaker()
        speaker.current = greeting
        greeting.say(attention())
        void greeting.end()
      }
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    handle(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `${tr('Power-up failed')}: ${err.message}`
            : tr('Power-up failed. Click to try again.'),
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    /**
     * A reminder falling due. Said at once if he is idle; held if he is in the
     * middle of something, because talking over his own answer to deliver a
     * reminder helps nobody. The queue is emptied by the timer below.
     */
    watchReminders((reminder) => {
      // Seen as well as heard: the edges pulse (ui/Ambience.tsx).
      window.dispatchEvent(new Event('jarvis-alert'))
      dueQueue.current.push(reminder)
      void sayDue()
    })

    /**
     * JARVIS asking leave to do something.
     *
     * The action is put on screen and asked aloud, and nothing proceeds until
     * there is a yes — spoken, or the Y key. Silence, a no, the N key and
     * Escape all mean no, and so does the question going unanswered.
     */
    watchConfirm(
      (req) =>
        new Promise<boolean>((resolve) => {
          const settle = (ok: boolean) => {
            clearTimeout(timer)
            consent.current = null
            store.getState().setConsent(null)
            sfx.play(ok ? 'done' : 'error')
            resolve(ok)
          }
          // A little inside the bridge's own limit, so the refusal comes from
          // here with the card still up rather than from a timeout nobody saw.
          const timer = setTimeout(() => settle(false), 28_000)
          consent.current = settle
          store.getState().setConsent(req)
          const spk = createSpeaker()
          speaker.current = spk
          spk.say(tr('Shall I proceed, sir?'))
          void spk.end()
        }),
    )

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError(tr('Bridge connection lost — reconnecting.'))
      } else if (state === 'open' || state === 'reconnected') {
        // Clear any previous bridge connection error once connected
        const currentErr = store.getState().error
        if (currentErr && (currentErr.includes('Cannot reach the bridge') || currentErr.includes('Bridge connection lost') || currentErr.includes('The bridge closed'))) {
          store.getState().setError(null)
        }
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())

    // One voice loop, started once, running until the page closes.
    voiceHandlers.current = {
      mode,
      onWake,
      onName,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    }
    voice.current = await startVoice(voiceHandlers.current)

    // Come up locked if there is a face to wait for. Decided here, at the end
    // of boot, so the lock is in place before the wake word can be heard.
    const guarded = face.enrolled()
    if (guarded) store.getState().setLocked(true)

    store.getState().setPhase('dormant')

    // Whoever just switched him on is usually the person he is waiting for,
    // and is sitting in front of the camera. Look straight away rather than
    // make them ask to be recognised by a machine that is looking at them.
    if (guarded) void unlock('')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- starting by himself --------------------------------------------------

  /**
   * `?auto=1` switches him on without the click, for when he is opened by the
   * machine at login rather than by a person.
   *
   * A browser only allows sound after a click unless it was started with the
   * flag that waives that (the launcher passes it). So this asks first: if an
   * audio context will not run, it leaves the button where it is. Trying anyway
   * would hang on the audio unlock with the button already disabled.
   */
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('auto')) return
    const probe = new AudioContext()
    void probe.resume().catch(() => {})
    const timer = setTimeout(() => {
      const allowed = probe.state === 'running'
      void probe.close()
      if (allowed) void powerOn()
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- reminders ------------------------------------------------------------

  // A reminder that arrived while he was busy waits here for a quiet moment.
  useEffect(() => {
    const timer = setInterval(() => void sayDue(), 4000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- side monitors --------------------------------------------------------

  // Whatever is open on the other monitors follows this window's state.
  useEffect(() => publish(), [])

  // In development, `__brief()` in the console runs the briefing without a
  // microphone — the only way to work on it in a pane that has none.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__brief = () => void brief('bom dia')
    ;(window as unknown as Record<string, unknown>).__night = () => void nightRoutine('boa noite')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`${tr('Voice set to')} ${name.replace(/\(.*?\)/g, '').trim()}. ${tr('At your service, sir.')}`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? tr('Camera access denied — gesture control is unavailable.')
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      // Y and N answer an open "shall I proceed"; Escape is also a no.
      if (consent.current && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'y' || k === 's' || k === 'n' || k === 'escape') {
          e.preventDefault()
          consent.current(k === 'y' || k === 's')
          return
        }
      }

      // H shows what he can be asked, and hides it again; Escape hides it too.
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const st = store.getState()
        if (e.key === 'h' && st.phase !== 'offline' && st.phase !== 'boot') {
          e.preventDefault()
          st.setHelp(!st.help)
          return
        }
        if (e.key === 'Escape' && st.help) st.setHelp(false)
      }

      // M: the microphone off and on. Not while typing into something.
      if (e.key === 'm' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const st = store.getState()
        if (st.phase !== 'offline' && st.phase !== 'boot') {
          e.preventDefault()
          void (st.muted ? unmute() : mute())
          return
        }
      }

      // L locks, F enrols a face. Both are also spoken commands; the keys are
      // for when the room is too loud to give one.
      const idle = ['dormant', 'listening', 'waking'].includes(store.getState().phase)
      if (e.key === 'l' && idle && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (!store.getState().locked) void lock()
        return
      }
      if (e.key === 'f' && idle && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (!store.getState().locked) void enrolFace()
        return
      }

      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say(tr('Audio test. If you can hear this, speech output is working, sir.'))
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      {ORB === 'plasma' && <Plasma />}
      <Ambience />
      <Hud />
      <Boot />
      <Briefing />
      <Help />
      <Consent />
      <Lock />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
