#!/usr/bin/env node
// Audit (and optionally repair) content a Lore server is missing for a revision.
//
// Why this exists: when the server loses a content blob, `lore push` cannot fix
// it. Push asks the server which fragments it needs *for the new delta*; the
// server answers "none" because the delta's own fragments really are present,
// and then the branch update is rejected because validating the whole tree
// trips over an OLDER missing blob. The client is never asked to upload the
// thing that is actually missing, so retrying — or `--force` — changes nothing.
//
// This walks a revision's tree, asks the server about every content address it
// references, and reports exactly which are absent. With --repair it uploads
// the missing ones from this machine's local store. Repair is purely additive
// (storagePut with remoteWrite, no obliterate), so it is safe where the server
// genuinely lacks the content. Run it on a machine that still has the data,
// which usually means the machine that committed it.
//
// A metadata-only probe is NOT sufficient, and an earlier version of this script
// gave two false "nothing to repair" verdicts because of it. A large file is
// stored as a FRAGMENTED payload: the address in the tree points at a small
// reference list, and the real bytes live in separate chunk fragments addressed
// by (same context, different hash). The server can hold the reference list
// while a chunk is gone — measured on a real 1.2 MB asset: getMetadata on the
// parent succeeded with flags=262145 (PayloadFragmented|PayloadStoredDurable)
// and sizePayload=520 vs sizeContent=1257908, yet reading it failed with
// `Address not found` on the chunk hash. So fragmented entries get a deep
// (assembling) read instead, which is the only probe here that touches chunks.
//
// Usage:
//   node scripts/remote-content-audit.mjs --repo <path> --revision <hash|branch> [--repair] [--verbose]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collect, configureSdk, shutdownSdk } from "../server/sdk.mjs";

const ZERO_CONTEXT = "0".repeat(32);
/** Directory node kind as reported by REVISION_TREE_CHILD.kind (files are 1). */
const KIND_DIRECTORY = 0;
/** `FragmentFlags::PayloadFragmented` — lore-base/src/types/fragment_flags.rs:11.
 * Set when the payload is a list of chunk fragments rather than the content. */
const PAYLOAD_FRAGMENTED = 0x1;

/**
 * Hex string to the `{ data }` struct the native layer expects for a bare
 * LoreHash field.
 *
 * Needed because the SDK does not convert those: `revisionTreeLoad` declares
 * `loreHash: ["revisionHash"]`, but the outbound converter
 * (`convertToLoreDatatype` in @lore-vcs/sdk/dist/native/index.js) handles
 * lorePartition / loreContext / loreAddress and has no `loreHash` branch — only
 * the *inbound* `convertFromLoreDatatype` does. So passing the documented hex
 * string reaches koffi unconverted and throws "Unexpected String value,
 * expected object". Partition/address fields do get converted, hence hex
 * strings are correct for those.
 */
function toHashStruct(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return { data: bytes };
}
/** Addresses per storageGetMetadata call. */
const PROBE_BATCH = 64;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/remote-content-audit.mjs --repo <path> --revision <hash|branch> [--repair] [--verbose]");
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const out = { repair: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repair") out.repair = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--help" || a === "-h") usage();
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--revision") out.revision = argv[++i];
    else usage(`unknown argument: ${a}`);
  }
  if (!out.repo) usage("--repo is required");
  if (!out.revision) usage("--revision is required");
  out.repo = out.repo.replace(/\\/g, "/");
  return out;
}

