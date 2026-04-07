// ──────────────────────────────────────────────
// Schema-driven dashboard config
// ──────────────────────────────────────────────
// One source of truth for the 8 user-facing dashboard settings.
// loadConfig / saveConfig / setConfig / getConfig in store.js all
// delegate here. Adding a new setting = one row in SCHEMA.
//
// NOT covered here: apiToken, dashboardPasswordHash, machineNames,
// anomaly subconfig — those are runtime secrets / persistent state /
// delegated submodules and stay in store.js.
// ──────────────────────────────────────────────

const SCHEMA = {
  remoteApprovalEnabled: { type: "boolean", default: true },
  autoApproveEnabled:    { type: "boolean", default: false },
  stoppedCleanupMinutes: { type: "int",     default: 1440, min: 1, max: 43200 },
  showTokenChart:        { type: "boolean", default: true },
  autoArchiveStopped:    { type: "boolean", default: false },
  autoUpdateEnabled:     { type: "boolean", default: false },
  updateChannel:         { type: "enum",    default: "stable",  values: ["stable", "beta"] },
  uiSkin:                { type: "enum",    default: "default", values: ["default", "linear", "sentry", "raycast"] },
};

// Module state — initialized on first load() call
const state = {};
for (const [k, def] of Object.entries(SCHEMA)) state[k] = def.default;

// Coerce a raw value to the schema-declared type. Returns the validated
// value, or `undefined` if the input fails validation. Strict — never
// auto-converts strings to booleans/numbers.
function coerce(name, raw) {
  const def = SCHEMA[name];
  if (!def) return undefined;
  switch (def.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "int": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      const n = Math.floor(raw);
      const lo = def.min != null ? def.min : Number.MIN_SAFE_INTEGER;
      const hi = def.max != null ? def.max : Number.MAX_SAFE_INTEGER;
      return Math.max(lo, Math.min(hi, n));
    }
    case "enum":
      return typeof raw === "string" && def.values.includes(raw) ? raw : undefined;
    case "string": {
      if (typeof raw !== "string") return undefined;
      if (def.maxLength != null && raw.length > def.maxLength) return undefined;
      return raw;
    }
    default:
      return undefined;
  }
}

// Hydrate state from a raw JSON object (e.g. parsed config.json).
// Unknown keys are silently ignored.
function load(raw) {
  if (!raw || typeof raw !== "object") return;
  for (const name of Object.keys(SCHEMA)) {
    if (raw[name] === undefined) continue;
    const v = coerce(name, raw[name]);
    if (v !== undefined) state[name] = v;
  }
}

// Apply partial updates. Returns { changed: boolean }.
// Unknown keys silently ignored. Invalid values silently rejected.
function set(updates) {
  if (!updates || typeof updates !== "object") return { changed: false };
  let changed = false;
  for (const name of Object.keys(updates)) {
    if (!(name in SCHEMA)) continue;
    const v = coerce(name, updates[name]);
    if (v === undefined) continue;
    if (state[name] !== v) {
      state[name] = v;
      changed = true;
    }
  }
  return { changed };
}

// Snapshot of current values. Always contains every schema key.
function get() {
  const out = {};
  for (const k of Object.keys(SCHEMA)) out[k] = state[k];
  return out;
}

module.exports = {
  SCHEMA,
  load,
  set,
  get,
  coerce, // exported for unit testing
};
