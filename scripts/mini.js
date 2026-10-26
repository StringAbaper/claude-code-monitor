#!/usr/bin/env node
// Opens the desktop mini window: a small frameless window that stays on
// top of every other one. Windows only — it is PowerShell + WPF, both part
// of the OS, so there is nothing to install. See lib/mini.js.
//
// The window runs on its own: closing this terminal leaves it open, and
// running this again while it is open does nothing. Errors it hits are
// written to data/mini.log, since it has no console to show them in.

const mini = require("../lib/mini");

if (!mini.open()) {
  console.error(`The mini window is only implemented for Windows; this is ${process.platform}.`);
  process.exit(1);
}
