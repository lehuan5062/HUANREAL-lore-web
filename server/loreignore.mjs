// .loreignore management. Lore reads ignore rules from a gitignore-style
// .loreignore at the working-copy root (see lore-revision repository::load_filter).
// These helpers seed and extend it from the UI without the user hand-editing files.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOREIGNORE = ".loreignore";
const GITIGNORE = ".gitignore";
const P4IGNORE = ".p4ignore";

// Other VCS metadata is meaningless to Lore, so a fresh .loreignore always
// excludes it. The ignore files are listed too: when coexisting with other VCS
// tools they are their files, not something Lore should version.
const LORE_IGNORES = [".git/", ".gitignore", ".p4/", ".p4ignore"];
// Conversely, once Lore manages the working copy its metadata should stay out of
// other VCS tools, so their ignore files gain the Lore counterparts.
const VCS_IGNORES = [".lore/", ".loreignore"];

const splitLines = (text) => text.split(/\r?\n/);

/** Compare ignore entries ignoring trailing slashes and surrounding space. */
function sameEntry(a, b) {
  const norm = (s) => s.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Convert a Perforce .p4ignore pattern to gitignore format. Perforce uses `...`
 * to mean "everything recursively"; gitignore interprets trailing `/` as recursive.
 * Examples: `Intermediate/...` → `Intermediate/`, `*.log` → `*.log` (unchanged).
 * @param {string} pattern the Perforce pattern
 * @returns {string} the converted gitignore pattern
 */
function convertP4PatternToGitignore(pattern) {
  // Strip leading/trailing whitespace and skip comments/empty lines.
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  // Replace Perforce's recursive `...` suffix with gitignore's `/` (or remove it if already has `/`).
  return trimmed.endsWith("/...") ? trimmed.slice(0, -3) : trimmed.endsWith("...") ? trimmed.slice(0, -3) + "/" : trimmed;
}

/**
 * Append the entries not already present to an ignore file, creating it if
 * needed. A header comment is written above the first batch actually added.
 * @returns {string[]} the entries that were newly written (empty if no change)
 */
function appendEntries(filePath, header, entries) {
  let text = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = splitLines(text);
  const missing = entries.filter((e) => !lines.some((l) => sameEntry(l, e)));
  if (missing.length === 0) return [];
  let out = text;
  if (out && !out.endsWith("\n")) out += "\n";
  if (header) out += `${out ? "\n" : ""}${header}\n`;
  out += missing.join("\n") + "\n";
  writeFileSync(filePath, out);
  return missing;
}

/**
 * Append entries to an ignore file, tolerating the read-only state Perforce
 * leaves a file in on disk until `p4 edit` checks it out. A permission
 * failure is reported rather than thrown, so callers can treat it as "skip
 * this one" instead of aborting whatever larger operation they're part of.
 * Used both for foreign ignore files (.gitignore, .p4ignore) and for
 * .loreignore itself, since .loreignore can be checked into another VCS too
 * (in which case it's just as read-only-until-checked-out as anything else).
 * @param {string} filePath the ignore file (must already exist)
 * @param {string|null} header comment written above the first batch actually added
 * @param {string[]} entries
 * @returns {{updated: boolean, blocked: boolean}} updated when entries were
 *   written; blocked when the file exists but is read-only / not writable
 */
function appendIgnoreTolerant(filePath, header, entries) {
  try {
    return { updated: appendEntries(filePath, header, entries).length > 0, blocked: false };
  } catch (err) {
    // Perforce keeps versioned files read-only until `p4 edit`; treat that as a
    // skip, not a failure that aborts the whole setup.
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      return { updated: false, blocked: true };
    }
    throw err;
  }
}

