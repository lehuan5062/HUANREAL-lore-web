// Fallback to the installed `lore` CLI for the few things better handled by a
// real process than the in-process SDK. The SDK is still the primary engine;
// this is the hybrid escape hatch. Two distinct reasons to be here:
//
//  1. Things the SDK cannot do at all — interactive browser login, the service
//     lifecycle. Those use `runCli` and treat the result as status + text.
//  2. Calls that can HANG. The SDK has no cancellation (see LORE_BUG_PROMPTS.md
//     P5 BUG 1), so every abandoned call permanently occupies a koffi/libuv
//     threadpool worker for the life of the process — damage that accumulates
//     until lore-web is restarted (sdk.mjs counts it as `abandonedCallCount`).
//     A hung subprocess, by contrast, is just killed. `runCliJson` exists for
//     that case and always runs under a timeout.
//
// The CLI *does* have machine-readable output: a hidden global `--json` / `-j`
// (lore-client/src/cli/cli.rs, `hide = true`) serializes the same event objects
// the SDK yields, as NDJSON. Being hidden, it carries no stability contract —
// see P12, which asks Epic to document it.

import { spawn } from "node:child_process";
import { log } from "./log.mjs";

const LORE_BIN = process.env.LORE_CLI ?? "lore";

/**
 * Run a `lore` subcommand to completion, capturing its output.
 * @param {string[]} args CLI arguments, such as ["auth", "list"]
 * @param {{ repoPath?: string, timeoutMs?: number, cwd?: string }} [opts] `timeoutMs`
 *   kills the process and resolves rather than hanging forever; `cwd` overrides the
 *   inherited working directory (use this for commands that must never resolve an
 *   ambient working copy from the server process's own cwd, such as a remote delete).
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runCli(args, opts = {}) {
  const full = opts.repoPath ? ["--repository", opts.repoPath, ...args] : args;
  return new Promise((resolve) => {
    const child = spawn(LORE_BIN, full, { windowsHide: true, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill();
          log.warn("lore cli timed out", { args: full, timeoutMs: opts.timeoutMs });
          resolve({ code: -1, stdout, stderr: stderr || `timed out after ${opts.timeoutMs}ms` });
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      log.warn("lore cli spawn failed", { error: err.message });
      resolve({ code: -1, stdout, stderr: String(err.message) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      log.debug("lore cli finished", { args: full, code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) });
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** camelCase event name from `--json` → the SCREAMING_SNAKE `tag` the SDK emits
 *  and `transforms.mjs` filters on (`branchListEntry` → `BRANCH_LIST_ENTRY`). */
function tagFromName(tagName) {
  return String(tagName)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

/**
 * Enum fields the CLI renders as strings but the SDK (and therefore our
 * consumers) express as numbers. `LoreBranchLocation` is `LOCAL=0, REMOTE=1`,
 * and web/app.js compares `b.location === 0` / `=== 1` strictly — so leaving
 * `"remote"` through would quietly empty the local-only/remote-only branch
 * badges instead of failing, which is far worse than an error.
 */
const ENUM_FIELDS = {
  location: { local: 0, remote: 1 },
};

function normalizeEnums(data) {
  if (!data || typeof data !== "object") return data;
  for (const [field, mapping] of Object.entries(ENUM_FIELDS)) {
    const value = data[field];
    if (typeof value === "string" && value.toLowerCase() in mapping) {
      data[field] = mapping[value.toLowerCase()];
    }
  }
  return data;
}

/**
 * Run a `lore` subcommand with machine-readable output and return its events in
 * the same shape `collect()` produces, so `transforms.mjs` consumes either
 * engine unchanged.
 *
 * Always bounded by a timeout: killing a hung process is the whole reason a
 * caller chooses this over the SDK (see the header note about leaked workers).
 * @param {string[]} args CLI arguments, e.g. ["branch", "list", "--remote"]
 * @param {{ repoPath?: string, timeoutMs?: number, cwd?: string }} [opts]
 * @returns {Promise<import("./errors.mjs").LoreEvt[]>}
 * @throws {Error} on spawn failure, timeout, non-zero exit, or a non-zero
 *   `complete.error.errorCode`, so callers keep the SDK's failure contract.
 */
export async function runCliJson(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const { code, stdout, stderr } = await runCli(["--json", "--no-pager", ...args], { ...opts, timeoutMs });

  /** @type {import("./errors.mjs").LoreEvt[]} */
  const events = [];
  let completeError = null;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text || text[0] !== "{") continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // Not an event line; ignore rather than fail the whole call.
    }
    if (!parsed.tagName) continue;
    const tag = tagFromName(parsed.tagName);
    const data = normalizeEnums(parsed.data ?? {});
    if (tag === "COMPLETE" && data.error && data.error.errorCode) completeError = data.error;
    events.push({ tag, tagRaw: -1, data });
  }

  if (code !== 0 || completeError) {
    const detail = completeError?.message || stderr.trim() || `exit code ${code}`;
    throw new Error(`lore ${args.join(" ")} failed: ${detail}`);
  }
  return events;
}

/**
 * Report whether the CLI has any stored identity — whether the user has logged in.
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn() {
  const { code, stdout } = await runCli(["auth", "list", "--no-pager"]);
  return code === 0 && /\S/.test(stdout) && !/no identities/i.test(stdout);
}
