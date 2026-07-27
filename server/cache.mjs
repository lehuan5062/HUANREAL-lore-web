// Cache for per-repository read results (status, history, branches,
// organization, and the repo-list summary). Caching is safe here because every
// change signal already flows through one choke point: the filesystem watcher
// and every mutating endpoint call `notifyChanged`, which invalidates the
// affected entries before clients are told to refetch. A stale-while-revalidate
// window keeps hot reads instant, and a hard time-to-live bounds staleness for
// changes the watcher cannot see (network drives, remote pushes with no local
// filesystem event).
//
// Entries also persist to disk (debounced) and rehydrate on startup, marked
// stale so the first read serves them instantly while a background revalidate
// fetches live data — the same instant-startup technique the desktop client
// uses, but self-correcting: `onUpdate` tells the server when a revalidate
// changed a value so it can push a refresh to clients.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./log.mjs";

/** @typedef {{ value: unknown, fetchedAt: number, inflight: Promise<unknown>|null }} CacheEntry */

/** @type {Map<string, CacheEntry>} */
const entries = new Map();

/** Time-to-live pair: serve cached under `softMs`, serve stale + revalidate under `hardMs`. */
export const TTL = {
  repo: { softMs: 15_000, hardMs: 120_000 },
  list: { softMs: 30_000, hardMs: 300_000 },
};

const CACHE_PATH = process.env.LORE_WEB_CACHE ?? join(homedir(), ".lore-web", "cache.json");
const PERSIST_DEBOUNCE_MS = 1_000;

/** @type {NodeJS.Timeout|null} */
let persistTimer = null;

/** @type {((key: string) => void)|null} */
let updateListener = null;

/**
 * Register the listener called with a cache key whenever a background
 * revalidate replaced that key's value with a different one. The server uses
 * this to push a refresh to clients that were served the stale value. At most
 * one listener; later calls replace it.
 * @param {(key: string) => void} fn
 */
export function onUpdate(fn) {
  updateListener = fn;
}

/**
 * Notify the update listener when a revalidated value differs from what was
 * served before. Comparison is structural (serialized), since fetchers always
 * return plain JSON-safe data.
 * @param {string} key the cache key that was refreshed
 * @param {unknown} oldValue value before the refetch
 * @param {unknown} newValue value after the refetch
 */
function notifyIfChanged(key, oldValue, newValue) {
  if (!updateListener) return;
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
  updateListener(key);
}

/**
 * Write all settled entries to `CACHE_PATH` atomically (tmp file + rename).
 * Unsettled in-flight placeholders (`fetchedAt === 0`) are skipped. Failures
 * are logged and swallowed — persistence is an optimization, never a fault.
 */
