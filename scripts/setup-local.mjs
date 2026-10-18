// Sets up the local helper from nothing: a Python environment with its
// packages, and the models it loads. Safe to run again — what is already
// there is left alone. `npm run setup:local`.
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const WIN = process.platform === 'win32'
const VENV = '.venv-stt'
const PY = WIN ? `${VENV}/Scripts/python.exe` : `${VENV}/bin/python`

const MODELS = [
  ['smart-turn-v3.2-cpu.onnx', 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx'],
  [
    '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  ],
  ['kokoro-v1.0.onnx', 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'],
  ['voices-v1.0.bin', 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'],
]

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status ?? r.error?.message})`)
}

// 1. Python. The launcher on Windows knows every installed version.
if (!existsSync(PY)) {
  const tries = WIN ? [['py', ['-3.13']], ['py', ['-3.12']], ['python', []]] : [['python3', []]]
  let made = false
  for (const [cmd, pre] of tries) {
    const r = spawnSync(cmd, [...pre, '-m', 'venv', VENV], { stdio: 'inherit' })
    if (r.status === 0) {
      made = true
      break
    }
  }
  if (!made) throw new Error('No Python 3.12+ found. Install it from python.org and run this again.')
}
run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q'])
run(PY, ['-m', 'pip', 'install', '-q', '-r', 'scripts/requirements-local.txt'])

// 2. Models. Whisper downloads its own on first use.
mkdirSync('models', { recursive: true })
for (const [name, url] of MODELS) {
  const to = `models/${name}`
  if (existsSync(to) && statSync(to).size > 1000) {
    console.log(`✓ ${name}`)
    continue
  }
  console.log(`↓ ${name}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${name}: ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${to}.part`))
  renameSync(`${to}.part`, to)
}

console.log('\nLocal helper ready. Start with Jarvis.cmd or npm start; check with npm run doctor.')
