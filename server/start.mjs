// Launch the server (if not already running) and open it in the default browser.
// This is the everyday entry point (`npm start` / start.bat); use `npm run serve`
// to run headless without opening a browser.

// Koffi runs native SDK calls on the libuv threadpool, whose default of 4
// workers throttles multi-repo enrichment on startup. libuv sizes the pool
// lazily on its first use — which, now that index.mjs loads the SDK only after
// the port is bound (see server/sdk-lazy.mjs), happens well after this module
// runs. Setting it here still takes effect; it just no longer has to beat an
// import to do so.
//
// This is also the only real mitigation for a harder problem: the SDK exposes
// no way to cancel or time out a stuck native call (see collect()'s idle
// timeout in sdk.mjs), so a verb that blocks forever on an unresponsive remote
// permanently occupies one worker thread for the rest of the process's life.
// Enough of those exhaust the pool and stall every other async call in the
// process, Lore-related or not (fs, dns, crypto, zlib all share it too).
// Raising this only buys headroom — it cannot fix the underlying leak — but
// headroom is cheap (threads here are lightweight), so size it generously.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "32";

import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { log } from "./log.mjs";
import { sinceLaunch } from "./launch.mjs";

const host = process.env.LORE_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.LORE_WEB_PORT ?? 7420);
const url = `http://${host}:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve true if something is already listening on the target port. */
function isUp() {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

/**
 * Kill whatever is listening on the target port so a restart always loads
 * current code. Only spawns a process when something is actually up — the common
 * case (first launch) skips it entirely rather than paying PowerShell's startup
 * cost on every launch.
 */
function killExisting() {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
        "Select-Object -ExpandProperty OwningProcess -Unique | " +
        "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
    ],
    { stdio: "ignore" }
  );
}

/** Open the URL with the platform's default browser opener. */
function openBrowser() {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is best-effort; the URL is printed below regardless.
  }
}

// Stop any instance already running so a restart always loads current code, and
// wait for its port to actually close — index.mjs now binds within milliseconds
// of launch, so it lands much closer to this kill than it used to and would
// otherwise race it into EADDRINUSE.
if (await isUp()) {
  console.log(`[lore-web] Stopping existing instance on ${url}...`);
  killExisting();
  for (let i = 0; i < 20 && (await isUp()); i++) await sleep(100);
}
log.debug("startup: preflight done", { sinceLaunchMs: sinceLaunch() });

// index.mjs binds the port during import and resolves `whenListening` from the
// listen callback. Awaiting that promise (rather than polling the port) is what
// makes the browser open before the blocking native load starts: continuations
// of an already-resolved promise are microtasks, and those always run before the
// timer that index.mjs uses to defer the SDK. See the comment there.
const { whenListening } = await import("./index.mjs");

const READY_TIMEOUT_MS = 10_000;
const ready = await Promise.race([
  whenListening.then(() => true),
  sleep(READY_TIMEOUT_MS).then(() => false),
]);

if (ready) {
  console.log(`\nlore-web is running. Opening ${url}`);
  console.log(`If your browser does not open, go to ${url} manually.\n`);
  openBrowser();
  log.debug("startup: browser spawned", { sinceLaunchMs: sinceLaunch() });
} else {
  console.error(`Server did not become ready on ${url}. Check the log above.`);
  process.exit(1);
}
