// Thin wrapper over @lore-vcs/sdk (koffi FFI -> lorelib). All Lore work in
// lore-web flows through here so the FFI lifecycle and the failure contract are
// handled in exactly one place.
//
// Failure contract (per Lore's error-handling standard, errors.md §4): a verb's
// outcome is canonical on its COMPLETE event — `status` (0 = success, non-zero =
// FFI code) and an `error` detail (`errorCode`, `message`, `traceLocations`).
// Older builds instead emit a mid-stream ERROR event (`errorType`, `errorInner`);
// we read COMPLETE.error first and fall back to ERROR events, then raise a single
// typed LoreVerbError. Event-detail strings are read inside the iteration (the
// events are already cloned by the SDK), never retained past it.

import { lore, LoreError } from "@lore-vcs/sdk";
import { LoreEventTag, LoreLogLevel } from "@lore-vcs/sdk/types/enums";
import { log } from "./log.mjs";
import { LoreVerbError } from "./errors.mjs";

// Re-exported so importers of this module keep getting the symbol from here.
// The class itself lives in errors.mjs (which imports nothing) so index.mjs can
// use `instanceof LoreVerbError` without loading the native library.
export { LoreVerbError };

/** @typedef {import("./errors.mjs").LoreEvt} LoreEvt */

const TAG_NAME = /** @type {Record<number, string>} */ (LoreEventTag);

/** Resolve a numeric event tag to its enum name (falls back to the number). */
function tagName(raw) {
  return TAG_NAME[raw] ?? String(raw);
}

/** @param {any} ev */
function normalize(ev) {
  return { tag: tagName(ev.tag), tagRaw: ev.tag, data: ev.data };
}

/** Map SDK LOG severity onto our logger levels. */
const LOG_LEVEL = {
  [LoreLogLevel.TRACE]: "trace",
  [LoreLogLevel.DEBUG]: "debug",
  [LoreLogLevel.INFO]: "info",
  [LoreLogLevel.WARN]: "warn",
  [LoreLogLevel.ERROR]: "error",
};

/**
 * Look up a verb function on the SDK, failing loudly for unknown names rather
 * than letting an undefined call throw an opaque TypeError.
 * @param {string} verb
 */
function resolve(verb) {
  const fn = /** @type {any} */ (lore)[verb];
  if (typeof fn !== "function") {
    throw new LoreVerbError(`Unknown Lore verb: ${verb}`, { verb });
  }
  return fn;
}

/** Pull a readable message out of the ERROR events the SDK collected. */
function messageFromErrors(errors, fallback) {
  for (const e of errors ?? []) {
    const data = e?.data ?? e;
    const inner = data?.errorInner ?? data?.message;
    if (inner) return String(inner);
  }
  return fallback;
}

/**
 * Idle ceiling on a single `collect()` call: if a native verb goes this long
 * without making forward progress (e.g. blocked on a remote connect the SDK
 * never bounds), the call is abandoned rather than hanging an HTTP response
 * forever. This is a backstop, not the fix: callers on the latency-sensitive
 * read path should pass `offline: true` in globalArgs so the SDK never
 * attempts the remote connect in the first place. The blocked native call
 * keeps running after this fires (it can't be cancelled), but the request it
 * was serving is freed to fail fast.
 *
 * The timer is rearmed on every *non-LOG* event, so it measures silence
 * between real progress, not total runtime — a verb that keeps emitting real
 * events (e.g. a `fileStage` scanning a huge working tree) can run
 * indefinitely without tripping it. LOG events are deliberately excluded from
 * resetting it: live testing against a connection that accepts a socket but
 * never speaks the protocol showed the native client's own internal
 * reconnect/backoff loop emitting a burst of LOG events roughly every 50s
 * forever, with no other event ever arriving — if LOG counted as progress,
 * that verb would never be considered stalled and this timeout would never
 * fire, no matter how long it ran. Only COMPLETE/ERROR/PROGRESS/etc. (and the
 * terminal iterator-done signal) count as progress.
 */
const VERB_IDLE_TIMEOUT_MS = Number(process.env.LORE_WEB_VERB_TIMEOUT_MS ?? 60_000);

