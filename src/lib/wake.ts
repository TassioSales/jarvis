import * as ort from 'onnxruntime-web/wasm'
// The runtime's own WebAssembly, resolved by the bundler rather than fetched
// from a CDN: the page's CSP allows scripts from this origin only, and these
// are the exact bytes of the version in the lockfile.
// (By relative path: the package's export map does not list its dist files.)
import runtimeMjs from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import runtimeWasm from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import { CHUNK, SAMPLE_RATE, WakeDetector, type Run } from './oww'

/**
 * The wake-word detector, attached to the microphone.
 *
 * oww.ts is the arithmetic; this is the plumbing around it — loading the three
 * networks, taking the microphone down to 16 kHz, cutting it into 80 ms steps
 * and handing each score to whoever asked. It never decides anything: the
 * voice loop does that, because whether a score means "wake" depends on what
 * he is doing at the time.
 */

const MODELS = '/openwakeword/'

export type Wake = { stop: () => void }

export async function startWake(
  stream: MediaStream,
  onScore: (score: number) => void,
): Promise<Wake> {
  ort.env.wasm.wasmPaths = { mjs: runtimeMjs, wasm: runtimeWasm }
  // One thread. More would need SharedArrayBuffer, which needs the page to be
  // cross-origin isolated, which would break the bridge's iframes — and at six
  // milliseconds a step there is nothing to parallelise.
  ort.env.wasm.numThreads = 1

  const open = (file: string) =>
    ort.InferenceSession.create(`${MODELS}${file}`, { executionProviders: ['wasm'] })
  const sessions = {
    mel: await open('melspectrogram.onnx'),
    embed: await open('embedding_model.onnx'),
    wake: await open('hey_jarvis_v0.1.onnx'),
  }

  const run: Run = async (model, data, dims) => {
    const session = sessions[model]
    const out = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', data, dims),
    })
    return out[session.outputNames[0]].data as Float32Array
  }
  const detector = new WakeDetector(run)

  // A context at the networks' own rate: the browser does the resampling, and
  // does it better than a few lines of JavaScript would.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated in favour of AudioWorklet, and still the only
  // one of the two that needs no separately served module — which under this
  // CSP is the difference between working and not.
  const tap = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0

  let pending = new Float32Array(0)
  const queue: Float32Array[] = []
  let busy = false
  let stopped = false

  const drain = async () => {
    if (busy) return
    busy = true
    try {
      while (queue.length && !stopped) {
        const chunk = queue.shift()!
        onScore(await detector.feed(chunk))
      }
    } catch (err) {
      console.warn('[jarvis] wake-word detector stopped:', err)
      stopped = true
    } finally {
      busy = false
    }
  }

  tap.onaudioprocess = (e) => {
    if (stopped) return
    const input = e.inputBuffer.getChannelData(0)
    const joined = new Float32Array(pending.length + input.length)
    joined.set(pending)
    // Web Audio speaks in -1..1; the networks were trained on 16-bit integers.
    for (let i = 0; i < input.length; i++) joined[pending.length + i] = input[i] * 32767
    let offset = 0
    while (joined.length - offset >= CHUNK) {
      queue.push(joined.slice(offset, offset + CHUNK))
      offset += CHUNK
    }
    pending = joined.slice(offset)
    // If inference ever falls behind, drop the oldest audio rather than score
    // sounds from seconds ago as if they were happening now.
    if (queue.length > 12) queue.splice(0, queue.length - 12)
    void drain()
  }

  source.connect(tap)
  // A processor only runs while it is connected to something that is.
  tap.connect(mute)
  mute.connect(ctx.destination)

  return {
    stop: () => {
      stopped = true
      tap.onaudioprocess = null
      try {
        source.disconnect()
        tap.disconnect()
        mute.disconnect()
        void ctx.close()
      } catch {
        /* already gone */
      }
    },
  }
}
