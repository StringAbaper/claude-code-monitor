const https = require("https");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO = "bruceyxli/claude-code-monitor";
const CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const ROOT_DIR = path.join(__dirname, "..");

// State
let updateState = {
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  lastCheck: null,
  lastError: null,
  updating: false,
  lastUpdate: null,
};

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Fetch latest release tag from GitHub API (no dependencies needed)
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          "User-Agent": "claude-code-monitor",
          Accept: "application/vnd.github.v3+json",
        },
        timeout: 10_000,
      },
      (res) => {
        // Handle redirects
        if (res.statusCode === 302 || res.statusCode === 301) {
          return resolve(null);
        }
        if (res.statusCode === 404) {
          // No releases yet — try tags instead
          return fetchLatestTag().then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return resolve(null);
        }
        let data = "";
        const MAX_BODY = 1024 * 1024; // 1MB limit
        res.on("data", (c) => { data += c; if (data.length > MAX_BODY) { res.destroy(); resolve(null); } });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const tag = (json.tag_name || "").replace(/^v/, "");
            // Validate semver format
            resolve(/^\d+\.\d+\.\d+/.test(tag) ? tag : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Fallback: fetch latest tag via git ls-remote
function fetchLatestTag() {
  return new Promise((resolve) => {
    try {
      const output = execSync(
        `git ls-remote --tags --sort=-v:refname https://github.com/${REPO}.git`,
        { encoding: "utf8", timeout: 10_000, cwd: ROOT_DIR }
      );
      const lines = output.trim().split("\n");
      for (const line of lines) {
        const match = line.match(/refs\/tags\/v?([\d.]+)$/);
        if (match) return resolve(match[1]);
      }
      resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Compare semver: returns true if remote > local
function isNewer(remote, local) {
  if (!remote || !local) return false;
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

// Check for updates (does NOT apply them)
async function checkForUpdate() {
  updateState.currentVersion = getCurrentVersion();
  try {
    const latest = await fetchLatestRelease();
    updateState.lastCheck = Date.now();
    if (latest) {
      updateState.latestVersion = latest;
      updateState.updateAvailable = isNewer(latest, updateState.currentVersion);
      updateState.lastError = null;
    }
  } catch (err) {
    updateState.lastError = err.message;
  }
  return updateState;
}

// Apply update via git pull + npm install
function applyUpdate() {
  if (updateState.updating) return { ok: false, error: "Update already in progress" };
  if (!updateState.updateAvailable) return { ok: false, error: "No update available" };

  updateState.updating = true;
  let stashed = false;
  try {
    // Stash any local changes
    try {
      const stashOut = execSync("git stash", { cwd: ROOT_DIR, encoding: "utf8", timeout: 15_000 });
      stashed = !stashOut.includes("No local changes");
    } catch {
      // No changes to stash, that's fine
    }

    // Pull latest
    const pullOutput = execSync("git pull origin master", {
      cwd: ROOT_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });

    // Restore stashed changes
    if (stashed) {
      try { execSync("git stash pop", { cwd: ROOT_DIR, encoding: "utf8", timeout: 15_000 }); } catch {}
    }

    // Install dependencies if package.json changed
    if (pullOutput.includes("package.json") || pullOutput.includes("package-lock.json")) {
      execSync("npm install --production", {
        cwd: ROOT_DIR,
        encoding: "utf8",
        timeout: 60_000,
      });
    }

    updateState.currentVersion = getCurrentVersion();
    updateState.updateAvailable = false;
    updateState.updating = false;
    updateState.lastUpdate = Date.now();
    updateState.lastError = null;

    return { ok: true, version: updateState.currentVersion, needsRestart: true };
  } catch (err) {
    // Restore stashed changes on failure
    if (stashed) {
      try { execSync("git stash pop", { cwd: ROOT_DIR, encoding: "utf8", timeout: 15_000 }); } catch {}
    }
    updateState.updating = false;
    updateState.lastError = err.message;
    return { ok: false, error: err.message };
  }
}

function getUpdateState() {
  if (!updateState.currentVersion) {
    updateState.currentVersion = getCurrentVersion();
  }
  return { ...updateState };
}

// Start periodic checking (called from server.js)
let checkTimer = null;
async function runAutoCheck(store, broadcast) {
  if (!store.getConfig().autoUpdateEnabled) return;
  await checkForUpdate();
  if (updateState.updateAvailable && store.getConfig().autoUpdateEnabled) {
    const result = applyUpdate();
    if (result.ok) {
      console.log(`  Auto-updated to v${result.version}. Restart required.`);
    }
  }
  broadcast();
}

function startPeriodicCheck(store, broadcast) {
  // Initial check after 30s
  setTimeout(() => runAutoCheck(store, broadcast), 30_000);
  // Periodic check every hour
  checkTimer = setInterval(() => runAutoCheck(store, broadcast), CHECK_INTERVAL_MS);
}

function stopPeriodicCheck() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

module.exports = {
  checkForUpdate,
  applyUpdate,
  getUpdateState,
  startPeriodicCheck,
  stopPeriodicCheck,
};
