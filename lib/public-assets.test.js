// Run with: node --test lib/public-assets.test.js
// The dashboard's static assets are referenced from three separate places
// — the <link> tags in the head, the TAB_ICONS map the tab badge swaps
// between, and the web manifest. A typo in any of them fails silently in
// the browser (a missing tab icon just… does not appear), so the paths are
// checked against the filesystem here.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

// Only local, root-relative paths are ours to verify.
function assertServed(href, where) {
  assert.ok(href.startsWith("/"), `${where}: ${href} should be root-relative`);
  const file = path.join(PUBLIC_DIR, href.replace(/^\//, ""));
  assert.ok(fs.existsSync(file), `${where}: ${href} does not exist in public/`);
}

test("every <link> in the dashboard head resolves to a file", () => {
  const hrefs = [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => h.startsWith("/"));
  assert.ok(hrefs.length >= 3, "expected the icon, apple-touch-icon and manifest links");
  for (const href of hrefs) assertServed(href, "<link>");
});

test("every tab-badge icon resolves to a file", () => {
  const map = html.match(/const TAB_ICONS=\{([^}]+)\}/);
  assert.ok(map, "TAB_ICONS map not found in the dashboard");
  const hrefs = [...map[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs.length,
    3,
    "expected three states: none, attention, done"
  );
  for (const href of hrefs) assertServed(href, "TAB_ICONS");
});

test("every manifest icon resolves to a file", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PUBLIC_DIR, "site.webmanifest"), "utf8")
  );
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) assertServed(icon.src, "manifest icon");
  assertServed(manifest.start_url, "manifest start_url");
});

test("the badged icons are regenerated from favicon.svg", () => {
  // scripts/gen-icons.js appends the badge to the base file. If the base
  // changes and the script is not re-run, the variants silently drift.
  const base = fs.readFileSync(path.join(PUBLIC_DIR, "favicon.svg"), "utf8");
  const body = base.replace(/<\/svg>\s*$/, "");
  for (const name of ["favicon-attention.svg", "favicon-done.svg"]) {
    const variant = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    assert.ok(
      variant.startsWith(body),
      `${name} is out of date — re-run node scripts/gen-icons.js`
    );
    assert.match(variant, /<circle /, `${name} should carry the badge`);
  }
});
