const https = require("https");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO = "bruceyxli/claude-code-monitor";
const CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
const ROOT_DIR = path.join(__dirname, "..");
const ALLOWED_CHANNELS = new Set(["stable", "beta"]);
const BETA_BRANCH = "beta";

// State
let updateState = {
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  lastCheck: null,
  lastError: null,
  updating: false,
  lastUpdate: null,
  channel: "stable",
  currentSha: null,
  remoteSha: null,
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
        const MAX_BODY = 64 * 1024; // 64KB — generous for a release JSON
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

// Get current local commit SHA (for beta channel)
function getCurrentSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT_DIR, encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

// Get remote branch SHA via ls-remote (no auth needed for public repo)
function fetchRemoteBranchSha(branch) {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9_\-]+$/.test(branch)) return resolve(null);
    try {
      const output = execSync(
        `git ls-remote https://github.com/${REPO}.git refs/heads/${branch}`,
        { encoding: "utf8", timeout: 10_000, cwd: ROOT_DIR }
      );
      const m = output.match(/^([a-f0-9]{40})\s/);
      resolve(m ? m[1] : null);
    } catch {
      resolve(null);
    }
  });
}

// Check for updates (does NOT apply them)
async function checkForUpdate(channel) {
  const ch = ALLOWED_CHANNELS.has(channel) ? channel : updateState.channel;
  updateState.channel = ch;
  updateState.currentVersion = getCurrentVersion();
  try {
    if (ch === "beta") {
      updateState.currentSha = getCurrentSha();
      const remote = await fetchRemoteBranchSha(BETA_BRANCH);
      updateState.lastCheck = Date.now();
      if (remote) {
        updateState.remoteSha = remote;
        updateState.latestVersion = `beta@${remote.slice(0, 7)}`;
        updateState.updateAvailable = remote !== updateState.currentSha;
        updateState.lastError = null;
      }
    } else {
      const latest = await fetchLatestRelease();
      updateState.lastCheck = Date.now();
      if (latest) {
        updateState.latestVersion = latest;
        updateState.updateAvailable = isNewer(latest, updateState.currentVersion);
        updateState.lastError = null;
      }
    }
  } catch (err) {
    updateState.lastError = err.message;
  }
  return updateState;
}

// Mutex: prevent concurrent applyUpdate calls
let updateLock = false;

// Apply update via git pull --ff-only + npm install
// REPO is hardcoded — never interpolate user input into execSync commands.
function applyUpdate() {
  if (updateLock) return { ok: false, error: "Update already in progress" };
  if (!updateState.updateAvailable) return { ok: false, error: "No update available" };

  updateLock = true;
  updateState.updating = true;
  let stashed = false;
  // Hardcoded branch names — never interpolate user input.
  const branch = updateState.channel === "beta" ? BETA_BRANCH : "master";
  try {
    // Stash any local changes
    try {
      const stashOut = execSync("git stash", { cwd: ROOT_DIR, encoding: "utf8", timeout: 15_000 });
      stashed = !stashOut.includes("No local changes");
    } catch (stashErr) {
      // Only ignore "nothing to stash" errors
      if (stashErr.stderr && !stashErr.stderr.includes("No local changes")) {
        throw new Error("git stash failed: " + (stashErr.stderr || stashErr.message));
      }
    }

    // Pull latest (--ff-only prevents merge commits on diverged branches)
    // For beta we fetch + checkout the branch first in case the local repo is on master
    if (branch === BETA_BRANCH) {
      execSync(`git fetch origin ${BETA_BRANCH}`, { cwd: ROOT_DIR, encoding: "utf8", timeout: 30_000 });
      execSync(`git checkout ${BETA_BRANCH}`, { cwd: ROOT_DIR, encoding: "utf8", timeout: 15_000 });
    }
    const pullOutput = execSync(`git pull --ff-only origin ${branch}`, {
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
  } finally {
    updateLock = false;
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
  await checkForUpdate(store.getConfig().updateChannel);
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
