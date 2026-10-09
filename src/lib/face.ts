import { holdCamera, releaseCamera } from './camera'

/**
 * Knowing whose face is in front of the camera.
 *
 * This is the lock on the command centre: the side monitors stay dark and he
 * answers nothing until the person who enrolled is looking at him. It runs
 * entirely in the browser — a small detector finds the face, a recognition
 * network turns it into 128 numbers, and those are compared with the ones kept
 * from enrolment. No picture is stored and nothing leaves the machine.
 *
 * What it is not is security. A photograph of the right face held up to the
 * camera passes, because nothing here tests for depth or liveness. It keeps a
 * colleague or a child from talking to him; it does not keep out anyone who
 * means to get in, and nothing that matters should rest on it.
 *
 * The library and its weights are loaded on first use, not at boot: they are
 * about seven megabytes and most sessions that never lock never need them.
 */

const STORE_KEY = 'jarvis.face'

/**
 * How alike two faces must be to count as the same person, as a distance —
 * smaller is stricter. The network's own guidance is 0.6; this is tighter
 * because the cost of the two mistakes is not equal. Refusing the owner once
 * costs them a second look at the camera. Admitting someone else is the one
 * thing the lock exists to prevent.
 */
const MATCH_DISTANCE = 0.5

/** Samples taken at enrolment, a little apart, so a turn of the head is covered. */
const ENROL_SAMPLES = 6
const ENROL_GAP_MS = 350

/** A match has to hold for this many frames running; one lucky frame is not a face. */
const CONFIRM_FRAMES = 2

type FaceApi = typeof import('@vladmandic/face-api')
let api: Promise<FaceApi> | null = null

function load(): Promise<FaceApi> {
  api ??= (async () => {
    const faceapi = await import('@vladmandic/face-api')
    // Served from our own origin (see vendorModels in scripts/start.mjs), which
    // is the only place the page's CSP lets weights come from.
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/faceapi'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/faceapi'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/faceapi'),
    ])
    // The first pass through each network compiles its shaders, which takes
    // seconds — longer than the whole scan is allowed. Spend that here, on a
    // blank frame, so the clock on a real check only ever times the looking.
    const blank = document.createElement('canvas')
    blank.width = 320
    blank.height = 240
    blank.getContext('2d')?.fillRect(0, 0, 320, 240)
    await faceapi.nets.tinyFaceDetector.locateFaces(
      blank,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416 }),
    )
    await faceapi.nets.faceLandmark68Net.detectLandmarks(blank)
    await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(blank)
    return faceapi
  })()
  // A failed load must not be remembered, or one missing file disables the
  // lock until the page is reloaded.
  api.catch(() => (api = null))
  return api
}

/** Fetch the weights ahead of the first scan, so that one is not the slow one. */
export function warmFace(): void {
  if (enrolled()) void load().catch(() => {})
}

function known(): Float32Array[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as number[][]
    return raw.filter((d) => d.length === 128).map((d) => new Float32Array(d))
  } catch {
    return []
  }
}

export const enrolled = (): boolean => known().length > 0

export function forgetFace(): void {
  localStorage.removeItem(STORE_KEY)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function describe(
  faceapi: FaceApi,
  video: HTMLVideoElement,
): Promise<Float32Array | null> {
  const found = await faceapi
    .detectSingleFace(
      video,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
    )
    .withFaceLandmarks()
    .withFaceDescriptor()
  return found?.descriptor ?? null
}

/**
 * Learn the face in front of the camera. Returns how many samples were kept;
 * zero means nobody was seen and nothing was changed.
 */
export async function enrol(): Promise<number> {
  const faceapi = await load()
  const video = await holdCamera()
  try {
    const samples: number[][] = []
    const deadline = Date.now() + 12_000
    while (samples.length < ENROL_SAMPLES && Date.now() < deadline) {
      const d = await describe(faceapi, video)
      if (d) samples.push(Array.from(d, (n) => Math.round(n * 1e4) / 1e4))
      await sleep(ENROL_GAP_MS)
    }
    // Half a set is not an enrolment: three frames of one angle would lock the
    // owner out the first time they sat differently.
    if (samples.length < ENROL_SAMPLES / 2) return 0
    localStorage.setItem(STORE_KEY, JSON.stringify(samples))
    return samples.length
  } finally {
    releaseCamera()
  }
}

export type Verdict = 'match' | 'stranger' | 'nobody'

/**
 * Look for the enrolled face for up to `timeoutMs`.
 *
 * 'stranger' means a face was seen and it was not theirs; 'nobody' means no
 * face was found at all. They are reported apart because the right thing to
 * say differs — one is a refusal, the other is "I cannot see you".
 */
export async function verify(timeoutMs = 8000, cancelled = () => false): Promise<Verdict> {
  const mine = known()
  if (!mine.length) return 'nobody'

  const faceapi = await load()
  const video = await holdCamera()
  try {
    const deadline = Date.now() + timeoutMs
    let streak = 0
    let sawFace = false
    while (Date.now() < deadline && !cancelled()) {
      const d = await describe(faceapi, video)
      if (d) {
        sawFace = true
        const best = Math.min(...mine.map((k) => faceapi.euclideanDistance(k, d)))
        streak = best < MATCH_DISTANCE ? streak + 1 : 0
        if (streak >= CONFIRM_FRAMES) return 'match'
      } else {
        streak = 0
      }
      await sleep(120)
    }
    return sawFace ? 'stranger' : 'nobody'
  } finally {
    releaseCamera()
  }
}
