// lore-web HTTP server. Built on Node's stdlib http only (no web framework) so
// the whole tool runs on any machine with Node + the vendored SDK, no build and
// no extra native deps. Bound to 127.0.0.1: it exposes full repo write access
// and must never be reachable off-host.

import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, renameSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, extname, normalize as normalizePath, dirname, parse as parsePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

import { log } from "./log.mjs";
// Lazy wrappers, NOT ./sdk.mjs directly: importing that would load the 29 MB
// native library before this module's body — and so before listen(). See
// sdk-lazy.mjs. LoreVerbError comes from errors.mjs (zero imports) so
// `instanceof` works without pulling the SDK in.
import { collect, stream, preloadSdk, shutdownSdk } from "./sdk-lazy.mjs";
import { LoreVerbError } from "./errors.mjs";
import { sinceLaunch } from "./launch.mjs";
// Pure frozen enums — this subpath has no imports of its own and does not touch koffi.
import { LoreErrorCode } from "@lore-vcs/sdk/types/enums";
import * as store from "./store.mjs";
import * as xform from "./transforms.mjs";
import { addClient, broadcastRefresh } from "./events.mjs";
import { watchRepo, unwatchRepo } from "./watcher.mjs";
import { isLoggedIn, runCli } from "./cli.mjs";
import { setupLoreignore, appendIgnorePattern, hasLoreignore, hasGitignore, hasP4ignore } from "./loreignore.mjs";
import { discoverServers } from "./discovery.mjs";
import * as cache from "./cache.mjs";
import { parseAddress } from "./address.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "web");
const HOST = process.env.LORE_WEB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LORE_WEB_PORT ?? process.env.PORT ?? 7420);

/** A path is a Lore working copy if it holds a .lore (or legacy .urc) dir. */
function isRepo(path) {
  return existsSync(join(path, ".lore")) || existsSync(join(path, ".urc"));
}

/**
 * Global args for a render-path read: `offline: true` skips Lore's default
 * remote-first resolution (status/history otherwise await a remote connect
 * before falling back to local, which can stall for seconds against a down
 * server). Never use this for verbs that must reach the server (sync, push,
 * clone, branch switch, remote listing) — those need the real connection.
 * @param {string} repoPath
 */
function readArgs(repoPath) {
  return { repositoryPath: repoPath, offline: true };
}

/**
 * The remote server base to assign when initializing a brand-new repository, so
 * the user never types one. Reads from configured default remote, falls back to
 * an already-tracked repo's remote, or the default local Lore server. The repo
 * name is appended later; repositoryCreate mints the per-repo UUID that
 * distinguishes repos on a server.
 * @returns {string} a remote base URL with no trailing repo-name path component
 */
function defaultRemoteBase() {
  const configured = store.getDefaultRemote();
  if (configured) return configured;

  for (const r of store.listRepos()) {
    for (const name of ["config.toml", "config"]) {
      const cfg = join(r.path, ".lore", name);
      if (!existsSync(cfg)) continue;
      try {
        const m = readFileSync(cfg, "utf8").match(/^\s*remote_url\s*=\s*"([^"]+)"/m);
        if (m && m[1]) return m[1];
      } catch {
        // unreadable config — keep looking
      }
    }
  }
  return "lore://127.0.0.1:41337";
}

/** The remote_url recorded in a repo's .lore config, or null if none/unreadable. */
function readRepoRemote(repoPath) {
  for (const name of ["config.toml", "config"]) {
    const cfg = join(repoPath, ".lore", name);
    if (!existsSync(cfg)) continue;
    try {
      const m = readFileSync(cfg, "utf8").match(/^\s*remote_url\s*=\s*"([^"]+)"/m);
      if (m && m[1]) return m[1];
    } catch {
      // unreadable — fall through
    }
  }
  return null;
}

/** The scheme://authority prefix of a URL, with any path/repo component dropped. */
function remoteBase(url) {
  const m = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i);
  return m ? m[1] : url.replace(/\/+$/, "");
}

/**
 * The repository URL suggested when initializing a folder named `label`, of the
 * form <server-base>/<label>. This is what the Add flow shows for review.
 * @param {string} label the repo name (usually the folder's last path segment)
 * @returns {string} a full repository URL
 */
function suggestInitUrl(label) {
  return `${defaultRemoteBase().replace(/\/+$/, "")}/${label}`;
}

/**
 * Forward-slash form of a path — the native lib drops Windows backslashes.
 * @param {string} p a filesystem path, possibly using backslash separators
 * @returns {string} the same path with every backslash replaced by a slash
 */
