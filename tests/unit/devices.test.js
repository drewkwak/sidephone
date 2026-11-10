import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DEVICE,
  DEVICES,
  DEVICE_GROUPS,
  RESPONSIVE,
  getMetrics,
  isKnownPreset,
  realSizeScale,
} from "../../src/panel/devices.js";

const base = { rotated: false, browserBars: true, deviceFrame: true };

test("every device is listed in exactly one group", () => {
  const listed = DEVICE_GROUPS.flatMap((group) => group.ids);
  assert.deepEqual([...listed].sort(), Object.keys(DEVICES).sort());
  assert.equal(new Set(listed).size, listed.length);
});

test("the default device exists", () => {
  assert.ok(DEVICES[DEFAULT_DEVICE]);
  assert.ok(isKnownPreset(DEFAULT_DEVICE));
  assert.ok(isKnownPreset(RESPONSIVE));
  assert.ok(!isKnownPreset("393x852"));
  assert.ok(!isKnownPreset("constructor"));
});

test("the responsive preset has no device metrics", () => {
  assert.equal(getMetrics({ ...base, preset: RESPONSIVE }), null);
  assert.equal(getMetrics({ ...base, preset: "nope" }), null);
});

test("screen sizes match Chrome DevTools", () => {
  const expected = {
    "iphone-se": [375, 667],
    "iphone-16": [393, 852],
    "iphone-16-pro-max": [440, 956],
    "pixel-9": [412, 924],
    "pixel-9-pro": [427, 952],
    "pixel-10": [412, 924],
    "galaxy-a55": [360, 800],
    "pixel-9-pro-fold": [412, 922],
    "pixel-9-pro-fold-open": [836, 842],
    "galaxy-z-fold-6": [412, 968],
    "galaxy-z-fold-6-open": [744, 860],
    "ipad-mini": [768, 1024],
    "ipad-pro-13": [1032, 1376],
    "surface-pro-10": [960, 1440],
    "nest-hub-max": [1280, 800],
  };
  for (const [id, [w, h]] of Object.entries(expected)) {
    assert.deepEqual([DEVICES[id].w, DEVICES[id].h], [w, h], id);
  }
});

test("every device, in every mode, gives the page a sensible viewport", () => {
  for (const id of Object.keys(DEVICES)) {
    for (const rotated of [false, true]) {
      for (const browserBars of [false, true]) {
        for (const deviceFrame of [false, true]) {
          const m = getMetrics({ preset: id, rotated, browserBars, deviceFrame });
          const label = `${id} rotated=${rotated} bars=${browserBars} frame=${deviceFrame}`;
          assert.ok(m.w >= 300 && m.h >= 250, `${label}: ${m.w}×${m.h}`);
          assert.ok(m.w <= m.sw && m.h <= m.sh, label);
          assert.ok(m.outerW >= m.screenW && m.outerH >= m.screenH, label);
          // The bars and the page fill the screen exactly, so nothing can scroll.
          if (deviceFrame) assert.equal(m.bars.top + m.h + m.bars.bottom, m.sh, label);
        }
      }
    }
  }
});

test("browser bars take height from the page, not width, in portrait", () => {
  const withBars = getMetrics({ ...base, preset: "iphone-16" });
  const without = getMetrics({ ...base, preset: "iphone-16", browserBars: false });
  assert.deepEqual([withBars.w, withBars.h], [393, 692]);
  assert.deepEqual([without.w, without.h], [393, 852]);
});

test("rotating swaps the screen and keeps the page clear of the camera", () => {
  const m = getMetrics({ ...base, preset: "iphone-16", rotated: true });
  assert.deepEqual([m.sw, m.sh], [852, 393]);
  assert.equal(m.w, 852 - 2 * 59);
});

test("a landscape-only device ignores rotation", () => {
  const m = getMetrics({ ...base, preset: "nest-hub-max", rotated: true });
  assert.equal(m.rotated, false);
  assert.deepEqual([m.sw, m.sh], [1280, 800]);
});

test("without the device frame only the page area is drawn", () => {
  const m = getMetrics({ ...base, preset: "iphone-16", deviceFrame: false });
  assert.deepEqual([m.outerW, m.outerH], [m.w, m.h]);
});

test("real size is smaller than 100% on an ordinary monitor", () => {
  const scale = realSizeScale(DEVICES["iphone-16"], null);
  assert.ok(scale > 0.6 && scale < 1, String(scale));
  // A denser monitor needs less shrinking.
  assert.ok(realSizeScale(DEVICES["iphone-16"], 6) > scale);
});
