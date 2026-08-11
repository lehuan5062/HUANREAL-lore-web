# lore-web

A self-hosted browser UI for the [Lore](https://epicgames.github.io/lore/) version
control system. It drives Lore through the same `@lore-vcs/sdk` engine the
official desktop app uses, but with refresh logic that never serves a stale
cache — lists update live from disk and after every action.

It runs identically on two kinds of machine:

- **Host** — a machine with a local `lore-server`. lore-web manages local working
  copies and is the push/sync target for collaborators.
- **Collaborator** — a machine with no server. lore-web drives `clone` / `sync` /
  `push` against a host's server over the network. It needs only the SDK
  dependency and a one-time `lore login`.

## Features

- **Live refresh** — repository and revision lists update instantly on disk changes
  or after any action, with no manual cache clear.
- **Visual branch graph** — all branches and commits as an interactive graph with
  wheel zoom, drag pan, and fit controls; click any revision to see its details or
  sync the working copy to it. Every branch stays visible: children of archived
  branches attach to the nearest visible ancestor, and branches with no commits of
  their own are labeled at the revision they point to.
- **Branch management** — create, switch, archive, and merge branches directly
  from the web UI, with per-file conflict resolution for merges. Branches archived
  by a teammate are flagged **local only** so each collaborator can tidy their own
  list, and branches that exist on the server but not yet in your working copy are
  flagged **remote only**.
- **Safe by default** — merges state their target branch and are refused server-side
  if the working copy's current branch changed underneath. The Changes panel can
  unstage every staged file at once, or revert every unstaged change in bulk
  (discarding edits and deleting new files, after a confirmation).

## Why this exists

The official desktop app persists its entire UI state to SQLite and rehydrates
it on launch, with no file watching — so repository and revision lists go stale
until you restart or clear the cache, and it refuses to remove a repository whose
folder was deleted. lore-web fixes these by owning the refresh path: see
[docs/explanation/architecture.md](docs/explanation/architecture.md).

## Quick start

### Windows (no terminal needed)

1. Double-click **`setup.bat`** — checks for Node.js and the `lore` CLI (offering
   to install anything missing) and installs the SDK.
2. Double-click **`start.bat`** — launches the app and opens
   `http://127.0.0.1:7420`. (It also runs setup automatically on first use, so you
   can skip step 1 and run `start.bat` directly.)

### Any platform (terminal)

```sh
git clone <this-repo-url>
cd HUANREAL-Lore-Web
npm install       # pulls @lore-vcs/sdk (and its native lorelib) from npm
npm start         # launch the server and open http://127.0.0.1:7420
```

Then click **Add**, paste the path to a Lore working copy, and you're in.

### Setting up a collaborator machine

This repository is self-contained — a collaborator clones it and works through
these four steps once. Steps 3 and 4 happen in the app, and skipping step 3 is
what leaves a fresh install pointed at no server at all.

1. Run **`setup.bat`** (or `npm install`) — installs Node.js if needed, the SDK,
   and the `lore` CLI.
2. `lore login lore://<your-host>:41337` — authenticate against the host's server.
3. Start the app, click **⚙** beside the logo, and set the **remote server URL**
   to the same `lore://<your-host>:41337`.
4. Click **Add** and paste the path to a working copy — or **Clone from URL…** to
   fetch one from the server.

> **Updating an existing install:** run **`setup.bat`**, not `start.bat`.
> `start.bat` skips setup whenever `node_modules/@lore-vcs/sdk` already exists,
> so an old SDK survives the update silently. See
> [Versions](#versions).

See the [how-to guide](docs/how-to/run-lore-web.md) for the longer walkthrough.

- Run headless (no browser auto-open): `npm run serve`
- Run the tests: `npm test`
- Smoke-test the SDK against a repo: `npm run smoke -- "D:\path\to\repo"`

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LORE_WEB_PORT` | `7420` | HTTP port |
| `LORE_WEB_HOST` | `127.0.0.1` | bind address — keep it loopback |
| `LORE_WEB_LOG_LEVEL` | `info` | `trace`…`error` |
| `LORE_WEB_STORE` | `~/.lore-web/store.json` | tracked-repo list location |
| `LORE_WEB_DEFAULT_REMOTE` | none | initial remote server URL, seen once on first run |
| `LORE_CLI` | `lore` | path to the `lore` CLI (login/service fallback) |

The remote server (the `lore://host:port` a new repository is created under, and
where **Server repositories…**/**Clone from URL…** look) is set from the app
itself: click the **⚙** button beside the `lore web` logo. This is how a
collaborator points lore-web at their host's server — see
[Set up a collaborator](docs/how-to/run-lore-web.md#set-up-a-collaborator-no-server).
`LORE_WEB_DEFAULT_REMOTE` only seeds the value before it has ever been set
through the app; once configured, the app's own setting takes over.

> **Security:** lore-web exposes full read/write access to your repositories and
> is bound to loopback only. Never expose it on a network. The *Lore server* is
> the networked component, not lore-web.

## Runtime dependencies

lore-web needs **two** Lore clients, and they are upgraded separately.

**1. `@lore-vcs/sdk`** (required) — the primary engine, from the public npm
registry. `npm install` also pulls the platform-specific native library
(`lorelib`) and `koffi` automatically. No binaries are committed to the repo.

**2. The `lore` CLI on `PATH`** (strongly recommended) — a few operations run as
a subprocess instead of in-process. Set `LORE_CLI` to an absolute path if the
binary is not on `PATH`. It is used for:

| Feature | Without the CLI |
|---|---|
| Login status / `lore login` | The app cannot tell whether you are authenticated |
| Deleting a repository on the server | That action fails |
| **Local-only / remote-only branch badges** | **Degrades silently** — branches still list from local data, the badges just stop appearing |
| **"Server repositories…" browser** | Shows an error when opened |

The last two moved to the CLI deliberately: the SDK cannot cancel an in-flight
call, so a call that hangs against an unreachable server permanently occupies a
threadpool worker, while a hung subprocess can simply be killed. `lore --json`
emits the same events the SDK does. See `LORE_BUG_PROMPTS.md` (P5 BUG 1) for the
upstream bug, and run `node scripts/check-lore-updates.mjs` to see when it is
fixed and these shims can be reverted.

### Versions

The SDK, the `lore` CLI, and `loreserver` are **three separate upgrades** —
bumping one does not touch the others, and mixing versions has bitten us before.
Current baseline: SDK `0.8.6`, CLI `0.8.6`, server `0.8.6`.

- SDK: bump the version in `package.json`, then `npm install`.
- CLI and server: install from the
  [Lore releases](https://github.com/EpicGames/lore/releases).

Keep the SDK at least version-matched to the server you talk to. Older clients
lack the transport connect timeouts, which turns an unreachable remote into a
~30 s stall on every call rather than a prompt failure.

> **Updating an existing install:** run **`setup.bat`**, not `start.bat`.
> `start.bat` only runs setup when `node_modules/@lore-vcs/sdk` is *absent*, so
> an existing install keeps whatever SDK version it already had — silently.
> `setup.bat` always runs `npm install`.

## Documentation

- [How to run lore-web](docs/how-to/run-lore-web.md) — setup, and collaborator login
- [HTTP API reference](docs/reference/http-api.md) — every endpoint
- [Architecture](docs/explanation/architecture.md) — how it works and why