function toUnixPath(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Invalidate cached data for a repository and notify all clients to refetch.
 * Invalidation happens before broadcast so SSE-triggered refetches hit fresh
 * data. Call this whenever a repository changes (filesystem watch, mutating verb).
 * @param {string} repoPath repository path, or "*" to invalidate all repos
 * @param {string} reason description of the change, for logging
 */
function notifyChanged(repoPath, reason) {
  if (repoPath === "*") {
    cache.invalidateAll();
  } else {
    cache.invalidateRepo(repoPath);
  }
  // The online branch enumeration lives outside cache.mjs (see onlineBranches),
  // so it needs its own invalidation on a mutation that could change branches.
  clearOnlineBranches(repoPath);
  broadcastRefresh(repoPath, reason);
}

// A persisted cache entry is served stale-but-instant on the first read after
// restart, then revalidated in the background (see cache.mjs). When that
// revalidate changes the value, broadcast (not invalidate — the cache already
// holds the fresh value) so clients refetch and pick it up.
cache.onUpdate((key) => {
  if (key === "repos") return broadcastRefresh("*", "revalidated");
  const repoPath = key.split(" ")[0];
  broadcastRefresh(repoPath, "revalidated");
});

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

/** Translate a thrown error into a typed JSON error response (never crash). */
function sendError(res, err) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err && typeof err === "object" && "httpStatus" in err ? err.httpStatus : 500;
  log.warn("request failed", { message });
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** Serve a static asset from web/, defaulting to index.html (SPA fallback). */
async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // Contain the path within WEB_DIR.
  const filePath = join(WEB_DIR, normalizePath(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(WEB_DIR)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("dir");
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA fallback for unknown non-API paths.
    try {
      const index = await readFile(join(WEB_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(index);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }
}

/**
 * Enrich one tracked repo entry with its live branch/status and organization,
 * each fetched via a separate native store read. The two reads run in
 * parallel, and each degrades independently on failure (a broken metadata
 * read must not blank out a working status, or vice versa).
 * @param {import("./store.mjs").RepoEntry} r a tracked repo entry
 * @returns {Promise<object>} the entry merged with `exists`, `organization`, and status fields
 */
async function enrichRepo(r) {
  const exists = isRepo(r.path);
  if (!exists) return { ...r, exists, organization: "" };

  const [info, organization] = await Promise.all([
    collect("repositoryStatus", readArgs(r.path), { staged: false })
      .then((events) => xform.repoSummary(events))
      .catch((err) => {
        log.debug("repo enrich failed", { path: r.path, message: err instanceof Error ? err.message : String(err) });
        return {};
      }),
    readOrg(r.path)
      .then((org) => org.organization)
      .catch((err) => {
        log.debug("repo org read failed", { path: r.path, message: err instanceof Error ? err.message : String(err) });
        return "";
      }),
  ]);
  return { ...r, exists, organization, ...info };
}

/**
 * Enrich every tracked repo in parallel and cache the result under `"repos"`.
 * Callers on a cold cache should prefer `listRepos`, which serves an
 * unenriched list immediately instead of waiting on this.
 * @returns {Promise<object[]>} enriched repo entries
 */
async function enrichRepos() {
  return cache.cached("repos", cache.TTL.list, () => Promise.all(store.listRepos().map(enrichRepo)));
}

/**
 * GET /api/repos — tracked repos, enriched with live branch/organization.
 * On a warm cache this returns instantly. On a cold cache (fresh server
 * start, or after invalidation) the native store reads that back branch and
 * organization data can take seconds across many repos; rather than block
 * the response on them, an unenriched list (name, path, `exists`) is returned
 * immediately and the enrichment runs in the background — when it completes,
 * `notifyChanged("*", "enriched")` tells clients to refetch the full list.
 */
async function listRepos(res) {
  if (cache.has("repos")) {
    return sendJson(res, 200, { repos: await enrichRepos() });
  }
  const repos = store.listRepos().map((r) => ({ ...r, exists: isRepo(r.path), organization: "" }));
  sendJson(res, 200, { repos, enriching: true });
  // The cache is now populated by enrichRepos(), so broadcast directly rather
  // than notifyChanged (which would invalidate what was just cached).
  enrichRepos()
    .then(() => broadcastRefresh("*", "enriched"))
    .catch((err) => log.debug("repo list enrichment failed", { message: err instanceof Error ? err.message : String(err) }));
}

/**
 * Read a repository's organization, parsed from its `name` metadata. Lore stores
 * the name as an `org/repo` value; the prefix before the first slash is the
 * organization. Reads local metadata only (the working copy), matching what the
 * desktop client surfaces. Results are cached and invalidated on repo changes.
 * @param {string} repoPath path to a Lore working copy
 * @returns {Promise<{ organization: string, repoName: string, name: string }>}
 */
async function readOrg(repoPath) {
  const key = cache.repoKey(repoPath, "org");
  return cache.cached(key, cache.TTL.repo, async () => {
    const events = await collect("repositoryMetadataGet", { repositoryPath: repoPath, local: true }, { key: "name" });
    return xform.splitOrg(xform.metadata(events).name);
  });
}

/**
 * GET /api/org — the organization and repository name for a tracked repo.
 * @param {import("node:http").ServerResponse} res
 * @param {string|null} repoPath the `path` query parameter
 */
async function getOrg(res, repoPath) {
  if (!repoPath) return sendJson(res, 400, { error: "path required" });
  return sendJson(res, 200, await readOrg(repoPath));
}

/**
 * POST /api/org — change a repository's organization. A repo's org is the `org/`
 * prefix of its `name` metadata, which Lore makes read-only after creation: it is
 * set from the path of the create URL and cannot be edited via metadata. The only
 * way to change it in place is to recreate the working copy's `.lore` under a new
 * URL (preserving the repository id), which discards local committed history. The
 * caller must therefore confirm the destructive nature first; this endpoint
 * performs the recreate unconditionally.
 *
 * The body is `{ path, organization }`. An organization cannot be empty or contain
 * a slash, since the slash separates it from the repository name.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function setOrg(req, res) {
  const body = await readBody(req);
  const path = typeof body.path === "string" ? toUnixPath(body.path) : "";
  if (!path) return sendJson(res, 400, { error: "path required" });
  if (!existsSync(path)) return sendJson(res, 400, { error: "path does not exist" });
  if (!isRepo(path)) return sendJson(res, 400, { error: "not a Lore repository" });
  const organization = typeof body.organization === "string" ? body.organization.trim() : "";
  if (!organization) return sendJson(res, 400, { error: "organization required" });
  if (organization.includes("/")) return sendJson(res, 400, { error: "organization cannot contain '/'" });
  const current = await readOrg(path);
  const repoName = current.repoName || path.split(/[\\/]/).filter(Boolean).pop() || path;
  const remote = readRepoRemote(path);
  const base = remote ? remoteBase(remote) : defaultRemoteBase().replace(/\/+$/, "");
  const repositoryUrl = `${base}/${organization}/${repoName}`;
  log.info("changing organization", { path, from: current.organization, to: organization });
  const id = await recreateLore(path, repositoryUrl, { requireExistingId: true });
  notifyChanged("*", "setOrg");
  return sendJson(res, 200, { ...xform.splitOrg(`${organization}/${repoName}`), id });
}

/**
 * POST /api/repos — start tracking a folder, smartly. If the folder is already a
 * Lore working copy it is tracked as-is; otherwise a new repository is initialized
 * there first (with an auto-generated remote URL) so the user can point at any
 * folder without caring whether it has been set up yet.
 */
async function addRepo(req, res) {
  let { path, url } = await readBody(req);
  if (!path || typeof path !== "string") return sendJson(res, 400, { error: "path required" });
  // The native lib mangles backslash paths; forward slashes are the store's
  // convention and what every other verb here is given.
  path = toUnixPath(path);
  if (!existsSync(path)) return sendJson(res, 400, { error: "path does not exist" });
  const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
  let initialized = false;
  if (!isRepo(path)) {
    // Use the caller's reviewed URL when given, else the generated suggestion.
    // A bare host is rejected as invalid, so the name is part of the suggestion.
    const repositoryUrl = (typeof url === "string" && url.trim()) || suggestInitUrl(label);
    log.info("initializing repository", { path, repositoryUrl });
    try {
      await collect("repositoryCreate", { repositoryPath: path }, { repositoryUrl, id: "" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The remote already holds a repo under this name with a different id
      // (e.g. .lore was deleted and re-created, minting a fresh id). Surface a
      // structured conflict so the UI can offer to adopt the remote's id.
      const m = message.match(/already exist(?:s)? with id\s*([0-9a-fA-F-]+)\b[\s\S]*does not match/i);
      if (!m) throw err;
      // A failed create can leave a partial .lore behind; clear it so a later
      // adopt (offline create with the remote id) starts from a clean slate.
      if (isRepo(path)) rmSync(join(path, ".lore"), { recursive: true, force: true });
      return sendJson(res, 409, {
        error: message,
        code: "id_mismatch",
        remoteId: m[1].replace(/-/g, "").toLowerCase(),
        path,
        repositoryUrl,
        name: label,
      });
    }
    // Seed .loreignore (from .gitignore when present) and keep each tool's
    // metadata out of the other's history.
    setupLoreignore(path);
    initialized = true;
  }
  const entry = store.addRepo(path, label);
  watchRepo(path, () => notifyChanged(path, "fs"));
  notifyChanged("*", "addRepo");
  sendJson(res, 200, { repo: entry, initialized });
}

/**
 * POST /api/repair — rebuild a working copy's .lore in place. Lore can leave
 * "zombie" status entries (for example, a nested repo that was indexed then deleted) that
 * no reset/stage/commit/obliterate can remove; the only cure is recreating .lore.
 * We do that while preserving the repository id and remote, so the repo keeps its
 * identity. Refused when there is committed history (which a rebuild would drop) —
 * such a repo should be re-cloned from its remote instead.
 */
async function repairRepo(path, res) {
  if (!existsSync(path)) return sendJson(res, 400, { error: "path does not exist" });
  if (!isRepo(path)) return sendJson(res, 400, { error: "not a Lore repository" });
  // Guard: never destroy committed history.
  const hist = xform.history(await collect("revisionHistory", { repositoryPath: path }, { length: 1 }));
  if (hist.length > 0) {
    return sendJson(res, 409, {
      error: "repository has committed revisions; repair would lose them — re-clone from the remote instead",
    });
  }
  const remote = readRepoRemote(path);
  const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const repositoryUrl = `${remote ? remoteBase(remote) : defaultRemoteBase().replace(/\/+$/, "")}/${label}`;
  const id = await recreateLore(path, repositoryUrl, { requireExistingId: true });
  notifyChanged(path, "repair");
  sendJson(res, 200, { ok: true, id });
}

/**
 * `renameSync` with retries. On Windows, `fs.watch(...).close()` returns
 * before the OS has necessarily released the underlying directory handle
 * (ReadDirectoryChangesW) — a rename attempted immediately afterward can
 * transiently fail with EPERM/EBUSY even though the watcher was correctly
 * closed first. A short retry lets that release catch up instead of failing
 * the whole repair on what is normally a sub-second race.
 * @param {string} from
 * @param {string} to
 * @param {number} [attempts]
 * @param {number} [delayMs]
 */
async function renameWithRetry(from, to, attempts = 5, delayMs = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
      if ((code !== "EPERM" && code !== "EBUSY") || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Rebuild a working copy's `.lore` in place, re-registering it under
 * `repositoryUrl` while preserving its existing repository id. The old `.lore` is
 * moved aside and restored if the rebuild throws, so a failure never leaves the
 * folder without a repository. The rebuild runs offline so it never re-registers
 * on (or conflicts with) the remote — the repo already exists there.
 *
 * This discards any local committed history (a fresh `.lore` has none), so callers
 * must guard against or warn about that before invoking it.
 * @param {string} path a Lore working copy
 * @param {string} repositoryUrl the URL whose path component becomes the repo name
 * @param {{id?: string, requireExistingId?: boolean}} [opts] `id` forces a specific
 *   repository id (hex); `requireExistingId` makes an unreadable `.lore/id` an error
 *   instead of silently minting a fresh identity (which, offline, is guaranteed to
 *   mismatch the remote later).
 * @returns {Promise<string>} the repository id (hex) the rebuild used, or "" if none
 */
async function recreateLore(path, repositoryUrl, { id: forcedId, requireExistingId = false } = {}) {
  const dot = join(path, ".lore");
  let id = forcedId || "";
  if (!id) {
    try {
      id = readFileSync(join(dot, "id")).toString("hex");
    } catch {
      if (requireExistingId) {
        throw new Error(
          "cannot read this repository's id (.lore/id); rebuilding without it would mint a new identity that conflicts with the remote",
        );
      }
    }
  }
  log.info("recreating repository .lore", { path, repositoryUrl, id });
  const backup = `${dot}.repair-bak`;
  // Suspend the watcher to avoid EPERM on Windows when renaming .lore (fs.watch
  // holds an open directory handle that blocks renames). Re-establish it in
  // finally so both success and rollback paths resume watching.
  const wasWatched = unwatchRepo(path);
  try {
    rmSync(backup, { recursive: true, force: true });
    await renameWithRetry(dot, backup);
    try {
      await collect("repositoryCreate", { repositoryPath: path, offline: true }, { repositoryUrl, id });
    } catch (err) {
      rmSync(dot, { recursive: true, force: true });
      await renameWithRetry(backup, dot);
      throw err;
    }
    rmSync(backup, { recursive: true, force: true });
    setupLoreignore(path);
  } finally {
    if (wasWatched) {
      watchRepo(path, () => notifyChanged(path, "fs"));
    }
  }
  return id;
}

/**
 * POST /api/adopt-remote-id — bind a local folder to a repository that already
 * exists on the remote under the same name but a different id (the "already
 * exist with id X which does not match Y" conflict from repositoryCreate).
 * Recreates the local `.lore` offline with the remote's id, so future syncs talk
 * to the existing server-side repository. Refused when the folder has committed
 * local history — adopting the remote's identity under divergent history risks
 * corruption; such a folder should be re-cloned instead.
 */
async function adoptRemoteId(req, res) {
  const body = await readBody(req);
  const path = typeof body.path === "string" ? toUnixPath(body.path) : "";
  const remoteId = typeof body.remoteId === "string" ? body.remoteId.replace(/-/g, "").toLowerCase() : "";
  const repositoryUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!path) return sendJson(res, 400, { error: "path required" });
  if (!existsSync(path)) return sendJson(res, 400, { error: "path does not exist" });
  if (!/^[0-9a-f]+$/.test(remoteId)) return sendJson(res, 400, { error: "remoteId must be a hex repository id" });
  if (!repositoryUrl) return sendJson(res, 400, { error: "url required" });
  const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
  log.info("adopting remote repository id", { path, repositoryUrl, remoteId });
  if (isRepo(path)) {
    // Guard: never destroy committed history (same rule as repair).
    const hist = xform.history(await collect("revisionHistory", { repositoryPath: path }, { length: 1 }));
    if (hist.length > 0) {
      return sendJson(res, 409, {
        error: "repository has committed revisions; adopting the remote id would lose them — re-clone from the remote instead",
      });
    }
    await recreateLore(path, repositoryUrl, { id: remoteId });
  } else {
    // The add-flow collision case: no .lore yet, so create it offline directly
    // under the remote's id. Existing working files simply become local changes.
    await collect("repositoryCreate", { repositoryPath: path, offline: true }, { repositoryUrl, id: remoteId });
    setupLoreignore(path);
  }
  const entry = store.addRepo(path, label);
  watchRepo(path, () => notifyChanged(path, "fs"));
  notifyChanged("*", "adoptRemoteId");
  sendJson(res, 200, { repo: entry, id: remoteId });
}

/**
 * Resolve a repository name to the id it is actually bound to on the server,
 * via `repositoryInfo` (which, unlike `repositoryList`, looks a name up
 * directly instead of enumerating everything the server currently lists). A
 * name can be bound on the server without appearing in `repositoryList` — this
 * is the only way to detect that, and it's what a stuck delete or a fresh
 * `repositoryCreate` collision actually depends on.
 * @param {string} base server base URL (no path)
 * @param {string} name repository name (may include an org prefix)
 * @returns {Promise<string|null>} the bound id, or null if the name doesn't
 *   resolve (a normal answer) or the request fails outright
 */
async function resolveRemoteName(base, name) {
  try {
    const events = await collect("repositoryInfo", {}, { repositoryUrl: `${base}/${name}` });
    return xform.repositoryInfo(events);
  } catch {
    return null;
  }
}

/**
 * Map `items` through `fn`, running at most `limit` calls concurrently.
 *
 * Each `fn` call here wraps a `collect()` that can time out but never cancels
 * its underlying native call (see sdk.mjs) — every one left running abandons a
 * koffi/libuv threadpool worker for the rest of the process's life (koffi's
 * async dispatch shares that pool with Node's own fs/dns/crypto/zlib calls).
 * An unbounded `Promise.all` here would let one dialog-open against a
 * remote that accepts-but-never-responds leak one thread per repo at once;
 * capping concurrency bounds that to `limit` regardless of how many repos or
 * candidate names are being cross-checked.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * GET /api/remote-repos?url= — ask a Lore server which repositories it hosts, so
 * the user can pick one to clone instead of typing its full URL. The server base
 * comes from the query, falling back to the same default the Add flow suggests
 * (the remote of an already-tracked repo, an env override, or the local server).
 * Each entry is returned with a ready-to-clone URL of the form <base>/<name>.
 *
 * Deliberately just `repositoryList` — fast, no cross-checking. An earlier
 * version of this endpoint cross-checked every name against `repositoryInfo`
 * inline (see `verifyRemoteRepoNames` below for why that check is valuable),
 * but doing that here meant the whole response waited on every probe: bounded
 * to 3 concurrent, each able to take the full verb idle timeout (60s) if a
 * name stalls, a server listing even a couple dozen repos against a
 * slow/flaky remote could hold this response for many minutes — "just list
 * the repos" has no business taking that long. The client now renders this
 * fast list immediately and requests the cross-check separately, in the
 * background, patching in badges once it completes.
 * @param {import("node:http").ServerResponse} res
 * @param {string|null} rawUrl the server URL to query; empty/null uses the default
 */
async function listRemoteRepos(res, rawUrl) {
  const base = remoteBase((rawUrl || "").trim() || defaultRemoteBase());
  const events = await collect("repositoryList", {}, { url: base });
  const local = localRepoIds();
  const repos = xform.remoteRepos(events).map((r) => ({
    ...r,
    url: `${base}/${r.name}`,
    idUrl: `${base}/${r.id}`,
    tracked: local.has(r.id),
  }));
  sendJson(res, 200, { base, repos });
}

/**
 * POST /api/remote-repos/verify — the background half of the repository
 * listing: cross-check every given name (the ones the client already rendered
 * from `listRemoteRepos`) plus every tracked local repo's name against this
 * same server, via `repositoryInfo`. `repositoryList` alone is not ground
 * truth: a name can be bound to a repository id the listing doesn't
 * enumerate, which is exactly what makes `repositoryCreate` collide on a name
 * that looks free. Split out from `listRemoteRepos` so the (potentially very
 * slow, one stalled name can cost up to the full verb idle timeout) cross-
 * check never blocks the initial listing.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function verifyRemoteRepoNames(req, res) {
  const { base: rawBase, names } = await readBody(req);
  if (!Array.isArray(names)) return sendJson(res, 400, { error: "names must be an array" });
  const base = remoteBase((rawBase || "").trim() || defaultRemoteBase());
  const local = localRepoIds();
  const listedNames = new Set(names);

  // Names of tracked local repos pointed at this same server, so their name
  // can be cross-checked even if the listing doesn't cover them.
  const candidateNames = new Set();
  for (const r of store.listRepos()) {
    if (!isRepo(r.path)) continue;
    const remote = readRepoRemote(r.path);
    if (!remote || remoteBase(remote) !== base) continue;
    try {
      const { name } = await readOrg(r.path);
      if (name && !listedNames.has(name)) candidateNames.add(name);
    } catch {
      // metadata unreadable — nothing to cross-check for this repo
    }
  }

  // Bounded, not Promise.all — see mapLimited's doc comment for why unbounded
  // fan-out here is a real resource-exhaustion risk, not just a style choice.
  const RESOLVE_CONCURRENCY = 3;
  const [listedResolved, phantomResolved] = await Promise.all([
    mapLimited(names, RESOLVE_CONCURRENCY, (name) => resolveRemoteName(base, name)),
    mapLimited([...candidateNames], RESOLVE_CONCURRENCY, (name) => resolveRemoteName(base, name)),
  ]);

  const listed = Object.fromEntries(names.map((name, i) => [name, listedResolved[i]]));
  const phantom = [...candidateNames]
    .map((name, i) => ({ name, resolvedId: phantomResolved[i], tracked: local.has(phantomResolved[i]) }))
    .filter((p) => p.resolvedId != null); // doesn't actually resolve — nothing phantom here

  sendJson(res, 200, { base, listed, phantom });
}

/** Repository ids of every tracked local working copy (from each .lore/id). */
function localRepoIds() {
  const ids = new Set();
  for (const r of store.listRepos()) {
    try {
      const id = readFileSync(join(r.path, ".lore", "id")).toString("hex");
      if (id) ids.add(id);
    } catch {
      // no id file / not a working copy — nothing to match
    }
  }
  return ids;
}

/**
 * DELETE /api/remote-repos — remove a repository from its server by id. Never
 * touches local content: it addresses the server purely by URL, is never given
 * `--repository` or `--dry-run` (the latter only guards the local filesystem —
 * it does not prevent the remote delete), and runs with a neutral `cwd` so it
 * can never resolve an ambient working copy from this process's own directory.
 *
 * A Lore quirk forces the verification to go beyond a simple re-list: repos
 * created without an owner do not resolve by their listed name, only by id, and
 * `lore repository delete` exits 0 whether it succeeded or failed — a real
 * failure prints "Not found" and still returns 0, identically to a delete that
 * matched nothing. So success is judged by three checks, not the CLI's exit
 * code: the id is gone from `repositoryList`, no listed entry carries the old
 * name, and (the decisive one) `resolveRemoteName` no longer resolves that name
 * to anything — this is what a re-list alone cannot see, and what let a prior
 * "successful" delete leave the name still bound on the server.
 */
async function deleteRemoteRepo(req, res) {
  const { id, base: rawBase } = await readBody(req);
  if (!id) return sendJson(res, 400, { error: "id required" });
  const base = remoteBase((rawBase || "").trim() || defaultRemoteBase());
  const before = xform.remoteRepos(await collect("repositoryList", {}, { url: base }));
  const target = before.find((r) => r.id === id);
  if (!target) return sendJson(res, 404, { error: "repository not found on this server" });
  const { name } = target;
  log.info("deleting remote repository", { base, id, name });

  const result = await runCli(["repository", "delete", `${base}/${id}`, "--no-pager"], {
    timeoutMs: 30_000,
    cwd: tmpdir(),
  });

  const verify = async () => {
    const after = xform.remoteRepos(await collect("repositoryList", {}, { url: base }));
    const idGone = !after.some((r) => r.id === id);
    const nameGone = !after.some((r) => r.name === name);
    const resolvedId = await resolveRemoteName(base, name);
    return { ok: idGone && nameGone && resolvedId == null, resolvedId };
  };

  let outcome = await verify();
  if (!outcome.ok) {
    // The id may be gone from the listing while the name is still bound (the
    // failure mode this rewrite exists to catch). Retry once against the name
    // URL — best effort, since the name form of delete has been observed to
    // reject with "Invalid repository name" even for a legitimate target.
    await runCli(["repository", "delete", `${base}/${name}`, "--no-pager"], { timeoutMs: 30_000, cwd: tmpdir() });
    outcome = await verify();
  }

  if (!outcome.ok) {
    const cliText = [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
    const detail = cliText
      ? `server did not delete the repository (lore reported: ${cliText})`
      : "server did not delete the repository";
    const stillBound = outcome.resolvedId ? ` — the name still resolves to ${outcome.resolvedId}` : "";
    return sendJson(res, 500, { error: `${detail}${stillBound}` });
  }
  sendJson(res, 200, { ok: true });
}

/**
 * GET /api/config — return the configured default remote server and discovered servers.
 * @param {import("node:http").ServerResponse} res
 */
async function getConfig(res) {
  let discovered = [];
  try {
    discovered = await discoverServers();
  } catch (err) {
    log.debug("server discovery failed", { message: err instanceof Error ? err.message : String(err) });
  }
  return sendJson(res, 200, {
    defaultRemote: store.getDefaultRemote(),
    discoveredServers: discovered,
  });
}

/**
 * POST /api/config — set the default remote server URL.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function setConfig(req, res) {
  const body = await readBody(req);
  const defaultRemote = typeof body.defaultRemote === "string" ? body.defaultRemote.trim() : "";
  try {
    store.setDefaultRemote(defaultRemote);
    log.info("remote server configured", { url: defaultRemote ? "[configured]" : "[cleared]" });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 400, { error: message });
  }
}

/**
 * GET /api/discover — manually trigger discovery of Lore servers on the local network.
 * @param {import("node:http").ServerResponse} res
 */
async function manualDiscover(res) {
  try {
    const discovered = await discoverServers();
    return sendJson(res, 200, { discoveredServers: discovered });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { error: message });
  }
}

/**
 * Drive roots present on this machine, used as the picker's top "This PC" level.
 * @returns {string[]} drive-root paths (Windows: C:\ … Z:\; POSIX: "/")
 */
function listDrives() {
  if (process.platform !== "win32") return ["/"];
  const drives = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (existsSync(d)) drives.push(d);
  }
  return drives;
}

/**
 * GET /api/browse?path= — list the sub-folders of a directory so the UI can offer
 * a native-feeling folder picker (the browser can't hand us a real fs path). An
 * empty path returns the drive roots ("This PC"). Each entry is flagged when it
 * is itself a Lore repo. Only directories are returned — this is a folder picker.
 * @param {import("node:http").ServerResponse} res
 * @param {string|null} rawPath directory to list; empty/null lists the roots
 */
async function browse(res, rawPath) {
  let path = (rawPath || "").trim();
  // Empty path → the roots level (drives on Windows, "/" on POSIX).
  if (!path) {
    const entries = listDrives().map((d) => ({ name: d, path: d, isRepo: isRepo(d) }));
    return sendJson(res, 200, { path: "", parent: null, sep, entries });
  }
  const norm = normalizePath(path);
  let info;
  try {
    info = await stat(norm);
  } catch {
    return sendJson(res, 400, { error: "path does not exist" });
  }
  if (!info.isDirectory()) return sendJson(res, 400, { error: "not a directory" });
  // Parent: the drives/roots level when we're at a drive root, else dirname.
  const atRoot = parsePath(norm).root === norm || norm === "/";
  const parent = atRoot ? "" : dirname(norm);
  let entries = [];
  try {
    const dirents = await readdir(norm, { withFileTypes: true });
    entries = dirents
      .filter((d) => {
        try {
          return d.isDirectory();
        } catch {
          return false;
        }
      })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => {
        const full = join(norm, d.name);
        return { name: d.name, path: full, isRepo: isRepo(full) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message : "cannot read directory" });
  }
  sendJson(res, 200, { path: norm, parent, sep, isRepo: isRepo(norm), entries });
}

/**
 * Read a repository's status, optionally including the full working-tree
 * scan. `scan: false` skips discovering untracked files and is fast even on
 * large working copies; `scan: true` is the complete picture but can take
 * seconds on a repo with many files.
 * @param {string} repoPath repository path
 * @param {boolean} scan whether to run the full working-tree scan
 * @returns {Promise<object>} status data with hasLoreignore/hasGitignore/hasP4ignore and nested flags applied
 */
async function fetchStatus(repoPath, scan) {
  const events = await collect("repositoryStatus", readArgs(repoPath), { staged: true, scan });
  const data = xform.status(events);
  // The UI offers an "Initialize .loreignore" action when one is absent.
  data.hasLoreignore = hasLoreignore(repoPath);
  data.hasGitignore = hasGitignore(repoPath);
  data.hasP4ignore = hasP4ignore(repoPath);
  // Flag entries that are themselves Lore working copies (a directory holding
  // its own .lore). The UI prompts to ignore these *while they still exist* —
  // the only way to avoid the unremovable "zombie" entry Lore leaves behind if
  // an indexed nested repo is later deleted.
  for (const f of data.files) {
    if (f.type === 0 && isRepo(join(repoPath, f.path))) f.nested = true;
  }
  return data;
}

/** Repo paths with a background full status scan currently in flight, to avoid starting duplicates. */
const scanningRepos = new Set();

/**
 * Kick off the full working-tree scan in the background after a fast
 * (`scan: false`) status response has already gone out, so a repo switch is
 * never blocked on scanning a large working copy. On completion, the cached
 * status entry is replaced with the complete result and clients are told to
 * refetch; deduped per repo so overlapping requests do not start redundant
 * scans.
 * @param {string} repoPath repository path
 * @param {string} key the cache key the fast result was stored under
 */
function startBackgroundScan(repoPath, key) {
  if (scanningRepos.has(repoPath)) return;
  scanningRepos.add(repoPath);
  fetchStatus(repoPath, true)
    .then((data) => {
      cache.put(key, data);
      broadcastRefresh(repoPath, "scan");
    })
    .catch((err) => {
      log.debug("background status scan failed", { path: repoPath, message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => scanningRepos.delete(repoPath));
}

// ---- Branch enumeration --------------------------------------------------
// The render path (status/history/branch graph, refetched after every sync,
// switch, poll, focus, and file-watch) must never block on the remote. branchList
// run online connects to the Lore server, and a slow or unreachable server there
// makes the whole refresh hang for VERB_TIMEOUT_MS or fail with a "Not found" /
// timeout that surfaces as a toast even though the sync itself succeeded. So the
// render path uses an OFFLINE branchList (local branches only, instant), and the
// remote enumeration — needed only for the "local only" / "remote only" cleanup
// badges — is refreshed in the background and merged in when it arrives.

/** Offline (local-only) branch list. No remote connect — safe on the render path. */
async function fetchBranchesOffline(repoPath, archived) {
  const events = await collect("branchList", { repositoryPath: repoPath, offline: true }, { archived });
  return xform.branches(events);
}

/**
 * Online branch list. Enumerates remote entries too (a pushed branch appears as
 * both a LOCAL and a REMOTE entry), which is what lets the UI tell local-only from
 * remote-only. It connects to the remote, so it can stall or fail — only ever
 * called from the background refresh below, never on the render path.
 */
async function fetchBranchesOnline(repoPath, archived) {
  const events = await collect("branchList", { repositoryPath: repoPath }, { archived });
  return xform.branches(events);
}

/**
 * Last successful online branch enumeration, keyed by repo+archived. Held here
 * rather than in the shared cache (cache.mjs) on purpose: that cache's
 * stale-while-revalidate would re-run the *offline* fetcher on the render path
 * and clobber this remote-aware value, making the badges flicker every softMs.
 * @type {Map<string, { branches: object[], fetchedAt: number }>}
 */
const onlineBranches = new Map();
const onlineBranchInflight = new Set();
const ONLINE_BRANCH_TTL_MS = Number(process.env.LORE_WEB_ONLINE_BRANCH_TTL_MS ?? 60_000);

/**
 * Backoff state for a failing online branch refresh, keyed the same way as
 * `onlineBranches`. Unlike that map (success-only), this tracks *attempts* so
 * consecutive failures space themselves out — without it, a remote that stays
 * slow/unreachable gets re-tried on every render-path trigger the instant the
 * in-flight guard clears (as soon as a `collect()` call gives up), abandoning
 * one more uncancellable native call roughly every idle-timeout period,
 * forever (see server/sdk.mjs's abandonedCallCount tracking).
 * @type {Map<string, { failCount: number, nextAttemptAt: number }>}
 */
const onlineBranchBackoff = new Map();
const ONLINE_BRANCH_BACKOFF_MAX_MS = 10 * 60_000;

function onlineBranchesKey(repoPath, archived) {
  return `${toUnixPath(repoPath)} branches-online:${archived ? "all" : "active"}`;
}

/** Drop cached online enumerations for a repo (or all) after a mutation, so the
 *  next refresh re-reads the remote instead of serving a pre-change branch set.
 *  Also clears any backoff, so a mutation (which implies the user just
 *  successfully reached the remote) gets an immediate retry rather than
 *  waiting out a delay computed from earlier, possibly unrelated failures. */
function clearOnlineBranches(repoPath) {
  if (!repoPath || repoPath === "*") {
    onlineBranches.clear();
    onlineBranchBackoff.clear();
    return;
  }
  const prefix = `${toUnixPath(repoPath)} `;
  for (const key of onlineBranches.keys()) {
    if (key.startsWith(prefix)) onlineBranches.delete(key);
  }
  for (const key of onlineBranchBackoff.keys()) {
    if (key.startsWith(prefix)) onlineBranchBackoff.delete(key);
  }
}

/**
 * Refresh the cached online branch enumeration in the background: deduped so only
 * one runs per key at a time, and rate-limited by ONLINE_BRANCH_TTL_MS so a
 * healthy remote is polled at most once per interval instead of on every refetch.
 * A failing remote backs off exponentially instead (see onlineBranchBackoff) —
 * without that, every render-path trigger arriving after the in-flight guard
 * clears would re-attempt immediately, abandoning one more uncancellable native
 * call roughly every idle-timeout period for as long as the remote stays bad.
 * Broadcasts a refresh only when the enumeration actually changed, so clients pick
 * up accurate badges without periodic churn. A slow/unreachable remote fails
 * quietly here — it never reaches the render path.
 */
function refreshOnlineBranches(repoPath, archived) {
  const key = onlineBranchesKey(repoPath, archived);
  if (onlineBranchInflight.has(key)) return;
  const entry = onlineBranches.get(key);
  if (entry && Date.now() - entry.fetchedAt < ONLINE_BRANCH_TTL_MS) return;
  const backoff = onlineBranchBackoff.get(key);
  if (backoff && Date.now() < backoff.nextAttemptAt) return;
  onlineBranchInflight.add(key);
  fetchBranchesOnline(repoPath, archived)
    .then((branches) => {
      onlineBranchBackoff.delete(key);
      const prev = onlineBranches.get(key);
      onlineBranches.set(key, { branches, fetchedAt: Date.now() });
      if (!prev || JSON.stringify(prev.branches) !== JSON.stringify(branches)) {
        broadcastRefresh(repoPath, "branches-enriched");
      }
    })
    .catch((err) => {
      log.debug("online branch enrichment failed", { key, message: err instanceof Error ? err.message : String(err) });
      const failCount = (onlineBranchBackoff.get(key)?.failCount ?? 0) + 1;
      const delay = Math.min(ONLINE_BRANCH_TTL_MS * 2 ** (failCount - 1), ONLINE_BRANCH_BACKOFF_MAX_MS);
      onlineBranchBackoff.set(key, { failCount, nextAttemptAt: Date.now() + delay });
    })
    .finally(() => onlineBranchInflight.delete(key));
}

/**
 * Branch list for the render path: the last-known online enumeration when we have
 * one (remoteKnown: true, so the UI shows accurate badges), otherwise the fast
 * offline list (remoteKnown: false, so the UI suppresses badges rather than
 * flashing a wrong "local only" on every branch). Always kicks a background
 * online refresh so the enumeration converges; never blocks on the remote.
 * @returns {Promise<{ branches: object[], remoteKnown: boolean }>}
 */
async function resolveBranches(repoPath, archived) {
  refreshOnlineBranches(repoPath, archived);
  const online = onlineBranches.get(onlineBranchesKey(repoPath, archived));
  if (online) return { branches: online.branches, remoteKnown: true };
  const key = cache.repoKey(repoPath, `branches:${archived ? "all" : "active"}`);
  const branches = await cache.cached(key, cache.TTL.repo, () => fetchBranchesOffline(repoPath, archived));
  return { branches, remoteKnown: false };
}

/**
 * DELETE /api/repos — stop tracking a repo. Always succeeds, even if the folder
 * is gone (issue #4: the desktop refused to remove a repo with a missing folder).
 */
async function deleteRepo(req, res) {
  const { path } = await readBody(req);
  if (!path) return sendJson(res, 400, { error: "path required" });
  unwatchRepo(path);
  const removed = store.removeRepo(path);
  notifyChanged("*", "deleteRepo");
  sendJson(res, 200, { removed });
}

/** Resolve repo-relative file paths to absolute (the native lib uses cwd). */
function absFiles(repoPath, files) {
  if (!Array.isArray(files)) return undefined;
  return files.map((f) => (repoPath ? join(repoPath, f) : f));
}

/** True for a LoreVerbError raised because a content blob isn't in the local store. */
function isAddressNotFound(err) {
  return err instanceof LoreVerbError && err.code === LoreErrorCode.ADDRESS_NOT_FOUND;
}

/** True for a streamed DONE failure message describing a missing content blob.
 * The streaming path (unlike collect()'s LoreVerbError) carries no error code —
 * only the free-text message — so this matches the same "Address not found"
 * text the client already parses (see ADDRESS_NOT_FOUND_RE in web/app.js). */
function isAddressNotFoundMessage(message) {
  return /address not found/i.test(String(message ?? ""));
}

/**
 * Revert files to their committed base (fileReset), streaming progress.
 * Reverting a *modified* tracked file realizes its base content back into the
 * working tree, which needs that content in the local store; a lazily/
 * partially-synced repo may not have it yet, so the first attempt fails with
 * an address-not-found DONE. When that happens, pull the missing committed
 * content from the remote (revisionSync, without discarding the working tree)
 * and retry once. If content is still unreachable, finish with the same
 * actionable message the pre-streaming version raised as a 409.
 * @param {string} rp repository path
 * @param {string[]|undefined} paths absolute file paths, or undefined for whole-tree
 * @returns {AsyncGenerator<import("./errors.mjs").LoreEvt>}
 */
async function* resetFilesStream(rp, paths) {
  // purge is required to discard newly added (untracked) files/folders — without
  // it, fileReset only reverts already-tracked modified content and silently
  // leaves added entries dirty.
  const args = { paths, purge: true };
  let failure = null;
  for await (const ev of stream("fileReset", { repositoryPath: rp }, args)) {
    if (ev.tag !== "DONE") {
      yield ev;
    } else if (ev.data.ok) {
      yield ev;
      return; // succeeded on the first attempt
    } else {
      failure = ev.data.message;
    }
  }
  if (!isAddressNotFoundMessage(failure)) {
    yield { tag: "DONE", tagRaw: -1, data: { ok: false, status: -1, message: failure } };
    return;
  }
  log.debug("fileReset missing base content; syncing then retrying", { repo: rp });
  yield { tag: "LOG", tagRaw: -1, data: { level: "info", message: "Base content missing locally — syncing before retrying the revert…" } };
  // reset:false materializes missing committed content without resetting the
  // working tree over the user's other changes.
  let syncFailure = null;
  for await (const ev of stream("revisionSync", { repositoryPath: rp }, { reset: false })) {
    if (ev.tag !== "DONE") yield ev;
    else if (!ev.data.ok) syncFailure = ev.data.message;
  }
  if (syncFailure) {
    yield { tag: "DONE", tagRaw: -1, data: { ok: false, status: -1, message: syncFailure } };
    return;
  }
  let retryFailure = null;
  for await (const ev of stream("fileReset", { repositoryPath: rp }, args)) {
    if (ev.tag !== "DONE") {
      yield ev;
    } else if (ev.data.ok) {
      yield ev;
      return;
    } else {
      retryFailure = ev.data.message;
    }
  }
  const message = isAddressNotFoundMessage(retryFailure)
    ? "File content isn't available locally yet — sync this repo, then retry the revert."
    : retryFailure;
  yield { tag: "DONE", tagRaw: -1, data: { ok: false, status: -1, message } };
}

/** Read every GET_DATA chunk for a storageGet item into one buffer, keyed by offset. */
function reassembleGetData(events, id) {
  const chunks = events
    .filter((e) => e.tag === "STORAGE_GET_DATA" && e.data.id === id)
    .sort((a, b) => a.data.offset - b.data.offset);
  return Buffer.concat(chunks.map((e) => Buffer.from(e.data.bytes)));
}

/**
 * Run a Lore verb to completion via the streaming path and return every event
 * regardless of outcome. Unlike `collect()`, this never throws and never
 * discards events on a non-zero overall status — needed here because a
 * bulk storage verb's per-item ITEM_COMPLETE detail (the actual error code)
 * is exactly what `collect()`'s throw-on-failure contract discards.
 * @param {string} verb
 * @param {Record<string, unknown>} globalArgs
 * @param {Record<string, unknown>} args
 * @returns {Promise<import("./errors.mjs").LoreEvt[]>}
 */
async function collectAllEvents(verb, globalArgs, args) {
  const events = [];
  for await (const ev of stream(verb, globalArgs, args)) events.push(ev);
  return events;
}

/**
 * Force a genuine re-upload of one address that the local store already
 * (wrongly) marks durable: `storageUpload`/`storagePut` both trust that flag
 * and skip the remote call entirely, which is exactly the bug that let this
 * blob go missing from the remote in the first place (see incident context).
 * Bypasses it the only way the SDK allows: read the bytes out, delete the
 * local entry so nothing claims it's already handled, then write fresh with
 * a remote session attached, which forces a real upload attempt.
 *
 * Destructive in the middle (obliterate briefly leaves this machine's only
 * copy at risk if the process dies before the put): the bytes are staged to
 * a temp file first as a manual-recovery fallback, deleted only after the
 * put reports success.
 * @param {Record<string, unknown>} handle
 * @param {string} partition
 * @param {{hash: string, context: string}} address
 */
async function forceReupload(handle, partition, address) {
  const getEvents = await collectAllEvents("storageGet", {}, {
    handle,
    items: [{ id: 0, partition, address, streaming: false, localCache: true }],
  });
  const getComplete = getEvents.find((e) => e.tag === "STORAGE_GET_ITEM_COMPLETE");
  if (!getComplete || getComplete.data.errorCode !== LoreErrorCode.NONE) {
    log.error("forceReupload: storageGet failed", { address, events: getEvents.map((e) => e.tag), errorCode: getComplete?.data.errorCode });
    return { errorCode: getComplete?.data.errorCode ?? LoreErrorCode.INTERNAL };
  }
  const bytes = reassembleGetData(getEvents, 0);

  const backupDir = mkdtempSync(join(tmpdir(), "lore-web-push-content-"));
  const backupPath = join(backupDir, `${address.hash}-${address.context}.bin`);
  writeFileSync(backupPath, bytes);

  try {
    await collectAllEvents("storageObliterate", {}, { handle, items: [{ id: 0, partition, address }] });

    const putEvents = await collectAllEvents("storagePut", {}, {
      handle,
      items: [{ id: 0, partition, context: address.context, data: bytes, remoteWrite: true, localCache: true, fixedSizeChunk: 0 }],
    });
    const putComplete = putEvents.find((e) => e.tag === "STORAGE_PUT_ITEM_COMPLETE");
    if (!putComplete) {
      log.error("forceReupload: storagePut produced no completion event; bytes preserved", { address, backupPath, events: putEvents.map((e) => e.tag) });
      return { errorCode: LoreErrorCode.INTERNAL, backupPath };
    }
    if (putComplete.data.errorCode === LoreErrorCode.NONE && putComplete.data.address?.hash !== address.hash) {
      // Should be unreachable (hash is recomputed from the same bytes we just
      // read back), but never claim success on a hash mismatch.
      log.error("forceReupload: put address hash mismatch; bytes preserved", { address, backupPath, gotHash: putComplete.data.address?.hash });
      return { errorCode: LoreErrorCode.INTERNAL, backupPath };
    }
    if (putComplete.data.errorCode === LoreErrorCode.NONE) {
      rmSync(backupDir, { recursive: true, force: true });
      return { errorCode: LoreErrorCode.NONE };
    }
    log.error("forceReupload: storagePut failed; bytes preserved", { address, backupPath, errorCode: putComplete.data.errorCode });
    return { errorCode: putComplete.data.errorCode, backupPath };
  } catch (err) {
    log.error("forceReupload failed after obliterate; bytes preserved", { address, backupPath, message: err instanceof Error ? err.message : String(err) });
    return { errorCode: LoreErrorCode.INTERNAL, backupPath };
  }
}

/**
 * Push locally-held content that hasn't been confirmed durable on the remote
 * back to the remote store. Repairs the case where a commit's upload timed
 * out: the content stays in the local store (recoverable) but the published
 * revision references a blob the remote never received, so every other
 * client fails to sync with ADDRESS_NOT_FOUND.
 *
 * Tries the cheap path first (`storageUpload`, wrapping the native
 * `lore_storage_upload` — this app otherwise never calls it, the CLI has no
 * equivalent command). If the local store already marks an address durable,
 * `storageUpload` trusts that and skips the remote call without checking —
 * which is exactly how the blob went missing to begin with. When that
 * happens, fall back to `forceReupload`, which bypasses the shortcut.
 * @param {string} rp repository path
 * @param {{hash: string, context: string}[]} addresses
 * @returns {Promise<{hash: string, context: string, alreadyDurable: boolean, errorCode: number, backupPath?: string}[]>}
 */
async function pushContent(rp, addresses) {
  if (addresses.length === 0) return [];

  const statusEvents = await collect("repositoryStatus", { repositoryPath: rp }, { staged: false });
  const { repository: partition } = xform.repoSummary(statusEvents);
  if (!partition) throw new LoreVerbError("Could not resolve repository id for push-content", { verb: "pushContent" });

  const remoteUrl = readRepoRemote(rp);
  if (!remoteUrl) throw new LoreVerbError("Repository has no remote configured", { verb: "storageOpen" });

  const openEvents = await collect("storageOpen", {}, {
    repositoryPath: rp,
    hasRemoteConfig: true,
    remoteConfig: { remoteUrl },
  });
  const opened = openEvents.find((e) => e.tag === "STORAGE_OPENED");
  const handle = opened?.data && { handleId: opened.data.handleId };
  if (!handle) throw new LoreVerbError("storageOpen did not return a handle", { verb: "storageOpen" });

  try {
    const items = addresses.map((addr, id) => ({ id, partition, address: addr }));
    const events = await collect("storageUpload", {}, { handle, items });
    const byId = new Map();
    for (const e of events) {
      if (e.tag === "STORAGE_UPLOAD_ITEM_COMPLETE") byId.set(e.data.id, e.data);
    }

    const results = [];
    for (const addr of addresses) {
      const id = addresses.indexOf(addr);
      const data = byId.get(id);
      const alreadyDurable = !!data?.alreadyDurable;
      let errorCode = data?.errorCode ?? LoreErrorCode.INTERNAL;
      let backupPath;
      if (alreadyDurable) {
        // Locally "durable" but we got here because the remote is missing it
        // (that's the whole reason this endpoint exists) — verify for real.
        const forced = await forceReupload(handle, partition, addr);
        errorCode = forced.errorCode;
        backupPath = forced.backupPath;
      }
      results.push({ hash: addr.hash, context: addr.context, alreadyDurable, errorCode, ...(backupPath ? { backupPath } : {}) });
    }
    return results;
  } finally {
    await collect("storageClose", {}, { handle }).catch((err) =>
      log.debug("storageClose failed", { repo: rp, message: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * Run a content-reading verb (fileDiff, revisionInfo) on the fast local-only path
 * (offline), and if the needed content isn't in the local store
 * (ADDRESS_NOT_FOUND), retry once with remote resolution enabled so the SDK
 * fetches the missing blob on demand. This keeps the common case fast (the 407a090
 * no-stall behavior) while still rendering diffs/revision files in a partially-
 * synced repo. Read-only: unlike the revert path it never mutates the working
 * tree, so it drops `offline` rather than running revisionSync.
 * @param {string} verb such as "fileDiff"
 * @param {string|null} repoPath the repo, or null for a repo-less read
 * @param {Record<string, unknown>} args verb-specific arguments
 * @returns {Promise<import("./errors.mjs").LoreEvt[]>}
 */
async function collectRead(verb, repoPath, args) {
  if (!repoPath) return collect(verb, {}, args);
  try {
    return await collect(verb, readArgs(repoPath), args);
  } catch (err) {
    if (!isAddressNotFound(err)) throw err;
    // Content missing from the local store: retry with remote-first resolution
    // (drop `offline`) so the SDK fetches it. Only paid on a genuine cache miss.
    log.debug("read verb missing content offline; retrying online", { verb, repo: repoPath });
    try {
      return await collect(verb, { repositoryPath: repoPath }, args);
    } catch (retryErr) {
      if (!isAddressNotFound(retryErr)) throw retryErr;
      const actionable = new LoreVerbError(
        "Content isn't available locally yet — sync this repo to view this diff.",
        { verb, status: retryErr.status, code: retryErr.code },
      );
      actionable.httpStatus = 409;
      throw actionable;
    }
  }
}

/**
 * Pipe an async generator of Lore events to the client as newline-delimited
 * JSON (one normalized event per line), ending with the DONE marker. Used for
 * both single-verb streams (streamOp) and custom multi-step generators (e.g.
 * resetFilesStream's sync-and-retry recovery) so the browser can render live
 * progress either way.
 * @param {import("node:http").ServerResponse} res
 * @param {AsyncGenerator<import("./errors.mjs").LoreEvt>} events
 * @param {string|null} repoPath repo to refresh on completion
 * @param {string} label used only for the finish log line
 */
async function pipeEvents(res, events, repoPath, label) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  let ok = false;
  for await (const ev of events) {
    if (ev.tag === "DONE") ok = ev.data?.ok;
    res.write(JSON.stringify(ev) + "\n");
  }
  res.end();
  // A mutating op changes repo state; invalidate cache and tell every client to refetch.
  if (repoPath) notifyChanged(repoPath, label);
  log.info("stream op finished", { verb: label, ok });
}

/**
 * Run a streaming verb and pipe its events to the client. Used for long
 * operations (sync, push, clone) so the browser can render live progress.
 * @param {import("node:http").ServerResponse} res
 * @param {string} verb
 * @param {Record<string, unknown>} globalArgs
 * @param {Record<string, unknown>} args
 * @param {string|null} repoPath repo to refresh on completion
 */
async function streamOp(res, verb, globalArgs, args, repoPath) {
  await pipeEvents(res, stream(verb, globalArgs, args), repoPath, verb);
}

/** One-shot flag for the startup timing below. */
let servedFirstRequest = false;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (!servedFirstRequest) {
      servedFirstRequest = true;
      log.debug("startup: first request served", { path: p, sinceLaunchMs: sinceLaunch() });
    }
    const q = url.searchParams;
    const repoPath = q.get("path");

    if (p === "/events" && req.method === "GET") return addClient(res);

    if (p === "/api/auth" && req.method === "GET") {
      return sendJson(res, 200, { loggedIn: await isLoggedIn() });
    }

    if (p === "/api/browse" && req.method === "GET") return await browse(res, q.get("path"));

    // Pre-flight for the Add flow: report whether a folder is already a repo and,
    // if not, the URL it would be initialized with (editable before confirming).
    if (p === "/api/init-url" && req.method === "GET") {
      const target = toUnixPath(q.get("path") || "");
      if (!target || !existsSync(target)) return sendJson(res, 400, { error: "path does not exist" });
      const already = isRepo(target);
      const label = target.split(/[\\/]/).filter(Boolean).pop() || target;
      return sendJson(res, 200, { isRepo: already, url: already ? null : suggestInitUrl(label) });
    }

    if (p === "/api/remote-repos" && req.method === "GET") return await listRemoteRepos(res, q.get("url"));
    if (p === "/api/remote-repos" && req.method === "DELETE") return await deleteRemoteRepo(req, res);
    if (p === "/api/remote-repos/verify" && req.method === "POST") return await verifyRemoteRepoNames(req, res);

    if (p === "/api/repos" && req.method === "GET") return await listRepos(res);
    if (p === "/api/repos" && req.method === "POST") return await addRepo(req, res);
    if (p === "/api/repos" && req.method === "DELETE") return await deleteRepo(req, res);

    if (p === "/api/org" && req.method === "GET") return await getOrg(res, repoPath);
    if (p === "/api/org" && req.method === "POST") return await setOrg(req, res);

    if (p === "/api/config" && req.method === "GET") return await getConfig(res);
    if (p === "/api/config" && req.method === "POST") return await setConfig(req, res);
    if (p === "/api/discover" && req.method === "GET") return await manualDiscover(res);

    if (p === "/api/history" && req.method === "GET") {
      const length = Number(q.get("length") ?? 50);
      const key = cache.repoKey(repoPath || "", `history:${length}`);
      if (!repoPath) return sendJson(res, 400, { error: "path required" });
      const revisions = await cache.cached(key, cache.TTL.repo, async () => {
        const events = await collect("revisionHistory", readArgs(repoPath), { length });
        return xform.history(events);
      });
      return sendJson(res, 200, { revisions });
    }
    if (p === "/api/status" && req.method === "GET") {
      if (!repoPath) return sendJson(res, 400, { error: "path required" });
      const key = cache.repoKey(repoPath, "status");
      const out = await cache.cached(key, cache.TTL.repo, async () => {
        const data = await fetchStatus(repoPath, false);
        data.scanning = true;
        return data;
      });
      if (out.scanning) startBackgroundScan(repoPath, key);
      return sendJson(res, 200, out);
    }
    if (p === "/api/branches" && req.method === "GET") {
      if (!repoPath) return sendJson(res, 400, { error: "path required" });
      const archived = q.get("archived") === "true";
      // Offline on the render path; remote enumeration is merged in once the
      // background refresh lands (see resolveBranches). remoteKnown tells the UI
      // whether the local-only / remote-only badges are trustworthy yet.
      const { branches, remoteKnown } = await resolveBranches(repoPath, archived);
      return sendJson(res, 200, { branches, remoteKnown });
    }

    if (p === "/api/graph" && req.method === "GET") {
      if (!repoPath) return sendJson(res, 400, { error: "path required" });
      const length = Number(q.get("length") ?? 100);
      const archived = q.get("archived") === "true";
      const { branches, remoteKnown } = await resolveBranches(repoPath, archived);
      // Per-branch history is built from local revisions (offline) and cached
      // under a key that includes the branch set, so an enrichment that adds or
      // changes branches naturally rebuilds instead of serving a stale graph.
      const sig = branches.map((b) => `${b.id}:${b.latest}`).join(",");
      const key = cache.repoKey(repoPath, `graph:${length}:${archived ? "all" : "active"}:${sig}`);
      const histories = await cache.cached(key, cache.TTL.repo, async () => {
        const out = {};
        // Fetch per-branch history in parallel, degrading gracefully — a
        // remote-only branch with no local revisions just gets an empty lane.
        await Promise.all(
          branches.map((b) =>
            collect("revisionHistory", readArgs(repoPath), {
              branch: b.name,
              length,
              onlyBranch: true,
            })
              .then((events) => {
                out[b.id] = xform.graphHistory(events);
              })
              .catch((err) => {
                log.debug("graph history fetch failed", { branch: b.name, message: err instanceof Error ? err.message : String(err) });
                out[b.id] = [];
              })
          )
        );
        return out;
      });
      return sendJson(res, 200, { branches, histories, remoteKnown });
    }
    // Branch mutations: quick ops that return immediately
    if (p === "/api/branch/create" && req.method === "POST") {
      const { path: rp, branch, category } = await readBody(req);
      if (!rp || !branch) return sendJson(res, 400, { error: "path and branch required" });
      const events = await collect("branchCreate", { repositoryPath: rp }, { branch, category: category || "" });
      const branches = xform.branches(events);
      notifyChanged(rp, "branchCreate");
      return sendJson(res, 200, { branch: branches[0] || null });
    }

    if (p === "/api/branch/archive" && req.method === "POST") {
      const { path: rp, branch } = await readBody(req);
      if (!rp || !branch) return sendJson(res, 400, { error: "path and branch required" });
      await collect("branchArchive", { repositoryPath: rp }, { branch });
      notifyChanged(rp, "branchArchive");
      return sendJson(res, 200, { ok: true });
    }

    // Branch switch: streaming op (materializes files, can be slow)
    if (p === "/api/branch/switch" && req.method === "POST") {
      const { path: rp, branch, revision, reset } = await readBody(req);
      if (!rp || !branch) return sendJson(res, 400, { error: "path and branch required" });
      const args = { branch, reset: !!reset };
      if (revision) args.revision = revision;
      return await streamOp(res, "branchSwitch", { repositoryPath: rp }, args, rp);
    }

    // Merge operations
    if (p === "/api/merge/start" && req.method === "POST") {
      const { path: rp, branch, message, noCommit, expectedTarget } = await readBody(req);
      if (!rp || !branch) return sendJson(res, 400, { error: "path and branch required" });
      // Guard against merging into a branch the client didn't intend: the UI
      // can hold stale state right after a switch, so it declares which branch
      // it believes is current and the merge is refused on any mismatch.
      if (expectedTarget) {
        const statusEvents = await collect("repositoryStatus", { repositoryPath: rp }, { staged: false });
        const current = xform.repoSummary(statusEvents).branch;
        if (current && current !== expectedTarget) {
          return sendJson(res, 409, {
            error: `current branch is ${current}, expected ${expectedTarget} — refresh and retry`,
          });
        }
      }
      const args = { branch, noCommit: !!noCommit };
      if (message) args.message = message;
      return await streamOp(res, "branchMergeStart", { repositoryPath: rp }, args, rp);
    }

    if (p === "/api/merge/abort" && req.method === "POST") {
      const { path: rp } = await readBody(req);
      if (!rp) return sendJson(res, 400, { error: "path required" });
      await collect("branchMergeAbort", { repositoryPath: rp }, {});
      notifyChanged(rp, "mergAbort");
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/merge/resolve" && req.method === "POST") {
      const { path: rp, mode, paths } = await readBody(req);
      if (!rp || !mode || !Array.isArray(paths)) {
        return sendJson(res, 400, { error: "path, mode, and paths array required" });
      }
      const absPathsArr = absFiles(rp, paths);
      const modeMap = {
        mine: "branchMergeResolveMine",
        theirs: "branchMergeResolveTheirs",
        manual: "branchMergeResolve",
        unresolve: "branchMergeUnresolve",
        restart: "branchMergeRestart",
      };
      const verb = modeMap[mode];
      if (!verb) return sendJson(res, 400, { error: `unknown resolve mode: ${mode}` });
      await collect(verb, { repositoryPath: rp }, { paths: absPathsArr });
      notifyChanged(rp, "mergeResolve");
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/diff" && req.method === "GET") {
      const file = q.get("file");
      // The native lib resolves relative path args against process.cwd(); anchor
      // them to the repo by passing an absolute path instead.
      const abs = file && repoPath ? join(repoPath, file) : file;
      const args = abs ? { paths: [abs] } : {};
      // Optional revision range: diff a file between two revisions instead of the
      // working tree (used to show what a historical revision changed).
      const source = q.get("source");
      const target = q.get("target");
      if (source) args.sourceRevision = source;
      if (target) args.targetRevision = target;
      const events = await collectRead("fileDiff", repoPath, args);
      return sendJson(res, 200, { diff: xform.diff(events) });
    }
    if (p === "/api/revision" && req.method === "GET") {
      const revision = q.get("revision");
      const events = await collectRead("revisionInfo", repoPath, { revision, delta: true });
      return sendJson(res, 200, { files: xform.revisionFiles(events) });
    }

    // Staging/unstaging/reverting stream progress (like sync/push/clone) rather
    // than answering once complete — fileStage's scan:true walks the whole
    // working tree, which can run well past a moment on a large repo, and the
    // caller needs a live signal that it's working, not stalled.
    if (p === "/api/stage" && req.method === "POST") {
      const { path: rp, files } = await readBody(req);
      return await streamOp(res, "fileStage", { repositoryPath: rp }, { paths: absFiles(rp, files), scan: true }, rp);
    }
    if (p === "/api/unstage" && req.method === "POST") {
      const { path: rp, files } = await readBody(req);
      return await streamOp(res, "fileUnstage", { repositoryPath: rp }, { paths: absFiles(rp, files) }, rp);
    }
    if (p === "/api/reset" && req.method === "POST") {
      const { path: rp, files } = await readBody(req);
      return await pipeEvents(res, resetFilesStream(rp, absFiles(rp, files)), rp, "fileReset");
    }
    // Add a file/folder/extension pattern to .loreignore (created if absent).
    if (p === "/api/ignore" && req.method === "POST") {
      const { path: rp, pattern } = await readBody(req);
      if (!rp || !pattern) return sendJson(res, 400, { error: "path and pattern required" });
      const added = appendIgnorePattern(toUnixPath(rp), pattern);
      notifyChanged(rp, "ignore");
      return sendJson(res, 200, { ok: true, added });
    }
    // Seed/repair .loreignore for an already-initialized repo (the same setup the
    // Add flow runs on init).
    if (p === "/api/init-loreignore" && req.method === "POST") {
      const { path: rp } = await readBody(req);
      if (!rp) return sendJson(res, 400, { error: "path required" });
      const result = setupLoreignore(toUnixPath(rp));
      notifyChanged(rp, "ignore");
      return sendJson(res, 200, { ok: true, ...result });
    }
    // Rebuild a repo's .lore in place to purge unremovable zombie index entries
    // (Lore has no command to drop them). Guarded: refuses if there is committed
    // history to lose. Preserves the repository id and remote so identity is kept.
    if (p === "/api/repair" && req.method === "POST") {
      const { path: rp } = await readBody(req);
      if (!rp) return sendJson(res, 400, { error: "path required" });
      return await repairRepo(toUnixPath(rp), res);
    }
    // Bind a local folder to a repo the remote already hosts under the same
    // name (resolves the repositoryCreate id-mismatch conflict).
    if (p === "/api/adopt-remote-id" && req.method === "POST") {
      return await adoptRemoteId(req, res);
    }
    if (p === "/api/commit" && req.method === "POST") {
      const { path: rp, message } = await readBody(req);
      if (!message) return sendJson(res, 400, { error: "commit message required" });
      return await streamOp(res, "revisionCommit", { repositoryPath: rp }, { message }, rp);
    }

    // Remote operations stream their progress back as NDJSON.
    if (p === "/api/sync" && req.method === "POST") {
      const { path: rp, revision, reset } = await readBody(req);
      return await streamOp(res, "revisionSync", { repositoryPath: rp }, { revision, reset: !!reset }, rp);
    }
    if (p === "/api/push" && req.method === "POST") {
      const { path: rp, branch, fastForwardMerge } = await readBody(req);
      return await streamOp(res, "branchPush", { repositoryPath: rp }, { branch, fastForwardMerge: !!fastForwardMerge }, rp);
    }
    // Repair: push locally-held, not-yet-durable content to the remote (e.g.
    // after a commit whose upload timed out). Synchronous, not streamed — it's
    // a handful of small items, not a bulk sync.
    if (p === "/api/push-content" && req.method === "POST") {
      const { path: rp, addresses } = await readBody(req);
      if (!rp) return sendJson(res, 400, { error: "path required" });
      if (!Array.isArray(addresses) || addresses.length === 0) {
        return sendJson(res, 400, { error: "addresses required" });
      }
      let parsed;
      try {
        parsed = addresses.map(parseAddress);
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      const results = await pushContent(rp, parsed);
      return sendJson(res, 200, { results });
    }
    if (p === "/api/clone" && req.method === "POST") {
      const { url, dest } = await readBody(req);
      if (!url || !dest) return sendJson(res, 400, { error: "url and dest required" });
      return await streamOp(res, "repositoryClone", { repositoryPath: toUnixPath(dest) }, { repositoryUrl: url }, null);
    }

    // Anything else is a static asset request, falling back to the SPA shell.
    if (req.method === "GET") return await serveStatic(req, res, p);
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
  }
});

// On startup, begin watching every already-tracked repo so refresh works before
// the user touches anything.
function startWatchers() {
  for (const r of store.listRepos()) {
    if (isRepo(r.path)) watchRepo(r.path, () => notifyChanged(r.path, "fs"));
  }
}

/**
 * Warm the repo-list cache in the background so the first browser request
 * after a fresh server start can be served from cache instead of paying the
 * full native enrichment cost. Best-effort — a failure here just means the
 * first browser request warms the cache itself, as before.
 */
function warmRepoCache() {
  const startedAt = Date.now();
  enrichRepos()
    .then(() => log.debug("startup: repo cache warmed", { ms: Date.now() - startedAt, sinceLaunchMs: sinceLaunch() }))
    .catch((err) => log.debug("repo cache warmup failed", { message: err instanceof Error ? err.message : String(err) }));
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    log.error("port already in use — is lore-web already running?", { host: HOST, port: PORT });
    process.exit(1);
  }
  log.error("server error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

/** Resolves once the port is bound; awaited by start.mjs to time the browser open. */
let onListening;
const whenListening = new Promise((resolve) => {
  onListening = resolve;
});

log.debug("startup: modules loaded (sdk deferred)", { sinceLaunchMs: sinceLaunch() });

// STARTUP ORDER IS THE WHOLE POINT (see sdk-lazy.mjs for the why). Nothing that
// can block goes before listen(): binding the port is what lets start.mjs open
// the browser, and the browser's own cold start is seconds we want to spend
// concurrently with loading the native library rather than after it.
//
// Serving is fully useful during that window: web/index.html is a complete
// static shell, and the cold path of GET /api/repos — the SPA's only initial API
// call — reads the tracked-repo JSON and checks for .lore dirs with plain fs, no
// SDK. Live branch/organization data arrives later via the "enriched" SSE refresh.
server.listen(PORT, HOST, () => {
  log.info("lore-web listening", { url: `http://${HOST}:${PORT}`, sinceLaunchMs: sinceLaunch() });

  // Cheap (two fs.watch per tracked repo), but still after listen: no request
  // depends on watchers existing, so they don't belong ahead of the bind.
  startWatchers();

  // koffi.load() is SYNCHRONOUS — while it runs, this process serves nothing.
  // Deferring it by a timer tick is what makes the overlap deterministic rather
  // than incidental: start.mjs awaits `whenListening`, and promise continuations
  // are microtasks, which always drain before the timer phase. So the browser is
  // guaranteed to be spawned before this blocks. spawn() creates the process
  // synchronously, so from there the browser's cold start and the native load
  // proceed in parallel — which is the entire fix.
  setTimeout(() => {
    preloadSdk();
    // Enrichment needs the SDK, so this queues behind the same load promise.
    warmRepoCache();
  }, 0);

  onListening();
});

function shutdown() {
  log.info("shutting down");
  server.close();
  shutdownSdk();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { server, whenListening };
