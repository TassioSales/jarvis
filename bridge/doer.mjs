import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The few things he does to the machine directly: the media keys, opening a
 * program or a page, and routines — named lists of things to open.
 *
 * All of this could be done through the shell tool, and the first version of
 * "open Spotify" was. But a shell is a blank cheque: consent to "Bash" is
 * consent to whatever string follows it. These do one narrow thing each, so
 * what the user is asked to approve is what will happen and nothing else.
 *
 * Two of them need no approval at all — the media keys, which do nothing a
 * keyboard does not, and listing what routines exist. Everything that opens
 * something is write-class and goes through the consent gate in server.mjs.
 */
const DIR = process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis')
const FILE = join(DIR, 'routines.json')

const text = (s) => ({ content: [{ type: 'text', text: s }] })

// ------------------------------------------------------------------- media

/** Windows virtual-key codes for the keys a media keyboard has. */
const MEDIA_KEYS = {
  toggle: 179, // play / pause — one key, as on the keyboard
  next: 176,
  previous: 177,
  stop: 178,
  volume_up: 175,
  volume_down: 174,
  mute: 173,
}

/**
 * Press a media key. Whatever is playing answers to it — Spotify, a browser
 * tab, a video — exactly as it would to the key on a keyboard.
 *
 * @returns {Promise<boolean>} false where there is no way to do it
 */