/** Sentinel the idle timer resolves with, distinguishing "stalled" from a real iterator result. */
const IDLE_TIMEOUT = Symbol("idle-timeout");

/**
 * Count of verb calls abandoned to an idle timeout so far. The SDK exposes no
 * way to cancel the underlying native call (see collect() below), so each of
 * these permanently occupies a koffi/libuv threadpool worker for the rest of
 * the process's life — the pool is shared with Node's own fs/dns/crypto/zlib
 * calls (see server/start.mjs's UV_THREADPOOL_SIZE comment), so this number
 * approaching that size is a real signal the process needs restarting, not
 * just a curiosity. Surfaced in the timeout log line so it's visible without
 * needing debug-level logging enabled.
 */
let abandonedCallCount = 0;

/**
 * Run a Lore verb to completion and return all of its events. Throws a
 * LoreVerbError if the operation fails or stalls.
 * @param {string} verb such as "revisionHistory"
 * @param {Record<string, unknown>} globalArgs at minimum `{ repositoryPath }`
 * @param {Record<string, unknown>} [args] verb-specific arguments
 * @returns {Promise<LoreEvt[]>}
 */
export async function collect(verb, globalArgs, args = {}) {
  const fn = resolve(verb);
  const events = [];
  let status = 0;
  /** @type {{message?: string, errorCode?: number}|null} */
  let complete = null;
  /** @type {string|null} */
  let errorEvent = null;
  let timedOut = false;
  const it = fn(globalArgs, args).asyncIter();

  // One idle timer for the whole call, only replaced when a non-LOG event
  // proves real progress happened — not recreated on every iteration, or a
  // verb that emits nothing but LOG chatter would keep resetting its own
  // deadline forever (see the doc comment above `VERB_IDLE_TIMEOUT_MS`).
  let timer;
  function armIdle() {
    return new Promise((resolve) => {
      timer = setTimeout(() => resolve(IDLE_TIMEOUT), VERB_IDLE_TIMEOUT_MS);
    });
  }
  let idle = armIdle();

  try {
    for (;;) {
      const next = it.next();
      // If idle wins the race, `next` is left pending and can still reject
      // later (the native call can't be cancelled) with nothing awaiting it —
      // attach a no-op handler so that doesn't surface as an unhandled
      // rejection; the race below still observes its real outcome.
      next.catch(() => {});
      const step = await Promise.race([next, idle]);
      if (step === IDLE_TIMEOUT) {
        timedOut = true;
        break;
      }
      if (step.done) break;
      const n = normalize(step.value);
      if (n.tag !== "LOG") {
        // Real forward progress (or a terminal event) — reset the stall
        // clock. LOG events do not count, or a verb stuck in a native
        // reconnect/backoff loop that logs periodically could "stay alive"
        // indefinitely without ever actually succeeding.
        clearTimeout(timer);
        idle = armIdle();
      }
      if (n.tag === "COMPLETE") {
        status = n.data?.status ?? 0;
        complete = n.data?.error ?? null;
      } else if (n.tag === "ERROR") {
        errorEvent = errorEvent ?? n.data?.errorInner;
      }
      events.push(n);
    }
  } catch (err) {
    // asyncIter throws LoreError on a non-zero return; the detail captured
    // above (first ERROR event, else COMPLETE) is the canonical source, so
    // mark failure and move on.
    if (!(err instanceof LoreError)) throw err;
    status = status || -1;
  } finally {
    clearTimeout(timer);
    // Fire-and-forget, never awaited: on a truly stalled verb (e.g. a dead
    // connect the native side never gives up on), the generator's own cleanup
    // path is paused on that same never-resolving operation, so `it.return()`
    // can itself hang forever. Awaiting it here would silently defeat the
    // entire timeout — the response would never be freed to return, exactly
    // the failure mode this timeout exists to prevent. Abandon the iterator
    // without waiting for it to confirm it's done.
    if (timedOut) it.return?.().catch(() => {});
  }
  if (timedOut) {
    abandonedCallCount++;
    // warn, not debug: an abandoned call is a standing resource cost (see
    // abandonedCallCount's doc comment above), worth seeing without turning on
    // debug logging, and the running total is the actionable part.
    log.warn("lore verb timed out; native call abandoned (cannot be cancelled)", {
      verb,
      timeoutMs: VERB_IDLE_TIMEOUT_MS,
      abandonedCallCount,
    });
    throw new LoreVerbError(`Lore verb '${verb}' timed out after ${VERB_IDLE_TIMEOUT_MS}ms with no progress`, {
      verb,
      status: -1,
      code: -1,
    });
  }
  if (status !== 0) {
    const message = errorEvent || complete?.message || `Lore verb '${verb}' failed`;
    log.debug("lore verb failed", { verb, status, message });
    throw new LoreVerbError(message, { verb, status, code: complete?.errorCode ?? status });
  }
  return events;
}

