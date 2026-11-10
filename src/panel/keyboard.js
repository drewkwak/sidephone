// The on-screen keyboard: a drawing that shows what a phone's keyboard would
// cover. It is not a working keyboard. Like the real thing, it overlays the
// page without resizing it.
//
// All markup here is fixed text from this file. Nothing from a web page is
// ever interpolated into it.

// Heights as [portrait, landscape], including the suggestion strip and, where
// the device has one, the area under the keys. The iPhone figures match the
// standard iOS keyboard on Face ID phones; the rest are approximate.
const HEIGHTS = {
  ios: { text: [336, 210], numeric: [291, 200] },
  "ios-home": { text: [260, 200], numeric: [216, 180] },
  android: { text: [300, 200], numeric: [280, 200] },
  tablet: { text: [330, 420], numeric: [330, 420] },
};

/** Never cover more than this share of the screen. */
const MAX_SHARE = 0.6;

/**
 * @param {string} kind       Device family: "ios", "ios-home", "android" or "tablet".
 * @param {"text" | "numeric"} layout
 * @param {boolean} landscape
 * @param {number} screenHeight
 */
export function keyboardHeight(kind, layout, landscape, screenHeight) {
  const heights = (HEIGHTS[kind] ?? HEIGHTS.ios)[layout];
  return Math.min(heights[landscape ? 1 : 0], Math.round(screenHeight * MAX_SHARE));
}

/** Which keyboard style a device family gets. */
export const keyboardPlatform = (kind) => (kind === "android" ? "android" : "ios");

/** Phones without a home button keep an area under the keys in portrait. */
export const keyboardHasFoot = (kind, landscape) =>
  (kind === "ios" || kind === "android") && !landscape;

const icon = (inner, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  shift: icon('<path d="M12 3.5 3.2 12.6h4.6v6.9h8.4v-6.9h4.6z"/>', 22),
  del: icon(
    '<path d="M8.6 5.5h10.9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8.6L2.5 12z"/><path d="m11.8 9.5 5 5m0-5-5 5"/>',
  ),
  emoji: icon(
    '<circle cx="12" cy="12" r="9.2"/><path d="M8 14.2a4.6 4.6 0 0 0 8 0"/><path d="M8.8 9.4v.8m6.4-.8v.8" stroke-width="2"/>',
    27,
  ),
  mic: icon(
    '<rect x="9" y="2.8" width="6" height="11.4" rx="3"/><path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6v3.6"/>',
    27,
  ),
  enter: icon('<path d="M19 6v6a2 2 0 0 1-2 2H6"/><path d="m9.5 10.5-3.5 3.5 3.5 3.5"/>', 20),
};

const letters = (chars) => [...chars].map((ch) => `<span class="key letter">${ch}</span>`).join("");
const row = (inner) => `<div class="kb-row">${inner}</div>`;
const digit = (value, sub = "") =>
  `<span class="key digit"><b>${value}</b><small>${sub}</small></span>`;

const LETTER_ROWS =
  row(letters("qwertyuiop")) +
  row(letters("asdfghjkl")) +
  row(
    `<span class="key fn side">${ICONS.shift}</span><span class="kb-gap"></span>` +
      letters("zxcvbnm") +
      `<span class="kb-gap"></span><span class="key fn side">${ICONS.del}</span>`,
  );

const NUMBER_PAD =
  digit(1) +
  digit(2, "ABC") +
  digit(3, "DEF") +
  digit(4, "GHI") +
  digit(5, "JKL") +
  digit(6, "MNO") +
  digit(7, "PQRS") +
  digit(8, "TUV") +
  digit(9, "WXYZ") +
  `<span class="key digit"><b>.</b></span>` +
  digit(0) +
  `<span class="key bare">${ICONS.del}</span>`;

/** Markup keyed by `${platform}-${layout}`. */
export const KEYBOARD_MARKUP = {
  "ios-text":
    `<div class="kb-suggest"><span>“I”</span><span>“The”</span><span>“I’m”</span></div>` +
    `<div class="kb-keys">${LETTER_ROWS}` +
    row(
      `<span class="key fn word">123</span><span class="key space">space</span>` +
        `<span class="key fn word">return</span>`,
    ) +
    `</div><div class="kb-foot"><span>${ICONS.emoji}</span><span>${ICONS.mic}</span></div>`,
  "ios-numeric": `<div class="kb-pad">${NUMBER_PAD}</div><div class="kb-foot"></div>`,
  "android-text":
    `<div class="kb-suggest"></div><div class="kb-keys">${LETTER_ROWS}` +
    row(
      `<span class="key fn sym">?123</span><span class="key fn letter">,</span>` +
        `<span class="key space"></span><span class="key fn letter">.</span>` +
        `<span class="key enter">${ICONS.enter}</span>`,
    ) +
    `</div><div class="kb-foot"></div>`,
  "android-numeric": `<div class="kb-pad">${NUMBER_PAD}</div><div class="kb-foot"></div>`,
};
