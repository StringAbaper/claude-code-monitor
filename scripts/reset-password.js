#!/usr/bin/env node
// Reset the dashboard password by clearing dashboardPasswordHash from
// data/config.json. The server's first-run path will then prompt the
// user to set a new password on next login.
//
// Usage: npm run reset-password
//
// Does NOT touch apiToken, anomaly config, machineNames, or sessions.

const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "..", "data", "config.json");

if (!fs.existsSync(CONFIG_FILE)) {
  console.error("No data/config.json found. Nothing to reset.");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (err) {
  console.error("Failed to parse data/config.json:", err.message);
  process.exit(1);
}

if (!data.dashboardPasswordHash) {
  console.log("Dashboard password is already unset. No changes made.");
  console.log("Restart the server and visit the dashboard to set a new password.");
  process.exit(0);
}

delete data.dashboardPasswordHash;

// Atomic write (matches lib/store.js writeFileAtomic behavior)
const tmp = CONFIG_FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
fs.renameSync(tmp, CONFIG_FILE);

console.log("Dashboard password cleared.");
console.log("Restart the server (npm start) and visit the dashboard — you'll be prompted to set a new password.");
console.log("Note: API token and all other settings are preserved.");
