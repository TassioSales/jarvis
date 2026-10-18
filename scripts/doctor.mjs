// A check-up of everything she depends on, in one table. `npm run doctor`.
// Reads the configuration but never prints a key: only whether it is set.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const rows = []
const ok = (what, detail) => rows.push(['ok', what, detail])
const warn = (what, detail) => rows.push(['!!', what, detail])
const bad = (what, detail) => rows.push(['XX', what, detail])

// Node
const major = Number(process.versions.node.split('.')[0])
;(major >= 20 ? ok : bad)('Node.js', process.versions.node)

// Configuration
const env = {}
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) env[m[1]] = m[2].trim()
  }
  ok('.env.local', 'presente')
} else warn('.env.local', 'faltando')
const set = (k) => Boolean(env[k] || process.env[k])
for (const [key, why] of [
  ['GEMINI_API_KEY', 'respostas rápidas, reserva'],
  ['ELEVENLABS_API_KEY', 'voz na nuvem'],
  ['TOMTOM_API_KEY', 'trânsito'],
  ['JARVIS_CALENDAR_ICS', 'agenda no painel'],
  ['JARVIS_HOME_ADDRESS', 'trajeto (com o trabalho)'],
  ['JARVIS_WORK_ADDRESS', 'trajeto (com a casa)'],
]) {
  ;(set(key) ? ok : warn)(key, set(key) ? `definida · ${why}` : `não definida · ${why}`)
}

// Local helper
const py = process.platform === 'win32' ? '.venv-stt/Scripts/python.exe' : '.venv-stt/bin/python'
;(existsSync(py) ? ok : bad)('Ambiente Python', existsSync(py) ? '.venv-stt' : 'rode: npm run setup:local')
for (const [file, what] of [
  ['models/smart-turn-v3.2-cpu.onnx', 'fim de fala'],
  ['models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx', 'voz do dono'],
  ['models/kokoro-v1.0.onnx', 'voz local'],
  ['models/voices-v1.0.bin', 'banco de vozes'],
  ['public/silero/silero_vad.onnx', 'detector de voz'],
]) {
  ;(existsSync(file) ? ok : warn)(what, existsSync(file) ? `${(statSync(file).size / 1e6).toFixed(0)} MB` : `faltando ${file}`)
}

// GPU
const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8' })
;(smi.status === 0 ? ok : warn)('GPU', smi.status === 0 ? smi.stdout.trim() : 'sem placa NVIDIA: a audição roda na CPU')

// Running services
const get = (url) =>
  fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
const status = await get('http://127.0.0.1:8787/status')
if (!status) bad('Ponte', 'parada (porta 8787) · abra o Jarvis.cmd')
else {
  ok('Ponte', `${status.model} · esforço ${status.effort}`)
  for (const s of status.services) {
    ;(s.state === 'ok' ? ok : s.state === 'down' ? bad : warn)(`  ${s.label}`, s.detail)
  }
}
const face = await fetch('http://localhost:5173/', { signal: AbortSignal.timeout(3000) }).catch(() => null)
;(face?.ok ? ok : bad)('Interface', face?.ok ? 'http://localhost:5173' : 'parada (porta 5173)')

// Her own files
const dir = join(homedir(), '.jarvis')
for (const [file, what] of [
  ['memory.md', 'memória'],
  ['voiceprint.npy', 'voz do dono'],
  ['habits.jsonl', 'registro de hábitos'],
  ['voice.log', 'log de voz'],
]) {
  const p = join(dir, file)
  ;(existsSync(p) ? ok : warn)(what, existsSync(p) ? `${(statSync(p).size / 1024).toFixed(0)} KB` : 'ainda não existe')
}

const width = Math.max(...rows.map((r) => r[1].length))
for (const [mark, what, detail] of rows) console.log(`[${mark}] ${what.padEnd(width)}  ${detail}`)
const problems = rows.filter((r) => r[0] === 'XX').length
console.log(problems ? `\n${problems} problema(s) para resolver.` : '\nTudo o que ela precisa está no lugar.')
process.exitCode = problems ? 1 : 0
