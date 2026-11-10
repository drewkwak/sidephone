import assert from "node:assert/strict";
import { test } from "node:test";

import { ZOOM_ACTUAL, sanitize } from "../../src/panel/settings.js";

test("empty input yields the defaults", () => {
  const s = sanitize({});
  assert.equal(s.preset, "iphone-16");
  assert.equal(s.zoom, 1);
  assert.equal(s.pxPerMm, null);
  assert.equal(s.scrollSync, true);
});

test("valid values are kept", () => {
  const s = sanitize({
    preset: "pixel-9",
    rotated: true,
    zoom: 0.75,
    pxPerMm: 5.2,
    keyboard: false,
  });
  assert.deepEqual(
    [s.preset, s.rotated, s.zoom, s.pxPerMm, s.keyboard],
    ["pixel-9", true, 0.75, 5.2, false],
  );
  assert.equal(sanitize({ zoom: ZOOM_ACTUAL }).zoom, ZOOM_ACTUAL);
});

test("unknown or out-of-range values fall back to defaults", () => {
  const s = sanitize({
    preset: "393x852", // a size saved by an early version
    rotated: "yes",
    zoom: 4,
    pxPerMm: 500,
    extra: "ignored",
  });
  assert.equal(s.preset, "iphone-16");
  assert.equal(s.rotated, false);
  assert.equal(s.zoom, 1);
  assert.equal(s.pxPerMm, null);
  assert.ok(!("extra" in s));
});
