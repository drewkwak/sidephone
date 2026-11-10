// Device definitions and the geometry derived from them. No DOM access here,
// so everything in this file can be unit tested.
//
// The device list mirrors the one in Chrome DevTools' device toolbar: same
// names, groups, screen sizes, camera cutouts and safe areas (taken from
// DevTools' EmulatedDevices.ts). What DevTools does not define is approximate:
// corner radius, bezel, physical density and browser bar heights.

export const NO_BARS = Object.freeze({ top: 0, bottom: 0 });

// Browser bars: the space a browser's own UI takes away from the page, split
// into what sits above and below it, for portrait (p) and landscape (l).
// Real values shift with OS version and whether the bars are collapsed.
//
// `status` describes the status bar (clock and signal icons): its height, side
// padding and text size, and whether it stays visible in landscape.

// Safari on a Face ID iPhone: the status bar fills the top safe area and the
// address bar sits at the bottom, above the swipe area.
const iosBars = (safeTop) => ({
  kind: "ios",
  address: "bottom",
  p: { top: safeTop, bottom: 101 },
  l: { top: 89, bottom: 21 },
  status: { h: safeTop, left: 48, right: 31, font: 17, landscape: false },
});

// Safari on an iPhone with a home button: address bar on top, toolbar below.
const IOS_HOME_BARS = {
  kind: "ios-home",
  address: "top",
  p: { top: 70, bottom: 45 },
  l: { top: 60, bottom: 0 },
  status: { h: 20, left: 7, right: 6, font: 12, landscape: false },
};

// Chrome on Android: status bar (as tall as the camera's safe area), then the
// toolbar, with the gesture bar underneath the page.
const ANDROID_TOOLBAR = 56;
const androidBars = (safeTop) => ({
  kind: "android",
  address: "top",
  p: { top: safeTop + ANDROID_TOOLBAR, bottom: 26 },
  l: { top: 24 + ANDROID_TOOLBAR, bottom: 24 },
  status: { h: safeTop, left: 24, right: 20, font: 14, landscape: false },
});

const TABLET_BARS = {
  kind: "tablet",
  address: "top",
  p: { top: 80, bottom: 20 },
  l: { top: 80, bottom: 20 },
  status: { h: 26, left: 18, right: 16, font: 13, landscape: true },
};

// A desktop browser on a Windows tablet: tabs and toolbar above, taskbar below.
const DESKTOP_BARS = {
  kind: "tablet",
  address: "top",
  p: { top: 86, bottom: 48 },
  l: { top: 86, bottom: 48 },
  status: null,
};

// A smart display shows the page full screen.
const KIOSK_BARS = { kind: "tablet", address: "top", p: NO_BARS, l: NO_BARS, status: null };

// Camera cutouts, measured in portrait: width, height, distance from the top
// edge, and `inset`, the margin a browser leaves beside the cutout in landscape.
const island = (top, inset) => ({ w: 125, h: 37, top, inset });
const hole = (diameter, top, inset) => ({ w: diameter, h: diameter, top, inset });

/**
 * @typedef {object} Device
 * @property {string} name         Shown in the device menu.
 * @property {number} w            Display width in CSS pixels (portrait, unless landscapeOnly).
 * @property {number} h            Display height in CSS pixels.
 * @property {number} ptPerInch    CSS pixels of this display per physical inch.
 * @property {number} radius       Corner radius of the display.
 * @property {[number, number]} bezel  Body thickness around the display: [top and bottom, sides].
 * @property {number} [bodyRadius] Outer corner radius, when it is not radius + bezel.
 * @property {{w: number, h: number, top: number, inset: number}} [cutout]
 * @property {boolean} [homeButton]    Draw a home button in the chin.
 * @property {boolean} [landscapeOnly] The device has no portrait orientation.
 * @property {object} bars         Browser bar allowances, see above.
 */

