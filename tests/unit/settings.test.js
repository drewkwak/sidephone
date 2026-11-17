import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_COMPARE,
  ZOOM_ACTUAL,
  rememberSiteDevice,
  sanitize,
} from "../../src/panel/settings.js";

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

test("compared devices must be real devices, and only a few", () => {
  const s = sanitize({
    compare: ["iphone-se", "fit", "nope", "pixel-9", "ipad-mini", "galaxy-a55"],
  });
  assert.deepEqual(s.compare, ["iphone-se", "pixel-9", "ipad-mini"].slice(0, MAX_COMPARE));
  assert.deepEqual(sanitize({ compare: "iphone-se" }).compare, []);
});

test("a responsive width is kept only within range", () => {
  assert.equal(sanitize({ responsiveWidth: 768 }).responsiveWidth, 768);
  assert.equal(sanitize({ responsiveWidth: 12 }).responsiveWidth, null);
  assert.equal(sanitize({ responsiveWidth: 700.5 }).responsiveWidth, null);
});

test("each site remembers its devices, most recent last, bounded", () => {
  const s = sanitize({});
  s.preset = "pixel-9";
  s.compare = ["iphone-se"];
  rememberSiteDevice(s, "localhost:3000");
  assert.deepEqual(s.siteDevices["localhost:3000"], {
    preset: "pixel-9",
    compare: ["iphone-se"],
    rotated: false,
  });
  for (let i = 0; i < 60; i++) rememberSiteDevice(s, `site-${i}.test`);
  rememberSiteDevice(s, "localhost:3000");
  const hosts = Object.keys(s.siteDevices);
  assert.ok(hosts.length <= 40);
  assert.equal(hosts.at(-1), "localhost:3000");
});

test("stored site devices are cleaned like everything else", () => {
  const s = sanitize({
    siteDevices: {
      a: { preset: "nope" },
      b: { preset: "ipad-mini", compare: ["x"], rotated: "yes" },
    },
  });
  assert.deepEqual(s.siteDevices, { b: { preset: "ipad-mini", compare: [], rotated: false } });
});
