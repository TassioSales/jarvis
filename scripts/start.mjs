/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

/**
 * Let the bridge see `.env.local` too.
 *
 * Vite reads that file for the face; the bridge only ever read its shell
 * environment. A setting both halves need — the language, above all — then had
 * to be made twice, in two places, and setting it once gave a face listening in
 * Portuguese to a brain answering in English. Variables already set in the
 * shell still win.
 */
if (existsSync('.env.local') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env.local')
  } catch (err) {
    console.warn(`  could not read .env.local: ${err.message}`)
  }
}

/**
 * The face-recognition weights, for the same two reasons as the WASM above:
 * the CSP only lets the page load them from its own origin, and copying them
 * out of node_modules pins them to the version in the lockfile. Only the three
 * networks the identity lock uses — the package ships seven.
 */
function vendorFaceModels() {
  const from = 'node_modules/@vladmandic/face-api/model'
  const to = 'public/faceapi'
  if (!existsSync(from)) return // the lock is optional; carry on without it
  if (existsSync(`${to}/face_recognition_model.bin`)) return
  try {
    mkdirSync(to, { recursive: true })
    for (const net of ['tiny_face_detector', 'face_landmark_68', 'face_recognition']) {
      for (const file of [`${net}_model-weights_manifest.json`, `${net}_model.bin`]) {
        cpSync(`${from}/${file}`, `${to}/${file}`)
      }
    }
    console.log('  vendored the face-recognition models into public/faceapi.')
  } catch (err) {
    console.warn(`  could not vendor the face-recognition models: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []
/** When each optional helper last died, to stop restarting one that cannot stay up. */
const restarts = new Map()

function run(name, command, args, colour, env, optional = false) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('error', (err) => console.log(`[${colour}m${name}[0m could not start: ${err.message}`))
  child.on('exit', (code) => {
    // A helper that is only an improvement — local hearing — going away
    // leaves the rest working, so it does not take them down with it.
    // An optional helper is brought back, a few times, after a pause: it is
    // the local ear and voice, and losing them for good to one crash would
    // send every phrase to the cloud for the rest of the day.
    if (optional) {
      if (stopping) return
      const now = Date.now()
      restarts.set(name, (restarts.get(name) ?? []).filter((t) => now - t < 10 * 60_000).concat(now))
      if (restarts.get(name).length > 5) {
        console.log(`[${colour}m${name}[0m exited (${code}) too often; carrying on without it.`)
        return
      }
      console.log(`[${colour}m${name}[0m exited (${code}); starting it again in 5 s.`)
      setTimeout(() => {
        if (!stopping) run(name, command, args, colour, env, optional)
      }, 5000)
      return
    }
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
// So the bridge can tell when this launcher is gone; see the watchdog in server.mjs.
bridgeEnv.JARVIS_PARENT_PID = String(process.pid)
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()
vendorFaceModels()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

// Local hearing, when its Python environment has been set up (see
// scripts/stt-server.py). Without it the bridge simply uses the cloud.
const sttPython = process.platform === 'win32' ? '.venv-stt/Scripts/python.exe' : '.venv-stt/bin/python'
if (existsSync(sttPython) && process.env.JARVIS_STT_LOCAL !== '0') {
  run('ears', sttPython, ['scripts/stt-server.py'], '33', { JARVIS_PARENT_PID: String(process.pid), PYTHONIOENCODING: 'utf-8' }, true)
}

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
