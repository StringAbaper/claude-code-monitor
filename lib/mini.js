const { spawn } = require("child_process");
const path = require("path");

// ──────────────────────────────────────────────
// Desktop mini window (Windows)
// ──────────────────────────────────────────────
// A small frameless window that stays on top of every other one; the
// window itself is scripts/mini.ps1. Opened from `npm run mini` and from
// the dashboard's ⧉ button, which asks the server to open it — so it
// appears on the desktop of the machine running the server.
//
// It goes through scripts/mini.vbs rather than spawning PowerShell
// directly: a detached child gets no console, and Windows PowerShell
// without one exits immediately — no window, no error, exit code 0.
// Detached, it outlives whoever opened it, server included. Opening it
// while it is already open does nothing: the script holds a mutex.

const SHIM = path.join(__dirname, "..", "scripts", "mini.vbs");

function isSupported() {
  return process.platform === "win32";
}

// Returns false when there is no mini window on this platform.
function open() {
  if (!isSupported()) return false;
  spawn("wscript.exe", [SHIM], { detached: true, stdio: "ignore" }).unref();
  return true;
}

module.exports = { isSupported, open };