/** @type {Record<string, Device>} */
export const DEVICES = {
  "iphone-se": {
    name: "iPhone SE",
    w: 375,
    h: 667,
    ptPerInch: 163,
    radius: 0,
    bezel: [72, 14],
    bodyRadius: 52,
    homeButton: true,
    bars: IOS_HOME_BARS,
  },
  "iphone-16": {
    name: "iPhone 16",
    w: 393,
    h: 852,
    ptPerInch: 153.3,
    radius: 55,
    bezel: [10, 10],
    cutout: island(11, 59),
    bars: iosBars(59),
  },
  "iphone-16-pro-max": {
    name: "iPhone 16 Pro Max",
    w: 440,
    h: 956,
    ptPerInch: 153.3,
    radius: 62,
    bezel: [9, 9],
    cutout: island(14, 62),
    bars: iosBars(62),
  },
  "pixel-9": {
    name: "Pixel 9",
    w: 412,
    h: 924,
    ptPerInch: 160.8,
    radius: 46,
    bezel: [10, 10],
    cutout: hole(28, 15, 58),
    bars: androidBars(58),
  },
  "pixel-9-pro": {
    name: "Pixel 9 Pro",
    w: 427,
    h: 952,
    ptPerInch: 165,
    radius: 48,
    bezel: [10, 10],
    cutout: hole(32, 18, 68),
    bars: androidBars(68),
  },
  "pixel-10": {
    name: "Pixel 10",
    w: 412,
    h: 924,
    ptPerInch: 160.8,
    radius: 46,
    bezel: [10, 10],
    cutout: hole(28, 15, 58),
    bars: androidBars(58),
  },
  "galaxy-a55": {
    name: "Samsung Galaxy A55",
    w: 360,
    h: 800,
    ptPerInch: 130,
    radius: 30,
    bezel: [9, 9],
    cutout: hole(14, 12, 40),
    bars: androidBars(36),
  },

  "pixel-9-pro-fold": {
    name: "Pixel 9 Pro Fold",
    w: 412,
    h: 922,
    ptPerInch: 160.8,
    radius: 44,
    bezel: [10, 10],
    cutout: hole(28, 15, 58),
    bars: androidBars(58),
  },
  "pixel-9-pro-fold-open": {
    name: "Pixel 9 Pro Fold, open",
    w: 836,
    h: 842,
    ptPerInch: 150,
    radius: 40,
    bezel: [12, 12],
    bars: androidBars(36),
  },
  "galaxy-z-fold-6": {
    name: "Galaxy Z Fold 6",
    w: 412,
    h: 968,
    ptPerInch: 174.5,
    radius: 18,
    bezel: [9, 9],
    cutout: hole(16, 14, 44),
    bars: androidBars(40),
  },
  "galaxy-z-fold-6-open": {
    name: "Galaxy Z Fold 6, open",
    w: 744,
    h: 860,
    ptPerInch: 150,
    radius: 18,
    bezel: [12, 12],
    bars: androidBars(36),
  },

  "ipad-mini": {
    name: "iPad Mini",
    w: 768,
    h: 1024,
    ptPerInch: 163,
    radius: 22,
    bezel: [22, 22],
    bars: TABLET_BARS,
  },
  "ipad-pro-13": {
    name: "iPad Pro 13",
    w: 1032,
    h: 1376,
    ptPerInch: 132,
    radius: 18,
    bezel: [20, 20],
    bars: TABLET_BARS,
  },
  "surface-pro-10": {
    name: "Surface Pro 10",
    w: 960,
    h: 1440,
    ptPerInch: 133.5,
    radius: 6,
    bezel: [18, 18],
    bars: DESKTOP_BARS,
  },

  "nest-hub-max": {
    name: "Nest Hub Max",
    w: 1280,
    h: 800,
    ptPerInch: 151,
    radius: 14,
    bezel: [30, 30],
    landscapeOnly: true,
    bars: KIOSK_BARS,
  },
};

export const DEVICE_GROUPS = [
  {
    label: "Mobile",
    ids: [
      "iphone-se",
      "iphone-16",
      "iphone-16-pro-max",
      "pixel-9",
      "pixel-9-pro",
      "pixel-10",
      "galaxy-a55",
    ],
  },
  {
    label: "Foldables",
    ids: ["pixel-9-pro-fold", "pixel-9-pro-fold-open", "galaxy-z-fold-6", "galaxy-z-fold-6-open"],
  },
  { label: "Tablets & desktops", ids: ["ipad-mini", "ipad-pro-13", "surface-pro-10"] },
  { label: "Smart displays", ids: ["nest-hub-max"] },
];

/** The preset id that means "no device: fill the available space". */
export const RESPONSIVE = "fit";
export const DEFAULT_DEVICE = "iphone-16";

export const isKnownPreset = (id) => id === RESPONSIVE || Object.hasOwn(DEVICES, id);

/**
 * Everything layout needs for a device, or null for the responsive preset.
 *
 *  sw, sh          the display (the full screen)
 *  w, h            the page's viewport: what the mirrored page is given
 *  screenW/H       the part of the display that is drawn
 *  outerW/H        the whole drawing, including the body when framed
 *
 * @param {{preset: string, rotated: boolean, browserBars: boolean, deviceFrame: boolean}} settings
 */
export function getMetrics(settings) {
  const spec = DEVICES[settings.preset];
  if (!spec) return null;

  const rotated = settings.rotated && !spec.landscapeOnly;
  const framed = settings.deviceFrame;
  const sw = rotated ? spec.h : spec.w;
  const sh = rotated ? spec.w : spec.h;

  const bars = settings.browserBars ? spec.bars[rotated ? "l" : "p"] : NO_BARS;

  // In landscape the camera cutout sits at the side, and the browser keeps the
  // page clear of it with an equal margin on both sides.
  const sideInset = rotated && settings.browserBars && spec.cutout ? spec.cutout.inset : 0;
  const w = sw - 2 * sideInset;
  const h = sh - bars.top - bars.bottom;

  // The bezel's "ends" are top and bottom in portrait, left and right when rotated.
  const [ends, sides] = framed ? spec.bezel : [0, 0];
  const padY = rotated ? sides : ends;
  const padX = rotated ? ends : sides;

  // With the frame off, only the page area is drawn.
  const screenW = framed ? sw : w;
  const screenH = framed ? sh : h;

  return {
    spec,
    rotated,
    framed,
    bars,
    sw,
    sh,
    w,
    h,
    padX,
    padY,
    screenW,
    screenH,
    outerW: screenW + 2 * padX,
    outerH: screenH + 2 * padY,
  };
}

const MM_PER_INCH = 25.4;

/** Density assumed for the user's monitor until they calibrate: a typical laptop. */
export const DEFAULT_PX_PER_MM = 127 / MM_PER_INCH;

/**
 * The scale at which a device drawn on this monitor measures the same as the
 * real thing. A CSS pixel on a monitor is physically larger than one on a
 * phone, so this is usually below 1.
 *
 * @param {Device} spec
 * @param {number | null} pxPerMm  The monitor's density, or null if not calibrated.
 */
export function realSizeScale(spec, pxPerMm) {
  return ((pxPerMm || DEFAULT_PX_PER_MM) * MM_PER_INCH) / spec.ptPerInch;
}
