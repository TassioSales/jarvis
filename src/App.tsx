import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Plasma } from './scene/Plasma'
import { Hud } from './ui/Hud'
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
  type Scene as BriefScene,
} from './lib/briefing'
import * as kokoro from './lib/kokoro'
import { ORB, TTS_ENGINE } from './config'
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
import { startAnalyser, micLevel } from './lib/audio'
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
const FOLLOW_UP_MS = 9000

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
/** Answers to "shall I proceed". Anything that is neither is not an answer. */
const YES_CMD =
  /^(?:sim|pode|podes|confirmo|confirmado|confirmar?|prossiga|prosseguir|autorizo|autorizado|fa[cç]a|manda|vai|claro|isso|yes|yeah|go ahead|do it|proceed|confirm)\b/i
const NO_CMD = /^(?:n[aã]o|nunca|cancela|cancelar|cancele|negativo|pare|para|deixa|esquece|no|nope|cancel|stop|don'?t)\b/i
/** Asking what he can do, which is answered on screen rather than by the model. */
const HELP_CMD =
  /^(?:ajuda|me ajuda|socorro|comandos|quais (?:s[aã]o )?os comandos|o que (?:voc[eê]|o senhor) (?:sabe|pode|consegue) fazer|help|commands|what can you do)[\s.?!]*$/i
/** A greeting on its own is a request for the day (see briefing.ts). */
const BRIEF_CMD =
  /^(?:(?:muito\s+)?bom dia|boa tarde|boa noite|good (?:morning|afternoon|evening)|briefing|resumo(?: do dia)?|como est[aá] o dia)(?:[\s,]+(?:senhor|jarvis|sir))?[\s.!?]*$/i
/** "It's me" — asking to be let in without naming the monitors. */
const IDENTIFY_CMD =
  /^(?:sou eu|confirmar?(?:\s+(?:a\s+)?minha)?\s+identidade|me\s+reconhe[cç]a|reconhecimento facial|it'?s me|identify me)[\s.!]*$/i

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

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
  const dueQueue = useRef<{ text: string; briefing: boolean }[]>([])
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
   * Deliver whatever reminders are waiting, if this is a moment he can speak.
   * Locked, he holds them: a reminder is for one person, and the lock means he
   * does not yet know that person is the one in the room.
   */
  const sayDue = async () => {
    const s = store.getState()
    if (!dueQueue.current.length || s.locked) return
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
    const spk = createSpeaker()
    speaker.current = spk
    spk.say(line)
    await spk.end()
    if (mine !== turn.current) return
    speaker.current = null
    // Open afterwards, so "obrigado" or "adia dez minutos" needs no name.
    listen(FOLLOW_UP_MS)
  }

  /** Put the list of things to say on screen, and say that it is there. */
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
    if (BRIEF_CMD.test(said)) return void brief(said)
    if (HELP_CMD.test(said)) return void showHelp()
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
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError(tr('Bridge reconnected. The previous conversation was not kept.'))
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
    store.getState().setVoice(currentVoiceName())

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

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onName,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

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
