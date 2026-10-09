// The wasm-only entry point ships no types of its own; it is the same API.
declare module 'onnxruntime-web/wasm' {
  export { env, InferenceSession, Tensor } from 'onnxruntime-web'
}
