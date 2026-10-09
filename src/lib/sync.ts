import { useStore, type Phase } from '../store'

/**
 * Keeping the side monitors in step with the main one.
 *
 * The satellites are separate windows of the same page. They have no
 * microphone, no bridge socket and no voice loop of their own — one assistant,
 * one conversation — so everything they show is a copy of what the main window
 * knows, sent over a BroadcastChannel. That works because all three windows
 * share an origin and a browser profile; it needs no server and survives the
 * bridge restarting.
 *
 * One direction only. A satellite asks for the current state when it opens and
 * otherwise just listens, so there is no question of two windows disagreeing
 * about whether he is locked.
 */

export type Identity = 'idle' | 'scanning' | 'granted' | 'denied'

export type Snapshot = {
  locked: boolean
  identity: Identity
  phase: Phase
  caption: string
  activeTool: string | null
  connected: string[]
  turns: { id: string; role: 'user' | 'jarvis'; text: string }[]
}

type Message = { type: 'state'; state: Snapshot } | { type: 'hello' }

const CHANNEL = 'jarvis-sync'

/** A satellite that hears nothing for this long shows that the link is down. */
export const STALE_MS = 6000
const HEARTBEAT_MS = 2000

function snapshot(): Snapshot {
  const s = useStore.getState()
  return {
    locked: s.locked,
    identity: s.identity,
    phase: s.phase,
    caption: s.caption,
    activeTool: s.activeTool,
    connected: s.connected,
    turns: s.turns.slice(-8).map(({ id, role, text }) => ({ id, role, text })),
  }
}

/** Main window: publish state on every change, on request, and on a heartbeat. */
export function publish(): () => void {
  const channel = new BroadcastChannel(CHANNEL)
  let last = ''
  const send = (force = false) => {
    const state = snapshot()
    const key = JSON.stringify(state)
    if (!force && key === last) return
    last = key
    channel.postMessage({ type: 'state', state } satisfies Message)
  }

  // `level` changes sixty times a second and is not in the snapshot, so the
  // comparison above is what keeps this from flooding the channel.
  const unsubscribe = useStore.subscribe(() => send())
  channel.onmessage = (e: MessageEvent<Message>) => {
    if (e.data.type === 'hello') send(true)
  }
  const beat = setInterval(() => send(true), HEARTBEAT_MS)
  send(true)

  return () => {
    unsubscribe()
    clearInterval(beat)
    channel.close()
  }
}

/** Satellite: receive state. The callback gets null when the main window goes quiet. */
export function follow(onState: (state: Snapshot | null) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL)
  let seen = 0
  channel.onmessage = (e: MessageEvent<Message>) => {
    if (e.data.type !== 'state') return
    seen = Date.now()
    onState(e.data.state)
  }
  channel.postMessage({ type: 'hello' } satisfies Message)
  const watchdog = setInterval(() => {
    if (seen && Date.now() - seen > STALE_MS) {
      seen = 0
      onState(null)
    }
  }, 1000)

  return () => {
    clearInterval(watchdog)
    channel.close()
  }
}
