#!/usr/bin/env node
// Check whether the upstream fixes we are working around have landed yet.
//
// This app is a deliberate CLI/SDK hybrid: a couple of calls shell out to the
// `lore` CLI because of known SDK defects, and those shims are meant to be
// TEMPORARY. Without something to check them against, "we'll go back to the SDK
// once it's fixed" quietly becomes permanent. Run this occasionally; it reports
// what's new upstream and prints the revert checklist.
//
// Read-only and dependency-free. Network failures degrade to a warning rather
// than a non-zero exit, so this is safe to run offline.
//
// Usage: node scripts/check-lore-updates.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Last lore-js commit reviewed while writing the shims. If the repo's newest
 * commit differs, someone should read the diff and re-check the P5 bugs. */
const LAST_REVIEWED_LORE_JS_COMMIT_DATE = "2026-07-23";
/** Lore release the workarounds were verified against. */
const VERIFIED_AGAINST_LORE_RELEASE = "v0.8.6";

/** Each CLI shim, and what has to land upstream before it can be removed. */
const REVERT_CHECKLIST = [
  {
    what: "server/index.mjs fetchBranchesOnline → `lore --json branch list`",
    blockedBy: "P5 BUG 1 — @lore-vcs/sdk has no call cancellation, so an abandoned call leaks a koffi/libuv threadpool worker permanently",
    revertWhen: "the SDK exposes an abort/cancellation API (e.g. an AbortSignal option)",
  },
  {
    what: "server/index.mjs listRemoteRepos → `lore --json repository list <url>`",
    blockedBy: "P5 BUG 1 — same cancellation gap on a remote-touching call",
    revertWhen: "the SDK exposes an abort/cancellation API",
  },
  {
    what: "scripts/remote-content-audit.mjs toHashStruct() manual hex→{data} conversion",
    blockedBy: "P5 BUG 3 — the outbound converter has no `loreHash` branch, so documented hex strings throw at the FFI boundary",
    revertWhen: "convertToLoreDatatype handles loreHash (then pass the plain hex string again)",
  },
  {
    what: "web/app.js regex-matching \"Address not found\" out of error text",
    blockedBy: "P5 BUG 2 — streamed terminal events carry no typed error code",
    revertWhen: "streamed DONE/terminal events expose errorCode (note: thrown LoreError already carries returnCode/loreErrors, so this may be a small change)",
  },
];

function installedSdkVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules/@lore-vcs/sdk/package.json"), "utf8")).version;
  } catch {
    return "(not installed)";
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "lore-web-update-check", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const installed = installedSdkVersion();
  console.log(`installed @lore-vcs/sdk:      ${installed}`);

  let npmLatest = null;
  try {
    const meta = await getJson("https://registry.npmjs.org/@lore-vcs/sdk");
    npmLatest = meta["dist-tags"]?.latest ?? null;
    console.log(`npm latest:                   ${npmLatest}`);
  } catch (err) {
    console.log(`npm latest:                   unavailable (${err.message})`);
  }

  try {
    const commits = await getJson("https://api.github.com/repos/EpicGames/lore-js/commits?per_page=1");
    const c = commits?.[0];
    const date = c?.commit?.author?.date?.slice(0, 10) ?? "?";
    console.log(`lore-js newest commit:        ${date}  ${c?.commit?.message?.split("\n")[0] ?? ""}`);
    if (date > LAST_REVIEWED_LORE_JS_COMMIT_DATE) {
      console.log(`  ^ NEWER than the ${LAST_REVIEWED_LORE_JS_COMMIT_DATE} commit these workarounds were written against.`);
      console.log("    Read the diff and re-test the P5 bugs before assuming they still apply.");
    }
  } catch (err) {
    console.log(`lore-js newest commit:        unavailable (${err.message})`);
  }

  try {
    const rel = await getJson("https://api.github.com/repos/EpicGames/lore/releases/latest");
    console.log(`lore newest release:          ${rel?.tag_name ?? "?"}`);
    if (rel?.tag_name && rel.tag_name !== VERIFIED_AGAINST_LORE_RELEASE) {
      console.log(`  ^ newer than ${VERIFIED_AGAINST_LORE_RELEASE}, which the findings were verified against.`);
      console.log("    See LORE_BUG_PROMPTS.md §0 — the server and the CLI are separate upgrades.");
    }
  } catch (err) {
    console.log(`lore newest release:          unavailable (${err.message})`);
  }

  if (npmLatest && npmLatest !== installed) {
    console.log(`\nACTION: SDK ${installed} → ${npmLatest} available. Bump it, run npm test, and re-check the items below.`);
    console.log("Remember the client/server split: bumping the SDK does not upgrade loreserver or the lore CLI.");
  }

  console.log("\nRevert checklist — workarounds currently in the tree:");
  for (const item of REVERT_CHECKLIST) {
    console.log(`\n  ${item.what}`);
    console.log(`    blocked by: ${item.blockedBy}`);
    console.log(`    revert when: ${item.revertWhen}`);
  }
  console.log("\nFull write-ups: LORE_BUG_PROMPTS.md (P5 for the SDK bugs, P12 for the CLI gaps).");
}

main().catch((err) => {
  console.error(`check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
