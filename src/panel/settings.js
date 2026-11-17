// View settings: defaults, validation and persistence.
//
// Settings live in the extension page's own localStorage. They never leave
// the browser and are not synced.

import { DEFAULT_DEVICE, isDevice, isKnownPreset } from "./devices.js";
import { MAX_RESPONSIVE_WIDTH, MIN_RESPONSIVE_WIDTH } from "./layout.js";

const STORAGE_KEY = "view-settings";

/** "actual" draws the device at its real physical size; a number is a plain scale. */
export const ZOOM_ACTUAL = "actual";

/** At most this many devices beside the main one. */
export const MAX_COMPARE = 2;

/** Sites whose device choice is remembered, most recent last. */
const MAX_REMEMBERED_SITES = 40;

const DEFAULTS = Object.freeze({
  preset: DEFAULT_DEVICE,
  compare: [], // more devices shown beside the main one
  rotated: false,
  scrollSync: true,
  zoom: 1,
  pxPerMm: null, // this monitor's density, once calibrated
  browserBars: true,
  deviceFrame: true,
  keyboard: true,
  inApp: false, // show the page as an app's WebView instead of a browser tab
  responsiveWidth: null, // a fixed width in Responsive mode, or null to fill the panel
  outlines: false, // outline layout problems on the page
  siteDevices: {}, // host -> { preset, compare, rotated }
});

const sanitizeCompare = (list) =>
  Array.isArray(list) ? list.filter(isDevice).slice(0, MAX_COMPARE) : [];

function sanitizeSiteDevices(raw) {
  if (!raw || typeof raw !== "object") return {};
  const entries = Object.entries(raw)
    .filter(([host, value]) => host.length <= 255 && value && isKnownPreset(value.preset))
    .slice(-MAX_REMEMBERED_SITES)
    .map(([host, value]) => [
      host,
      {
        preset: value.preset,
        compare: sanitizeCompare(value.compare),
        rotated: value.rotated === true,
      },
    ]);
  return Object.fromEntries(entries);
}

/** Replace anything missing or out of range with its default. */
export function sanitize(raw) {
  const s = { ...DEFAULTS, compare: [], siteDevices: {} };
  if (isKnownPreset(raw.preset)) s.preset = raw.preset;
  s.compare = sanitizeCompare(raw.compare);
  for (const key of [
    "rotated",
    "scrollSync",
    "browserBars",
    "deviceFrame",
    "keyboard",
    "inApp",
    "outlines",
  ]) {
    if (typeof raw[key] === "boolean") s[key] = raw[key];
  }
  if (raw.zoom === ZOOM_ACTUAL || (typeof raw.zoom === "number" && raw.zoom > 0 && raw.zoom <= 1)) {
    s.zoom = raw.zoom;
  }
  if (typeof raw.pxPerMm === "number" && raw.pxPerMm >= 2 && raw.pxPerMm <= 10) {
    s.pxPerMm = raw.pxPerMm;
  }
  if (
    Number.isInteger(raw.responsiveWidth) &&
    raw.responsiveWidth >= MIN_RESPONSIVE_WIDTH &&
    raw.responsiveWidth <= MAX_RESPONSIVE_WIDTH
  ) {
    s.responsiveWidth = raw.responsiveWidth;
  }
  s.siteDevices = sanitizeSiteDevices(raw.siteDevices);
  return s;
}

/** Remember the device choice for a site, keeping the list bounded. */
export function rememberSiteDevice(settings, host) {
  const sites = { ...settings.siteDevices };
  delete sites[host]; // re-inserted last, as the most recent
  sites[host] = {
    preset: settings.preset,
    compare: [...settings.compare],
    rotated: settings.rotated,
  };
  settings.siteDevices = sanitizeSiteDevices(sites);
}

function readStored() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {URLSearchParams | null} overrides  Set for a pop-out window, which
 *   takes its devices from the view that opened it and never saves.
 */
export function loadSettings(overrides = null) {
  const settings = sanitize(readStored());
  if (!overrides) return settings;

  return sanitize({
    ...settings,
    preset: overrides.get("preset") ?? settings.preset,
    compare: (overrides.get("compare") ?? "").split(",").filter(Boolean),
    rotated: overrides.get("rotated") === "1",
    browserBars: overrides.get("bars") !== "0",
    deviceFrame: overrides.get("frame") !== "0",
    inApp: overrides.get("inapp") === "1",
    responsiveWidth: Number(overrides.get("width")) || null,
    zoom: 1, // the pop-out window is resized to fit the devices at 100%
  });
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable or full. Settings then last for this view only.
  }
}
