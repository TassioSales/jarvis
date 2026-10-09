// Runs the wake-word pipeline over recorded clips and prints the peak score of
// each. The clips are 16 kHz mono signed 16-bit PCM, made by ffmpeg.
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'
import { CHUNK, WakeDetector, type Run } from '../src/lib/oww.ts'

const dir = new URL('../public/openwakeword/', import.meta.url)
const load = (f: string) => ort.InferenceSession.create(new Uint8Array(readFileSync(new URL(f, dir))))

const sessions = {
  mel: await load('melspectrogram.onnx'),
  embed: await load('embedding_model.onnx'),
  wake: await load('hey_jarvis_v0.1.onnx'),
}
for (const [name, s] of Object.entries(sessions)) console.log(name, 'in:', s.inputNames, 'out:', s.outputNames)

const run: Run = async (model, data, dims) => {
  const s = sessions[model]
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) })
  return out[s.outputNames[0]].data as Float32Array
}

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file)
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2))
  // A second of silence either side, as a microphone would have.
  const padded = new Float32Array(16000 + pcm.length + 16000)
  for (let i = 0; i < pcm.length; i++) padded[16000 + i] = pcm[i]

  const detector = new WakeDetector(run)
  let peak = 0
  let at = 0
  const t0 = performance.now()
  let steps = 0
  for (let i = 0; i + CHUNK <= padded.length; i += CHUNK) {
    const score = await detector.feed(padded.subarray(i, i + CHUNK))
    steps++
    if (score > peak) { peak = score; at = (i + CHUNK) / 16000 - 1 }
  }
  const perStep = (performance.now() - t0) / steps
  console.log(`${peak.toFixed(3)}  at ${at.toFixed(2)}s  (${perStep.toFixed(1)} ms/step)  ${file.split('/').pop()}`)
}
