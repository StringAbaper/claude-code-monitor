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
};

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Generic GitHub JSON GET (returns parsed body or null)
function ghGet(pathStr) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com${pathStr}`,
      {
        headers: {
          "User-Agent": "claude-code-monitor",
          Accept: "application/vnd.github.v3+json",
        },
        timeout: 10_000,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return resolve(null);
        if (res.statusCode !== 200) return resolve(null);
        let data = "";
        const MAX_BODY = 256 * 1024;
        res.on("data", (c) => { data += c; if (data.length > MAX_BODY) { res.destroy(); resolve(null); } });
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function normalizeTag(tag) {
  if (!tag || typeof tag !== "string") return null;
  const m = tag.match(SEMVER_RE);
  return m ? tag.replace(/^v/, "") : null;
}

// Fetch latest stable release tag (excludes prereleases — uses /releases/latest which already does this)
async function fetchLatestRelease() {
  const json = await ghGet(`/repos/${REPO}/releases/latest`);
  if (!json) {
    // Fallback: tag list via git ls-remote
    return fetchLatestTag();
  }
  return normalizeTag(json.tag_name);
}

// Fetch latest prerelease tag (highest semver among prereleases)
async function fetchLatestPrerelease() {
  const list = await ghGet(`/repos/${REPO}/releases?per_page=20`);
  if (!Array.isArray(list)) return null;
  const candidates = list
    .filter((r) => r && r.prerelease && !r.draft)
    .map((r) => normalizeTag(r.tag_name))
    .filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => cmpSemver(b, a)); // descending
  return candidates[0];
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

// Full semver compare with prerelease support.
// Returns >0 if a>b, <0 if a<b, 0 if equal. Invalid inputs compare as 0.
function cmpSemver(a, b) {
  const ma = (a || "").match(SEMVER_RE);
  const mb = (b || "").match(SEMVER_RE);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = (+ma[i] || 0) - (+mb[i] || 0);
    if (d) return d;
  }
  // Same X.Y.Z — compare prerelease tags per semver 2.0.0 §11
  const pa = ma[4], pb = mb[4];
  if (!pa && !pb) return 0;
  if (!pa) return 1;  // release > prerelease
  if (!pb) return -1;
  const aIds = pa.split("."), bIds = pb.split(".");
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const x = aIds[i], y = bIds[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = +x - +y;
      if (d) return d;
    } else if (xn) {
      return -1; // numeric < alphanumeric
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isNewer(remote, local) {
  return cmpSemver(remote, local) > 0;
}

// Check for updates (does NOT apply them)
async function checkForUpdate(channel) {
  const ch = ALLOWED_CHANNELS.has(channel) ? channel : updateState.channel;
  updateState.channel = ch;
  updateState.currentVersion = getCurrentVersion();
  try {
    const latest = ch === "beta" ? await fetchLatestPrerelease() : await fetchLatestRelease();
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