/** The remote_url recorded in a repo's .lore config. */
function readRepoRemote(repoPath) {
  for (const name of ["config.toml", "config"]) {
    const cfg = join(repoPath, ".lore", name);
    if (!existsSync(cfg)) continue;
    const m = readFileSync(cfg, "utf8").match(/^\s*remote_url\s*=\s*"([^"]+)"/m);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Resolve a revision argument that may be a branch name into a revision hash. */
async function resolveRevision(repoPath, revision) {
  if (/^[0-9a-f]{64}$/i.test(revision)) return revision;
  const events = await collect("branchList", { repositoryPath: repoPath }, { archived: false });
  const heads = events
    .filter((e) => e.data && e.data.name === revision && e.data.latest && !/^0+$/.test(e.data.latest))
    .map((e) => e.data.latest);
  if (heads.length === 0) {
    throw new Error(`could not resolve a revision for "${revision}" — pass an explicit 64-hex revision hash`);
  }
  return heads[0];
}

/**
 * Open a storage handle.
 *
 * Three shapes are used here, and the difference matters:
 * - `{repoPath, remoteUrl}` — local store first, then the server. For the tree
 *   walk (so missing node blocks can still be fetched) and for uploading.
 * - `{repoPath}` — local only. Answers "does THIS machine have it".
 * - `{inMemory, remoteUrl}` — **remote only**. An in-memory store holds no
 *   content, so a hit can only have come from the server.
 *
 * That last one is the whole reason this script works. A repo-backed handle
 * answers from the local store first, so on the machine that still has the data
 * every address looks present and nothing is ever reported missing. Verified:
 * a blob put with `remoteWrite: false` reads back fine on a repo-backed handle
 * and is correctly absent on an in-memory one. The `remote: true` global arg is
 * NOT sufficient for this — the local store still answers.
 */
async function openStore({ repoPath, remoteUrl, inMemory }) {
  const args = inMemory ? { inMemory: true } : { repositoryPath: repoPath };
  if (remoteUrl) {
    args.hasRemoteConfig = true;
    args.remoteConfig = { remoteUrl };
  }
  const events = await collect("storageOpen", {}, args);
  const opened = events.find((e) => e.tag === "STORAGE_OPENED");
  if (!opened) throw new Error("storageOpen returned no handle");
  return { handleId: opened.data.handleId };
}

/**
 * Walk a revision's tree and collect every file node's content address.
 * Directories are recursed into rather than collected — file content is what a
 * checkout actually has to read.
 */
async function collectAddresses(handle, partition, revisionHash, verbose) {
  const loaded = await collect("revisionTreeLoad", {}, {
    store: handle,
    repository: partition,
    revisionHash: toHashStruct(revisionHash),
  });
  const ev = loaded.find((e) => e.tag === "REVISION_TREE_LOADED");
  if (!ev) throw new Error("revisionTreeLoad returned no handle");
  const tree = { ...ev.data };

  const files = [];
  // Iterative so a deep tree cannot blow the stack.
  const queue = [{ nodeId: ev.data.rootNodeId ?? 0, path: "" }];
  let dirs = 0;
  while (queue.length > 0) {
    const { nodeId, path } = queue.shift();
    dirs++;
    const children = await collect("revisionTreeListChildren", {}, { id: 0, handle: tree, parentNodeId: nodeId });
    for (const c of children) {
      if (c.tag !== "REVISION_TREE_CHILD") continue;
      const childPath = path ? `${path}/${c.data.name}` : c.data.name;
      if (c.data.kind === KIND_DIRECTORY) {
        queue.push({ nodeId: c.data.nodeId, path: childPath });
        continue;
      }
      const address = c.data.address || {};
      // Empty files have no content blob that could be missing.
      if (!address.hash || /^0+$/.test(address.hash) || !c.data.size) continue;
      files.push({ path: childPath, hash: address.hash, context: address.context ?? ZERO_CONTEXT, size: c.data.size });
    }
    if (verbose && dirs % 50 === 0) console.error(`  … ${dirs} directories, ${files.length} files so far`);
  }
  await collect("revisionTreeClose", {}, { handle: tree }).catch(() => {});
  return { files, dirs };
}

/**
 * Probe addresses against a handle and return those it could not find.
 * storageGetMetadata transfers no payload, so this stays cheap on a big tree.
 * A batch call throws if any item fails, so a failing batch is re-probed one
 * at a time — otherwise a single miss would mark its whole batch missing.
 */
async function findMissing(handle, partition, entries, verbose) {
  /** @type {{absent: object[], chunksMissing: object[]}} */
  const result = { absent: [], chunksMissing: [] };
  for (let i = 0; i < entries.length; i += PROBE_BATCH) {
    const batch = entries.slice(i, i + PROBE_BATCH);
    /** id → {errorCode, flags} */
    const seen = new Map();
    const items = batch.map((e, id) => ({ id, partition, address: { hash: e.hash, context: e.context } }));
    const record = (id, e) => seen.set(id, { errorCode: e.errorCode, flags: e.fragment?.flags ?? 0 });
    try {
      const events = await collect("storageGetMetadata", {}, { handle, items });
      for (const e of events) {
        if (e.tag === "STORAGE_GET_METADATA_ITEM_COMPLETE") record(e.data.id, e.data);
      }
    } catch {
      // A batch throws if any item fails, so re-probe individually rather than
      // condemning the whole batch.
      for (let id = 0; id < items.length; id++) {
        try {
          const events = await collect("storageGetMetadata", {}, { handle, items: [{ ...items[id], id: 0 }] });
          const c = events.find((e) => e.tag === "STORAGE_GET_METADATA_ITEM_COMPLETE");
          if (c) record(id, c.data);
        } catch {
          // leave unset → treated as absent below
        }
      }
    }

    for (let id = 0; id < batch.length; id++) {
      const info = seen.get(id);
      if (!info || info.errorCode !== 0) {
        result.absent.push(batch[id]);
      } else if (info.flags & PAYLOAD_FRAGMENTED) {
        // Reference list is present, but that says nothing about the chunks —
        // deep-check below. Cheap for the common case: only large (chunked)
        // files land here.
        batch[id].needsDeepCheck = true;
      }
    }
    if (verbose) console.error(`  … probed ${Math.min(i + PROBE_BATCH, entries.length)}/${entries.length}`);
  }

  const deep = entries.filter((e) => e.needsDeepCheck);
  if (deep.length > 0) {
    if (verbose) console.error(`  … deep-checking ${deep.length} fragmented entr${deep.length === 1 ? "y" : "ies"}`);
    for (const entry of deep) {
      delete entry.needsDeepCheck;
      try {
        // An assembling read: fails if any chunk of the reference list is gone.
        await collect("storageGet", {}, {
          handle,
          items: [{ id: 0, partition, address: { hash: entry.hash, context: entry.context }, streaming: false, localCache: false }],
        });
      } catch {
        result.chunksMissing.push(entry);
      }
    }
  }
  return result;
}

/**
 * Read a blob from the LOCAL store and upload it to the server. Additive only —
 * no obliterate, so it cannot destroy anything the server already holds.
 *
 * CAUTION — unverified for falsely-durable local entries (bytes present
 * locally, `PayloadStoredDurable` set, but the server lost them). Lore's write
 * path dedups against the local entry and may short-circuit the remote write
 * when the flag claims durability — the same trap that makes `lore push` and
 * PR #148's `push_item` silently skip such blobs, and the reason the web app's
 * forceReupload obliterates before re-putting. After repairing that case,
 * verify with a remote-only probe (this script without --repair) that the
 * server REALLY has the bytes; do not trust the put's success alone.
 * @param {object} localHandle local-only handle, so the bytes provably come from this machine
 * @param {object} remoteHandle handle with a remote, used for the upload
 */
async function repairOne(localHandle, remoteHandle, partition, entry) {
  const address = { hash: entry.hash, context: entry.context };
  const getEvents = await collect("storageGet", {}, {
    handle: localHandle,
    items: [{ id: 0, partition, address, streaming: false, localCache: true }],
  });
  const bytes = Buffer.concat(
    getEvents
      .filter((e) => e.tag === "STORAGE_GET_DATA" && e.data.id === 0)
      .sort((a, b) => a.data.offset - b.data.offset)
      .map((e) => Buffer.from(e.data.bytes))
  );
  if (bytes.length === 0) throw new Error("local store returned no bytes");

  const putEvents = await collect("storagePut", {}, {
    handle: remoteHandle,
    items: [{ id: 0, partition, context: entry.context, data: bytes, remoteWrite: true, localCache: true, fixedSizeChunk: 0 }],
  });
  const done = putEvents.find((e) => e.tag === "STORAGE_PUT_ITEM_COMPLETE");
  if (!done || done.data.errorCode !== 0) throw new Error(`storagePut errorCode=${done?.data.errorCode ?? "none"}`);
  if (done.data.address?.hash && done.data.address.hash !== entry.hash) {
    throw new Error(`hash mismatch after put (got ${done.data.address.hash})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(opts.repo, ".lore"))) usage(`${opts.repo} is not a Lore working copy`);
  configureSdk();

  const remoteUrl = readRepoRemote(opts.repo);
  if (!remoteUrl) throw new Error("repository has no remote_url configured");
  console.log(`repo:     ${opts.repo}`);
  console.log(`remote:   ${remoteUrl}`);

  const statusEvents = await collect("repositoryStatus", { repositoryPath: opts.repo }, { staged: false });
  const partition = statusEvents.find((e) => e.data && e.data.repository)?.data?.repository;
  if (!partition) throw new Error("could not resolve the repository id");
  const revisionHash = await resolveRevision(opts.repo, opts.revision);
  const label = /^[0-9a-f]{64}$/i.test(opts.revision) ? "" : `  (${opts.revision})`;
  console.log(`revision: ${revisionHash}${label}\n`);

  const repoStore = await openStore({ repoPath: opts.repo, remoteUrl });
  let files, dirs;
  try {
    ({ files, dirs } = await collectAddresses(repoStore, partition, revisionHash, opts.verbose));
  } catch (err) {
    console.error(`\nCannot walk this revision's tree: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "That usually means a STRUCTURAL blob (a node block — a zero-context address) is itself\n" +
        "missing, so the tree cannot be enumerated from this machine. Run this on a machine that\n" +
        "still holds the branch's data. If none does, the structural loss is unrecoverable and the\n" +
        "branch cannot be checked out anywhere."
    );
    await collect("storageClose", {}, { handle: repoStore }).catch(() => {});
    process.exitCode = 1;
    return;
  }
  console.log(`walked ${dirs} directories, ${files.length} file(s) with content`);

  // Remote-ONLY probe via an in-memory store (see openStore) — a repo-backed
  // handle would answer from the local copy and report nothing missing.
  const remoteProbe = await openStore({ inMemory: true, remoteUrl });
  const remote = await findMissing(remoteProbe, partition, files, opts.verbose);
  const missingRemote = [...remote.absent, ...remote.chunksMissing];
  if (missingRemote.length === 0) {
    console.log("\nThe server has every content blob this revision references. Nothing to repair.");
    await collect("storageClose", {}, { handle: remoteProbe }).catch(() => {});
    await collect("storageClose", {}, { handle: repoStore }).catch(() => {});
    return;
  }

  if (remote.absent.length > 0) {
    console.log(`\n${remote.absent.length} address(es) MISSING from the server:`);
    for (const e of remote.absent) console.log(`  ${e.hash}-${e.context}  ${e.size} B  ${e.path}`);
  }
  if (remote.chunksMissing.length > 0) {
    // The dangerous category: every cheap check calls these healthy.
    console.log(`\n${remote.chunksMissing.length} address(es) present on the server but UNREADABLE — reference list is there, data chunks are not:`);
    for (const e of remote.chunksMissing) console.log(`  ${e.hash}-${e.context}  ${e.size} B  ${e.path}`);
    console.log("These look fine to a metadata query and to `verify fragment` on the parent address,");
    console.log("but any read of them fails. Re-uploading the file's content is what fixes them.");
  }

  const localStore = await openStore({ repoPath: opts.repo });
  const local = await findMissing(localStore, partition, missingRemote, opts.verbose);
  const absentLocally = [...local.absent, ...local.chunksMissing];
  const absentKeys = new Set(absentLocally.map((e) => `${e.hash}-${e.context}`));
  const repairable = missingRemote.filter((e) => !absentKeys.has(`${e.hash}-${e.context}`));

  console.log(`\nthis machine can supply ${repairable.length} of ${missingRemote.length}`);
  if (absentLocally.length > 0) {
    console.log(`${absentLocally.length} missing from BOTH this machine and the server:`);
    for (const e of absentLocally) console.log(`  ${e.hash}-${e.context}  ${e.path}`);
    console.log("Those must come from another machine that still has them.");
  }

  if (!opts.repair) {
    console.log("\nRe-run with --repair to upload what this machine can supply.");
  } else if (repairable.length === 0) {
    console.log("\nNothing to upload from this machine.");
  } else {
    console.log(`\nUploading ${repairable.length} blob(s)…`);
    let ok = 0;
    for (const e of repairable) {
      try {
        await repairOne(localStore, repoStore, partition, e);
        ok++;
        console.log(`  pushed ${e.hash}-${e.context}  ${e.path}`);
      } catch (err) {
        console.error(`  FAILED ${e.hash}-${e.context}  ${e.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`\nuploaded ${ok}/${repairable.length}. Re-run without --repair to confirm, then retry the push or branch switch.`);
  }

  await collect("storageClose", {}, { handle: localStore }).catch(() => {});
  await collect("storageClose", {}, { handle: remoteProbe }).catch(() => {});
  await collect("storageClose", {}, { handle: repoStore }).catch(() => {});
}

main()
  .catch((err) => {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    shutdownSdk();
    // Abandoned native calls keep threadpool workers alive; don't hang on exit.
    process.exit(process.exitCode ?? 0);
  });
