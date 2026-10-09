/**
 * Loads `.env.local` into the environment, and has to be the first thing
 * server.mjs imports.
 *
 * Imports are evaluated before the importing file's own code runs, so a
 * loadEnvFile() in the body of server.mjs comes too late for any module that
 * reads its settings as it loads — which is how the small model's key and the
 * feeds' language were being read as "not set" whenever the bridge was started
 * directly rather than through `npm start`. Importing this first puts the file
 * in the environment before anything else looks.
 *
 * Variables already set in the shell still win.
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(new URL('../.env.local', import.meta.url))
  } catch {
    // No file, which is the default and perfectly fine.
  }
}
