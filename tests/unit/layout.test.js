import assert from "node:assert/strict";
import { test } from "node:test";

import { clampWidth, fitScales, snapToBreakpoint } from "../../src/panel/layout.js";

test("a device that fits keeps the scale it asked for", () => {
  assert.deepEqual(fitScales([{ w: 400, h: 800, wanted: 1 }], { width: 1000, height: 1000 }), [1]);
  assert.deepEqual(
    fitScales([{ w: 400, h: 800, wanted: 0.5 }], { width: 1000, height: 1000 }),
    [0.5],
  );
});

test("a device that does not fit shrinks to fit", () => {
  const [scale] = fitScales([{ w: 400, h: 800, wanted: 1 }], { width: 1000, height: 400 });
  assert.equal(scale, 0.5);
});

test("devices side by side share the width and keep their relative sizes", () => {
  const items = [
    { w: 400, h: 800, wanted: 1 },
    { w: 400, h: 800, wanted: 0.8 }, // e.g. a denser screen at real size
  ];
  const scales = fitScales(items, { width: 360, height: 2000 }, { gap: 0 });
  assert.ok(Math.abs(scales[0] * 400 + scales[1] * 400 - 360) < 1e-9);
  assert.ok(Math.abs(scales[1] / scales[0] - 0.8) < 1e-9);
});

test("gaps, padding and labels take space before the devices", () => {
  const scales = fitScales(
    [
      { w: 100, h: 100, wanted: 1 },
      { w: 100, h: 100, wanted: 1 },
    ],
    { width: 236, height: 1000 },
    { gap: 16, padding: 10, labelHeight: 30 },
  );
  assert.deepEqual(scales, [1, 1]);
  const tight = fitScales(
    [{ w: 100, h: 100, wanted: 1 }],
    { width: 1000, height: 120 },
    { labelHeight: 30 },
  );
  assert.equal(tight[0], 0.9);
});

test("widths snap to a breakpoint or the pixel below it", () => {
  const breakpoints = [640, 768];
  assert.equal(snapToBreakpoint(765, breakpoints, 6), 767);
  assert.equal(snapToBreakpoint(769.4, breakpoints, 6), 768);
  assert.equal(snapToBreakpoint(700.4, breakpoints, 6), 700);
  assert.equal(snapToBreakpoint(700, [], 6), 700);
});

test("responsive widths stay in a sensible range", () => {
  assert.equal(clampWidth(10), 240);
  assert.equal(clampWidth(100000), 3840);
  assert.equal(clampWidth(500.6), 501);
});
