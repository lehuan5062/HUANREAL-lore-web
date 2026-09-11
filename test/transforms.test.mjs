// Transform unit tests. Pure functions over synthetic event arrays — no SDK, no
// repository, no filesystem. Event shapes mirror what sdk.collect() yields.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as xform from "../server/transforms.mjs";

const ev = (tag, data) => ({ tag, tagRaw: 0, data });

test("history groups metadata under each revision entry", () => {
  const events = [
    ev("REVISION_HISTORY_ENTRY", { revision: "abc", revisionNumber: 2, parent: ["x"] }),
    ev("METADATA", { key: "message", value: { tag: 6, data: "second", tagName: "string" } }),
    ev("METADATA", { key: "timestamp", value: { tag: 5, data: 1700, tagName: "numeric" } }),
    ev("REVISION_HISTORY_ENTRY", { revision: "def", revisionNumber: 1, parent: [] }),
    ev("METADATA", { key: "message", value: { tag: 6, data: "first", tagName: "string" } }),
    ev("COMPLETE", { status: 0 }),
  ];
  const revs = xform.history(events);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].message, "second");
  assert.equal(revs[0].timestamp, 1700);
  assert.equal(revs[1].message, "first");
  assert.equal(revs[1].timestamp, undefined);
});

test("metadata collects key/value pairs, unwrapping Lore metadata values", () => {
  const events = [
    ev("METADATA", { key: "name", value: { tag: 6, data: "acme/widgets", tagName: "string" } }),
    ev("METADATA", { key: "description", value: "plain" }),
    ev("COMPLETE", { status: 0 }),
  ];
  const meta = xform.metadata(events);
  assert.equal(meta.name, "acme/widgets");
  assert.equal(meta.description, "plain");
});

test("splitOrg separates the org prefix from the repository name", () => {
  assert.deepEqual(xform.splitOrg("acme/widgets"), {
    organization: "acme",
    repoName: "widgets",
    name: "acme/widgets",
  });
});

test("splitOrg treats a name with no slash as having no organization", () => {
  assert.deepEqual(xform.splitOrg("lore-web"), {
    organization: "",
    repoName: "lore-web",
    name: "lore-web",
  });
});

test("splitOrg keeps only the first slash as the org separator", () => {
  const out = xform.splitOrg("org/team/repo");
  assert.equal(out.organization, "org");
  assert.equal(out.repoName, "team/repo");
});

test("splitOrg tolerates a missing name", () => {
  assert.deepEqual(xform.splitOrg(undefined), { organization: "", repoName: "", name: "" });
});

test("status splits branch summary from changed files", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", { branchName: "main", revision: "r1" }),
    ev("REPOSITORY_STATUS_FILE", { path: "a.txt", flagStaged: true }),
    ev("REPOSITORY_STATUS_FILE", { path: "b.txt", flagStaged: false }),
    ev("COMPLETE", { status: 0 }),
  ];
  const s = xform.status(events);
  assert.equal(s.branch, "main");
  assert.equal(s.revision, "r1");
  assert.equal(s.files.length, 2);
});

test("branches keeps only BRANCH_LIST_ENTRY events", () => {
  const events = [
    ev("BRANCH_LIST_BEGIN", {}),
    ev("BRANCH_LIST_ENTRY", { name: "main" }),
    ev("BRANCH_LIST_END", {}),
  ];
  const result = xform.branches(events);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "main");
});

test("branches returns full stable shape", () => {
  const events = [
    ev("BRANCH_LIST_ENTRY", {
      id: "bid-1",
      location: 0,
      name: "main",
      category: "default",
      latest: "abc123",
      stack: [],
      creator: "user1",
      created: 1234567890,
      isCurrent: true,
      archived: false,
    }),
  ];
  const result = xform.branches(events);
  assert.equal(result[0].id, "bid-1");
  assert.equal(result[0].location, 0);
  assert.equal(result[0].latest, "abc123");
  assert.deepEqual(result[0].stack, []);
  assert.equal(result[0].isCurrent, true);
  assert.equal(result[0].archived, false);
});