function persistToDisk() {
  try {
    const settled = [...entries.entries()]
      .filter(([, e]) => e.fetchedAt > 0)
      .map(([key, e]) => ({ key, value: e.value, fetchedAt: e.fetchedAt }));
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(settled));
    renameSync(tmp, CACHE_PATH);
  } catch (err) {
    log.debug("cache persist failed", { path: CACHE_PATH, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Schedule a debounced `persistToDisk()` so bursts of cache writes yield one disk write. */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistToDisk();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Rehydrate persisted entries at startup. Every restored entry's `fetchedAt`
 * is clamped so its age lands past every TTL's `softMs` but within `hardMs`:
 * the first read serves it instantly (no blocking on native calls) while a
 * background revalidate fetches live data. A missing file is normal (first
 * run); a corrupt one starts empty with a warning.
 */
function loadFromDisk() {
  if (!existsSync(CACHE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    // Age every restored entry to exactly softMs + 1: past the soft window of
    // both TTLs (so it always revalidates) yet inside the hard window of both
    // (so it is served instantly meanwhile).
    //
    // The persisted `fetchedAt` is deliberately DISCARDED rather than clamped
    // with Math.min. Min only bounds staleness from above, so an entry written
    // before a reboot kept its original timestamp, aged past hardMs, and became
    // a hard miss — which killed this optimization in precisely the case it
    // exists for. Restoring a real timestamp is not what makes this safe:
    // correctness comes from the revalidate that every restored entry triggers,
    // plus `onUpdate` pushing a client refresh when the value turns out to differ.
    const staleAt = Date.now() - TTL.list.softMs - 1;
    for (const e of parsed) {
      if (!e || typeof e.key !== "string" || typeof e.fetchedAt !== "number") continue;
      entries.set(e.key, { value: e.value, fetchedAt: staleAt, inflight: null });
    }
    log.debug("cache rehydrated", { path: CACHE_PATH, entries: entries.size });
  } catch (err) {
    log.warn("cache file unreadable, starting empty", {
      path: CACHE_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

loadFromDisk();

/**
 * Cache key for a repository-scoped result. The path is normalized to forward
 * slashes so keys agree regardless of whether the caller passed a query-param
 * path or a watcher/store path.
 * @param {string} repoPath working-copy path
 * @param {string} kind result kind, for example "status" or "history:50"
 * @returns {string}
 */
export function repoKey(repoPath, kind) {
  return `${repoPath.replace(/\\/g, "/")} ${kind}`;
}

/**
 * Whether `key` currently holds a value that has actually finished fetching
 * at least once — an entry that only exists as an unsettled in-flight
 * placeholder (`fetchedAt === 0`) does not count. Used to decide whether a
 * cold-start caller should wait on a fetcher or serve a placeholder while one
 * runs in the background, without blocking on the very fetch it would
 * otherwise dedupe against.
 * @param {string} key from `repoKey` or a global name like "repos"
 * @returns {boolean}
 */
export function has(key) {
  const entry = entries.get(key);
  return !!entry && entry.fetchedAt > 0;
}

/**
 * Return the cached value for `key`, fetching with `fetcher` when needed.
 * Fresh (< softMs old) values return immediately; values between softMs and
 * hardMs old return immediately while a background refetch updates the entry;
 * missing or expired entries await the fetcher. Concurrent calls for the same
 * key share one in-flight fetch. Fetcher errors are never cached — they
 * propagate to the caller (or are logged when raised by a background refetch).
 * @param {string} key from `repoKey` or a global name like "repos"
 * @param {{ softMs: number, hardMs: number }} ttl freshness thresholds
 * @param {() => Promise<unknown>} fetcher produces the value on a miss
 * @returns {Promise<unknown>}
 */
export async function cached(key, ttl, fetcher) {
  const entry = entries.get(key);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;

  if (entry && age < ttl.softMs) return entry.value;

  if (entry && age < ttl.hardMs) {
    if (!entry.inflight) {
      const priorValue = entry.value;
      entry.inflight = fetcher()
        .then((value) => {
          entries.set(key, { value, fetchedAt: Date.now(), inflight: null });
          schedulePersist();
          notifyIfChanged(key, priorValue, value);
        })
        .catch((err) => {
          entry.inflight = null;
          log.debug("cache revalidate failed", {
            key,
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return entry.value;
  }

  if (entry?.inflight) {
    await entry.inflight;
    const refreshed = entries.get(key);
    if (refreshed && refreshed.fetchedAt > entry.fetchedAt) return refreshed.value;
  }

  const inflightEntry = { value: entry?.value, fetchedAt: entry?.fetchedAt ?? 0, inflight: null };
  const fetch = fetcher().then((value) => {
    entries.set(key, { value, fetchedAt: Date.now(), inflight: null });
    schedulePersist();
    return value;
  });
  inflightEntry.inflight = fetch.catch(() => {});
  entries.set(key, inflightEntry);
  try {
    return await fetch;
  } catch (err) {
    if (entries.get(key) === inflightEntry) entries.delete(key);
    throw err;
  }
}

/**
 * Directly overwrite a cache entry with a known-fresh value, bypassing the
 * fetcher path. Used when a caller already obtained a fresher result out of
 * band (for example, a background full-scan that supersedes a fast partial
 * read already stored under the same key).
 * @param {string} key from `repoKey` or a global name like "repos"
 * @param {unknown} value the fresh value to store
 */
export function put(key, value) {
  entries.set(key, { value, fetchedAt: Date.now(), inflight: null });
  schedulePersist();
}

/**
 * Drop every cached entry for one repository, plus the global repo-list entry
 * (the list embeds per-repo branch/status). Call whenever the repo changed on
 * disk or through a mutating verb.
 * @param {string} repoPath working-copy path (any slash style)
 */
export function invalidateRepo(repoPath) {
  const prefix = `${repoPath.replace(/\\/g, "/")} `;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
  entries.delete("repos");
  schedulePersist();
}

/** Drop every cached entry — used when the tracked-repo set itself changed. */
export function invalidateAll() {
  entries.clear();
  schedulePersist();
}
