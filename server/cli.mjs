// Fallback to the installed `lore` CLI for the few things better handled by the
// real process than the in-process SDK: interactive browser login and the
// service lifecycle. The SDK is the primary engine; this is the hybrid escape
// hatch. The CLI emits no machine-readable output, so callers treat results as
// status + text, not structured data.

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

/**
 * Report whether the CLI has any stored identity — whether the user has logged in.
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn() {
  const { code, stdout } = await runCli(["auth", "list", "--no-pager"]);
  return code === 0 && /\S/.test(stdout) && !/no identities/i.test(stdout);
}