/**
 * Set up .loreignore for a working copy (on init, or on demand for an existing
 * repo). Seeds .loreignore from .gitignore and .p4ignore when present, ensures
 * other VCS metadata is ignored by Lore, and ensures Lore's files are ignored by
 * other VCS tools. The counterpart writes into .gitignore/.p4ignore are
 * best-effort: a read-only Perforce file is reported via *Blocked flags rather
 * than aborting the seed. Idempotent: safe to call on an already-configured repo.
 * @param {string} repoPath working-copy root
 * @returns {{created: boolean, loreignoreBlocked: boolean, gitignoreUpdated: boolean, gitignoreBlocked: boolean, p4ignoreUpdated: boolean, p4ignoreBlocked: boolean}}
 */
export function setupLoreignore(repoPath) {
  const lorePath = join(repoPath, LOREIGNORE);
  const gitPath = join(repoPath, GITIGNORE);
  const p4Path = join(repoPath, P4IGNORE);
  const gitExists = existsSync(gitPath);
  const p4Exists = existsSync(p4Path);
  const created = !existsSync(lorePath);

  // Seed a brand-new .loreignore from .gitignore and .p4ignore — the same paths
  // a user already declared uninteresting to other tools are sensible starting
  // points for Lore. Convert Perforce patterns (which use `...` for recursion)
  // to gitignore format (which use `/` or `**`).
  if (created) {
    let seedContent = "";
    if (gitExists) {
      seedContent += readFileSync(gitPath, "utf8");
    }
    if (p4Exists) {
      const p4Content = readFileSync(p4Path, "utf8");
      // Avoid duplicating entries if both files exist
      const existingLines = seedContent.split(/\r?\n/);
      const p4Lines = p4Content.split(/\r?\n/).map(convertP4PatternToGitignore);
      const newLines = p4Lines.filter(
        (line) => !existingLines.some((existingLine) => sameEntry(line, existingLine))
      );
      if (newLines.length > 0) {
        if (seedContent && !seedContent.endsWith("\n")) seedContent += "\n";
        seedContent += newLines.join("\n");
      }
    }
    if (seedContent) {
      writeFileSync(lorePath, seedContent);
    }
  }

  // .loreignore can itself be checked into another VCS (e.g. Perforce) and
  // therefore just as read-only-until-checked-out as .gitignore/.p4ignore --
  // a blocked write here must not abort the rest of setup (created is still
  // true, the foreign-file seeding below still runs).
  const own = appendIgnoreTolerant(lorePath, "# Other VCS files (managed by Git/Perforce, not Lore)", LORE_IGNORES);

  const git = gitExists ? appendIgnoreTolerant(gitPath, "# Lore files", VCS_IGNORES) : { updated: false, blocked: false };
  const p4 = p4Exists ? appendIgnoreTolerant(p4Path, "# Lore files", VCS_IGNORES) : { updated: false, blocked: false };

  return {
    created,
    loreignoreBlocked: own.blocked,
    gitignoreUpdated: git.updated,
    gitignoreBlocked: git.blocked,
    p4ignoreUpdated: p4.updated,
    p4ignoreBlocked: p4.blocked,
  };
}

/**
 * Append a single gitignore-style pattern (a file, folder, or *.ext glob) to
 * .loreignore, creating the file if it does not exist yet. No-op if already
 * present. Tolerates .loreignore being read-only (e.g. checked into Perforce
 * and not checked out) — see appendIgnoreTolerant.
 * @returns {{added: boolean, blocked: boolean}} added when the pattern was
 *   newly written; blocked when .loreignore exists but isn't writable
 */
export function appendIgnorePattern(repoPath, pattern) {
  const result = appendIgnoreTolerant(join(repoPath, LOREIGNORE), null, [pattern]);
  return { added: result.updated, blocked: result.blocked };
}

/** Whether the working copy already has a .loreignore file. */
export function hasLoreignore(repoPath) {
  return existsSync(join(repoPath, LOREIGNORE));
}

/** Whether the working copy has a .gitignore file. */
export function hasGitignore(repoPath) {
  return existsSync(join(repoPath, GITIGNORE));
}

/** Whether the working copy has a .p4ignore file. */
export function hasP4ignore(repoPath) {
  return existsSync(join(repoPath, P4IGNORE));
}
