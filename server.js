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
app.use(express.static(path.join(__dirname, "public")));

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

// ──────────────────────────────────────────────
// Intervals + shutdown
// ──────────────────────────────────────────────
setInterval(() => store.checkIdleSessions(broadcast), 10_000);
setInterval(() => store.saveSessions(), 30_000);
setInterval(() => store.cleanupExpiredApprovals(broadcast), 5_000);
setInterval(() => { if (store.cleanupOldSessions()) broadcast(store.getFullState()); }, 600_000); // every 10 min

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
  console.log("  ║         Claude Code Monitor v1.4.0           ║");
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
