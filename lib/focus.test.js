// Run with: node --test lib/focus.test.js
// Pure logic only — the window scoring itself lives in the embedded
// PowerShell/C# and is not reachable from Node.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchTerms } = require("./focus");

const rankOf = (terms, needle) =>
  terms.findIndex(t => t.toLowerCase() === needle.toLowerCase());

test("the launch directory outranks the one the session wandered into", () => {
  // Started in ...ABAP\TEST, then cd'd into ...ABAP\SAPTools. Both VS Code
  // windows are open and report the same main-process pid, so the rank of
  // the term their title matches is all that tells them apart.
  const terms = buildSearchTerms({
    projectRoot: "TEST",
    rootCwd: "c:/Users/me/ABAP/TEST",
    project: "SAPTools",
    cwd: "C:\\Users\\me\\ABAP\\SAPTools",
  });
  assert.ok(rankOf(terms, "TEST") < rankOf(terms, "SAPTools"));
  assert.ok(rankOf(terms, "ABAP/TEST") < rankOf(terms, "ABAP/SAPTools"));
  // The full launch path is the most specific claim of all.
  assert.equal(terms[0], "c:/Users/me/ABAP/TEST");
});

test("a directory outranks its own basename", () => {
  const terms = buildSearchTerms({
    projectRoot: "TEST",
    rootCwd: "c:/Users/me/ABAP/TEST",
  });
  assert.ok(rankOf(terms, "ABAP/TEST") < rankOf(terms, "TEST"));
});

test("both separator styles are searched for", () => {
  const terms = buildSearchTerms({ rootCwd: "c:/Users/me/ABAP/TEST" });
  assert.ok(terms.includes("ABAP/TEST"));
  assert.ok(terms.includes("ABAP\\TEST"));
});

test("one directory spelled two ways yields no duplicate rank", () => {
  const terms = buildSearchTerms({
    projectRoot: "SAPTools",
    rootCwd: "c:/Users/me/ABAP/SAPTools",
    project: "SAPTools",
    cwd: "C:\\Users\\me\\ABAP\\SAPTools",
  });
  const lowered = terms.map(t => t.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length);
});

test("missing or blank fields never produce an empty term", () => {
  // An empty term would match every window title on the desktop.
  const terms = buildSearchTerms({
    projectRoot: null,
    rootCwd: "",
    project: "   ",
    cwd: undefined,
  });
  assert.deepEqual(terms, []);
  assert.deepEqual(buildSearchTerms({}), []);
});
