#!/usr/bin/env node
// Renders the dashboard icon (public/favicon.svg) to PNG.
//
//   node scripts/gen-icons.js
//
// Browsers take the SVG favicon directly; these PNGs exist for the
// platforms that refuse SVG — iOS "Add to Home Screen" (apple-touch-icon)
// and the Android/Chrome web app manifest. Re-run after editing
// favicon.svg and keep the two in sync by eye.
//
// No dependencies: signed-distance rasterizer + a minimal PNG encoder
// (zlib is in Node core). Anti-aliasing comes from sampling the distance
// field, so the output stays smooth at every size.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "public");

// Geometry mirrors favicon.svg, expressed in the same 32x32 space.
const PURPLE = [167, 139, 250];   // #a78bfa — chevron
const GREEN = [34, 197, 94];      // #22c55e — cursor
const RING = [139, 92, 246];      // #8b5cf6 — border
const BG_TOP = [27, 23, 38];      // #1b1726
const BG_BOT = [10, 10, 12];      // #0a0a0c

// Distance from point to a line segment (used for round-capped strokes).
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

// Signed distance to a rounded rectangle (negative inside).
function roundRectDist(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const ox = Math.max(cx, 0), oy = Math.max(cy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(cx, cy), 0) - r;
}

// Coverage in [0,1] for a shape whose signed distance is d, with the
// transition spread over one device pixel.
function coverage(d, px) {
  return Math.max(0, Math.min(1, 0.5 - d / px));
}

function over(dst, i, color, alpha) {
  if (alpha <= 0) return;
  for (let c = 0; c < 3; c++) {
    dst[i + c] = Math.round(dst[i + c] * (1 - alpha) + color[c] * alpha);
  }
  dst[i + 3] = Math.round(dst[i + 3] * (1 - alpha) + 255 * alpha);
}

function render(size) {
  const s = size / 32;            // user units → pixels
  const px = 1 / s;               // one device pixel in user units
  const buf = Buffer.alloc(size * size * 4, 0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ux = (x + 0.5) / s, uy = (y + 0.5) / s;
      const i = (y * size + x) * 4;

      // Body: vertical gradient inside the rounded square.
      const body = roundRectDist(ux, uy, 1, 1, 30, 30, 8);
      const t = Math.max(0, Math.min(1, (uy - 1) / 30));
      const bg = BG_TOP.map((c, k) => c + (BG_BOT[k] - c) * t);
      over(buf, i, bg, coverage(body, px));

      // Border: a 1.5-wide ring centred on the body outline.
      over(buf, i, RING, coverage(Math.abs(body) - 0.75, px) * 0.55);

      // Chevron ">" — two round-capped segments, 3.2 wide.
      const chev = Math.min(
        segDist(ux, uy, 9.5, 11, 15, 16),
        segDist(ux, uy, 9.5, 21, 15, 16)
      );
      over(buf, i, PURPLE, coverage(chev - 1.6, px));

      // Cursor "_".
      over(buf, i, GREEN, coverage(roundRectDist(ux, uy, 16.8, 19.2, 7, 3, 1.5), px));
    }
  }
  return buf;
}

// ── Minimal PNG encoder ─────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Fallback for Node versions without zlib.crc32 (added in Node 20.15).
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-512.png", 512]]) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`  wrote ${name} (${size}x${size}, ${fs.statSync(file).size} bytes)`);
}
