// Persistent record of the repositories the user has added to lore-web. This is
// the ONLY thing lore-web persists: a set of working-copy paths plus labels.
// Repository *data* (revisions, status, branches) is never cached here — it is
// always read live from the SDK so the UI cannot go stale (the core defect of
// the desktop app this replaces).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./log.mjs";

/** @typedef {{ path: string, label: string, addedAt: number }} RepoEntry */

const STORE_PATH =
  process.env.LORE_WEB_STORE ?? join(homedir(), ".lore-web", "store.json");

/** @type {{ repos: RepoEntry[], defaultRemote?: string }} */
let state = { repos: [], defaultRemote: process.env.LORE_WEB_DEFAULT_REMOTE ?? "" };

/**
 * Load persisted state from `STORE_PATH` into module state, if the file exists.
 * A missing file is normal (first run) and leaves the initial empty state in
 * place. A corrupt file must not take the app down, so it is treated the same
 * way, with a warning logged for visibility.
 */
function loadFromDisk() {
  if (!existsSync(STORE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (parsed && Array.isArray(parsed.repos)) state = parsed;
  } catch (err) {
    log.warn("store unreadable, starting empty", {
      path: STORE_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Write the current module state to `STORE_PATH`, creating its directory if needed. */
function persist() {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

loadFromDisk();

/** @returns {RepoEntry[]} a copy of the tracked repositories, newest first */
export function listRepos() {
  return [...state.repos].sort((a, b) => b.addedAt - a.addedAt);
}

/** @param {string} path */
export function getRepo(path) {
  return state.repos.find((r) => r.path === path);
}

/**
 * Remember a repository's organization so it can be restored after a re-clone.
 *
 * Lore keeps the organization only as an `org/repo` prefix on the working copy's
 * LOCAL `name` metadata — the server does not store it (measured: a repo whose
 * local name is `HUANREAL/InfinityGarden_Master` is registered on the server as
 * plain `InfinityGarden_Master`). So a clone, or anything that rebuilds `.lore`,
 * silently drops it and there is nowhere to read it back from. This store is the
 * only place it can survive, which is why it is kept here rather than derived.
 *
 * Keyed by repository id as well as path when known, because a re-clone usually
 * lands on a different folder while keeping the same id.
 * @param {string} path absolute working-copy path
 * @param {string} organization the organization, or "" to forget it
 * @param {string} [repositoryId] lore repository id, if resolved
 */
export function rememberOrganization(path, organization, repositoryId) {
  const entry = getRepo(path);
  if (!entry) return;
  if (organization) {
    entry.organization = organization;
    if (repositoryId) entry.repositoryId = repositoryId;
  } else {
    delete entry.organization;
  }
  persist();
}

/**
 * The organization last seen for this repo — by path, else by repository id (so a
 * re-clone into a new folder still finds it).
 * @param {string} path
 * @param {string} [repositoryId]
 * @returns {string} the remembered organization, or "" if none
 */
export function rememberedOrganization(path, repositoryId) {
  const byPath = getRepo(path);
  if (byPath?.organization) return byPath.organization;
  if (repositoryId) {
    const byId = state.repos.find((r) => r.repositoryId === repositoryId && r.organization);
    if (byId?.organization) return byId.organization;
  }
  return "";
}

/**
 * Add (or relabel) a tracked repository.
 * @param {string} path absolute working-copy path
 * @param {string} label display name
 * @returns {RepoEntry}
 */
export function addRepo(path, label) {
  const existing = getRepo(path);
  if (existing) {
    if (label) existing.label = label;
    persist();
    return existing;
  }
  const entry = { path, label: label || path, addedAt: Date.now() };
  state.repos.push(entry);
  persist();
  return entry;
}

/**
 * Stop tracking a repository. Always succeeds, even for a path whose folder no
 * longer exists — removing a dangling entry must never be blocked (the desktop
 * bug this fixes refused to remove a repo once its folder was deleted).
 * @param {string} path
 * @returns {boolean} whether an entry was removed
 */
export function removeRepo(path) {
  const before = state.repos.length;
  state.repos = state.repos.filter((r) => r.path !== path);
  const removed = state.repos.length < before;
  if (removed) persist();
  return removed;
}

/**
 * Get the configured default remote server URL.
 * @returns {string} the remote server URL or empty string if not set
 */
export function getDefaultRemote() {
  return state.defaultRemote || "";
}

/**
 * Set the default remote server URL for repositories. Validates the URL format.
 * @param {string} url the remote server URL, for example "lore://127.0.0.1:41337"
 * @throws {Error} if URL is malformed
 */
export function setDefaultRemote(url) {
  const trimmed = (url || "").trim();
  if (trimmed && !trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i)) {
    throw new Error(`invalid remote URL format: "${trimmed}"`);
  }
  state.defaultRemote = trimmed;
  persist();
}
