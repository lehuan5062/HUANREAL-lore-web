// lore-web single-page UI. Vanilla ES modules, no build step. Data is cached on
// the server (per-repo status/history/branches) and invalidated automatically
// (filesystem watch + every mutating verb). Stale-while-revalidate keeps reads
// instant, and TTL bounds staleness for changes the watcher cannot see. A brief
// stale view is acceptable; the SSE refresh corrects it moments later.

import * as graph from "./graph.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  repos: [],
  active: null, // repo path
  tab: "changes",
  selectedFile: null,
  defaultRemote: "",
  discoveredServers: [],
  branches: [],
  graphSig: null,
  // Refresh generation counter. Bumped by every refreshActive(); loaders capture
  // it and discard responses from an older generation so an in-flight fetch that
  // started before a mutation (e.g. a branch switch) can never overwrite the
  // post-mutation state with pre-mutation data.
  refreshSeq: 0,
  // The base URL the Server repositories dialog last actually queried, so
  // deleting a row acts on the server shown, not whatever the input field
  // currently contains (which is blank before the first listing loads).
  serverReposBase: "",
  // Bumped on every loadServerRepos() call; the background name-conflict
  // verify started by that call captures it and checks it's still current
  // before touching the DOM, so a slow verify from a superseded load/refresh
  // can never overwrite a newer render.
  serverReposGen: 0,
  // The fast-list repos currently rendered, so the background verify can
  // merge resolvedId/nameMismatch onto them by name without re-fetching.
  serverReposList: [],
};

/** Build an Error carrying the response status and JSON body, so callers can
 * react to structured failures (e.g. the id_mismatch conflict) beyond the message. */
function apiError(res, body) {
  const err = new Error(body.error || res.statusText);
  err.status = res.status;
  err.body = body;
  return err;
}

async function apiGet(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw apiError(res, body);
  return body;
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: payload && payload._method === "DELETE" ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw apiError(res, body);
  return body;
}

/** POST and consume an NDJSON progress stream, invoking onEvent per line. */
async function apiStream(path, payload, onEvent) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function toast(msg, isErr) {
  const container = $("#toast-container");

  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");

  const text = document.createElement("span");
  text.className = "toast-msg";
  text.textContent = msg;
  el.appendChild(text);

  const dismiss = () => el.remove();

  if (isErr) {
    // Errors persist until manually dismissed.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Dismiss");
    closeBtn.onclick = dismiss;
    el.appendChild(closeBtn);
  } else {
    // Success/info toasts auto-dismiss.
    setTimeout(dismiss, 2500);
  }

  // column-reverse stacks the first DOM child at the bottom (anchor); prepending
  // keeps the newest toast closest to the anchor and pushes older ones upward.
  container.prepend(el);
}

async function loadRepos(attempt = 0) {
  try {
    if (state.repos.length === 0) {
      const ul = $("#repo-list");
      ul.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
    }
    const { repos, enriching } = await apiGet("/api/repos");
    state.repos = repos;
    // On a cold server cache, the list arrives instantly but without live
    // branch/organization data; the server enriches it in the background and
    // pushes an "enriched" SSE refresh when done, which re-triggers loadRepos.
    state.reposEnriching = !!enriching;
    renderRepos();
  } catch (err) {
    // The server binds its port before the native library finishes loading, so
    // the very first request after launch can land while it is still coming up.
    // Nothing else retries this one — the 10s poll is gated on an active repo —
    // so without a bounded retry here the skeleton rows shimmer forever.
    if (attempt < 4) {
      setTimeout(() => loadRepos(attempt + 1), 300 * 2 ** attempt);
      return;
    }
    // Out of retries: clear the skeletons so the sidebar reads honestly empty
    // rather than looking like it is still loading.
    state.repos = [];
    state.reposEnriching = false;
    renderRepos();
    toast(err.message, true);
  }
}

/** The repo row's branch slot: a shimmering placeholder while the server is still enriching, else the live branch or a "missing" flag. */
function repoBranchSlot(r) {
  if (!r.exists) return `<span class="r-missing">missing</span>`;
  if (state.reposEnriching && !r.branch) return `<span class="skeleton r-branch-skel"></span>`;
  return `<span class="r-branch">${r.branch || ""}</span>`;
}

function renderRepos() {
  const ul = $("#repo-list");
  ul.innerHTML = "";
  for (const r of state.repos) {
    const li = document.createElement("li");
    li.className = r.path === state.active ? "active" : "";
    li.innerHTML = `
      <span class="r-name" title="${r.path}">${r.label}</span>
      ${r.organization ? `<span class="r-org">${r.organization}</span>` : ""}
      ${repoBranchSlot(r)}
      <button class="r-remove" title="Remove">✕</button>`;
    // Select on a click anywhere in the row, not only the label, so the whole
    // row is one big hit target — even while enrichment is still in flight,
    // since the repo view's own data (status/history/branches) is fetched
    // independently of this sidebar summary. The remove button stops
    // propagation below.
    li.onclick = () => selectRepo(r.path);
    li.querySelector(".r-remove").onclick = (e) => {
      e.stopPropagation();
      removeRepo(r.path);
    };
    ul.appendChild(li);
  }
}

/** Pick a folder, then track it — initializing a new repo if it isn't one yet. */
async function addRepo() {
  const path = await pickFolder({ title: "Add a repository" });
  if (!path) return;
  let url;
  try {
    // Brand-new folders are initialized; let the user review/edit the URL first.
    const info = await apiGet(`/api/init-url?path=${encodeURIComponent(path)}`);
    if (!info.isRepo) {
      url = await confirmInit(path, info.url);
      if (url === null) return; // cancelled
    }
  } catch (err) {
    return toast(err.message, true);
  }
  try {
    const initialized = await runBlocking("Adding repository…", async () => {
      const res = await apiPost("/api/repos", { path, url });
      await loadRepos();
      selectRepo(path);
      return res.initialized;
    });
    toast(initialized ? "Repository initialized" : "Repository added");
  } catch (err) {
    if (err.body?.code === "id_mismatch") {
      // Hand off to the collision dialog — drop the failed overlay first so it
      // isn't left sitting behind the dialog showing a now-irrelevant error.
      $("#op-overlay").hidden = true;
      return handleIdMismatch(err.body);
    }
    toast(err.message, true);
  }
}

/**
 * The server already hosts a repository under this name with a different id
 * (the local .lore was likely deleted or the folder re-created). Offer to adopt
 * the server's identity, clone instead, or cancel.
 */
function handleIdMismatch({ path, repositoryUrl, remoteId, name }) {
  $("#adopt-text").textContent =
    `The server already has a repository named "${name}" (${repositoryUrl}). ` +
    `Adopt it to bind this folder to the existing server repository — your files become local changes. ` +
    `Or clone the server's copy into a fresh folder instead.`;
  const dlg = $("#adopt-dialog");
  $("#adopt-go").onclick = async () => {
    dlg.close(); // before the overlay: a showModal() dialog outranks any z-index
    try {
      await runBlocking(
        "Adopting server repository…",
        async () => {
          await apiPost("/api/adopt-remote-id", { path, remoteId, url: repositoryUrl });
          await loadRepos();
          selectRepo(path);
        },
        { keepOpen: true, successMessage: "Adopted the server repository's identity" },
      );
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#adopt-clone").onclick = () => {
    dlg.close();
    $("#clone-url").value = repositoryUrl;
    $("#clone-dest").value = "";
    $("#clone-dialog").showModal();
  };
  dlg.showModal();
}

/**
 * Show the generated repository URL for a soon-to-be-initialized folder in an
 * editable box. Resolves to the (possibly edited) URL, or null if cancelled.
 */
let initResolve = null;
function confirmInit(path, suggestedUrl) {
  $("#init-folder").textContent = `${path} is not a Lore repository yet — it will be created with:`;
  $("#init-url").value = suggestedUrl || "";
  $("#init-dialog").showModal();
  return new Promise((resolve) => {
    initResolve = resolve;
  });
}

function initFinish(url) {
  $("#init-dialog").close();
  const resolve = initResolve;
  initResolve = null;
  resolve?.(url);
}

function wireInit() {
  $("#init-cancel").onclick = () => initFinish(null);
  $("#init-go").onclick = () => {
    const v = $("#init-url").value.trim();
    if (!v) return toast("Repository URL required", true);
    initFinish(v);
  };
  $("#init-dialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    initFinish(null);
  });
}

async function removeRepo(path) {
  try {
    await apiPost("/api/repos", { path, _method: "DELETE" });
    if (state.active === path) {
      state.active = null;
      showEmpty();
    }
    await loadRepos();
    toast("Repository removed");
  } catch (err) {
    toast(err.message, true);
  }
}

function showEmpty() {
  $("#empty").hidden = false;
  $("#repo-view").hidden = true;
}

/** Activate a tab (changes/history/branches) by name, syncing buttons and panels. */
function switchTab(name) {
  state.tab = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((pnl) => pnl.classList.toggle("active", pnl.dataset.panel === name));
}

/** Clear the active repo view and show a loading skeleton to prevent stale content flash on repo switch. */
function clearRepoView() {
  $("#staged-files").innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  $("#unstaged-files").innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  $("#history-list").innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  $("#branch-list").innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  $("#repo-branch").textContent = "";
  $("#diff-view").classList.remove("show");
  state.historySig = null;
  state.openRevision = null;
  $("#repo-view").classList.add("loading");
}

async function selectRepo(path) {
  state.active = path;
  state.selectedFile = null;
  const repo = state.repos.find((r) => r.path === path);
  $("#empty").hidden = true;
  $("#repo-view").hidden = false;
  $("#repo-title").textContent = repo?.label || path;
  $("#repo-path").textContent = path;
  renderRepos();
  loadOrg(path);
  clearRepoView();
  try {
    await refreshActive();
  } finally {
    $("#repo-view").classList.remove("loading");
  }
}

