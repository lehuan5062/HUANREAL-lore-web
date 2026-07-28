// Shape normalized SDK event streams into the compact JSON the SPA consumes.
// Each function takes the array returned by sdk.collect() and returns plain data.

/** @typedef {{ tag: string, tagRaw: number, data: any }} LoreEvt */

/** Unwrap a Lore metadata value ({ tag, data, tagName }) to its inner value. */
function metaValue(value) {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

/**
 * Group revision-history events into revision records. Each REVISION_HISTORY_ENTRY
 * is followed by METADATA events (message, timestamp, branch) that belong to it.
 * @param {LoreEvt[]} events
 */
export function history(events) {
  const revisions = [];
  let current = null;
  for (const e of events) {
    if (e.tag === "REVISION_HISTORY_ENTRY") {
      current = {
        revision: e.data?.revision,
        revisionNumber: e.data?.revisionNumber,
        parent: e.data?.parent,
        message: undefined,
        timestamp: undefined,
        branch: undefined,
      };
      revisions.push(current);
    } else if (e.tag === "METADATA" && current) {
      const key = e.data?.key;
      const value = metaValue(e.data?.value);
      if (key === "message") current.message = value;
      else if (key === "timestamp") current.timestamp = value;
      else if (key === "branch") current.branch = value;
    }
  }
  return revisions;
}

/**
 * Reduce status events to a branch summary plus the list of changed files.
 * @param {LoreEvt[]} events
 */
export function status(events) {
  let branch = null;
  let revision = null;
  let revisionMerged = null;
  let revisionStaged = null;
  const files = [];
  let summary = null;
  for (const e of events) {
    if (e.tag === "REPOSITORY_STATUS_REVISION") {
      branch = e.data?.branchName ?? branch;
      revision = e.data?.revision ?? revision;
      revisionMerged = e.data?.revisionMerged ?? revisionMerged;
      revisionStaged = e.data?.revisionStaged ?? revisionStaged;
    } else if (e.tag === "REPOSITORY_STATUS_FILE") {
      files.push(e.data);
    } else if (e.tag === "REPOSITORY_STATUS_SUMMARY") {
      summary = e.data;
    }
  }
  // Count unresolved conflicts
  const conflicts = files.filter((f) => f.flagConflictUnresolved).length;
  // inMerge: a staged merge anchor exists (revisionStaged non-zero and different from HEAD)
  // AND a merge is being merged (revisionMerged non-zero). Prevents false positives when
  // HEAD itself is a merge commit: revisionMerged will be non-zero but no staged anchor means
  // the merge is already committed (not in progress).
  const isZeroHash = (h) => !h || /^0+$/.test(h);
  const hasStagedState = !isZeroHash(revisionStaged) && revisionStaged !== revision;
  const inMerge = hasStagedState && !isZeroHash(revisionMerged);
  return { branch, revision, revisionMerged, revisionStaged, files, summary, inMerge, conflicts };
}

/**
 * Transform branch list events into full stable shape with id, location,
 * category, creator, created, isCurrent, archived, stack, and latest revision.
 * @param {LoreEvt[]} events
 */
export function branches(events) {
  return events.filter((e) => e.tag === "BRANCH_LIST_ENTRY").map((e) => {
    const b = e.data || {};
    return {
      id: b.id,
      location: b.location,
      name: b.name,
      category: b.category,
      latest: b.latest,
      stack: b.stack || [],
      creator: b.creator,
      created: b.created,
      isCurrent: b.isCurrent,
      archived: b.archived,
    };
  });
}

/**
 * The files changed in a single revision, from `revisionInfo({ delta: true })`.
 * @param {LoreEvt[]} events
 */
export function revisionFiles(events) {
  return events
    .filter((e) => e.tag === "REVISION_INFO_DELTA")
    // The delta walks the whole tree; keep only entries that actually changed
    // (content modified, or added/deleted/moved — action other than KEEP=0).
    // Unchanged directory/context entries (action KEEP, not modified) are noise.
    .filter((e) => e.data?.flagModify || (e.data?.action ?? 0) !== 0)
    .map((e) => ({
      path: e.data?.path,
      action: e.data?.action,
      size: e.data?.size,
      flagModify: e.data?.flagModify,
      flagMerged: e.data?.flagMerged,
    }));
}

/** @param {LoreEvt[]} events */
export function diff(events) {
  return events
    .filter((e) => e.tag === "FILE_DIFF" || e.tag === "REVISION_DIFF_FILE")
    .map((e) => e.data);
}

/**
 * Collect per-branch history entries keyed by branchId for the graph view.
 * Used in parallel with branchList to build branches + per-branch histories.
 * @param {string} branchId the branch to collect for
 * @param {LoreEvt[]} events from revisionHistory for that branch
 * @returns {object[]} revision entries for that branch
 */
export function graphHistory(events) {
  return history(events);
}

/** Repositories a server hosts, from `repositoryList`. @param {LoreEvt[]} events */
export function remoteRepos(events) {
  return events
    .filter((e) => e.tag === "REPOSITORY_LIST_ENTRY")
    .map((e) => ({ id: e.data?.id, name: e.data?.name }));
}

/**
 * The repository id a name resolves to on the server, from `repositoryInfo`.
 * @param {LoreEvt[]} events
 * @returns {string|null} the bound id, or null if no REPOSITORY_DATA event arrived
 */
export function repositoryInfo(events) {
  const e = events.find((ev) => ev.tag === "REPOSITORY_DATA");
  return e?.data?.id ?? null;
}

/** Collect repository metadata key/values from `repositoryMetadataGet`. @param {LoreEvt[]} events */
export function metadata(events) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const e of events) {
    if (e.tag === "METADATA" && e.data?.key != null) out[e.data.key] = metaValue(e.data.value);
  }
  return out;
}

/**
 * Split a repository `name` metadata value into its organization prefix and bare
 * repository name. Lore encodes the org as an `org/repo` prefix on the name (it
 * comes from the path of the create/clone URL); everything before the first slash
 * is the organization, the remainder is the repository name.
 * @param {string|undefined} name
 * @returns {{ organization: string, repoName: string, name: string }}
 */
export function splitOrg(name) {
  const full = typeof name === "string" ? name : "";
  const slash = full.indexOf("/");
  if (slash === -1) return { organization: "", repoName: full, name: full };
  return { organization: full.slice(0, slash), repoName: full.slice(slash + 1), name: full };
}

/** Branch/revision summary used to enrich the repo list. @param {LoreEvt[]} events */
export function repoSummary(events) {
  for (const e of events) {
    if (e.tag === "REPOSITORY_STATUS_REVISION") {
      return {
        branch: e.data?.branchName,
        revision: e.data?.revision,
        repository: e.data?.repository,
      };
    }
  }
  return {};
}
