#!/usr/bin/env node
// Creates deployment packages for Claude Code Monitor.
//
// Usage:
//   node deploy.js               # creates both server + client packages
//   node deploy.js --server      # server package only
//   node deploy.js --client      # client package only
//
// Output:
//   deploy/server/  — copy to the remote machine that runs the dashboard
//   deploy/client/  — copy to each machine running Claude Code

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const serverOnly = args.includes("--server");
const clientOnly = args.includes("--client");
const buildServer = !clientOnly;
const buildClient = !serverOnly;

const DEPLOY_DIR = path.join(__dirname, "deploy");

function copyFile(src, destDir, destName) {
  const name = destName || path.basename(src);
  const dest = path.join(destDir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  ${name}`);
}

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, f);
    const destPath = path.join(destDir, f);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ${path.relative(DEPLOY_DIR, destPath)}`);
    }
  }
}

// ── Server package ──
if (buildServer) {
  const serverDir = path.join(DEPLOY_DIR, "server");
  if (fs.existsSync(serverDir)) fs.rmSync(serverDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  console.log("\nServer package (deploy/server/):");
  copyFile(path.join(__dirname, "server.js"), serverDir);
  copyFile(path.join(__dirname, "package.json"), serverDir);

  // lib/
  const libSrc = path.join(__dirname, "lib");
  const libDest = path.join(serverDir, "lib");
  copyDir(libSrc, libDest);

  // public/
  const pubSrc = path.join(__dirname, "public");
  const pubDest = path.join(serverDir, "public");
  copyDir(pubSrc, pubDest);

  // Setup script
  const setupScript = `#!/bin/bash
echo "Claude Code Monitor - Server Setup"
echo "===================================="
echo ""

if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install it from https://nodejs.org/ (v18+)"
  exit 1
fi

echo "Node.js: $(node -v)"
echo ""
echo "Installing dependencies..."
npm install --production
echo ""
echo "Done! Start the server with:"
echo "  node server.js"
echo ""
echo "Or use PM2 for persistence:"
echo "  npm install -g pm2"
echo "  pm2 start server.js --name claude-monitor"
`;
  fs.writeFileSync(path.join(serverDir, "setup.sh"), setupScript);
  console.log("  setup.sh");

  const setupBat = `@echo off
echo Claude Code Monitor - Server Setup
echo ====================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js is not installed.
  echo Install it from https://nodejs.org/ (v18+)
  pause
  exit /b 1
)

echo Node.js found.
echo.
echo Installing dependencies...
call npm install --production
echo.
echo Done! Start the server with:
echo   node server.js
echo.
pause
`;
  fs.writeFileSync(path.join(serverDir, "setup.bat"), setupBat);
  console.log("  setup.bat");
}

// ── Client package ──
if (buildClient) {
  const clientDir = path.join(DEPLOY_DIR, "client");
  if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });

  console.log("\nClient package (deploy/client/):");
  copyFile(path.join(__dirname, "hook-handler.js"), clientDir);
  copyFile(path.join(__dirname, "install-hooks.js"), clientDir);

  // Client setup script
  const clientSetup = `#!/bin/bash
echo "Claude Code Monitor - Client Setup"
echo "===================================="
echo ""

if [ -z "$1" ]; then
  echo "Usage: ./setup.sh <monitor-server-url>"
  echo ""
  echo "Example:"
  echo "  ./setup.sh http://192.168.1.100:7888"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  exit 1
fi

echo "Installing hooks pointing to: $1"
node install-hooks.js --url="$1"
echo ""
echo "Done! Claude Code on this machine will now report to $1"
`;
  fs.writeFileSync(path.join(clientDir, "setup.sh"), clientSetup);
  console.log("  setup.sh");

  const clientBat = `@echo off
echo Claude Code Monitor - Client Setup
echo ====================================
echo.

if "%~1"=="" (
  echo Usage: setup.bat ^<monitor-server-url^>
  echo.
  echo Example:
  echo   setup.bat http://192.168.1.100:7888
  pause
  exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js is not installed.
  pause
  exit /b 1
)

echo Installing hooks pointing to: %~1
node install-hooks.js --url=%~1
echo.
echo Done! Claude Code on this machine will now report to %~1
pause
`;
  fs.writeFileSync(path.join(clientDir, "setup.bat"), clientBat);
  console.log("  setup.bat");
}

console.log("\n========================================");
if (buildServer) {
  console.log("Server: copy deploy/server/ to remote machine, run setup.sh/.bat");
}
if (buildClient) {
  console.log("Client: copy deploy/client/ to each Claude Code machine,");
  console.log("        run: setup.sh http://<server-ip>:7888");
}
console.log("========================================\n");