test("branchInfo flags behindRemote when the local latest trails the remote", () => {
  const events = [ev("BRANCH_INFO", { id: "b1", name: "main", latest: "aaa111", latestRemote: "bbb222" })];
  const info = xform.branchInfo(events);
  assert.equal(info.latest, "aaa111");
  assert.equal(info.latestRemote, "bbb222");
  assert.equal(info.behindRemote, true);
});

test("branchInfo reports in-sync when local and remote latest match", () => {
  const events = [ev("BRANCH_INFO", { id: "b1", name: "main", latest: "aaa111", latestRemote: "aaa111" })];
  assert.equal(xform.branchInfo(events).behindRemote, false);
});

test("branchInfo does not call an unpushed branch behind (zero-hash remote)", () => {
  const zero = "0".repeat(64);
  const events = [ev("BRANCH_INFO", { id: "b1", name: "feature", latest: "aaa111", latestRemote: zero })];
  assert.equal(xform.branchInfo(events).behindRemote, false);
});

test("branchInfo returns null when no BRANCH_INFO event is present", () => {
  assert.equal(xform.branchInfo([ev("COMPLETE", { status: 0 })]), null);
});

test("status includes merge-related fields", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "def456",
      revisionStaged: "stg789",
    }),
  ];
  const s = xform.status(events);
  assert.equal(s.revisionMerged, "def456");
  assert.equal(s.revisionStaged, "stg789");
});

test("status returns inMerge false when HEAD is a merge commit (revisionMerged non-zero but no staged anchor)", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "nonzerodef456",
      revisionStaged: undefined, // No staged anchor
    }),
  ];
  const s = xform.status(events);
  assert.equal(s.inMerge, false);
  assert.equal(s.revisionMerged, "nonzerodef456"); // Field still returned for debugging
});

test("status returns inMerge false when staged state equals current revision (no actual changes staged)", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "nonzerodef456",
      revisionStaged: "abc123", // Same as revision = no staged state
    }),
  ];
  const s = xform.status(events);
  assert.equal(s.inMerge, false);
});

test("status detects inMerge when staged anchor differs from revision and revisionMerged is non-zero", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "nonzerodef456",
      revisionStaged: "staged789", // Different from revision
    }),
  ];
  const s = xform.status(events);
  assert.equal(s.inMerge, true);
});

test("status returns inMerge false for plain staged changes (revisionStaged differs but no merge in progress)", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "", // No merge
      revisionStaged: "staged789", // Staged changes but no merge
    }),
  ];
  const s = xform.status(events);
  assert.equal(s.inMerge, false);
});

test("status treats empty string as not inMerge", () => {
  const s = xform.status([
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "",
    }),
  ]);
  assert.equal(s.inMerge, false);
});

test("status treats 64-char all-zeros hash as not inMerge", () => {
  const s = xform.status([
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "0000000000000000000000000000000000000000000000000000000000000000",
    }),
  ]);
  assert.equal(s.inMerge, false);
});

test("status counts unresolved conflicts", () => {
  const events = [
    ev("REPOSITORY_STATUS_REVISION", {
      branchName: "main",
      revision: "abc123",
      revisionMerged: "",
    }),
    ev("REPOSITORY_STATUS_FILE", { path: "a.txt", flagConflictUnresolved: true }),
    ev("REPOSITORY_STATUS_FILE", { path: "b.txt", flagConflictUnresolved: true }),
    ev("REPOSITORY_STATUS_FILE", { path: "c.txt", flagConflictUnresolved: false }),
  ];
  const s = xform.status(events);
  assert.equal(s.conflicts, 2);
});

test("remoteRepos keeps only REPOSITORY_LIST_ENTRY events", () => {
  const events = [
    ev("REPOSITORY_LIST_BEGIN", {}),
    ev("REPOSITORY_LIST_ENTRY", { id: "abc", name: "ui-demo" }),
    ev("REPOSITORY_LIST_ENTRY", { id: "def", name: "scratch" }),
    ev("REPOSITORY_LIST_END", {}),
  ];
  assert.deepEqual(xform.remoteRepos(events), [
    { id: "abc", name: "ui-demo" },
    { id: "def", name: "scratch" },
  ]);
});