export function pressMedia(action, times = 1) {
  const code = MEDIA_KEYS[action]
  if (!code || process.platform !== 'win32') return Promise.resolve(false)
  const n = Math.max(1, Math.min(25, Math.round(Number(times)) || 1))
  return new Promise((resolve) => {
    // Nothing from the caller reaches this command line but two integers.
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$w = New-Object -ComObject WScript.Shell; 1..${n} | ForEach-Object { $w.SendKeys([char]${code}) }`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    child.on('error', () => resolve(false))
    child.on('exit', (status) => resolve(status === 0))
  })
}

/**
 * Windows' own media sessions: what is playing, and an explicit pause or play.
 *
 * A media key only toggles, so "pause" said into a silent room starts the
 * music. Windows will pause or resume a session outright and say what it is
 * playing; scripts/media.ps1 asks it to. That script needs Windows PowerShell
 * 5.1 — the types it uses do not exist in PowerShell 7 — hence `powershell`
 * here and not `pwsh`.
 *
 * @param {'status' | 'pause' | 'play'} action
 * @returns {Promise<{app: string, status: string, artist: string, title: string}[] | null>}
 */
const MEDIA_SCRIPT = fileURLToPath(new URL('../scripts/media.ps1', import.meta.url))

export function mediaSession(action = 'status') {
  if (process.platform !== 'win32' || !['status', 'pause', 'play'].includes(action)) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, '-Action', action],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill(), 9000)
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(out.trim() || '[]')
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * A Spotify address the desktop app will open, from a URI or a share link.
 *
 * Only the shape Spotify itself hands out is accepted — a kind and a 22
 * character id — so this can be opened without asking: there is nothing in it
 * but a pointer into Spotify's own catalogue.
 */
export function spotifyUri(value) {
  const v = String(value ?? '').trim()
  const kinds = 'track|episode|album|playlist|artist|show'
  let m = new RegExp(`^spotify:(${kinds}):([A-Za-z0-9]{22})$`).exec(v)
  if (m) return `spotify:${m[1]}:${m[2]}`
  m = new RegExp(`^https://open\\.spotify\\.com/(?:intl-[a-z-]+/)?(${kinds})/([A-Za-z0-9]{22})(?:[?#].*)?$`).exec(v)
  return m ? `spotify:${m[1]}:${m[2]}` : null
}

/**
 * One entry point for everything about playback: pause and play are done
 * explicitly through the media session, the rest are keys.
 */
export async function control(action, times = 1) {
  if (action === 'pause' || action === 'play') {
    const done = await mediaSession(action)
    // No session to talk to — an app that does not register one. Fall back to
    // the key, which at least reaches it.
    return done?.length ? true : pressMedia('toggle')
  }
  return pressMedia(action, times)
}

// ------------------------------------------------------------------ opening

/**
 * Whether something is safe to hand to `start`.
 *
 * `start` runs through cmd, and cmd has operators. A target containing one —
 * `notepad & del …` — would open Notepad and then do the rest. So a target is
 * a web address, or a plain name or path with none of the characters cmd gives
 * meaning to. Anything else is refused rather than escaped: escaping cmd
 * correctly is a known way to be wrong.
 */
export function safeTarget(target) {
  const t = String(target ?? '').trim()
  if (!t || t.length > 300) return null
  if (/^https?:\/\/[^\s"<>|^&]+$/i.test(t)) return t
  if (/[&|<>^%"`\r\n]/.test(t)) return null
  if (/^[\w .:\\/()+,@~-]+$/u.test(t) || /^[\p{L}\p{N} .:\\/()+,@~_-]+$/u.test(t)) return t
  return null
}

function open(target) {
  const safe = safeTarget(target)
  if (!safe) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', safe], { windowsHide: true, stdio: 'ignore', detached: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [safe], { stdio: 'ignore', detached: true })
    child.on('error', () => resolve(false))
    child.on('exit', (status) => resolve(status === 0))
    child.unref()
  })
}

// ----------------------------------------------------------------- routines

const key = (name) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

function load() {
  try {
    const all = JSON.parse(readFileSync(FILE, 'utf8'))
    return all && typeof all === 'object' ? all : {}
  } catch {
    return {}
  }
}

function save(all) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(all, null, 2) + '\n')
}

/** The steps of a routine, for the consent card to show before it runs. */
export function routineSteps(name) {
  return load()[key(name)]?.steps ?? null
}

export function doServer() {
  return createSdkMcpServer({
    name: 'jarvis_do',
    version: '1.0.0',
    instructions: 'Media keys, opening programs and pages, and named routines that open several.',
    alwaysLoad: true,
    tools: [
      tool(
        'media',
        'Press a media key: play or pause what is playing, skip, go back, or change ' +
          'the volume. Works on whatever is playing on this computer. `times` repeats ' +
          'the key, which is how volume is moved by more than one step (each is 2%).',
        {
          action: z.enum(['pause', 'play', 'toggle', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute']),
          times: z.number().optional().describe('How many presses. Default 1; about 5 for "a bit louder".'),
        },
        async ({ action, times }) =>
          text((await control(action, times)) ? 'Done.' : 'Media control is not available on this machine.'),
      ),
      tool(
        'play',
        'Play something on Spotify, on this computer. Give the `uri` (or the ' +
          'open.spotify.com link) of what to play, as returned by a Spotify search. ' +
          'A track or an episode starts playing at once. An album, playlist or ' +
          'artist only opens in the app without starting — so when they ask for ' +
          'an artist or "some music by", search for tracks and play one of those.',
        { uri: z.string().describe('spotify:track:… or an open.spotify.com link.') },
        async ({ uri }) => {
          const target = spotifyUri(uri)
          if (!target) return text('That is not a Spotify address. Search Spotify first and pass the uri it returns.')
          if (!(await open(target))) return text('Spotify could not be opened on this machine.')
          return text(
            /^spotify:(track|episode):/.test(target)
              ? 'Playing.'
              : 'Opened in Spotify, but that kind of item does not start by itself.',
          )
        },
      ),
      tool(
        'now_playing',
        'What is playing on this computer right now, and in which app.',
        {},
        async () => {
          const sessions = await mediaSession('status')
          if (!sessions) return text('That cannot be read on this machine.')
          const live = sessions.filter((s) => s.title)
          if (!live.length) return text('Nothing is playing.')
          return text(
            live
              .map((s) => `${s.app}: ${s.status.toLowerCase()} — ${[s.artist, s.title].filter(Boolean).join(' – ')}`)
              .join('\n'),
          )
        },
      ),
      tool(
        'open',
        'Open one program, file, folder or web page on this computer. Give a web ' +
          'address, a program name Windows knows (notepad, calc, spotify, code), or a ' +
          'full path. The user is asked before it opens.',
        { target: z.string().describe('A URL, a program name, or a path.') },
        async ({ target }) => {
          if (!safeTarget(target)) return text('That is not something that can be opened by name.')
          return text((await open(target)) ? `Opened ${target}.` : `Could not open ${target}.`)
        },
      ),
      tool(
        'save_routine',
        'Define or replace a routine: a name and the list of things it opens, in ' +
          'order. Use when they describe one ("work mode opens VS Code, Chrome and ' +
          'Spotify"). Each step is a URL, a program name or a path.',
        {
          name: z.string().describe('What they will call it: "modo trabalho".'),
          steps: z.array(z.string()).describe('What to open, in order.'),
        },
        async ({ name, steps }) => {
          const id = key(name)
          if (!id) return text('A routine needs a name.')
          const good = (steps ?? []).map((s) => safeTarget(s)).filter(Boolean)
          if (!good.length) return text('None of those steps is something that can be opened.')
          const all = load()
          all[id] = { name: String(name).trim(), steps: good.slice(0, 12) }
          save(all)
          const dropped = (steps ?? []).length - good.length
          return text(
            `Saved "${all[id].name}" with ${good.length} step(s)` +
              (dropped ? `; ${dropped} could not be used and was left out.` : '.'),
          )
        },
      ),
      tool('list_routines', 'The routines that exist, and what each opens.', {}, async () => {
        const all = Object.values(load())
        if (!all.length) return text('No routines are defined.')
        return text(all.map((r) => `${r.name}: ${r.steps.join(', ')}`).join('\n'))
      }),
      tool(
        'run_routine',
        'Run a routine by name, opening everything in it. The user is shown the ' +
          'list and asked before anything opens.',
        { name: z.string() },
        async ({ name }) => {
          const routine = load()[key(name)]
          if (!routine) return text(`There is no routine called "${name}".`)
          const results = []
          for (const step of routine.steps) {
            results.push((await open(step)) ? step : `${step} (failed)`)
            // A beat between launches: several programs started in the same
            // instant fight over focus and some lose.
            await new Promise((r) => setTimeout(r, 400))
          }
          return text(`Ran "${routine.name}": ${results.join(', ')}.`)
        },
      ),
      tool(
        'delete_routine',
        'Remove a routine by name.',
        { name: z.string() },
        async ({ name }) => {
          const all = load()
          if (!all[key(name)]) return text(`There is no routine called "${name}".`)
          delete all[key(name)]
          save(all)
          return text('Removed.')
        },
      ),
    ],
  })
}
