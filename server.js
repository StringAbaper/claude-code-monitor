const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const store = require("./lib/store");
const routes = require("./lib/routes");

const PORT = process.env.PORT || 7888;

// ──────────────────────────────────────────────
// Express + WebSocket
// ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(store.getFullState()));
  ws.on("error", () => {});
});

// Register all API routes
routes.register(app, broadcast);

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
store.loadConfig();
store.loadSessions();
setInterval(() => store.checkIdleSessions(broadcast), 10_000);
setInterval(() => store.saveSessions(), 30_000);
setInterval(() => store.cleanupExpiredApprovals(broadcast), 5_000);

process.on("SIGINT", () => {
  store.saveSessions();
  process.exit(0);
});
process.on("SIGTERM", () => {
  store.saveSessions();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║       Claude Code Monitor v1.1.0     ║");
  console.log(`  ║  http://localhost:${PORT}            ║`);
  console.log("  ╚══════════════════════════════════════╝");
  const cfg = store.getConfig();
  console.log(`  Remote approval: ${cfg.remoteApprovalEnabled ? "ON" : "OFF"}`);
  console.log(`  Auto-approve:    ${cfg.autoApproveEnabled ? "ON (DANGEROUS)" : "OFF"}`);
  console.log("");
});
