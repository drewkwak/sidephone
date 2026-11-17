// Pure layout arithmetic for the stage: fitting several devices side by side,
// and snapping a resizable width to the page's breakpoints. No DOM access.

/**
 * The scale for each device so that all of them fit the stage side by side.
 *
 * Each device asks for a scale (`wanted`): 1 for 100%, less for a zoom, or
 * its own real-size scale. If they do not all fit at those scales, every one
 * shrinks by the same factor, so their sizes stay comparable.
 *
 * @param {{w: number, h: number, wanted: number}[]} items  Outer size of each device, unscaled.
 * @param {{width: number, height: number}} stage
 * @param {{gap?: number, padding?: number, labelHeight?: number}} [options]
 * @returns {number[]}
 */
export function fitScales(items, stage, { gap = 0, padding = 0, labelHeight = 0 } = {}) {
  if (items.length === 0) return [];
  const width = stage.width - 2 * padding - gap * (items.length - 1);
  const height = stage.height - 2 * padding - labelHeight;
  const wantedWidth = items.reduce((sum, item) => sum + item.w * item.wanted, 0);
  const wantedHeight = Math.max(...items.map((item) => item.h * item.wanted));
  const shrink = Math.min(1, width / wantedWidth, height / wantedHeight);
  return items.map((item) => Math.max(0.02, item.wanted * shrink));
}

/**
 * Snap a width to the nearest breakpoint, or to the pixel just below it, when
 * it is within `tolerance` pixels. Otherwise return it rounded.
 *
 * @param {number} width
 * @param {number[]} breakpoints  Widths at which the layout changes.
 * @param {number} tolerance
 */
export function snapToBreakpoint(width, breakpoints, tolerance) {
  let best = Math.round(width);
  let bestDistance = tolerance;
  for (const breakpoint of breakpoints) {
    for (const candidate of [breakpoint, breakpoint - 1]) {
      const distance = Math.abs(candidate - width);
      if (distance <= bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

export const MIN_RESPONSIVE_WIDTH = 240;
export const MAX_RESPONSIVE_WIDTH = 3840;

export const clampWidth = (width) =>
  Math.round(Math.min(MAX_RESPONSIVE_WIDTH, Math.max(MIN_RESPONSIVE_WIDTH, width)));
