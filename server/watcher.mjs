// Per-repo filesystem watcher. When a tracked working copy changes on disk, we
// notify the browser to refetch — this is what makes lists live instead of
// stale-until-restart. Built on node:fs.watch (recursive is supported on
// Windows and macOS); changes are debounced so a burst of writes yields one
// refresh.
//
// The watcher also reports *which* working-tree paths changed, not just that
// something did. Lore only surfaces a modified file once it has been told the
// file is dirty, and the alternative — a full `scan: true` status — walks the
// whole tree, is a write-path verb, and fails outright on a repo missing any
// structural blob. Feeding the changed paths to the `fileDirty` verb instead
// gets the same result cheaply (see markPendingDirty in server/index.mjs).

import { watch } from "node:fs";
import { join, sep } from "node:path";
import { log } from "./log.mjs";

/** @type {Map<string, { watchers: import("node:fs").FSWatcher[], timer: NodeJS.Timeout|null, pollTimer: NodeJS.Timeout|null }>} */
const active = new Map();

const DEBOUNCE_MS = 400;

// When fs.watch can't cover a repo (setup failure or a runtime error — both
// happen on network/virtualized volumes where recursive watching is flaky),
// fall back to periodic change notifications so the repo degrades to "refreshes
// every FALLBACK_POLL_MS" instead of silently going stale forever.
const FALLBACK_POLL_MS = 30_000;

// Ceiling on how many changed paths one debounce window accumulates. A branch
// switch or bulk sync rewrites the whole tree; forwarding every path to
// fileDirty would be slower than the scan it replaces, so past this point the
// batch is dropped and the caller just gets a plain refresh.
const MAX_CHANGED_PATHS = 2000;

/**
 * Start watching a repo's working tree and its .lore metadata dir. Calling this
 * again for an already-watched path is a no-op.
 * @param {string} repoPath
 * @param {(changed: string[]) => void} onChange invoked (debounced) with the
 *   repo-relative working-tree paths seen since the last call. Empty when the
 *   platform gave no filenames, the batch overflowed, or only .lore changed —
 *   callers must treat it as "something changed, paths unknown".
 */
export function watchRepo(repoPath, onChange) {
  if (active.has(repoPath)) return;
  const entry = { watchers: /** @type {import("node:fs").FSWatcher[]} */ ([]), timer: null, pollTimer: null };

  /** @type {Set<string>} */
  let changed = new Set();
  let overflowed = false;

  const fire = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const batch = overflowed ? [] : [...changed];
      changed = new Set();
      overflowed = false;
      onChange(batch);
    }, DEBOUNCE_MS);
  };

  /** Record a changed working-tree path reported by fs.watch, then debounce. */
  const onWorkingTreeEvent = (_eventType, filename) => {
    // filename is repo-relative here (the watch target is the repo root) and is
    // null on platforms/events that don't report it.
    if (filename) {
      const rel = String(filename);
      // .lore is Lore's own metadata; marking it dirty is meaningless.
      if (rel !== ".lore" && !rel.startsWith(`.lore${sep}`) && !rel.startsWith(".lore/")) {
        if (changed.size >= MAX_CHANGED_PATHS) overflowed = true;
        else changed.add(rel);
      }
    }
    fire();
  };

  const startFallbackPolling = (target, error) => {
    if (entry.pollTimer) return;
    log.warn("watcher degraded — falling back to periodic refresh", { repoPath, target, error, intervalMs: FALLBACK_POLL_MS });
    entry.pollTimer = setInterval(fire, FALLBACK_POLL_MS);
  };

  // Watch the working tree (recursive) for content changes, and the .lore dir
  // for new revisions/branch updates committed by the CLI or a remote push.
  for (const target of [repoPath, join(repoPath, ".lore")]) {
    const isWorkingTree = target === repoPath;
    try {
      const w = watch(target, { recursive: true }, isWorkingTree ? onWorkingTreeEvent : fire);
      w.on("error", (err) => {
        log.warn("watch error", { target, error: err.message });
        startFallbackPolling(target, err.message);
      });
      entry.watchers.push(w);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("watch failed", { target, error: message });
      startFallbackPolling(target, message);
    }
  }

  active.set(repoPath, entry);
  log.debug("watching repo", { repoPath, watchers: entry.watchers.length });
}

/**
 * Stop watching a repo.
 * @param {string} repoPath
 * @returns {boolean} true if a watcher existed and was closed, false otherwise
 */
export function unwatchRepo(repoPath) {
  const entry = active.get(repoPath);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      // Already closed or the path vanished; nothing to do.
    }
  }
  active.delete(repoPath);
  return true;
}