/**
 * Fetch the active repo's organization and show it as a clickable pill. The org
 * is the prefix of the repo's `name` metadata; a repo with no org prefix hides
 * the pill. Best-effort — a read failure leaves the pill hidden rather than
 * surfacing an error.
 * @param {string} path the repository path
 */
async function loadOrg(path) {
  const pill = $("#repo-org");
  pill.hidden = true;
  try {
    const { organization, repoName } = await apiGet(`/api/org?path=${encodeURIComponent(path)}`);
    state.org = { organization, repoName };
    pill.textContent = organization || "Set organization…";
    pill.classList.toggle("org-empty", !organization);
    pill.hidden = false;
  } catch (err) {
    state.org = null;
  }
}

/** Refetch every view for the active repo. The single source of freshness. */
async function refreshActive() {
  if (!state.active) return;
  state.refreshSeq++;
  const path = encodeURIComponent(state.active);
  const statusPromise = loadStatus(path);
  const historyPromise = loadHistory(path);
  const branchesPromise = statusPromise.then(() => loadBranches(path));
  await Promise.all([statusPromise, historyPromise, branchesPromise]);
}

function fileBadge(f) {
  // A directory that is itself a Lore working copy: a live nested repo. Offer to
  // ignore it (see the changes bar) rather than track a repo-inside-a-repo.
  if (f.nested) return ["nested", "badge-nested"];
  // A directory (LoreNodeType.DIRECTORY = 0) reported with action DELETE that is
  // no longer on disk is a *stale* nested-repo entry — a Lore zombie that no
  // discard can clear (only "Repair repository" can). Not a real deletion.
  if (f.type === 0 && f.action === 2) return ["stale", "badge-stale"];
  if (f.action === 1) return ["A", "badge-A"];
  if (f.action === 2) return ["D", "badge-D"];
  if (f.action === 3) return ["R", "badge-M"];
  return ["M", "badge-M"];
}

