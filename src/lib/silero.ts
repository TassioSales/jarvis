import * as ort from 'onnxruntime-web/wasm'
// The runtime's own WebAssembly, from this origin (see wake.ts for why).
import runtimeMjs from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import runtimeWasm from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'

/**
 * Whether what the microphone hears right now is a human voice.
 *
 * The detector in vad.ts goes by loudness, and loudness cannot tell a voice
 * from a door, a fan, or music: a loud room fills the transcriber with noise,
 * and a quiet speaker never reaches the bar. Silero VAD (snakers4/silero-vad,
 * MIT) is a small network trained to recognise speech itself, 32 ms at a time,
 * a few hundred microseconds each. vad.ts asks it before starting a segment
 * and while deciding whether one has ended.
 *
 * Optional: if the model cannot load, `startSilero` rejects and the loudness
 * detector carries on alone, exactly as before.
 */

const MODEL = '/silero/silero_vad.onnx'
const RATE = 16000
/** Samples per step at 16 kHz — the size the model was trained on. */
const FRAME = 512
/** The tail of the previous step, prepended as the reference wrapper does. */
const CONTEXT = 64

export type Silero = {
  /** The highest speech probability over the last ~100 ms, 0 to 1. */
  prob: () => number
  stop: () => void
}

export async function startSilero(stream: MediaStream): Promise<Silero> {
  ort.env.wasm.wasmPaths = { mjs: runtimeMjs, wasm: runtimeWasm }
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['wasm'] })

  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), [])
  const input = new Float32Array(CONTEXT + FRAME)
  const recent = [0, 0, 0]
  let busy = false
  let stopped = false

  // At the model's own rate, so the browser does the resampling.
  const ctx = new AudioContext({ sampleRate: RATE })
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const tap = ctx.createScriptProcessor(FRAME, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(tap)
  tap.connect(mute)
  mute.connect(ctx.destination)

  tap.onaudioprocess = (e) => {
    // One step at a time. If inference ever falls behind, a frame is skipped
    // rather than queued: what matters is what is being said now.
    if (busy || stopped) return
    const frame = e.inputBuffer.getChannelData(0)
    input.copyWithin(0, FRAME) // keep the last CONTEXT samples at the front
    input.set(frame, CONTEXT)
    busy = true
    session
      .run({
        input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + FRAME]),
        state,
        sr,
      })
      .then((out: Record<string, ort.Tensor>) => {
        state = out.stateN as ort.Tensor
        recent.shift()
        recent.push((out.output.data as Float32Array)[0])
      })
      .catch(() => {})
      .finally(() => {
        busy = false
      })
  }

  return {
    prob: () => Math.max(...recent),
    stop: () => {
      stopped = true
      tap.onaudioprocess = null
      try {
        source.disconnect()
        tap.disconnect()
        void ctx.close()
      } catch {
        /* already gone */
      }
    },
  }
}
