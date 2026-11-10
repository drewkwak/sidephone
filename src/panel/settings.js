// View settings: defaults, validation and persistence.
//
// Settings live in the extension page's own localStorage. They never leave
// the browser and are not synced.

import { DEFAULT_DEVICE, isKnownPreset } from "./devices.js";

const STORAGE_KEY = "view-settings";

/** "actual" draws the device at its real physical size; a number is a plain scale. */
export const ZOOM_ACTUAL = "actual";

const DEFAULTS = Object.freeze({
  preset: DEFAULT_DEVICE,
  rotated: false,
  scrollSync: true,
  zoom: 1,
  pxPerMm: null, // this monitor's density, once calibrated
  browserBars: true,
  deviceFrame: true,
  keyboard: true,
});

function readStored() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Replace anything missing or out of range with its default. */
export function sanitize(raw) {
  const s = { ...DEFAULTS };
  if (isKnownPreset(raw.preset)) s.preset = raw.preset;
  for (const key of ["rotated", "scrollSync", "browserBars", "deviceFrame", "keyboard"]) {
    if (typeof raw[key] === "boolean") s[key] = raw[key];
  }
  if (raw.zoom === ZOOM_ACTUAL || (typeof raw.zoom === "number" && raw.zoom > 0 && raw.zoom <= 1)) {
    s.zoom = raw.zoom;
  }
  if (typeof raw.pxPerMm === "number" && raw.pxPerMm >= 2 && raw.pxPerMm <= 10) {
    s.pxPerMm = raw.pxPerMm;
  }
  return s;
}

/**
 * @param {URLSearchParams | null} overrides  Set for a pop-out window, which
 *   takes its device from the view that opened it and never saves.
 */
export function loadSettings(overrides = null) {
  const settings = sanitize(readStored());
  if (!overrides) return settings;

  return sanitize({
    ...settings,
    preset: overrides.get("preset") ?? settings.preset,
    rotated: overrides.get("rotated") === "1",
    browserBars: overrides.get("bars") !== "0",
    deviceFrame: overrides.get("frame") !== "0",
    zoom: 1, // the pop-out window is resized to fit the device at 100%
  });
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable or full. Settings then last for this view only.
  }
}
