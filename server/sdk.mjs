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
 * Ceiling on a single `collect()` call, so a native verb that blocks (e.g. on a
 * remote connect the SDK never bounds) can't hang an HTTP response forever.
 * This is a backstop, not the fix: callers on the latency-sensitive read path
 * should pass `offline: true` in globalArgs so the SDK never attempts the
 * remote connect in the first place. The blocked native call keeps running
 * after this fires (it can't be cancelled), but the request it was serving is
 * freed to fail fast.
 */
const VERB_TIMEOUT_MS = Number(process.env.LORE_WEB_VERB_TIMEOUT_MS ?? 10_000);

/**
 * Run a Lore verb to completion and return all of its events. Throws a
 * LoreVerbError if the operation fails or times out.
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
  const timer = setTimeout(() => {
    timedOut = true;
  }, VERB_TIMEOUT_MS);
  try {
    for await (const ev of fn(globalArgs, args).asyncIter()) {
      if (timedOut) break;
      const n = normalize(ev);
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
  }
  if (timedOut) {
    log.debug("lore verb timed out", { verb, timeoutMs: VERB_TIMEOUT_MS });
    throw new LoreVerbError(`Lore verb '${verb}' timed out after ${VERB_TIMEOUT_MS}ms`, { verb, status: -1, code: -1 });
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
export async function* stream(verb, globalArgs, args = {}) {
  const fn = resolve(verb);
  let status = 0;
  /** @type {string|null} */
  let failure = null;
  const exec = fn(globalArgs, args);
  try {
    for await (const ev of exec.asyncIter()) {
      const n = normalize(ev);
      if (n.tag === "COMPLETE") {
        status = n.data?.status ?? 0;
        failure = failure ?? n.data?.error?.message;
      }
      if (n.tag === "ERROR") failure = failure ?? n.data?.errorInner;
      if (n.tag === "LOG") {
        const lvl = LOG_LEVEL[n.data?.level] ?? "debug";
        log[/** @type {"debug"} */ (lvl)](`lore: ${n.data?.message ?? ""}`, { verb });
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
