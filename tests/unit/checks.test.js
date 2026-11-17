import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// content/checks.js is a classic script that defines globalThis.SidephoneChecks.
vm.runInThisContext(readFileSync(new URL("../../src/content/checks.js", import.meta.url), "utf8"));
const { parseMediaBoundaries } = globalThis.SidephoneChecks;

test("classic min-width and max-width give the width where the layout changes", () => {
  assert.deepEqual(parseMediaBoundaries("(min-width: 768px)"), [768]);
  assert.deepEqual(parseMediaBoundaries("(max-width: 767px)"), [768]);
  assert.deepEqual(parseMediaBoundaries("(max-width: 767.98px)"), [768]);
  assert.deepEqual(parseMediaBoundaries("screen and (min-width:48em)"), [768]);
  assert.deepEqual(
    parseMediaBoundaries("(min-width: 40rem) and (max-width: 63.99rem)"),
    [640, 1024],
  );
});

test("range syntax, in both directions and combined", () => {
  assert.deepEqual(parseMediaBoundaries("(width >= 640px)"), [640]);
  assert.deepEqual(parseMediaBoundaries("(width > 640px)"), [641]);
  assert.deepEqual(parseMediaBoundaries("(width < 1024px)"), [1024]);
  assert.deepEqual(parseMediaBoundaries("(width <= 1023px)"), [1024]);
  assert.deepEqual(parseMediaBoundaries("(640px <= width)"), [640]);
  assert.deepEqual(
    parseMediaBoundaries("(640px <= width < 1024px)").sort((a, b) => a - b),
    [640, 1024],
  );
});

test("everything else is ignored", () => {
  assert.deepEqual(parseMediaBoundaries("(prefers-color-scheme: dark)"), []);
  assert.deepEqual(parseMediaBoundaries("(min-height: 600px)"), []);
  assert.deepEqual(parseMediaBoundaries("(min-width: 50vw)"), []);
  assert.deepEqual(parseMediaBoundaries("print"), []);
});
