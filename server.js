const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const path = require("path");
const os = require("os");

const store = require("./lib/store");
const routes = require("./lib/routes");
const { timingSafeEqual } = require("./lib/auth");
const updater = require("./lib/updater");

const PORT = process.env.PORT || 7888;
const USE_HTTPS = process.argv.includes("--https") || process.env.HTTPS === "true";

// ──────────────────────────────────────────────
// Startup (load config first so token is available)
// ──────────────────────────────────────────────
store.loadConfig();
store.loadSessions();

// ──────────────────────────────────────────────
// HTTPS cert setup
// ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const CERT_PATH = path.join(DATA_DIR, "cert.pem");
const KEY_PATH = path.join(DATA_DIR, "key.pem");

function ensureCerts() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return true;
  }
  console.log("  Generating self-signed certificate...");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const { execSync } = require("child_process");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 365 -nodes -subj "/CN=claude-code-monitor"`,
      { stdio: "pipe" }
    );
    console.log("  Self-signed certificate created in data/");
    return true;
  } catch {
    console.error("  ERROR: openssl not found. Install openssl or manually place cert.pem and key.pem in data/");
    return false;
  }
}

// ──────────────────────────────────────────────
// Express + WebSocket
// ──────────────────────────────────────────────
const app = express();
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "1mb" }));

// CSRF / blind cross-origin POST defense.
// Every state-changing request to /api/* must carry an Authorization
// header. /api/login is the one exception (it issues the token). The
// browser will not attach Authorization on a cross-origin fetch unless
// the attacker controls a same-origin script, which would already
// require a separate breach. This middleware is cheap and turns CORS
// into a non-issue for the dashboard.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/login") return next();
  if (!req.headers.authorization) {
    return res.status(403).json({ error: "Authorization header required" });
  }
  next();
});
// Serve dashboard with no-cache so HTML/JS/CSS updates are picked up
// immediately after a server restart instead of waiting for the user
// to hard-refresh.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

let server;
if (USE_HTTPS) {
  if (!ensureCerts()) {
    console.error("  HTTPS enabled but certificates unavailable. Exiting.");
    process.exit(1);
  }
  server = https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  }, app);
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server, path: "/ws" });

function augmentState(data) {
  if (data && data.type === "update") data.updateState = updater.getUpdateState();
  return data;
}

function broadcast(data) {
  const msg = JSON.stringify(augmentState(data));
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (!timingSafeEqual(token, store.getApiToken())) {
    ws.close(4001, "Unauthorized");
    return;
  }
  ws.send(JSON.stringify(augmentState(store.getFullState())));
  ws.on("error", () => {});
});

// Register all API routes
routes.register(app, broadcast);

// Generic error handler — catches any exception thrown out of a route
// handler that did not use its own try/catch. Returns a generic 500
// without leaking stack traces or internal state. Logs to stderr for
// local debugging.
// Must be declared AFTER routes.register so it's the last middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("  [server] Unhandled route error:", err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
});

// ──────────────────────────────────────────────
// Intervals + shutdown
// ──────────────────────────────────────────────
setInterval(() => store.checkIdleSessions(broadcast), 10_000);
setInterval(() => store.saveSessions(), 30_000);
setInterval(() => store.cleanupExpiredApprovals(broadcast), 5_000);
// Sessions are no longer auto-deleted. Long-idle sessions are auto-promoted
// to "stopped" (lib/store.js checkIdleSessions) and visible in the archive
// view; users delete them manually from there.

// Auto-update checker
updater.startPeriodicCheck(store, () => broadcast(store.getFullState()));

process.on("SIGINT", () => { store.saveSessions(); updater.stopPeriodicCheck(); process.exit(0); });
process.on("SIGTERM", () => { store.saveSessions(); updater.stopPeriodicCheck(); process.exit(0); });

// ──────────────────────────────────────────────
// Listen
// ──────────────────────────────────────────────
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === "IPv4" && !cfg.internal) return cfg.address;
    }
  }
  return "unknown";
}

server.listen(PORT, "0.0.0.0", () => {
  const lanIP = getLanIP();
  const proto = USE_HTTPS ? "https" : "http";
  const token = store.getApiToken();
  const hasPw = !!store.getDashboardPasswordHash();
  console.log("");
  console.log("  ╔══════════════════════════════════════════════╗");
  // Read from package.json so the banner cannot drift from the release.
  const version = require("./package.json").version;
  console.log(`  ║         Claude Code Monitor v${version}${" ".repeat(Math.max(1, 16 - version.length))}║`);
  console.log(`  ║  Local:   ${proto}://localhost:${PORT}                ║`);
  console.log(`  ║  LAN:     ${proto}://${lanIP}:${PORT}          ║`);
  console.log(`  ║  HTTPS:   ${USE_HTTPS ? "ON" : "OFF (use --https to enable)"}             ║`);
  console.log("  ╚══════════════════════════════════════════════╝");
  const cfg = store.getConfig();
  console.log(`  Remote approval: ${cfg.remoteApprovalEnabled ? "ON" : "OFF"}`);
  console.log(`  Auto-approve:    ${cfg.autoApproveEnabled ? "ON (DANGEROUS)" : "OFF"}`);
  console.log(`  Dashboard:       ${hasPw ? "Password set" : "No password (set on first login)"}`);
  console.log(`  API Token:       ${token}`);
  console.log("");
  console.log(`  Remote machines: node install-hooks.js --url=${proto}://${lanIP}:${PORT} --token=${token}`);
  console.log("");
});
