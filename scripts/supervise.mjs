#!/usr/bin/env node
// Keeps the harness server running, and restarts it on request.
//
//   node scripts/supervise.mjs [--watch dir1,dir2] -- <command> [args...]
//
// The server asks for a restart by exiting with code 75 (POST
// /api/admin/restart does that after a settings change); the supervisor starts
// a fresh process straight away, so every value is re-read from .env, including
// PORT and the module-level paths that cannot change in a live process.
//
// --watch replaces `tsx watch` in development: a change to a .ts file under the
// listed directories restarts the server too. `tsx watch` itself cannot be used
// for this, because when its child exits it waits for a file change instead of
// starting the child again.
//
// Any other exit stops the supervisor with the same code — unless it is
// watching, in which case it waits for the next edit like `tsx watch` would.
//
// Plain JavaScript on purpose: it must run before anything is compiled.

import { spawn } from "node:child_process";
import { watch } from "node:fs";

export const RESTART_EXIT_CODE = 75;

const argv = process.argv.slice(2);
let watchDirs = [];
const sep = argv.indexOf("--");
const opts = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? argv : argv.slice(sep + 1);
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === "--watch" && opts[i + 1]) watchDirs = opts[++i].split(",").filter(Boolean);
}
if (command.length === 0) {
  console.error("usage: supervise.mjs [--watch dir1,dir2] -- <command> [args...]");
  process.exit(2);
}

const log = (msg) => console.error(`[supervisor] ${msg}`);

let child = null;
let stopping = false;
/** Why the current child is being stopped by us, so its exit is not mistaken for a crash. */
let restartReason = null;

function start(reason) {
  if (reason) log(`starting server (${reason})`);
  child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, PRMONSTER_SUPERVISED: "1" },
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (restartReason) {
      const why = restartReason;
      restartReason = null;
      start(why);
      return;
    }
    if (code === RESTART_EXIT_CODE) {
      start("restart requested from the admin page");
      return;
    }
    if (watchDirs.length > 0) {
      log(`server exited (${signal ?? `code ${code}`}); waiting for a file change`);
      return;
    }
    log(`server exited (${signal ?? `code ${code}`}); not restarting`);
    process.exit(code ?? 1);
  });
}

function restart(reason) {
  if (!child) {
    start(reason);
    return;
  }
  if (restartReason) return; // already on its way down
  restartReason = reason;
  child.kill("SIGTERM");
}

if (watchDirs.length > 0) {
  let timer = null;
  for (const dir of watchDirs) {
    watch(dir, { recursive: true }, (_event, file) => {
      if (!file || !/\.(ts|tsx|js|mjs|json)$/.test(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(() => restart(`${dir}/${file} changed`), 150);
    });
  }
  log(`watching ${watchDirs.join(", ")}`);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
