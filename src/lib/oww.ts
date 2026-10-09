/**
 * Hearing his name without sending the room anywhere.
 *
 * This is openWakeWord's pipeline (Apache-2.0, github.com/dscripka/openWakeWord)
 * run in the page: three small networks, chained, on a rolling window of the
 * microphone.
 *
 *   audio, 80 ms at a time
 *     → mel spectrogram      (what frequencies, when)
 *     → speech embedding     (a 96-number summary of each ~0.8 s of sound)
 *     → wake-word classifier (do the last 1.3 s of summaries sound like "hey Jarvis")
 *
 * The result is a score between 0 and 1, eighty milliseconds after the sound
 * that produced it. That is what makes it worth having next to a cloud
 * transcriber that is far more accurate: the transcriber can only tell you he
 * was called after the sentence is over and a round trip has completed, and it
 * has to be sent every sound in the room to find out.
 *
 * Nothing here touches the DOM or the network. `run` is how the caller lends
 * it an ONNX runtime, which keeps this file testable from Node against
 * recorded audio — the only way to know a detector works before trusting a
 * microphone to it.
 */

/** Run one of the three networks: input tensor in, first output tensor out. */
export type Run = (
  model: 'mel' | 'embed' | 'wake',
  data: Float32Array,
  dims: number[],
) => Promise<Float32Array>

/** Samples per step: 80 ms at 16 kHz. Everything downstream assumes this. */
export const CHUNK = 1280
export const SAMPLE_RATE = 16000

const MEL_BINS = 32
/** Mel frames the embedding network looks at, and how far it moves each step. */
const EMBED_WINDOW = 76
const EMBED_STRIDE = 8
/** Embeddings the classifier looks at. */
const WAKE_WINDOW = 16
const EMBED_SIZE = 96
/** Extra audio handed to the spectrogram each step so its frames line up
 *  across chunk boundaries (three hops of 160 samples). */
const MEL_CONTEXT = 480

export class WakeDetector {
  private readonly run: Run
  private raw = new Float32Array(0)
  /** Mel frames, flattened, newest last. Starts as the "ones" the reference
   *  implementation starts with, so the first embeddings are well defined. */
  private mel = new Float32Array(EMBED_WINDOW * MEL_BINS).fill(1)
  private embeddings: Float32Array[] = []
  private pendingFrames = 0
  /** Steps taken. The first second or so scores a buffer that is still mostly
   *  padding, and is not to be believed. */
  private steps = 0

  constructor(run: Run) {
    this.run = run
  }

  /**
   * Feed exactly CHUNK samples, scaled as 16-bit integers (-32768..32767) —
   * the range the networks were trained on, not the -1..1 of Web Audio.
   * Returns the current score.
   */
  async feed(chunk: Float32Array): Promise<number> {
    if (chunk.length !== CHUNK) throw new Error(`expected ${CHUNK} samples, got ${chunk.length}`)

    // Keep only what the next spectrogram needs.
    const keep = Math.min(this.raw.length, MEL_CONTEXT)
    const joined = new Float32Array(keep + CHUNK)
    joined.set(this.raw.subarray(this.raw.length - keep))
    joined.set(chunk, keep)
    this.raw = joined

    // 1. Spectrogram of the new audio, with its context.
    const spec = await this.run('mel', this.raw, [1, this.raw.length])
    const frames = spec.length / MEL_BINS
    const grown = new Float32Array(this.mel.length + spec.length)
    grown.set(this.mel)
    // The reference rescales the network's output this way before using it.
    for (let i = 0; i < spec.length; i++) grown[this.mel.length + i] = spec[i] / 10 + 2
    // Ten seconds of frames is far more than is ever looked at.
    const cap = 1000 * MEL_BINS
    this.mel = grown.length > cap ? grown.slice(grown.length - cap) : grown
    this.pendingFrames += frames

    // 2. One embedding for every EMBED_STRIDE new frames.
    while (this.pendingFrames >= EMBED_STRIDE) {
      this.pendingFrames -= EMBED_STRIDE
      // The window ends `pendingFrames` short of the newest frame, so that
      // successive windows are exactly one stride apart.
      const end = this.mel.length - this.pendingFrames * MEL_BINS
      const window = this.mel.slice(end - EMBED_WINDOW * MEL_BINS, end)
      const embedding = await this.run('embed', window, [1, EMBED_WINDOW, MEL_BINS, 1])
      this.embeddings.push(embedding.slice(0, EMBED_SIZE))
      if (this.embeddings.length > WAKE_WINDOW) this.embeddings.shift()
    }

    this.steps++
    if (this.embeddings.length < WAKE_WINDOW) return 0

    // 3. Does the last 1.3 seconds sound like his name?
    const features = new Float32Array(WAKE_WINDOW * EMBED_SIZE)
    this.embeddings.forEach((e, i) => features.set(e, i * EMBED_SIZE))
    const [score] = await this.run('wake', features, [1, WAKE_WINDOW, EMBED_SIZE])
    return score
  }

  /** Forget what was heard — after a detection, so one "Jarvis" is one wake. */
  reset(): void {
    this.embeddings = []
    this.pendingFrames = 0
    this.mel = new Float32Array(EMBED_WINDOW * MEL_BINS).fill(1)
    this.raw = new Float32Array(0)
  }
}
