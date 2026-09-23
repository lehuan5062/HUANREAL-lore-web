// Persistent registry of (path, size) combinations known to trigger a specific
// permanently-dead Lore fragment on the remote -- a payload-less association
// the server keeps advertising as held (see the 2026-09-22/23 incidents:
// address 512b733c...-019fa7d2... blocked `main` twice, hit by two different
// files independently, each time the file's SIZE matched a size already known
// to be dead. Content differed both times; size did not.).
//
// This is institutional knowledge, not repository state -- unlike everything
// else in this app (see store.mjs's header), it cannot be read live from the
// SDK. There is no verb that answers "will committing this content eventually
// fail to push"; the only way to find out is to try pushing and watch it fail,
// which costs a slow branch-reset/backup/recommit cycle to recover from. This
// registry exists so the SECOND time a file returns to a known-bad size, the
// user is warned before staging it, not after a failed push days later.
//
// Deliberately warns, never blocks: a match is a size that has previously been
// SEEN to fail, not a guarantee this one will -- other files at the same block
// boundary matter too, and the registry cannot enumerate those. A false
// positive costs a warning; a false negative costs a failed push. Lean toward
// warning.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./log.mjs";

/** @typedef {{ path: string, size: number, address: string, note?: string, firstSeen: number, lastSeen: number, occurrences: number }} DeadSizeEntry */

const STORE_PATH = process.env.LORE_WEB_DEAD_FRAGMENTS_STORE ?? join(homedir(), ".lore-web", "dead-fragments.json");

/** @type {Record<string, DeadSizeEntry[]>} keyed by Lore repository id */
let state = {};

function loadFromDisk() {
  if (!existsSync(STORE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
  } catch (err) {
    log.warn("dead-fragment registry unreadable, starting empty", {
      path: STORE_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function persist() {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

loadFromDisk();

/**
 * Record that this (path, size) combination was involved in a push that failed
 * because the content is missing from both the local store and the remote --
 * the permanently-dead-fragment case, not the recoverable one. Idempotent:
 * repeated failures for the same (path, size) bump `occurrences`/`lastSeen`
 * rather than duplicating the entry.
 * @param {string} repositoryId
 * @param {string} path repo-relative
 * @param {number} size bytes
 * @param {string} address the `hash-context` this push failed on
 * @param {string} [note] e.g. "possibly implicated" when not individually isolated
 */
export function recordDeadSize(repositoryId, path, size, address, note) {
  if (!repositoryId || !path || !Number.isFinite(size)) return;
  const list = state[repositoryId] ?? (state[repositoryId] = []);
  const existing = list.find((e) => e.path === path && e.size === size);
  const now = Date.now();
  if (existing) {
    existing.lastSeen = now;
    existing.occurrences += 1;
    existing.address = address;
  } else {
    list.push({ path, size, address, ...(note ? { note } : {}), firstSeen: now, lastSeen: now, occurrences: 1 });
  }
  persist();
}

/**
 * Which of these (path, size) pairs are already known to have triggered a dead
 * fragment for this repository.
 * @param {string} repositoryId
 * @param {{path: string, size: number}[]} candidates
 * @returns {DeadSizeEntry[]} matches, same order as input where matched
 */
export function matchDeadSizes(repositoryId, candidates) {
  const list = state[repositoryId];
  if (!list || list.length === 0) return [];
  const bySize = new Map(list.map((e) => [`${e.path}\u0000${e.size}`, e]));
  return candidates.map((c) => bySize.get(`${c.path}\u0000${c.size}`)).filter((e) => e !== undefined);
}
