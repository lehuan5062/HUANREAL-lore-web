// Lazy front door to sdk.mjs, so binding the HTTP port never waits on the
// native library.
//
// WHY THIS EXISTS: @lore-vcs/sdk has a bare top-level `koffi.load()`
// (node_modules/@lore-vcs/sdk/dist/functions/ffi.js:49) that dlopens a 29 MB
// lorelib DLL and then resolves ~420 struct definitions and 125 exported
// symbols — all synchronously, at import time. ESM `import` statements are
// hoisted, so a static `import ... from "./sdk.mjs"` in index.mjs completes ALL
// of that before a single line of index.mjs's own body runs, and therefore
// before server.listen(). Warm that costs ~44ms and nobody notices. On the first
// launch after a reboot — cold file cache, antivirus first-touching a 29 MB
// binary — it costs seconds, and those seconds run STRICTLY BEFORE the browser
// is even spawned (start.mjs waits for the port), so the browser's own
// multi-second cold launch is serialized after it instead of overlapping it.
//
// Deferring the load requires a dynamic import(), which is what this module
// wraps. index.mjs imports only these thin wrappers, so the module graph it
// pulls in at startup is pure JS plus Node stdlib and listen() happens in
// milliseconds. The load is then kicked off from the `listening` callback,
// concurrently with the browser starting up.

import { log } from "./log.mjs";
import { sinceLaunch } from "./launch.mjs";

/** In-flight (or settled) load promise — the dedup. @type {Promise<typeof import("./sdk.mjs")>|null} */
let loading = null;

/**
 * The resolved module, tracked separately from `loading` so shutdownSdk() can
 * stay synchronous (shutdown() calls process.exit immediately after it, so an
 * awaited value there would never arrive).
 * @type {typeof import("./sdk.mjs")|null}
 */
let sdkMod = null;

/**
 * Load (once) and configure the native SDK. Every wrapper below funnels through
 * this, so a request arriving mid-load simply awaits the same promise and no
 * second dlopen is ever attempted.
 *
 * configureSdk() is invoked here rather than by callers: running it inside the
 * single shared promise guarantees every verb call is sequenced after it, which
 * is the ordering the SDK requires. (It is idempotent besides, so this is belt
 * and braces.)
 * @returns {Promise<typeof import("./sdk.mjs")>}
 */
export function loadSdk() {
  if (loading) return loading;
  const startedAt = Date.now();
  loading = import("./sdk.mjs").then((mod) => {
    // Deliberately NOT reset on failure: the only realistic causes are a missing
    // or unloadable lorelib, which will not fix itself between requests, and
    // retrying a multi-second dlopen per request would be worse than failing fast.
    mod.configureSdk();
    sdkMod = mod;
    log.debug("startup: sdk loaded", { ms: Date.now() - startedAt, sinceLaunchMs: sinceLaunch() });
    return mod;
  });
  return loading;
}

/**
 * Begin loading the SDK in the background. Fire-and-forget: the failure is
 * logged here so it can never surface as an unhandled rejection, while the same
 * rejected promise is still handed to (and reported by) whichever request needs it.
 */
export function preloadSdk() {
  loadSdk().catch((err) =>
    log.error("sdk failed to load", { error: err instanceof Error ? err.message : String(err) })
  );
}

/**
 * Run a Lore verb to completion and return all of its events.
 * @see import("./sdk.mjs").collect
 * @param {string} verb such as "revisionHistory"
 * @param {Record<string, unknown>} globalArgs at minimum `{ repositoryPath }`
 * @param {Record<string, unknown>} [args] verb-specific arguments
 * @returns {Promise<import("./errors.mjs").LoreEvt[]>}
 */
export async function collect(verb, globalArgs, args) {
  const sdk = await loadSdk();
  return sdk.collect(verb, globalArgs, args);
}

/**
 * Stream a Lore verb's events as they arrive.
 *
 * This must itself be an async generator (not a function returning one) so
 * callers keep writing `for await (const ev of stream(...))` unchanged. `yield*`
 * delegates to the real generator, forwarding values and completion, so the
 * terminal DONE-marker contract is untouched.
 * @see import("./sdk.mjs").stream
 * @param {string} verb
 * @param {Record<string, unknown>} globalArgs
 * @param {Record<string, unknown>} [args]
 * @returns {AsyncGenerator<import("./errors.mjs").LoreEvt>}
 */
export async function* stream(verb, globalArgs, args) {
  const sdk = await loadSdk();
  yield* sdk.stream(verb, globalArgs, args);
}

/**
 * Release the native library, if it was ever loaded. Synchronous by design —
 * shutdown() calls process.exit() on the next line — and a no-op when the SDK
 * never loaded (there is nothing native to release in that case).
 */
export function shutdownSdk() {
  if (!sdkMod) return;
  sdkMod.shutdownSdk();
}