/**
 * Stream a Lore verb's events as they arrive, for live progress over SSE. Yields
 * normalized events (including LOG, PROGRESS, and any ERROR detail) and a final
 * `{ tag: "DONE", data: { ok, status } }` marker. Never throws to the caller;
 * failures arrive as the terminal marker so the SSE channel can close cleanly.
 * The DONE message prefers the first ERROR event's detail (the root cause —
 * some verbs finish with a generic COMPLETE message after a specific ERROR).
 * @param {string} verb
 * @param {Record<string, unknown>} globalArgs
 * @param {Record<string, unknown>} [args]
 * @returns {AsyncGenerator<LoreEvt>}
 */
// A native LOG event can embed an entire verb invocation's arguments as one
// message — e.g. staging ~10,000 files logs "Command arguments:
// LoreFileStageArgs { paths: [...every absolute path...], ... }" as a single
// multi-megabyte string. Piped to the browser unmodified, one such line is
// enough to freeze the tab (synchronous JSON.parse + DOM append of a
// multi-MB string with no yield point). LOG content is diagnostic-only —
// nothing reads it downstream — so it's safe to cap before it leaves this
// process; the full message still reaches the server's own debug log below.
const CLIENT_LOG_MESSAGE_LIMIT = 2000;

export async function* stream(verb, globalArgs, args = {}) {
  const fn = resolve(verb);
  let status = 0;
  /** @type {string|null} */
  let failure = null;
  const exec = fn(globalArgs, args);
  try {
    for await (const ev of exec.asyncIter()) {
      let n = normalize(ev);
      if (n.tag === "COMPLETE") {
        status = n.data?.status ?? 0;
        failure = failure ?? n.data?.error?.message;
      }
      if (n.tag === "ERROR") failure = failure ?? n.data?.errorInner;
      if (n.tag === "LOG") {
        const message = String(n.data?.message ?? "");
        const lvl = LOG_LEVEL[n.data?.level] ?? "debug";
        log[/** @type {"debug"} */ (lvl)](`lore: ${message}`, { verb }); // full message, server-side only
        if (message.length > CLIENT_LOG_MESSAGE_LIMIT) {
          n = {
            ...n,
            data: {
              ...n.data,
              message: `${message.slice(0, CLIENT_LOG_MESSAGE_LIMIT)}… [truncated, ${message.length} chars total]`,
            },
          };
        }
      }
      yield n;
    }
  } catch (err) {
    if (err instanceof LoreError) {
      failure = messageFromErrors(err.loreErrors, failure);
      status = status || -1;
    } else {
      failure = err instanceof Error ? err.message : String(err);
      status = -1;
    }
  }
  const ok = status === 0 && !failure;
  yield { tag: "DONE", tagRaw: -1, data: { ok, status, message: failure ?? undefined } };
}

let configured = false;

/** Configure SDK file logging once. Safe to call repeatedly. */
export function configureSdk() {
  if (configured) return;
  configured = true;
  try {
    /** @type {any} */ (lore).logConfigure?.({
      file: false,
      level: LoreLogLevel.INFO,
      categories: 0,
    });
  } catch (err) {
    log.warn("sdk logConfigure failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Release the native library. Call on process shutdown. */
export function shutdownSdk() {
  try {
    /** @type {any} */ (lore).shutdown?.();
  } catch {
    // The process is exiting; a failure to release the lib is not actionable.
  }
}