/** Fetches repository status and renders the staged/unstaged file lists. Ignores stale responses when the active repo has changed. */
async function loadStatus(pathEnc) {
  const forPath = state.active;
  const seq = state.refreshSeq;
  try {
    const data = await apiGet(`/api/status?path=${pathEnc}`);
    if (state.active !== forPath || state.refreshSeq !== seq) return;
    $("#repo-branch").textContent = data.branch || "";

    // Store status for use in graph rendering and popover
    state.status = data;

    // Render merge UI if in merge
    renderMergeUI(data);

    const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    const staged = data.files.filter((f) => f.flagStaged).sort(byPath);
    const unstaged = data.files.filter((f) => !f.flagStaged).sort(byPath);
    renderVirtualFiles($("#staged-files"), staged, "unstage");
    renderVirtualFiles($("#unstaged-files"), unstaged, "stage");
    $("#commit-btn").disabled = staged.length === 0;
    $("#stage-all-btn").disabled = unstaged.length === 0;
    $("#unstage-all-btn").disabled = staged.length === 0;
    $("#revert-all-btn").disabled = unstaged.length === 0;
    state.staged = staged;
    state.unstaged = unstaged;
    updateChangesBar(data);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderMergeUI(statusData) {
  const banner = $("#merge-banner");
  const conflictsSection = $("#conflicts-section");
  const completeBtn = $("#merge-complete-btn");
  const abortBtn = $("#merge-abort-btn");

  if (!statusData.inMerge) {
    banner.hidden = true;
    conflictsSection.hidden = true;
    return;
  }

  banner.hidden = false;

  // Get conflicts and staged files from files
  const conflicts = statusData.files.filter((f) => f.flagConflictUnresolved);
  const stagedFiles = statusData.files.filter((f) => f.flagStaged);

  if (conflicts.length > 0) {
    conflictsSection.hidden = false;
    $("#conflict-count").textContent = conflicts.length;
    renderConflicts(conflicts);
  } else {
    conflictsSection.hidden = true;
  }

  const branch = statusData.branch || "unknown";
  const isEmpty = conflicts.length === 0 && stagedFiles.length === 0;

  if (isEmpty) {
    // Empty merge: nothing to commit
    $("#merge-status-text").textContent = `Nothing to merge — already up to date`;
    completeBtn.hidden = true;
    abortBtn.textContent = "Clear merge state";
    abortBtn.hidden = false;
  } else if (conflicts.length > 0) {
    // Has conflicts
    $("#merge-status-text").textContent = `Merging into ${branch} — ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`;
    completeBtn.hidden = false;
    abortBtn.textContent = "Abort";
    abortBtn.hidden = false;
  } else {
    // Has staged changes, no conflicts
    $("#merge-status-text").textContent = `Merging into ${branch} — all resolved`;
    completeBtn.hidden = false;
    abortBtn.textContent = "Abort";
    abortBtn.hidden = false;
  }
}

function renderConflicts(conflicts) {
  const ul = $("#conflicts-list");
  ul.innerHTML = "";

  for (const f of conflicts) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="conflict-path" title="${f.path}">${f.path}</span>
      <div class="conflict-actions">
        <button class="c-mine" title="Keep local">Mine</button>
        <button class="c-theirs" title="Accept remote">Theirs</button>
        <button class="c-mark" title="Mark as manually resolved">Mark resolved</button>
        <button class="c-diff" title="Show diff">Diff</button>
      </div>`;

    li.querySelector(".c-mine").onclick = () => resolveConflict(f.path, "mine");
    li.querySelector(".c-theirs").onclick = () => resolveConflict(f.path, "theirs");
    li.querySelector(".c-mark").onclick = () => resolveConflict(f.path, "manual");
    li.querySelector(".c-diff").onclick = () => showDiff(f.path);

    ul.appendChild(li);
  }
}

async function resolveConflict(path, mode) {
  try {
    await apiPost("/api/merge/resolve", {
      path: state.active,
      mode,
      paths: [path],
    });
    toast(`Resolved ${path} (${mode})`);
    await loadStatus(encodeURIComponent(state.active));
  } catch (err) {
    toast(err.message, true);
  }
}

async function completeMerge() {
  // Guard: no staged files means nothing to commit
  const hasStagedFiles = (state.status?.files || []).some((f) => f.flagStaged);
  if (!hasStagedFiles) {
    toast("Nothing staged — clearing merge state instead");
    await apiPost("/api/merge/abort", { path: state.active });
    await refreshActive();
    return;
  }

  const ok = confirm("Complete merge? This will commit all staged changes.");
  if (!ok) return;
  await runOp("Completing merge…", "/api/commit", { path: state.active, message: "Merge completed" });
}

async function abortMerge() {
  const hasStagedFiles = (state.status?.files || []).some((f) => f.flagStaged);
  // Skip confirmation if nothing is staged — nothing to lose
  if (!hasStagedFiles) {
    try {
      await runBlocking("Aborting merge…", async () => {
        await apiPost("/api/merge/abort", { path: state.active });
        await loadStatus(encodeURIComponent(state.active));
      });
      toast("Merge state cleared");
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const ok = confirm("Abort merge? This will discard all staged changes.");
  if (!ok) return;
  try {
    await runBlocking("Aborting merge…", async () => {
      await apiPost("/api/merge/abort", { path: state.active });
      await loadStatus(encodeURIComponent(state.active));
    });
    toast("Merge aborted");
  } catch (err) {
    toast(err.message, true);
  }
}

const FILES_ROW_HEIGHT = 45; // must match .files li's fixed height in style.css
const FILES_OVERSCAN = 8; // extra rows rendered above/below the viewport

/** Per-container virtualization state: the files/action currently rendered,
 * so the delegated click handler and the scroll-driven re-render always read
 * current data. @type {WeakMap<Element, {files: object[], action: string}>} */
const virtualFilesState = new WeakMap();

/**
 * Render a file list without building one DOM node per file: only the rows
 * within the visible scroll viewport (plus a small overscan buffer) are ever
 * in the DOM, rebuilt as the user scrolls. A repo with tens of thousands of
 * changed files previously froze the tab for several seconds building and
 * laying out every row at once; this keeps that cost constant regardless of
 * list size. `container` is the `.files` element (e.g. #staged-files);
 * `action` is "stage" or "unstage".
 */
function renderVirtualFiles(container, files, action) {
  if (files.length === 0) {
    container.classList.remove("virtual");
    container.innerHTML = `<li class="muted">— none —</li>`;
    virtualFilesState.delete(container);
    return;
  }
  container.classList.add("virtual");

  let sizer = container.querySelector(":scope > .files-sizer");
  let windowEl = container.querySelector(":scope > .files-window");
  if (!sizer || !windowEl) {
    container.innerHTML = "";
    sizer = document.createElement("div");
    sizer.className = "files-sizer";
    windowEl = document.createElement("ul");
    windowEl.className = "files-window";
    container.appendChild(sizer);
    container.appendChild(windowEl);
  }
  // Attach listeners exactly once per container's lifetime (it's a static
  // element reused across every loadStatus refresh) — separate from the DOM
  // structure above, which does get torn down and rebuilt whenever the list
  // toggles between empty and non-empty.
  if (!container.dataset.virtualized) {
    container.dataset.virtualized = "1";
    container.addEventListener("scroll", () => renderVisibleFileRows(container));
    container.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-index]");
      if (!li) return;
      const st = virtualFilesState.get(container);
      const f = st?.files[Number(li.dataset.index)];
      if (!f) return;
      if (e.target.closest(".f-path")) showDiff(f.path);
      else if (e.target.closest(".f-do")) fileAction(st.action, f.path);
      else if (e.target.closest(".f-ignore")) openIgnoreMenu(f);
      else if (e.target.closest(".f-reset")) fileAction("reset", f.path);
    });
  }

  virtualFilesState.set(container, { files, action });
  sizer.style.height = `${files.length * FILES_ROW_HEIGHT}px`;
  container.scrollTop = 0;
  renderVisibleFileRows(container);
}

/** Rebuild just the currently-visible rows of a virtualized file list, per
 * the container's current scroll position — see renderVirtualFiles. */
function renderVisibleFileRows(container) {
  const st = virtualFilesState.get(container);
  if (!st) return;
  const { files, action } = st;
  const windowEl = container.querySelector(":scope > .files-window");
  if (!windowEl) return;
  const start = Math.max(0, Math.floor(container.scrollTop / FILES_ROW_HEIGHT) - FILES_OVERSCAN);
  const visibleCount = Math.ceil(container.clientHeight / FILES_ROW_HEIGHT) + FILES_OVERSCAN * 2;
  const end = Math.min(files.length, start + visibleCount);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const f = files[i];
    const [label, cls] = fileBadge(f);
    const li = document.createElement("li");
    li.dataset.index = i;
    li.innerHTML = `
      <span class="f-act ${cls}">${label}</span>
      <span class="f-path" title="${f.path}">${f.path}</span>
      <button class="f-do">${action === "stage" ? "Stage" : "Unstage"}</button>
      <button class="f-ignore" title="Add to .loreignore">⊘</button>
      ${action === "stage" ? `<button class="f-reset" title="Discard changes">↺</button>` : ""}`;
    frag.appendChild(li);
  }
  windowEl.innerHTML = "";
  windowEl.appendChild(frag);
  windowEl.style.transform = `translateY(${start * FILES_ROW_HEIGHT}px)`;
}

/**
 * Consume a streamed op (stage/unstage/reset now all stream, per-file included)
 * without showing the overlay — for a single-file action, a full-screen modal
 * would be overkill for something that normally finishes instantly. Throws if
 * the operation's terminal DONE marker reports failure.
 */
async function streamSilently(path, payload) {
  let failureMessage = null;
  await apiStream(path, payload, (ev) => {
    if (ev.tag === "DONE" && !ev.data.ok) failureMessage = ev.data.message || "unknown error";
  });
  if (failureMessage) throw new Error(failureMessage);
}

async function fileAction(action, file) {
  try {
    await streamSilently(`/api/${action}`, { path: state.active, files: [file] });
    // SSE refresh will follow, but refetch now for immediate feedback.
    await loadStatus(encodeURIComponent(state.active));
  } catch (err) {
    toast(err.message, true);
  }
}

/** Stages every currently unstaged file in the active repository. Streams
 * progress through the op overlay — fileStage's working-tree scan can run well
 * past a moment on a large repo, and the overlay auto-closes on success so it
 * doesn't add an extra click to a routine action. */
async function stageAll() {
  const files = (state.unstaged || []).map((f) => f.path);
  if (files.length === 0) return;
  await runOp("Staging…", "/api/stage", { path: state.active, files }, { autoClose: true });
}

/** Unstages every currently staged file in the active repository. */
async function unstageAll() {
  const files = (state.staged || []).map((f) => f.path);
  if (files.length === 0) return;
  await runOp("Unstaging…", "/api/unstage", { path: state.active, files }, { autoClose: true });
}

/** Reverts every currently unstaged change in the active repository. */
async function revertAll() {
  const count = (state.unstaged || []).length;
  if (count === 0) return;
  const ok = confirm(`Discard all unstaged changes to ${count} file(s)? New files will be deleted. This cannot be undone.`);
  if (!ok) return;
  const files = (state.unstaged || []).map((f) => f.path);
  await runOp("Reverting…", "/api/reset", { path: state.active, files }, { autoClose: true });
}

/**
 * The ignore patterns offered for a file: the file itself, its parent folder,
 * and its extension. Patterns are gitignore-style with forward slashes (Lore's
 * ignore syntax), regardless of the path separator the status used.
 */
function ignoreOptionsFor(f) {
  const path = (f.path || "").replace(/\\/g, "/");
  const sep = path.lastIndexOf("/");
  const name = path.slice(sep + 1);
  const parent = sep >= 0 ? path.slice(0, sep + 1) : "";
  const opts = [];
  if (f.type === 0) {
    // A directory entry (for example, a stale nested-repo marker): ignore the folder
    // itself with a trailing slash. This is the way to clear nested-repo
    // phantoms — Lore's status filter excludes ignored paths.
    opts.push({ pattern: `${path}/`, label: "This folder" });
  } else {
    opts.push({ pattern: path, label: "This file" });
    const dot = name.lastIndexOf(".");
    if (dot > 0) opts.push({ pattern: `*${name.slice(dot)}`, label: "All files with this extension" });
  }
  if (parent) opts.push({ pattern: parent, label: "Its parent folder" });
  return opts;
}

function openIgnoreMenu(f) {
  const ul = $("#ignore-options");
  ul.innerHTML = "";
  for (const o of ignoreOptionsFor(f)) {
    const li = document.createElement("li");
    li.innerHTML = `<code>${o.pattern}</code><span class="muted">${o.label}</span>`;
    li.onclick = () => {
      $("#ignore-dialog").close();
      ignorePattern(o.pattern);
    };
    ul.appendChild(li);
  }
  $("#ignore-dialog").showModal();
}

async function ignorePattern(pattern) {
  try {
    const { added } = await apiPost("/api/ignore", { path: state.active, pattern });
    toast(added ? `Ignoring ${pattern}` : `${pattern} was already ignored`);
    await loadStatus(encodeURIComponent(state.active));
  } catch (err) {
    toast(err.message, true);
  }
}

async function initLoreignore() {
  try {
    const { created, loreignoreBlocked, gitignoreUpdated, p4ignoreUpdated, p4ignoreBlocked } = await apiPost(
      "/api/init-loreignore",
      { path: state.active },
    );
    toast(created ? "Created .loreignore" : "Updated .loreignore");
    if (gitignoreUpdated) toast("Updated .gitignore");
    if (p4ignoreUpdated) toast("Updated .p4ignore");
    // Perforce keeps a checked-in file read-only until it is opened for edit,
    // so Lore cannot add its entries there on its own — this can apply to
    // .loreignore itself, not just .gitignore/.p4ignore, if it's also tracked.
    if (loreignoreBlocked) toast(".loreignore is read-only — run p4 edit .loreignore, then retry", true);
    if (p4ignoreBlocked) toast(".p4ignore is read-only — run p4 edit .p4ignore, then retry", true);
    await loadStatus(encodeURIComponent(state.active));
  } catch (err) {
    toast(err.message, true);
  }
}

function barButton(label, onclick, cls) {
  const b = document.createElement("button");
  b.className = cls || "ghost";
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

/**
 * Populate the toolbar above the file lists with context actions: set up
 * .loreignore, ignore live nested repos (so they never rot into zombies), and
 * repair stale nested-repo entries that no discard can clear.
 */
function updateChangesBar(data) {
  const bar = $(".changes-bar");
  bar.innerHTML = "";
  const files = data.files || [];
  const nested = files.filter((f) => f.nested);
  const stale = files.filter((f) => f.type === 0 && f.action === 2 && !f.nested);

  if (data.scanning) {
    const note = document.createElement("span");
    note.className = "bar-note";
    note.textContent = "Scanning for new files…";
    bar.appendChild(note);
  }
  if (data.hasLoreignore === false) {
    bar.appendChild(barButton("Initialize .loreignore", initLoreignore));
  } else if (data.hasGitignore || data.hasP4ignore) {
    bar.appendChild(barButton("Re-sync ignore patterns", initLoreignore, "ghost"));
  }
  if (nested.length) {
    const n = nested.length;
    const note = document.createElement("span");
    note.className = "bar-note";
    note.textContent = `${n} nested ${n === 1 ? "repository" : "repositories"} — ignore so Lore doesn't track a repo-in-a-repo`;
    bar.appendChild(note);
    bar.appendChild(barButton(`Ignore nested`, () => ignoreNested(nested)));
  }
  if (stale.length) {
    const n = stale.length;
    const note = document.createElement("span");
    note.className = "bar-note warn";
    note.textContent = `${n} stale nested ${n === 1 ? "entry" : "entries"} can't be discarded`;
    bar.appendChild(note);
    bar.appendChild(barButton("Repair repository…", repairRepository));
  }
  bar.hidden = bar.childElementCount === 0;
}

/** Add each live nested repo to .loreignore (as a folder pattern). */
async function ignoreNested(list) {
  try {
    // One overlay for the whole batch, not per entry — this is N sequential
    // requests, so it can take real time on a repo with many nested repos.
    await runBlocking(`Ignoring ${list.length} ${list.length === 1 ? "repository" : "repositories"}…`, async () => {
      for (const f of list) {
        const path = (f.path || "").replace(/\\/g, "/");
        await apiPost("/api/ignore", { path: state.active, pattern: `${path}/` });
      }
      await loadStatus(encodeURIComponent(state.active));
    });
    toast(`Ignored ${list.length} nested ${list.length === 1 ? "repo" : "repos"}`);
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * Rebuild the repo's .lore to purge stale "zombie" entries Lore can't otherwise
 * remove. Files are untouched; the server refuses if there is committed history.
 */
async function repairRepository() {
  const ok = confirm(
    "Rebuild this repository's index to clear stale entries?\n\n" +
      "Your files are not touched, and the repository keeps its identity and remote. " +
      "You can only do this before anything has been committed.",
  );
  if (!ok) return;
  try {
    // keepOpen: a rebuild discards local committed history, so it gets an
    // explicit acknowledgement rather than a modal that vanishes.
    await runBlocking(
      "Repairing repository…",
      async () => {
        await apiPost("/api/repair", { path: state.active });
        await refreshActive();
      },
      { keepOpen: true, successMessage: "Repository repaired" },
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function showDiff(file) {
  const view = $("#diff-view");
  state.selectedFile = file;
  try {
    const { diff } = await apiGet(`/api/diff?path=${encodeURIComponent(state.active)}&file=${encodeURIComponent(file)}`);
    const patch = diff.map((d) => d.patch || "").join("\n");
    view.innerHTML = colorizeDiff(patch || "(no differences)");
    view.classList.add("show");
  } catch (err) {
    toast(err.message, true);
  }
}

function colorizeDiff(text) {
  return text
    .split("\n")
    .map((line) => {
      const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      if (line.startsWith("+")) return `<span class="diff-add">${esc}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${esc}</span>`;
      if (line.startsWith("@@")) return `<span class="diff-hunk">${esc}</span>`;
      return esc;
    })
    .join("\n");
}

async function commit() {
  const msg = $("#commit-msg").value.trim();
  if (!msg) return toast("Enter a commit message", true);
  $("#commit-btn").disabled = true;
  try {
    await runOp("Committing…", "/api/commit", { path: state.active, message: msg });
    $("#commit-msg").value = "";
  } finally {
    $("#commit-btn").disabled = false;
  }
}

async function loadHistory(pathEnc) {
  const forPath = state.active;
  const seq = state.refreshSeq;
  try {
    const { revisions } = await apiGet(`/api/history?path=${pathEnc}&length=50`);
    if (state.active !== forPath || state.refreshSeq !== seq) return;
    state.revisions = revisions;
    // Skip the rebuild when nothing changed, so a background refresh (poll, focus,
    // file-watch) does not collapse a revision the user has expanded.
    const sig = revisions.map((r) => r.revision).join(",");
    if (sig === state.historySig) return;
    state.historySig = sig;
    const ul = $("#history-list");
    ul.innerHTML = "";
    for (const r of revisions) {
      const li = document.createElement("li");
      const when = r.timestamp ? new Date(r.timestamp).toLocaleString() : "";
      li.innerHTML = `
        <div class="h-row">
          <div class="h-msg">${(r.message || "(no message)").split("\n")[0]}</div>
          <div class="h-meta">
            <span class="h-rev">#${r.revisionNumber} · ${(r.revision || "").slice(0, 12)}</span>
            <span>${when}</span>
            <button class="h-sync" title="Sync to this revision">Sync</button>
          </div>
        </div>
        <div class="rev-detail" hidden></div>`;
      li.querySelector(".h-row").onclick = () => toggleRevision(r, li);
      li.querySelector(".h-sync").onclick = (evt) => {
        evt.stopPropagation();
        syncToRevision(r);
      };
      if (r.revision === state.openRevision) toggleRevision(r, li);
      ul.appendChild(li);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/** Expand a revision to show the files it changed; collapse if already open. */
async function toggleRevision(r, li) {
  const detail = li.querySelector(".rev-detail");
  if (!detail.hidden) {
    detail.hidden = true;
    li.classList.remove("open");
    state.openRevision = null;
    return;
  }
  detail.hidden = false;
  li.classList.add("open");
  state.openRevision = r.revision;
  detail.innerHTML = `<div class="muted">Loading changes…</div>`;
  const parent = (r.parent && r.parent[0]) || "";
  try {
    const { files } = await apiGet(
      `/api/revision?path=${encodeURIComponent(state.active)}&revision=${r.revision}`,
    );
    if (!files.length) {
      detail.innerHTML = `<div class="muted">No file changes in this revision.</div>`;
      return;
    }
    detail.innerHTML = `<ul class="rev-files"></ul><pre class="rev-diff" hidden></pre>`;
    const list = detail.querySelector(".rev-files");
    for (const f of files) {
      const [label, cls] = fileBadge(f);
      const item = document.createElement("li");
      item.innerHTML = `<span class="f-act ${cls}">${label}</span><span class="f-path" title="${f.path}">${f.path}</span>`;
      item.onclick = () => showRevisionFileDiff(r, parent, f.path, detail);
      list.appendChild(item);
    }
  } catch (err) {
    detail.innerHTML = `<div class="muted">${err.message}</div>`;
  }
}

/** Show one file's diff between a revision and its parent, inside the detail. */
async function showRevisionFileDiff(r, parent, file, detail) {
  const pre = detail.querySelector(".rev-diff");
  detail.querySelectorAll(".rev-files li").forEach((el) =>
    el.classList.toggle("sel", el.querySelector(".f-path")?.title === file),
  );
  pre.hidden = false;
  pre.textContent = "Loading diff…";
  try {
    const url =
      `/api/diff?path=${encodeURIComponent(state.active)}` +
      `&file=${encodeURIComponent(file)}&source=${parent}&target=${r.revision}`;
    const { diff } = await apiGet(url);
    const patch = diff.map((d) => d.patch || "").join("\n");
    pre.innerHTML = colorizeDiff(patch || "(no textual diff — binary file or no change)");
  } catch (err) {
    pre.textContent = err.message;
  }
}

async function loadBranches(pathEnc) {
  const forPath = state.active;
  const seq = state.refreshSeq;
  try {
    const showArchived = $("#show-archived-check")?.checked ?? false;
    const graphData = await apiGet(`/api/graph?path=${pathEnc}&length=100${showArchived ? "&archived=true" : ""}`);
    if (state.active !== forPath || state.refreshSeq !== seq) return;

    // Dedupe branches by id, preferring LOCAL
    const deduped = graph.dedupeBranches(graphData.branches);
    // Presence per side, computed before dedupe collapses locations. A branch
    // only in the local cache was either never pushed or archived on the server
    // by a collaborator (archives delete server-side but never prune other
    // clients' local caches) — surfaced as a badge so it can be tidied.
    // remoteKnown is false while the server is still serving the fast offline
    // branch list (remote enumeration pending in the background); the list is
    // local-only then, so suppress both badges rather than flash a wrong "local
    // only" on every branch. The background enrichment pushes an SSE refresh when
    // the remote data lands, and this recomputes with accurate badges.
    const remoteKnown = graphData.remoteKnown !== false;
    const localIds = new Set(graphData.branches.filter((b) => b.location === 0).map((b) => b.id));
    const remoteIds = new Set(graphData.branches.filter((b) => b.location === 1).map((b) => b.id));
    for (const b of deduped) {
      b.localOnly = remoteKnown && localIds.has(b.id) && !remoteIds.has(b.id);
      b.remoteOnly = remoteKnown && remoteIds.has(b.id) && !localIds.has(b.id);
    }
    state.branches = deduped;

    // Filter branches (active or archived)
    const branches = deduped.filter((b) => showArchived || !b.archived);
    const currentBranch = branches.find((b) => b.isCurrent);

    // Store reachable revisions from current branch for sync enablement
    state.currentBranchRevisions = new Set((graphData.histories[currentBranch?.id] || []).map(r => r.revision));

    // Populate merge source select. Never rebuild while the merge dialog is
    // open (a background refresh would silently reset the user's selection to
    // the placeholder), and preserve the previous selection otherwise.
    const mergeSelect = $("#merge-source");
    if (mergeSelect && !$("#merge-dialog")?.open) {
      const prev = mergeSelect.value;
      const options = branches.filter((b) => !b.isCurrent && !b.archived);
      mergeSelect.innerHTML = '<option value="">— Select branch —</option>';
      for (const b of options) {
        const opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = b.name;
        mergeSelect.appendChild(opt);
      }
      if (prev && options.some((b) => b.id === prev)) mergeSelect.value = prev;
    }

    // Render sidebar
    const ul = $("#branch-list");
    ul.innerHTML = "";
    for (const b of branches) {
      const li = document.createElement("li");
      li.className = (b.isCurrent ? "current" : "") + (b.archived ? " archived" : "");
      const actionable = !b.isCurrent && !b.archived;
      const canArchive = actionable && (b.stack?.length > 0);
      li.innerHTML = `
        <div class="b-head">
          <span class="b-current-dot">${b.isCurrent ? "●" : "○"}</span>
          <span class="b-name" title="${b.name}">${b.name}</span>
          ${b.archived ? `<span class="b-archived-badge">archived</span>` : ""}
          ${!b.archived && b.localOnly ? `<span class="b-loc-badge" title="Not on the server — either never pushed, or archived/deleted by a collaborator. Archive to remove it here.">local only</span>` : ""}
          ${!b.archived && b.remoteOnly ? `<span class="b-loc-badge" title="Exists on the server but not in this working copy.">remote only</span>` : ""}
        </div>
        <div class="b-cat">${b.category || "—"}</div>
        <div class="b-meta">
          <span class="b-creator">${b.creator || "?"}</span>
          <span>${(b.latest || "").slice(0, 12)}</span>
        </div>
        <div class="b-actions">
          ${actionable ? `<button class="b-switch" title="Switch to branch">Switch</button>` : ""}
          ${actionable ? `<button class="b-merge" title="Merge into current">Merge</button>` : ""}
          ${canArchive ? `<button class="b-archive" title="Archive branch">Archive</button>` : ""}
        </div>`;
      ul.appendChild(li);
      if (actionable) {
        li.querySelector(".b-switch")?.addEventListener("click", () => switchBranch(b));
        li.querySelector(".b-merge")?.addEventListener("click", () => startMerge(b));
        li.querySelector(".b-archive")?.addEventListener("click", () => archiveBranch(b));
      }
    }

    // Render graph (if any nodes)
    if (graphData.branches.length > 0) {
      const layout = graph.layoutGraph(graphData, currentBranch?.id);
      const sig = graph.layoutSignature(layout);
      // Include current revision in signature so revision-changed-but-topology-unchanged still triggers re-render
      const compositeSig = sig + "|" + (state.status?.revision || "");
      if (state.graphSig !== compositeSig) {
        state.graphSig = compositeSig;
        graph.renderGraph($("#branch-graph"), layout, {
          onNodeClick: (node, evt) => showNodePopover(node, evt),
          currentRevision: state.status?.revision,
        });
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function createBranch() {
  const name = $("#create-branch-name")?.value?.trim();
  const category = $("#create-branch-category")?.value?.trim() || "user";
  if (!name) {
    toast("Branch name required", true);
    return;
  }
  // Close before the overlay, not after success: a showModal() dialog sits in
  // the top layer, above any overlay z-index. The typed name survives a
  // failure — it's only cleared when the dialog is reopened.
  $("#create-branch-dialog")?.close?.();
  try {
    await runBlocking("Creating branch…", async () => {
      await apiPost("/api/branch/create", {
        path: state.active,
        branch: name,
        category,
      });
      // Block until every view reflects the new branch, so the user cannot act
      // on stale state (e.g. merge with the old current branch still shown).
      await refreshActive();
    });
    toast(`Created branch ${name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function switchBranch(branch) {
  const pathEnc = encodeURIComponent(state.active);
  if (state.unstaged?.length > 0) {
    const ok = confirm("Working tree has unstaged changes. Continue switch?");
    if (!ok) return;
  }
  await runOp(`Switch to ${branch.name}`, "/api/branch/switch", {
    path: state.active,
    branch: branch.name,
  });
}

async function archiveBranch(branch) {
  const ok = confirm(`Archive branch ${branch.name}?`);
  if (!ok) return;
  try {
    await runBlocking("Archiving branch…", async () => {
      await apiPost("/api/branch/archive", {
        path: state.active,
        branch: branch.name,
      });
      await refreshActive();
    });
    toast(`Archived ${branch.name}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function startMerge(branch) {
  const target = state.status?.branch || "current branch";
  const targetEl = $("#merge-target");
  if (targetEl) targetEl.innerHTML = `Merging into <strong>${target}</strong>`;
  const msgEl = $("#merge-message");
  if (msgEl && branch) msgEl.placeholder = `Merge ${branch.name} into ${target}`;
  $("#merge-source").value = branch.id;
  $("#merge-dialog")?.showModal?.();
}

async function confirmMerge() {
  const sourceId = $("#merge-source")?.value;
  const sourceBranch = state.branches?.find((b) => b.id === sourceId);
  if (!sourceBranch) {
    toast("Select a source branch", true);
    return;
  }
  const target = state.status?.branch || "current branch";
  const noCommit = $("#merge-no-commit-check")?.checked ?? false;
  // An empty message would leave the merge staged but uncommitted (the lib only
  // auto-commits when a message is given) — invisible in history and easy to
  // mistake for a no-op. Default a message unless no-commit was chosen.
  let message = $("#merge-message")?.value?.trim() || "";
  if (!message && !noCommit) message = `Merge ${sourceBranch.name} into ${target}`;
  $("#merge-dialog").close();
  await runOp(`Merge ${sourceBranch.name}`, "/api/merge/start", {
    path: state.active,
    branch: sourceBranch.name,
    message,
    noCommit,
    // The server refuses the merge if the actual current branch differs — the
    // last line of defense against merging with a stale idea of the target.
    expectedTarget: state.status?.branch || "",
  });

  // Auto-clear an empty merge (nothing staged, no conflicts)
  const hasConflicts = (state.status?.files || []).some((f) => f.flagConflictUnresolved);
  const hasStagedFiles = (state.status?.files || []).some((f) => f.flagStaged);
  if (state.status?.inMerge && !hasConflicts && !hasStagedFiles) {
    try {
      await apiPost("/api/merge/abort", { path: state.active });
      await refreshActive();
      toast(`Nothing to merge — ${sourceBranch.name} is already merged into ${target}`);
      return;
    } catch (err) {
      toast(err.message, true);
    }
  }

  // A staged-but-uncommitted merge (no-commit requested, or conflicts) needs
  // the user to finish it in the Changes tab — take them there.
  if (state.status?.inMerge || (noCommit && state.status?.files?.some((f) => f.flagStaged))) {
    switchTab("changes");
    toast("Merge staged — review and commit in Changes");
  }
}

/** Format a byte count as a short human-readable string, for example "42.1 MB".
 * @param {number} n bytes to format
 * @returns {string} human-readable byte count
 */
function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const PROGRESS_BEGIN_TAGS = new Set(["REPOSITORY_CLONE_BEGIN", "REVISION_COMMIT_BEGIN"]);
const PROGRESS_TAGS = new Set(["REPOSITORY_CLONE_PROGRESS", "REVISION_COMMIT_PROGRESS"]);
const PROGRESS_END_TAGS = new Set(["REPOSITORY_CLONE_END", "REVISION_COMMIT_END"]);

// Stage/unstage/reset report progress as running item counts (files and
// directories touched), not the byte-transfer counters clone/commit use — the
// BEGIN event's pathCount is the only "total" they ever state, so it has to be
// captured and carried forward to compute a percentage on PROGRESS/END.
const FILE_OP_BEGIN_TAGS = new Set(["FILE_STAGE_BEGIN", "FILE_UNSTAGE_BEGIN", "FILE_RESET_BEGIN"]);
const FILE_OP_PROGRESS_TAGS = new Set(["FILE_STAGE_PROGRESS", "FILE_UNSTAGE_PROGRESS", "FILE_RESET_PROGRESS"]);
const FILE_OP_END_TAGS = new Set(["FILE_STAGE_END", "FILE_UNSTAGE_END", "FILE_RESET_END"]);
// Per-file/per-revision detail events — real signal, but one line per file
// would swamp the log on a large repo, so these are dropped rather than
// appended to the compact "• TAG" fallback.
const FILE_OP_NOISE_TAGS = new Set(["FILE_STAGE_FILE", "FILE_UNSTAGE_FILE", "FILE_RESET_FILE", "FILE_STAGE_REVISION", "FILE_UNSTAGE_REVISION"]);

/** Sum of items a FILE_STAGE/UNSTAGE/RESET count struct reports as done so far.
 * Stage/unstage carry a ready-made totalCount; reset has no single total field,
 * so its four counters (files and directories, reset and deleted) are summed. */
function fileOpItemsDone(tag, count) {
  if (!count) return 0;
  if (tag.startsWith("FILE_RESET")) {
    return (count.fileResetCount ?? 0) + (count.fileDeleteCount ?? 0) + (count.directoryResetCount ?? 0) + (count.directoryDeleteCount ?? 0);
  }
  return count.totalCount ?? 0;
}

/** Render stage/unstage/reset progress against the BEGIN event's requested path count. */
function renderFileOpProgress(barFillEl, textEl, tag, count, total) {
  const done = fileOpItemsDone(tag, count);
  const pct = total > 0 ? (done / total) * 100 : 0;
  barFillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  textEl.textContent = total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()} items` : `${done.toLocaleString()} items`;
}

/** Render progress data (file and byte counts) onto the operation overlay bar.
 * @param {HTMLElement} barFillEl progress bar fill element
 * @param {HTMLElement} textEl progress text element
 * @param {object} data a REPOSITORY_CLONE_PROGRESS/REVISION_COMMIT_PROGRESS (or
 *   matching END) event's data — the actual counts (fileComplete, fileTotal,
 *   bytesTransferred, bytesTotal, discoveryComplete) live nested under `count`,
 *   confirmed against real captured events; fall back to top-level fields too
 *   in case some verb's event shape doesn't nest.
 */
function renderOpProgress(barFillEl, textEl, data) {
  const count = data.count || data;
  const fileDone = count.fileComplete ?? count.fileCount ?? 0;
  const fileTotal = count.fileTotal ?? count.fileCount ?? 0;
  const bytesDone = count.bytesTransferred ?? 0;
  const bytesTotal = count.bytesTotal ?? 0;
  const pct = count.discoveryComplete && bytesTotal > 0 ? (bytesDone / bytesTotal) * 100 : fileTotal > 0 ? (fileDone / fileTotal) * 100 : 0;
  barFillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  textEl.textContent = count.discoveryComplete
    ? `${fileDone.toLocaleString()} / ${fileTotal.toLocaleString()} files · ${fmtBytes(bytesDone)} / ${fmtBytes(bytesTotal)}`
    : "Discovering…";
}

// A single native LOG event can embed thousands of file paths as one message
// (e.g. staging a large repo logs its full invocation args as one line) —
// the server already truncates these (server/sdk.mjs), but cap again here as
// a second line of defense, and bound the log element's total size so a very
// long-running stream of ordinary-sized lines can't grow the DOM node
// unbounded either. Both matter: an unbounded single append can freeze the
// tab outright; an unbounded total size degrades everything after it.
const OP_LOG_MESSAGE_LIMIT = 2000;
const OP_LOG_TOTAL_LIMIT = 50_000;

/** Append text to the op log overlay, capping per-message and total size. */
function appendOpLog(logEl, text) {
  if (text.length > OP_LOG_MESSAGE_LIMIT) {
    text = `${text.slice(0, OP_LOG_MESSAGE_LIMIT)}… [truncated, ${text.length} chars total]\n`;
  }
  let next = logEl.textContent + text;
  if (next.length > OP_LOG_TOTAL_LIMIT) {
    next = `… [earlier output trimmed]\n${next.slice(-OP_LOG_TOTAL_LIMIT)}`;
  }
  logEl.textContent = next;
}

/** Matches the native SDK's free-text "Address not found: <hash>-<context>" error. */
const ADDRESS_NOT_FOUND_RE = /Address not found:\s*([0-9a-fA-F]+)-([0-9a-fA-F]+)/gi;

/** Extract every "hash-context" address out of an "Address not found" failure message. */
function findMissingAddresses(message) {
  const text = String(message ?? "");
  const seen = new Set();
  for (const m of text.matchAll(ADDRESS_NOT_FOUND_RE)) seen.add(`${m[1]}-${m[2]}`);
  return [...seen];
}

/**
 * Run a one-shot action behind the blocking overlay. The sibling of runOp for
 * endpoints that answer with a single JSON response rather than a stream:
 * same modal chrome (title, blocked interaction, status), but no log or
 * progress bar since there is nothing incremental to show. Exists so actions
 * that do real server-side work — notably the .lore rebuilds behind
 * organization change / repair / adopt-remote-id — can't look idle while the
 * user waits on them.
 *
 * Rethrows on failure so each caller's existing catch/toast still runs.
 * @param {string} title shown as the overlay heading, e.g. "Repairing repository…"
 * @param {() => Promise<any>} fn the work to await
 * @param {{keepOpen?: boolean, successMessage?: string}} [opts] `keepOpen`
 *   leaves the overlay up on success until the user dismisses it (for
 *   destructive rebuilds that deserve an explicit acknowledgement); otherwise
 *   it auto-closes. A failure always stays open, regardless.
 */
async function runBlocking(title, fn, opts = {}) {
  const overlay = $("#op-overlay");
  const logEl = $("#op-log");
  const statusEl = $("#op-status");
  const closeBtn = $("#op-close");
  const pushContentBtn = $("#op-push-content");
  const progressEl = $("#op-progress");
  $("#op-title").textContent = title;
  logEl.textContent = "";
  logEl.hidden = true; // nothing streamed — restored in finally for runOp's sake
  progressEl.hidden = true;
  pushContentBtn.hidden = true;
  closeBtn.hidden = true;
  statusEl.textContent = "Working…";
  statusEl.className = "";
  overlay.hidden = false;
  try {
    const result = await fn();
    statusEl.textContent = opts.successMessage ?? "Success";
    statusEl.className = "ok";
    if (opts.keepOpen) closeBtn.hidden = false;
    else overlay.hidden = true;
    return result;
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
    statusEl.className = "fail";
    closeBtn.hidden = false;
    throw err;
  } finally {
    logEl.hidden = false;
  }
}

/**
 * @param {string} title
 * @param {string} path
 * @param {object} payload
 * @param {{autoClose?: boolean}} [opts] `autoClose` hides the overlay on success
 *   instead of waiting for the user to click Close — for quick bulk actions
 *   (stage/unstage/revert all) where a lingering modal is just friction. On
 *   failure the overlay always stays open, same as every other operation.
 */
async function runOp(title, path, payload, opts = {}) {
  const overlay = $("#op-overlay");
  const logEl = $("#op-log");
  const statusEl = $("#op-status");
  const closeBtn = $("#op-close");
  const pushContentBtn = $("#op-push-content");
  const progressEl = $("#op-progress");
  const barFillEl = $("#op-bar-fill");
  const progressTextEl = $("#op-progress-text");
  $("#op-title").textContent = title;
  logEl.textContent = "";
  statusEl.textContent = "";
  statusEl.className = "";
  closeBtn.hidden = true;
  pushContentBtn.hidden = true;
  pushContentBtn.onclick = null;
  progressEl.hidden = true;
  barFillEl.style.width = "0%";
  progressTextEl.textContent = "";
  overlay.hidden = false;

  // Coalesce the log-scroll reflow to once per animation frame instead of
  // once per event — a high-volume stream (thousands of file-op events) would
  // otherwise force a synchronous layout on every single one.
  let scrollScheduled = false;
  function scheduleLogScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      logEl.scrollTop = logEl.scrollHeight;
      scrollScheduled = false;
    });
  }

  let failureMessage = "";
  let successCaveat = "";
  let fileOpTotal = 0;
  try {
    await apiStream(path, payload, (ev) => {
      if (ev.tag === "LOG") appendOpLog(logEl, (ev.data?.message || "") + "\n");
      else if (ev.tag === "DONE") {
        if (ev.data.ok) barFillEl.style.width = "100%";
        failureMessage = ev.data.ok ? "" : ev.data.message || "unknown error";
        successCaveat = ev.data.ok ? ev.data.message || "" : "";
        // A successful op can still carry a caveat (e.g. revert skipped some
        // read-only files) -- show it instead of a bare "Success" that would
        // hide it, especially since this overlay can auto-close right after.
        statusEl.textContent = ev.data.ok ? `Success${ev.data.message ? ` — ${ev.data.message}` : ""}` : `Failed: ${failureMessage}`;
        statusEl.className = ev.data.ok ? "ok" : "fail";
      } else if (PROGRESS_BEGIN_TAGS.has(ev.tag)) {
        progressEl.hidden = false;
        barFillEl.style.width = "0%";
        progressTextEl.textContent = "Starting…";
      } else if (PROGRESS_TAGS.has(ev.tag)) {
        progressEl.hidden = false;
        renderOpProgress(barFillEl, progressTextEl, ev.data || {});
      } else if (PROGRESS_END_TAGS.has(ev.tag)) {
        progressEl.hidden = false;
        renderOpProgress(barFillEl, progressTextEl, { ...ev.data, count: { ...ev.data?.count, discoveryComplete: true } });
        barFillEl.style.width = "100%"; // END always means done, even a zero-file clone/commit
      } else if (FILE_OP_BEGIN_TAGS.has(ev.tag)) {
        fileOpTotal = ev.data?.pathCount || 0;
        progressEl.hidden = false;
        barFillEl.style.width = "0%";
        progressTextEl.textContent = fileOpTotal > 0 ? `0 / ${fileOpTotal.toLocaleString()} items` : "Working…";
      } else if (FILE_OP_PROGRESS_TAGS.has(ev.tag)) {
        progressEl.hidden = false;
        renderFileOpProgress(barFillEl, progressTextEl, ev.tag, ev.data?.count, fileOpTotal);
      } else if (FILE_OP_END_TAGS.has(ev.tag)) {
        progressEl.hidden = false;
        barFillEl.style.width = "100%";
        renderFileOpProgress(barFillEl, progressTextEl, ev.tag, ev.data?.count, fileOpTotal);
      } else if (FILE_OP_NOISE_TAGS.has(ev.tag)) {
        // dropped — see FILE_OP_NOISE_TAGS
      } else if (ev.tag !== "END" && ev.tag !== "COMPLETE") {
        // Surface other progress-bearing events compactly.
        appendOpLog(logEl, `• ${ev.tag}\n`);
      }
      scheduleLogScroll();
    });
  } catch (err) {
    failureMessage = err.message;
    statusEl.textContent = `Failed: ${failureMessage}`;
    statusEl.className = "fail";
  }

  // A commit whose content upload timed out publishes a revision other clients
  // can't sync — the remote never received that blob. The content is usually
  // still recoverable from whichever machine committed it, so offer to push it
  // straight from here rather than leaving the user with just an address in an
  // error string.
  const missing = failureMessage ? findMissingAddresses(failureMessage) : [];
  if (missing.length > 0) {
    pushContentBtn.hidden = false;
    pushContentBtn.textContent = `Push missing content (${missing.length})`;
    pushContentBtn.onclick = async () => {
      pushContentBtn.disabled = true;
      try {
        const { results } = await apiPost("/api/push-content", { path: state.active, addresses: missing });
        const failed = results.filter((r) => r.errorCode !== 0);
        if (failed.length === 0) {
          toast("Pushed missing content — retry the sync now.");
          pushContentBtn.hidden = true;
        } else {
          toast(`This machine doesn't have all of the missing content (${failed.length} still missing).`, true);
        }
      } catch (err) {
        toast(err.message, true);
      } finally {
        pushContentBtn.disabled = false;
      }
    };
  }

  // Keep the overlay blocking until every view reflects the new repo state —
  // interacting with stale branch/status data right after a switch or merge is
  // how merges end up aimed at the wrong branch.
  const doneText = statusEl.textContent;
  statusEl.textContent = `${doneText} — refreshing…`;
  await refreshActive();
  statusEl.textContent = doneText;
  if (opts.autoClose && !failureMessage && !successCaveat) {
    overlay.hidden = true;
  } else {
    closeBtn.hidden = false;
  }
}

async function syncToRevision(revision) {
  const pathEnc = encodeURIComponent(state.active);
  if (state.unstaged?.length > 0) {
    const ok = confirm(`Working tree has ${state.unstaged.length} unstaged change${state.unstaged.length === 1 ? "" : "s"}. Continue sync?`);
    if (!ok) return;
  }
  await runOp(`Syncing to #${revision.revisionNumber}…`, "/api/sync", {
    path: state.active,
    revision: revision.revision,
  });
}

function showNodePopover(node, evt) {
  const popover = $("#node-popover");
  const currentBranch = state.branches?.find((b) => b.isCurrent);
  const shortHash = (node.revision || "").slice(0, 12);
  const when = node.timestamp ? new Date(node.timestamp).toLocaleString() : "";

  // Sync is enabled for revisions reachable from the current branch
  const syncable = state.currentBranchRevisions?.has(node.revision);
  let syncButton = "";
  if (!syncable) {
    syncButton = `<button class="pop-action" disabled title="Switch to ${node.branch} first">Sync to this revision</button>`;
  } else {
    syncButton = `<button class="pop-action pop-sync">Sync to this revision</button>`;
  }

  popover.innerHTML = `
    <div class="pop-header">
      <span class="pop-branch">${node.branch}</span>
      <span class="pop-rev">#${node.revisionNumber}</span>
    </div>
    <div class="pop-content">
      <div class="pop-hash" title="${node.revision}">${shortHash}</div>
      <div class="pop-msg">${(node.message || "(no message)").split("\n")[0]}</div>
      <div class="pop-time">${when}</div>
    </div>
    <div class="pop-actions">
      ${syncButton}
      <button class="pop-action pop-copy">Copy hash</button>
    </div>`;

  popover.hidden = false;

  // Position popover near the click
  const rect = popover.getBoundingClientRect();
  let x = evt.clientX;
  let y = evt.clientY + 8;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = evt.clientY - rect.height - 8;
  popover.style.left = Math.max(8, x) + "px";
  popover.style.top = Math.max(8, y) + "px";

  // Sync action
  popover.querySelector(".pop-sync")?.addEventListener("click", () => {
    popover.hidden = true;
    syncToRevision(node);
  });

  // Copy hash action
  popover.querySelector(".pop-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(node.revision);
    toast("Hash copied");
    popover.hidden = true;
  });

  // Dismiss on outside click
  const dismissOnClick = (e) => {
    if (!popover.contains(e.target) && e.target !== evt.target && !evt.target?.contains?.(e.target)) {
      popover.hidden = true;
      document.removeEventListener("click", dismissOnClick);
    }
  };
  setTimeout(() => document.addEventListener("click", dismissOnClick), 0);

  // Dismiss on Esc
  const dismissOnEsc = (e) => {
    if (e.key === "Escape") {
      popover.hidden = true;
      document.removeEventListener("keydown", dismissOnEsc);
    }
  };
  document.addEventListener("keydown", dismissOnEsc);
}

/** Scheduler that coalesces overlapping refresh requests (focus, SSE, poll) into a single debounced update. */
let refreshPending = null;
let refreshWantRepos = false;
let refreshWantActive = false;
let refreshInflight = false;

/**
 * Request a refresh with coalescing — multiple calls within 150ms are batched
 * into one. Prevents refresh storms from focus + SSE + poll stacking up.
 * @param {{ repos?: boolean, active?: boolean }} what to refresh
 */
function scheduleRefresh({ repos = false, active = false } = {}) {
  refreshWantRepos = refreshWantRepos || repos;
  refreshWantActive = refreshWantActive || active;
  if (refreshPending) return;
  refreshPending = setTimeout(() => {
    refreshPending = null;
    const wantRepos = refreshWantRepos;
    const wantActive = refreshWantActive;
    refreshWantRepos = false;
    refreshWantActive = false;
    (async () => {
      if (refreshInflight) return;
      refreshInflight = true;
      try {
        if (wantRepos) await loadRepos();
        if (wantActive && state.active) await refreshActive();
      } finally {
        refreshInflight = false;
      }
    })();
  }, 150);
}

function connectSSE() {
  const es = new EventSource("/events");
  es.onopen = () => $("#conn").classList.add("live");
  es.onerror = () => $("#conn").classList.remove("live");
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "refresh") {
      if (msg.repo === "*") scheduleRefresh({ repos: true });
      else if (msg.repo === state.active) scheduleRefresh({ repos: true, active: true });
      else scheduleRefresh({ repos: true });
    }
  };
}

// The browser can't hand the server a real filesystem path, so the folder picker
// drives a server-backed directory browser (/api/browse) instead of typed paths.
const picker ={ cur: "", parent: null, sep: "\\", resolve: null };

async function pickerNavigate(path) {
  const data = await apiGet(`/api/browse?path=${encodeURIComponent(path ?? "")}`);
  picker.cur = data.path;
  picker.parent = data.parent;
  picker.sep = data.sep || picker.sep;
  $("#picker-cur").textContent = data.path || "This PC";
  $("#picker-up").disabled = data.parent === null;
  const ul = $("#picker-list");
  ul.innerHTML = "";
  if (data.entries.length === 0) {
    ul.innerHTML = `<li class="muted">— no sub-folders —</li>`;
  }
  for (const e of data.entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="p-name" title="${e.path}">${e.name}</span>${
      e.isRepo ? `<span class="p-tag">lore</span>` : ""
    }`;
    li.onclick = () => pickerNavigate(e.path);
    ul.appendChild(li);
  }
}

/**
 * Open the folder picker and resolve to a chosen absolute path (or null on
 * cancel). With { allowNew: true } the user may type a new sub-folder name to
 * create under the browsed directory (used for a clone destination).
 */
function pickFolder({ title, allowNew } = {}) {
  $("#picker-title").textContent = title || "Select a folder";
  $("#picker-new").hidden = !allowNew;
  $("#picker-newname").value = "";
  pickerNavigate("").catch((err) => toast(err.message, true));
  $("#picker-dialog").showModal();
  return new Promise((resolve) => {
    picker.resolve = resolve;
  });
}

function pickerFinish(path) {
  $("#picker-dialog").close();
  const resolve = picker.resolve;
  picker.resolve = null;
  resolve?.(path);
}

function wirePicker() {
  $("#picker-up").onclick = () => picker.parent !== null && pickerNavigate(picker.parent);
  $("#picker-cancel").onclick = () => pickerFinish(null);
  $("#picker-choose").onclick = () => {
    if (!picker.cur) return toast("Open a folder first", true);
    const name = $("#picker-newname")?.value.trim();
    const path = !$("#picker-new").hidden && name ? picker.cur + picker.sep + name : picker.cur;
    pickerFinish(path);
  };
  $("#picker-dialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    pickerFinish(null);
  });
}

/** Show a loading placeholder in the Server repositories list while the fast
 * listing request is in flight, so the dialog doesn't look identical whether
 * it's still working or broken. */
function showServerReposLoading() {
  const ul = $("#server-repos");
  ul.innerHTML = `<li class="muted">Loading…</li>`;
  ul.hidden = false;
}

/** Fetch the server's hosted repositories into the Server repositories dialog
 * (server URL from the field, or the default when blank). Renders the fast
 * list immediately, then kicks off the name-conflict cross-check in the
 * background (see verifyServerRepos) — the list itself never waits on it. */
async function loadServerRepos() {
  const server = $("#server-url").value.trim();
  const gen = ++state.serverReposGen;
  const data = await apiGet(`/api/remote-repos${server ? `?url=${encodeURIComponent(server)}` : ""}`);
  if (gen !== state.serverReposGen) return; // a newer load/refresh already superseded this one
  $("#server-url").value = data.base;
  state.serverReposBase = data.base;
  state.serverReposList = data.repos;
  renderServerRepos(data.repos);
  verifyServerRepos(gen, data.base, data.repos.map((r) => r.name));
}

/**
 * Cross-check every rendered name (plus every tracked local repo's name)
 * against the server in the background, via POST /api/remote-repos/verify,
 * and patch in `nameMismatch`/`listed: false` badges once it resolves. Split
 * out from the fast list fetch because this cross-check runs one
 * repositoryInfo probe per name (bounded to 3 concurrent server-side) and a
 * single stalled name can cost the full verb idle timeout — the list itself
 * must never wait on that. Best-effort: a slow or failed verify never surfaces
 * an error toast, since the listing is already fully usable without it.
 * @param {number} gen this call's generation, from loadServerRepos
 * @param {string} base
 * @param {string[]} names
 */
async function verifyServerRepos(gen, base, names) {
  showServerReposChecking(true);
  try {
    const { listed, phantom } = await apiPost("/api/remote-repos/verify", { base, names });
    if (gen !== state.serverReposGen) return; // superseded by a newer load/refresh
    const repos = state.serverReposList.map((r) => {
      const resolvedId = listed[r.name];
      return { ...r, resolvedId, nameMismatch: resolvedId != null && resolvedId !== r.id };
    });
    for (const p of phantom) {
      repos.push({
        id: p.resolvedId,
        name: p.name,
        url: `${base}/${p.name}`,
        idUrl: `${base}/${p.resolvedId}`,
        tracked: p.tracked,
        resolvedId: p.resolvedId,
        nameMismatch: false,
        listed: false,
      });
    }
    state.serverReposList = repos;
    renderServerRepos(repos);
  } catch {
    // Best-effort enhancement — a failed/slow verify doesn't invalidate the
    // already-rendered, already-usable listing.
  } finally {
    if (gen === state.serverReposGen) showServerReposChecking(false);
  }
}

/** Toggle a small non-blocking indicator under the rendered rows while the
 * background name-conflict verify (see verifyServerRepos) is in flight. */
function showServerReposChecking(show) {
  const ul = $("#server-repos");
  let li = ul.querySelector(".server-repos-checking");
  if (show) {
    if (!li) {
      li = document.createElement("li");
      li.className = "muted server-repos-checking";
      li.textContent = "Checking for name conflicts…";
      ul.appendChild(li);
    }
  } else {
    li?.remove();
  }
}

/**
 * Render the repositories the server hosts. Each row offers Clone (hands the
 * remote URL to the clone dialog to pick a destination) and a labeled Delete
 * (removes it from the server by id — see the server's deleteRemoteRepo).
 * Repos already cloned on this machine are tagged, and rows the server's name
 * resolution disagrees with the listing on (`listed: false` / `nameMismatch`,
 * from the background `verifyServerRepos` cross-check) are flagged once it
 * completes — these are exactly the phantom name bindings that make a fresh
 * add collide.
 */
function renderServerRepos(repos) {
  const ul = $("#server-repos");
  ul.innerHTML = "";
  ul.hidden = false;
  if (repos.length === 0) {
    ul.innerHTML = `<li class="muted">— no repositories on this server —</li>`;
    return;
  }
  for (const r of repos) {
    const li = document.createElement("li");
    const tags = [];
    if (r.tracked) tags.push(`<span class="p-tag">cloned</span>`);
    if (r.listed === false) tags.push(`<span class="p-tag warn" title="Resolves to ${r.resolvedId} but repositoryList does not show it — this is a name binding that can collide with a fresh add.">not listed</span>`);
    if (r.nameMismatch) tags.push(`<span class="p-tag warn" title="This name currently resolves to ${r.resolvedId}, not the id shown here.">name mismatch</span>`);
    const title = r.listed === false ? `${r.url} (unlisted — resolves to ${r.resolvedId})` : r.url;
    li.innerHTML =
      `<span class="p-name" title="${title}">${r.name}</span>${tags.join("")}` +
      `<button type="button" class="p-clone">Clone</button>` +
      `<button type="button" class="p-del">Delete</button>`;
    li.querySelector(".p-clone").onclick = () => cloneServerRepo(r);
    li.querySelector(".p-del").onclick = (e) => deleteServerRepo(r, e.currentTarget);
    ul.appendChild(li);
  }
}

/** Start cloning a server repo: prefill and open the clone-from-URL dialog so
 * the user only has to choose a destination folder. */
function cloneServerRepo(r) {
  $("#server-dialog").close();
  $("#clone-url").value = r.url;
  $("#clone-dest").value = "";
  $("#clone-dialog").showModal();
}

/**
 * Delete a server-side repository after confirmation, then refresh the list.
 * Only ever removes the repository from the server: it addresses the server by
 * URL and id alone, never a local path, so no local working copy's files or
 * `.lore` are touched — even if this repo happens to also be cloned locally.
 */
async function deleteServerRepo(r, btn) {
  const warn = r.tracked
    ? "\n\nThis is one of your local working copies — its files on disk and its .lore folder are left untouched; only the server-side repository is removed, leaving this copy orphaned from that remote."
    : "";
  if (!confirm(`Delete "${r.name}" from the server? This cannot be undone.${warn}`)) return;
  // An in-row busy state rather than the global overlay: this fires from
  // inside the Server-repositories dialog, which stays open (the list
  // refreshes in place afterward) — and a showModal() dialog sits above any
  // overlay z-index, so the overlay would be hidden behind it anyway.
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Deleting…";
  }
  try {
    // Act on the server this dialog actually queried, not the input field —
    // it can be blank or stale relative to what's on screen.
    await apiPost("/api/remote-repos", { _method: "DELETE", id: r.id, base: state.serverReposBase });
    toast(`Deleted ${r.name}`);
    await loadServerRepos(); // re-renders the list, replacing this button
  } catch (err) {
    toast(err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

/** Load and display the current remote server configuration. */
async function loadConfig() {
  try {
    const data = await apiGet("/api/config");
    state.defaultRemote = data.defaultRemote || "";
    state.discoveredServers = data.discoveredServers || [];
    $("#settings-remote").value = state.defaultRemote;
    renderDiscoveredServers();
  } catch (err) {
    toast(err.message, true);
  }
}

/** Display the list of discovered servers in the settings dialog. */
function renderDiscoveredServers() {
  const container = $("#discovered-servers");
  const list = $("#discovered-list");
  if (state.discoveredServers.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  list.innerHTML = "";
  for (const server of state.discoveredServers) {
    const li = document.createElement("li");
    li.textContent = server.url;
    li.onclick = () => {
      $("#settings-remote").value = server.url;
    };
    list.appendChild(li);
  }
}

/** Trigger manual discovery of Lore servers and update the list. */
async function discoverServers() {
  // In-button busy state rather than the global overlay: this fires from the
  // Settings dialog, which holds unsaved input (#settings-remote) that closing
  // would discard — and a showModal() dialog outranks any overlay z-index.
  const btn = $("#settings-discover");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Searching…";
  try {
    const data = await apiGet("/api/discover");
    state.discoveredServers = data.discoveredServers || [];
    if (state.discoveredServers.length === 0) {
      toast("No Lore servers found on the local network");
    } else {
      toast(`Found ${state.discoveredServers.length} server${state.discoveredServers.length === 1 ? "" : "s"}`);
    }
    renderDiscoveredServers();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** Save the remote server configuration and refresh repos. */
async function saveConfig() {
  const url = $("#settings-remote").value.trim();
  try {
    await apiPost("/api/config", { defaultRemote: url });
    toast(url ? "Remote server configured" : "Remote server cleared");
    state.defaultRemote = url;
    await loadRepos();
  } catch (err) {
    toast(err.message, true);
  }
}

function wire() {
  $("#add-btn").onclick = addRepo;
  $("#refresh-btn").onclick = refreshActive;
  $("#commit-btn").onclick = commit;
  $("#stage-all-btn").onclick = stageAll;
  $("#unstage-all-btn").onclick = unstageAll;
  $("#revert-all-btn").onclick = revertAll;
  $("#ignore-cancel").onclick = () => $("#ignore-dialog").close();

  $("#sync-btn").onclick = () => runOp("Syncing…", "/api/sync", { path: state.active });
  $("#push-btn").onclick = () => runOp("Pushing…", "/api/push", { path: state.active });
  $("#op-close").onclick = () => ($("#op-overlay").hidden = true);

  // Server repositories: open the dialog and list immediately (it falls back to
  // the default server when the field is blank, so the catalog shows at once).
  // If the last-loaded list is still around for the same server, show it
  // instantly instead of blanking to "Loading…" on every reopen — loadServerRepos
  // silently refreshes it underneath either way, same as a stale-while-
  // revalidate cache.
  $("#server-btn").onclick = async () => {
    const urlField = $("#server-url").value.trim();
    const sameServer = !urlField || urlField === state.serverReposBase;
    if (sameServer && state.serverReposList.length > 0) {
      renderServerRepos(state.serverReposList);
    } else {
      showServerReposLoading();
    }
    $("#server-dialog").showModal();
    const btn = $("#server-refresh");
    btn.disabled = true;
    try {
      await loadServerRepos();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  $("#server-refresh").onclick = async () => {
    const btn = $("#server-refresh");
    btn.disabled = true;
    showServerReposLoading();
    try {
      await loadServerRepos();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };

  $("#clone-btn").onclick = () => $("#clone-dialog").showModal();
  $("#clone-dest-browse").onclick = async () => {
    const dest = await pickFolder({ title: "Clone destination", allowNew: true });
    if (dest) $("#clone-dest").value = dest;
  };
  $("#clone-go").onclick = (e) => {
    const url = $("#clone-url").value.trim();
    const dest = $("#clone-dest").value.trim();
    if (!url || !dest) {
      e.preventDefault();
      return toast("URL and destination required", true);
    }
    setTimeout(async () => {
      await runOp("Cloning…", "/api/clone", { url, dest });
      await loadRepos();
    }, 0);
  };

  $("#repo-org").onclick = () => {
    if (!state.active) return;
    $("#org-repo").textContent = state.org?.repoName
      ? `Repository: ${state.org.repoName}`
      : "";
    $("#org-name").value = state.org?.organization || "";
    $("#org-dialog").showModal();
    $("#org-name").focus();
  };
  $("#org-go").onclick = (e) => {
    const organization = $("#org-name").value.trim();
    if (!organization || organization.includes("/")) {
      e.preventDefault();
      return toast("Organization is required and cannot contain '/'", true);
    }
    const path = state.active;
    // Deferred so the dialog's own form-submit close lands first — a
    // showModal() dialog sits in the top layer, above any overlay z-index.
    setTimeout(async () => {
      try {
        await runBlocking(
          "Changing organization…",
          async () => {
            await apiPost("/api/org", { path, organization });
            if (state.active === path) loadOrg(path);
            await loadRepos();
          },
          { keepOpen: true, successMessage: "Organization changed — repository rebuilt" },
        );
      } catch (err) {
        toast(err.message, true);
      }
    }, 0);
  };

  // Settings dialog
  $("#settings-btn").onclick = async () => {
    await loadConfig();
    $("#settings-dialog").showModal();
  };
  $("#settings-discover").onclick = () => discoverServers();
  $("#settings-go").onclick = () => {
    saveConfig();
    $("#settings-dialog").close();
  };
  $("#settings-dialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("#settings-dialog").close();
  });

  // Branch management
  $("#new-branch-btn").onclick = () => {
    $("#create-branch-name").value = "";
    $("#create-branch-category").value = "user";
    $("#create-branch-dialog").showModal();
    $("#create-branch-name").focus();
  };
  $("#create-branch-go").onclick = createBranch;
  $("#create-branch-cancel").onclick = () => $("#create-branch-dialog").close();
  $("#create-branch-dialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("#create-branch-dialog").close();
  });
  $("#create-branch-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBranch();
  });

  $("#show-archived-check").onchange = () => {
    loadBranches(encodeURIComponent(state.active));
  };

  // Graph zoom/pan controls
  const graphSvg = $("#branch-graph");
  $("#graph-zoom-in").onclick = () => graph.zoomGraph(graphSvg, 1.1);
  $("#graph-zoom-out").onclick = () => graph.zoomGraph(graphSvg, 1 / 1.1);
  $("#graph-zoom-fit").onclick = () => graph.fitGraph(graphSvg);

  $("#merge-go").onclick = confirmMerge;
  $("#merge-cancel").onclick = () => $("#merge-dialog").close();
  $("#merge-dialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("#merge-dialog").close();
  });
  $("#merge-message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) confirmMerge();
  });

  // Merge conflict resolution buttons
  $("#merge-complete-btn").onclick = completeMerge;
  $("#merge-abort-btn").onclick = abortMerge;

  wirePicker();
  wireInit();

  $$(".tab").forEach((tab) => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });

  // Freshness: refetch when the window regains focus (coalesced).
  window.addEventListener("focus", () => {
    if (document.hidden) return;
    scheduleRefresh({ repos: true, active: true });
  });
  // Slow poll catches revisions pushed by the remote (no local fs event).
  setInterval(() => {
    if (state.active && !document.hidden) {
      scheduleRefresh({ active: true });
    }
  }, 10000);
}

wire();
connectSSE();
loadRepos();
