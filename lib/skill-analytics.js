// ──────────────────────────────────────────────
// Skill Analytics — pure logic
// ──────────────────────────────────────────────
// This module is INTENTIONALLY isolated. It must not require any
// other lib/ file. Inputs are plain objects + filesystem paths;
// outputs are plain objects. The only I/O is synchronous fs reads
// of SKILL.md files (already inside the project's threat model —
// same sensitivity tier as the existing transcript reads).
//
// Rationale: if at any point we want to extract this as a standalone
// `ccb-skill-stats` npm package, this entire file becomes the
// package's index.js with zero changes. A 30-line CLI wrapper +
// package.json is all that's needed.
//
// Self-isolation is enforced by lib/skill-analytics.test.js via a
// require.cache assertion.
// ──────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");

// Defensive bounds — prevent a malicious or malformed SKILL.md from
// ballooning the index in memory.
const MAX_SCALAR_LEN = 500;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_LEN = 100;

// ──────────────────────────────────────────────
// Frontmatter parser (YAML-lite, single-pass)
// ──────────────────────────────────────────────
// Grammar:
//   --- (opening fence on its own line)
//   key: value           (scalar)
//   key: "quoted value"  (quoted scalar — outer quotes stripped)
//   key: true|false      (boolean)
//   key:                 (list header — followed by indented "- item")
//     - item
//     - item
//   --- (closing fence)
//
// Returns the parsed object on success, or null on any structural error.
function parseFrontmatter(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  // Find opening ---
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "---") return null;
  i++;
  const out = {};
  let currentListKey = null;
  let sawClose = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") { sawClose = true; break; }
    // List item under a list header
    if (currentListKey && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      if (out[currentListKey].length < MAX_LIST_ITEMS) {
        out[currentListKey].push(item.slice(0, MAX_LIST_ITEM_LEN));
      }
      continue;
    }
    // Otherwise we've left any in-progress list
    currentListKey = null;
    if (line.trim() === "") continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) return null; // structural error
    const key = m[1];
    const rawVal = m[2];
    if (rawVal === "") {
      // List header
      out[key] = [];
      currentListKey = key;
    } else if (rawVal === "true") {
      out[key] = true;
    } else if (rawVal === "false") {
      out[key] = false;
    } else if (rawVal.startsWith("\"") && rawVal.endsWith("\"") && rawVal.length >= 2) {
      out[key] = rawVal.slice(1, -1).slice(0, MAX_SCALAR_LEN);
    } else {
      out[key] = rawVal.slice(0, MAX_SCALAR_LEN);
    }
  }
  if (!sawClose) return null;
  return out;
}

// ──────────────────────────────────────────────
// Skill repo loader
// ──────────────────────────────────────────────
function parseSkillRepo(absPath) {
  const errors = [];
  const skillIndex = {};
  if (!absPath || typeof absPath !== "string" || !fs.existsSync(absPath)) {
    return { skillIndex, errors: [{ path: absPath || "", error: "not found" }] };
  }
  // Try canonical CCB-skills layout first: <repo>/commands/*.md
  const candidates = [
    path.join(absPath, "commands"),
    absPath,
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
    } catch (e) {
      errors.push({ path: dir, error: e.message });
      continue;
    }
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const text = fs.readFileSync(fp, "utf8");
        const fm = parseFrontmatter(text);
        if (!fm || !fm.name) {
          errors.push({ path: fp, error: "no valid frontmatter or missing name" });
          continue;
        }
        skillIndex[fm.name] = fm;
      } catch (e) {
        errors.push({ path: fp, error: e.message });
      }
    }
    if (Object.keys(skillIndex).length > 0) break;
  }
  return { skillIndex, errors };
}

// ──────────────────────────────────────────────
// Aggregator
// ──────────────────────────────────────────────
// skillCalls: array of { time, name }
// skillIndex: { name → frontmatter object }
function aggregateCalls(skillCalls, skillIndex) {
  const calls = Array.isArray(skillCalls) ? skillCalls : [];
  const idx = (skillIndex && typeof skillIndex === "object") ? skillIndex : {};
  if (calls.length === 0) {
    return {
      perSkill: {},
      chainEdges: {},
      totals: { totalCalls: 0, distinctSkills: 0, destructiveCalls: 0, unknownCalls: 0 },
      lastCall: null,
    };
  }
  const perSkill = {};
  const chainEdges = {};
  let destructiveCalls = 0;
  let unknownCalls = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] || {};
    const name = typeof call.name === "string" ? call.name : "";
    if (!name) continue;
    const fm = idx[name] || null;
    const isDestructive = !!(fm && fm.destructive);
    const isUnknown = !fm;
    if (!perSkill[name]) {
      perSkill[name] = {
        name,
        count: 0,
        lastUsed: 0,
        destructive: isDestructive,
        unknown: isUnknown,
        suggestsNext: fm && Array.isArray(fm.suggests_next) ? fm.suggests_next : [],
      };
    }
    perSkill[name].count++;
    const t = typeof call.time === "number" ? call.time : 0;
    if (t > perSkill[name].lastUsed) perSkill[name].lastUsed = t;
    if (isDestructive) destructiveCalls++;
    if (isUnknown) unknownCalls++;
    if (i + 1 < calls.length) {
      const nextName = (calls[i + 1] || {}).name;
      if (typeof nextName === "string" && nextName) {
        const edgeKey = name + "→" + nextName;
        chainEdges[edgeKey] = (chainEdges[edgeKey] || 0) + 1;
      }
    }
  }
  // lastCall — the most recent entry by array order (skillCalls is appended in order)
  const lastEntry = calls[calls.length - 1] || null;
  const lastCall = lastEntry && typeof lastEntry.name === "string"
    ? { name: lastEntry.name, time: typeof lastEntry.time === "number" ? lastEntry.time : 0 }
    : null;
  return {
    perSkill,
    chainEdges,
    totals: {
      totalCalls: calls.length,
      distinctSkills: Object.keys(perSkill).length,
      destructiveCalls,
      unknownCalls,
    },
    lastCall,
  };
}

// ──────────────────────────────────────────────
// Auto-probe for the CCB-skills repo
// ──────────────────────────────────────────────
// Returns the first existing path from a sensible set of conventions,
// or null if none match. Users with a non-standard layout set
// `skillRepoPath` in config explicitly.
function autoProbeSkillRepo() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "CCB-skills"),
    path.join(home, "Projects", "CCB-skills"),
    path.join(home, "code", "CCB-skills"),
    path.join(home, "dev", "CCB-skills"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

module.exports = {
  parseFrontmatter,
  parseSkillRepo,
  aggregateCalls,
  autoProbeSkillRepo,
};
