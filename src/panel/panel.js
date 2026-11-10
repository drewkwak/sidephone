// A mirror view. The same page runs in two places: the side panel, and a
// pop-out window opened from it. A view follows the active tab of one browser
// window and loads the same URL in its frame at the chosen device size.

import {
  DEVICES,
  DEVICE_GROUPS,
  RESPONSIVE,
  DEFAULT_PX_PER_MM,
  getMetrics,
  realSizeScale,
} from "./devices.js";
import { KEYBOARD_MARKUP, keyboardHasFoot, keyboardHeight, keyboardPlatform } from "./keyboard.js";
import { ZOOM_ACTUAL, loadSettings, saveSettings } from "./settings.js";
import {
  contentScriptReady,
  hasAccess,
  isBuiltIn,
  removeAccess,
  requestAccess,
  siteOf,
} from "./sites.js";

const el = (id) => document.getElementById(id);
const frame = el("frame");
const stage = el("stage");
const device = el("device");
const shell = el("shell");
const screenEl = el("screen");
const barTop = el("bar-top");
const barBottom = el("bar-bottom");
const statusBar = el("statusbar");
const cutoutEl = el("cutout");
const homeButton = el("home-button");
const keyboardEl = el("keyboard");
const readout = el("readout");
const scaleEl = el("scale");
const statusEl = el("status");
const statusText = el("status-text");
const statusAction = el("status-action");
const presetSelect = el("preset");
const rotateButton = el("rotate");
const popoutButton = el("popout");
const pinToggle = el("pin");
const scrollToggle = el("scroll-sync");
const barsToggle = el("bars");
const frameToggle = el("frame-toggle");
const keyboardToggle = el("kb-toggle");
const zoomInputs = [...document.querySelectorAll('input[name="zoom"]')];

const { short_name: EXTENSION_NAME } = chrome.runtime.getManifest();

/** Marks messages as belonging to this extension. Must match content.js. */
const TAG = "side-mirror";

/** How long a page gets to report in before it is treated as not loading. */
const LOAD_TIMEOUT_MS = 10_000;

const params = new URLSearchParams(location.search);
const IS_POPOUT = params.get("popout") === "1";

const settings = loadSettings(IS_POPOUT ? params : null);
// The side panel owns the saved defaults; a pop-out's changes are its own.
const persist = () => {
  if (!IS_POPOUT) saveSettings(settings);
};

// ---------- state ----------

let followWindowId = null; // the browser window whose active tab is mirrored
let currentUrl = null; // what the frame was last told to load
let frameReady = false; // the mirrored page has reported in
let pinned = false;
let loadTimer = null;
let tabPort = null; // connection to the content script in the mirrored tab
let tabPortId = null;
let lastScrollFraction = 0;
let pageColors = null; // { theme, background } reported by the mirrored page
let keyboardState = { open: false, layout: "text" };
let keyboardMarkupKey = "";
let keyboardInset = 0; // how much of the page the keyboard covers
let offeredSite = null; // the site the "Mirror this site" button would grant

const px = (n) => `${n}px`;
const withoutHash = (url) => url.split("#")[0];
const metrics = () => getMetrics(settings);

// ---------- status ----------

function setLoading(on) {
  document.body.classList.toggle("loading", on);
}

/**
 * Show a notice over the stage, or clear it with an empty string.
 * @param {string} text
 * @param {{bad?: boolean, action?: {label: string, run: () => void}}} [options]
 */
function setStatus(text, { bad = false, action = null } = {}) {
  statusText.textContent = text;
  statusEl.hidden = !text;
  statusEl.classList.toggle("bad", bad);
  statusAction.hidden = !action;
  statusAction.textContent = action ? action.label : "";
  statusAction.onclick = action ? action.run : null;
}

// ---------- layout ----------

const HOME_BUTTON_SIZE = 46;
const STAGE_PADDING = 8;
const MIN_BAR_HEIGHT_FOR_ADDRESS = 44;

function layoutBar(bar, height, showAddress) {
  bar.hidden = height <= 0;
  bar.style.height = px(height);
  bar.querySelector(".pill").hidden = !showAddress || height < MIN_BAR_HEIGHT_FOR_ADDRESS;
}

function layout() {
  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  if (!availW || !availH) return;

  const m = metrics();
  rotateButton.disabled = !m || Boolean(m.spec.landscapeOnly);
  for (const input of zoomInputs) input.disabled = !m;
  barsToggle.disabled = !m;
  frameToggle.disabled = !m;

  if (!m) {
    layoutResponsive(availW, availH);
  } else {
    layoutDevice(m, availW, availH);
  }
  // Nothing in the device should ever be scrolled out of place.
  screenEl.scrollTop = 0;
  screenEl.scrollLeft = 0;
  paintBars();
  layoutKeyboard();
}

// Responsive: the page simply fills the stage.
function layoutResponsive(availW, availH) {
  shell.className = "";
  shell.style.cssText = "";
  for (const node of [shell, screenEl, frame, device]) {
    node.style.width = px(availW);
    node.style.height = px(availH);
  }
  screenEl.style.borderRadius = "";
  barTop.hidden = true;
  barBottom.hidden = true;
  cutoutEl.hidden = true;
  homeButton.hidden = true;
  readout.textContent = `${availW} × ${availH}`;
  scaleEl.textContent = "";
}

function layoutDevice(m, availW, availH) {
  const { spec, rotated, framed } = m;

  // Keep a little air around the device in the side panel. The pop-out window
  // is sized to the device exactly, so it gets none.
  const padding = IS_POPOUT ? 0 : STAGE_PADDING;
  const wanted =
    settings.zoom === ZOOM_ACTUAL ? realSizeScale(spec, settings.pxPerMm) : settings.zoom;
  const scale = Math.min(
    wanted,
    (availW - 2 * padding) / m.outerW,
    (availH - 2 * padding) / m.outerH,
  );

  shell.className = framed ? "framed" : "boxed";
  shell.style.width = px(m.outerW);
  shell.style.height = px(m.outerH);
  shell.style.padding = `${px(m.padY)} ${px(m.padX)}`;
  shell.style.borderRadius = framed
    ? px(spec.bodyRadius ?? spec.radius + Math.min(m.padX, m.padY))
    : "";
  shell.style.transform = scale !== 1 ? `scale(${scale})` : "";

  screenEl.style.width = px(m.screenW);
  screenEl.style.height = px(m.screenH);
  screenEl.style.borderRadius = framed ? px(spec.radius) : "";

  frame.style.width = px(m.w);
  frame.style.height = px(m.h);

  // Browser bars are drawn only inside the device frame. The address goes
  // where the device normally shows it, unless that bar is too thin in this
  // orientation.
  const topH = framed ? m.bars.top : 0;
  const bottomH = framed ? m.bars.bottom : 0;
  const addressAtTop = spec.bars.address === "top" || bottomH < MIN_BAR_HEIGHT_FOR_ADDRESS;
  layoutBar(barTop, topH, addressAtTop);
  layoutBar(barBottom, bottomH, !addressAtTop);

  // Status bar: clock and signal icons at the very top of the screen.
  const status = spec.bars.status;
  const showStatus =
    Boolean(status) && status.h > 0 && topH >= status.h && (!rotated || status.landscape);
  statusBar.hidden = !showStatus;
  if (showStatus) {
    statusBar.style.height = px(status.h);
    statusBar.style.padding = `0 ${px(status.right)} 0 ${px(status.left)}`;
    statusBar.style.fontSize = px(status.font);
  }

  // Phones with a home button have the browser's toolbar under the page
  // instead of a swipe indicator.
  const hasToolbar = Boolean(spec.homeButton) && bottomH >= MIN_BAR_HEIGHT_FOR_ADDRESS;
  barBottom.querySelector(".indicator").hidden = Boolean(spec.homeButton);
  barBottom.querySelector(".browser-tools").hidden = !hasToolbar;
  barBottom.classList.toggle("tools", hasToolbar);

  // Camera cutout: at the top in portrait, on the left side when rotated.
  const cutout = framed ? spec.cutout : null;
  cutoutEl.hidden = !cutout;
  if (cutout) {
    const w = rotated ? cutout.h : cutout.w;
    const h = rotated ? cutout.w : cutout.h;
    cutoutEl.style.width = px(w);
    cutoutEl.style.height = px(h);
    cutoutEl.style.left = px(rotated ? cutout.top : (m.sw - w) / 2);
    cutoutEl.style.top = px(rotated ? (m.sh - h) / 2 : cutout.top);
  }

  // Home button: in the chin below the display, or to its right when rotated.
  const showHome = framed && Boolean(spec.homeButton);
  homeButton.hidden = !showHome;
  if (showHome) {
    const chin = rotated ? m.padX : m.padY;
    const inset = (chin - HOME_BUTTON_SIZE) / 2;
    homeButton.style.left = px(
      rotated ? m.outerW - chin + inset : (m.outerW - HOME_BUTTON_SIZE) / 2,
    );
    homeButton.style.top = px(
      rotated ? (m.outerH - HOME_BUTTON_SIZE) / 2 : m.outerH - chin + inset,
    );
  }

  device.style.width = px(Math.floor(m.outerW * scale));
  device.style.height = px(Math.floor(m.outerH * scale));

  readout.textContent = `${m.w} × ${m.h}`;
  readout.title = "The size the page lays out at";
  const isScaled = Math.abs(scale - 1) > 0.004;
  scaleEl.textContent = isScaled ? `${Math.round(scale * 100)}%` : "";
  if (scale < wanted - 0.004) {
    scaleEl.title =
      "Scaled down to fit. Drag the panel wider or open it in its own window to see it larger.";
  } else {
    scaleEl.title = settings.zoom === ZOOM_ACTUAL ? "Shown at the device's real size" : "Zoom";
  }
}

// A phone browser tints the bar above the page to match it: Safari uses the
// page's theme colour or background; Chrome on Android uses the theme colour
// when the page sets one.
function paintBars() {
  const m = metrics();
  const kind = m ? m.spec.bars.kind : "ios";
  let color = "";
  if (pageColors) {
    color = kind === "android" ? pageColors.theme : pageColors.theme || pageColors.background;
  }
  if (!color && kind !== "android") color = "#fff";

  // Assigning to backgroundColor (not background) means the browser accepts
  // a colour and nothing else, whatever the page sent.
  barTop.style.backgroundColor = "";
  if (color) barTop.style.backgroundColor = color;

  const channels = getComputedStyle(barTop).backgroundColor.match(/[\d.]+/g);
  let isDark = false;
  if (channels && channels.length >= 3) {
    const [r, g, b] = channels.map(Number);
    isDark = 0.299 * r + 0.587 * g + 0.114 * b < 140;
  }
  barTop.classList.toggle("on-dark", isDark);

  // The display itself is black, so its rounded corners blend into the body.
  // In landscape the page is narrower than the display, and the strips beside
  // it take the page's colour, as they do on a phone.
  const hasSideStrips = Boolean(m) && m.framed && m.w < m.screenW;
  screenEl.style.backgroundColor = hasSideStrips ? pageColors?.background || "#fff" : "";
}

// The drawn address bars show the mirrored page's host.
function updateAddress() {
  const host = siteOf(currentUrl)?.host ?? "";
  for (const pill of document.querySelectorAll(".pill")) pill.textContent = host;
}

// ---------- on-screen keyboard ----------

function layoutKeyboard() {
  const m = metrics();
  const kind = m ? m.spec.bars.kind : "ios";
  const platform = keyboardPlatform(kind);
  const layoutName = keyboardState.layout;
  const landscape = Boolean(m?.rotated);
  const height = keyboardHeight(kind, layoutName, landscape, m ? m.screenH : stage.clientHeight);
  const visible = settings.keyboard && keyboardState.open;

  const markupKey = `${platform}-${layoutName}`;
  if (markupKey !== keyboardMarkupKey) {
    keyboardEl.innerHTML = KEYBOARD_MARKUP[markupKey]; // fixed markup, see keyboard.js
    keyboardMarkupKey = markupKey;
  }

  keyboardEl.className = [
    platform,
    layoutName,
    keyboardHasFoot(kind, landscape) ? "has-foot" : "",
    landscape ? "landscape" : "",
    visible ? "open" : "",
  ].join(" ");
  keyboardEl.style.height = px(height);

  // The keyboard rises from the bottom of the screen, so it covers the bottom
  // browser bar first and the page after that.
  const belowPage = m?.framed ? m.bars.bottom : 0;
  keyboardInset = visible ? Math.max(0, height - belowPage) : 0;
}

function setKeyboard(open, layoutName = "text") {
  keyboardState = { open, layout: layoutName === "numeric" ? "numeric" : "text" };
  layoutKeyboard();
  if (open) postToFrame({ type: "keyboard-inset", inset: keyboardInset });
}

// Clicking the drawing must not take focus away from the page's text field.
keyboardEl.addEventListener("mousedown", (event) => event.preventDefault());

// ---------- pop-out window sizing ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resize the pop-out window until the stage is exactly the device's size.
// Stops after a few passes in case the monitor is too small; scaling covers
// the rest.
async function fitWindowToDevice() {
  if (!IS_POPOUT) return;
  for (let pass = 0; pass < 3; pass++) {
    const m = metrics();
    if (!m) return;
    const dw = m.outerW - stage.clientWidth;
    const dh = m.outerH - stage.clientHeight;
    if (!dw && !dh) return;
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.windows.update(win.id, { width: win.width + dw, height: win.height + dh });
    } catch {
      return;
    }
    await sleep(150);
  }
}

// ---------- header rules ----------
// Many sites forbid being shown in a frame, with an X-Frame-Options header or
// a Content-Security-Policy `frame-ancestors` directive. To mirror them, those
// headers are removed, but only from responses that load into a mirror view's
// frame, and only on sites the extension has been granted. Pages in ordinary
// tabs are never touched.
//
// declarativeNetRequest can remove a header but not edit one, so the whole
// Content-Security-Policy header goes, not just `frame-ancestors`. The
// mirrored copy of a page therefore runs without the site's CSP.
//
// These are session rules. background.js removes them when the last view
// closes.

const SIDE_PANEL_FRAME_RULE_ID = 1;
const OWN_PAGES_RULE_ID = 2;
const FIRST_POPOUT_RULE_ID = 1000; // each pop-out window takes the next free id

const ALLOW_FRAMING = {
  type: "modifyHeaders",
  responseHeaders: [
    { header: "x-frame-options", operation: "remove" },
    { header: "content-security-policy", operation: "remove" },
  ],
};

async function installHeaderRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const replaced = [OWN_PAGES_RULE_ID];
  const rules = [
    // Loads started by this extension's own pages: the first load of a frame.
    {
      id: OWN_PAGES_RULE_ID,
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ["sub_frame"] },
    },
  ];

  // Later navigations inside the frame are started by the page itself, so
  // they are matched by where the frame lives instead.
  if (IS_POPOUT) {
    const ownTab = await chrome.tabs.getCurrent();
    if (ownTab) {
      const forThisTab = (rule) => rule.condition.tabIds?.includes(ownTab.id);
      replaced.push(...existing.filter(forThisTab).map((rule) => rule.id));
      const taken = new Set(existing.filter((rule) => !forThisTab(rule)).map((rule) => rule.id));
      let id = FIRST_POPOUT_RULE_ID;
      while (taken.has(id)) id++;
      rules.push({ id, condition: { tabIds: [ownTab.id], resourceTypes: ["sub_frame"] } });
    }
  } else {
    // A side panel is not a tab; its requests carry the "no tab" id.
    replaced.push(SIDE_PANEL_FRAME_RULE_ID);
    rules.push({
      id: SIDE_PANEL_FRAME_RULE_ID,
      condition: { tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ["sub_frame"] },
    });
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: replaced,
    addRules: rules.map((rule) => ({ ...rule, priority: 1, action: ALLOW_FRAMING })),
  });
}

// Tell the service worker this view is going away, so it can remove the rules
// once no view is left.
window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "view-closing" }).catch(() => {});
});

// ---------- the mirrored page ----------

function postToFrame(message) {
  // The frame's origin changes as it navigates, and these messages carry only
  // a scroll fraction or a pixel inset, so a wildcard target is acceptable.
  frame.contentWindow?.postMessage({ source: TAG, ...message }, "*");
}

function sendScroll() {
  if (settings.scrollSync) postToFrame({ type: "scroll", frac: lastScrollFraction });
}

function load(url, { force = false } = {}) {
  const sameDocument = currentUrl !== null && withoutHash(currentUrl) === withoutHash(url);
  currentUrl = url;
  frame.src = url;
  updateAddress();

  // A hash-only change does not reload the frame.
  if (sameDocument && !force) return;

  frameReady = false;
  pageColors = null;
  setKeyboard(false);
  paintBars();
  setStatus("");
  setLoading(true);
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (frameReady) return;
    setLoading(false);
    setStatus("This page didn't load here. Some sites can't be shown inside another page.", {
      bad: true,
      action: { label: "Open in a window", run: openInOwnWindow },
    });
  }, LOAD_TIMEOUT_MS);
}

// For sites that cannot be framed at all: a real browser window at the
// device's size. It loses the side-by-side view but nothing can block it.
function openInOwnWindow() {
  if (!currentUrl) return;
  const m = metrics();
  chrome.windows
    .create({ url: currentUrl, type: "popup", width: m ? m.w : 400, height: m ? m.h : 800 })
    .catch((error) => setStatus(`Couldn't open a window: ${error.message}`, { bad: true }));
}

// Messages from the content script running in the mirrored page.
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || message.source !== TAG) return;

  switch (message.type) {
    case "ready":
      frameReady = true;
      clearTimeout(loadTimer);
      setLoading(false);
      setStatus("");
      sendScroll(); // line the fresh page up with the main tab
      break;
    case "colors":
      pageColors = {
        theme: cssColorOrNull(message.theme),
        background: cssColorOrNull(message.background),
      };
      paintBars();
      break;
    case "keyboard":
      setKeyboard(Boolean(message.open), message.layout);
      break;
  }
});

// Page-supplied values are only ever used as colours, and only when the
// browser itself recognises them as one.
function cssColorOrNull(value) {
  return typeof value === "string" && value.length <= 64 && CSS.supports("color", value)
    ? value
    : null;
}

// ---------- connection to the mirrored tab ----------

function disconnectTab() {
  try {
    tabPort?.disconnect();
  } catch {
    // already gone
  }
  tabPort = null;
  tabPortId = null;
}

/**
 * Connect to the content script in a tab, to receive its scroll position.
 * @param {number} tabId
 * @param {boolean} [injectIfMissing]  A tab that was open before the extension
 *   had access has no content script yet; inject it once and try again.
 */
function connectTab(tabId, injectIfMissing = true) {
  if (tabPort && tabPortId === tabId) return;
  disconnectTab();

  let port;
  try {
    port = chrome.tabs.connect(tabId, { name: TAG, frameId: 0 });
  } catch {
    return;
  }
  tabPort = port;
  tabPortId = tabId;
  let heardFromTab = false;

  port.onMessage.addListener((message) => {
    heardFromTab = true;
    if (port !== tabPort) return;
    if (message?.type === "scroll" && Number.isFinite(message.frac)) {
      lastScrollFraction = message.frac;
      sendScroll();
    }
  });

  port.onDisconnect.addListener(() => {
    // Reading lastError marks it as handled. It is set when nothing in the
    // tab was listening.
    const nobodyListening = Boolean(chrome.runtime.lastError) && !heardFromTab;
    if (port !== tabPort) return;
    tabPort = null;
    tabPortId = null;
    if (nobodyListening && injectIfMissing) {
      chrome.scripting
        .executeScript({ target: { tabId }, files: ["content.js"] })
        .then(() => connectTab(tabId, false))
        .catch(() => {
          // The page does not allow scripts (an error page, the Web Store).
        });
    }
  });
}

// The device's screen must never scroll: its contents are laid out to fit
// exactly. CSS already forbids it; this puts it back if anything manages to.
screenEl.addEventListener("scroll", () => {
  if (screenEl.scrollTop) screenEl.scrollTop = 0;
  if (screenEl.scrollLeft) screenEl.scrollLeft = 0;
});

// ---------- following the active tab ----------

const siteNotice = el("site-notice");
const siteNoticeText = el("site-notice-text");
const siteEnable = el("site-enable");
const siteRow = el("site-row");
const siteLabel = el("site-label");
const siteToggle = el("site-toggle");

/**
 * Update the two places that show whether the main tab's site is mirrored:
 * the notice over the stage and the switch in View options.
 *
 * @param {"mirrored" | "not-granted" | "unreadable" | "not-web"} state
 * @param {import("./sites.js").Site | null} site
 */
function showSiteState(state, site) {
  offeredSite = state === "not-granted" ? site : null;

  const showNotice = !pinned && (state === "not-granted" || state === "unreadable");
  siteNotice.hidden = !showNotice;
  if (state === "not-granted") {
    siteNoticeText.textContent = `Not mirroring ${site.host}`;
    siteEnable.hidden = false;
  } else if (state === "unreadable") {
    // Without access the extension cannot even see which site this is.
    // Clicking the toolbar icon grants access to the current tab.
    siteNoticeText.textContent = `To mirror this tab, click the ${EXTENSION_NAME} icon in the toolbar`;
    siteEnable.hidden = true;
  }
  if (showNotice) setStatus("");
  if (state === "not-web" && !currentUrl) setStatus("Open a web page to see it here.");

  // Sites the user turned on can be turned off again. Localhost is always on.
  const canTurnOff = state === "mirrored" && !isBuiltIn(site);
  siteRow.hidden = !canTurnOff;
  if (canTurnOff) {
    siteLabel.textContent = `Mirror ${site.host}`;
    siteToggle.checked = true;
  }
}

let syncRun = 0;
const scriptConfirmedFor = new Set(); // site patterns known to have the content script

async function sync() {
  if (pinned || followWindowId === null) return;
  const run = ++syncRun;

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, windowId: followWindowId });
  } catch {
    return;
  }
  if (run !== syncRun || !tab) return;

  // `tab.url` is only present for sites the extension has access to.
  const site = siteOf(tab.url);
  if (!site) {
    disconnectTab();
    showSiteState(tab.url ? "not-web" : "unreadable", null);
    return;
  }

  const granted = await hasAccess(site);
  if (run !== syncRun) return;
  if (!granted) {
    // Leave the last mirrored page where it is. Nothing is loaded for this tab.
    disconnectTab();
    showSiteState("not-granted", site);
    return;
  }

  // Localhost has the content script from the manifest. Other sites get it
  // registered when access is granted, which may still be in progress.
  if (!isBuiltIn(site) && !scriptConfirmedFor.has(site.pattern)) {
    await contentScriptReady();
    if (run !== syncRun) return;
    scriptConfirmedFor.add(site.pattern);
  }

  showSiteState("mirrored", site);
  if (tab.url !== currentUrl) {
    if (currentUrl === null || withoutHash(tab.url) !== withoutHash(currentUrl)) {
      lastScrollFraction = 0;
    }
    load(tab.url);
  }
  connectTab(tab.id);
}

// Reloading the main tab reloads the mirror too.
async function reloadIfStillOnSamePage(tabId) {
  await sleep(150); // a navigation to a new URL reports that URL a moment later
  if (pinned || !currentUrl) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active && tab.windowId === followWindowId && tab.url === currentUrl) {
      load(currentUrl, { force: true });
    }
  } catch {
    // The tab closed.
  }
}

chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId === followWindowId) sync();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.windowId !== followWindowId || !tab.active) return;
  if (changeInfo.url || changeInfo.status === "complete") sync();
  else if (changeInfo.status === "loading") reloadIfStillOnSamePage(tabId);
});

// Access can be granted or removed from the toolbar icon, from here, or from
// Chrome's own settings. Whichever it was, catch up.
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(() => {
  scriptConfirmedFor.clear();
  sync();
});

siteEnable.addEventListener("click", async () => {
  if (!offeredSite) return;
  try {
    await requestAccess(offeredSite); // Chrome's prompt; onAdded follows up
  } catch (error) {
    setStatus(`Couldn't ask for access: ${error.message}`, { bad: true });
  }
});

siteToggle.addEventListener("change", async () => {
  const site = siteOf(currentUrl);
  if (siteToggle.checked || !site) return;
  await removeAccess(site).catch(() => {});
  sync();
});

// ---------- controls ----------

function applyDeviceChange() {
  persist();
  layout();
  fitWindowToDevice();
}

presetSelect.addEventListener("change", () => {
  settings.preset = presetSelect.value;
  syncDeviceMenu();
  applyDeviceChange();
});

rotateButton.addEventListener("click", () => {
  settings.rotated = !settings.rotated;
  applyDeviceChange();
});

frameToggle.addEventListener("change", () => {
  settings.deviceFrame = frameToggle.checked;
  applyDeviceChange();
});

barsToggle.addEventListener("change", () => {
  settings.browserBars = barsToggle.checked;
  applyDeviceChange();
});

keyboardToggle.addEventListener("change", () => {
  settings.keyboard = keyboardToggle.checked;
  persist();
  layoutKeyboard();
  if (settings.keyboard && keyboardState.open) {
    postToFrame({ type: "keyboard-inset", inset: keyboardInset });
  }
});

scrollToggle.addEventListener("change", () => {
  settings.scrollSync = scrollToggle.checked;
  persist();
  sendScroll();
});

pinToggle.addEventListener("change", () => {
  pinned = pinToggle.checked;
  if (pinned) {
    disconnectTab();
    siteNotice.hidden = true;
  } else {
    sync();
  }
});

for (const input of zoomInputs) {
  input.addEventListener("change", () => {
    settings.zoom = input.value === ZOOM_ACTUAL ? ZOOM_ACTUAL : Number(input.value) || 1;
    persist();
    layout();
  });
}

function checkZoomInput() {
  const input =
    zoomInputs.find((item) => item.value === String(settings.zoom)) ??
    zoomInputs.find((item) => item.value === "1");
  input.checked = true;
}

popoutButton.addEventListener("click", async () => {
  if (followWindowId === null) return;
  const m = metrics();
  const query = new URLSearchParams({
    popout: "1",
    win: String(followWindowId),
    preset: settings.preset,
    rotated: settings.rotated ? "1" : "0",
    bars: settings.browserBars ? "1" : "0",
    frame: settings.deviceFrame ? "1" : "0",
  });
  try {
    // A rough first size; the pop-out then fits itself to the device exactly.
    await chrome.windows.create({
      url: chrome.runtime.getURL(`panel/panel.html?${query}`),
      type: "popup",
      width: (m ? m.outerW : 430) + 16,
      height: (m ? m.outerH : 800) + 80,
    });
  } catch (error) {
    setStatus(`Couldn't open the window: ${error.message}`, { bad: true });
  }
});

// ---------- calibrating real size ----------
// A bank card is the same size everywhere (ISO/IEC 7810 ID-1). The user drags
// until the outline on screen matches a real card, which gives the number of
// screen pixels in a millimetre.

const CARD_MM = { long: 85.6, short: 53.98, radius: 3.18 };
const calibration = el("calibrate");
const calibrationCard = el("cal-card");
const calibrationSlider = el("cal-slider");
const calibrationNote = el("cal-note");

function updateCalibrationNote() {
  calibrationNote.textContent = settings.pxPerMm
    ? "Calibrated for this screen"
    : "Assuming a typical laptop screen";
}

function drawCalibrationCard() {
  const pxPerMm = Number(calibrationSlider.value);
  calibrationCard.style.width = px(CARD_MM.short * pxPerMm);
  calibrationCard.style.height = px(CARD_MM.long * pxPerMm);
  calibrationCard.style.borderRadius = px(CARD_MM.radius * pxPerMm);
}

calibrationSlider.addEventListener("input", drawCalibrationCard);

el("cal-btn").addEventListener("click", () => {
  toggleSettings(false);
  calibrationSlider.value = String(settings.pxPerMm || DEFAULT_PX_PER_MM);
  drawCalibrationCard();
  calibration.hidden = false;
});

el("cal-cancel").addEventListener("click", () => {
  calibration.hidden = true;
});

el("cal-save").addEventListener("click", () => {
  settings.pxPerMm = Number(calibrationSlider.value);
  settings.zoom = ZOOM_ACTUAL;
  persist();
  checkZoomInput();
  updateCalibrationNote();
  calibration.hidden = true;
  layout();
});

// ---------- menus: device list and view options ----------
// The native <select> stays in the page, hidden, as the form control that
// holds the chosen device. The visible list is built from the same data.

const deviceButton = el("device-btn");
const deviceMenu = el("device-menu");
const deviceName = el("device-name");
const settingsButton = el("settings-btn");
const settingsMenu = el("settings");
const CHECK_ICON =
  '<svg class="check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

function buildDeviceList() {
  const addItem = (value, name, size) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "item";
    item.setAttribute("role", "option");
    item.dataset.value = value;
    const nameEl = document.createElement("span");
    nameEl.textContent = name;
    const sizeEl = document.createElement("span");
    sizeEl.className = "dims";
    sizeEl.textContent = size;
    item.append(nameEl, sizeEl);
    item.insertAdjacentHTML("beforeend", CHECK_ICON);
    deviceMenu.append(item);
  };

  addItem(RESPONSIVE, "Responsive", "");
  for (const group of DEVICE_GROUPS) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = group.label;
    deviceMenu.append(label);

    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const id of group.ids) {
      const { name, w, h } = DEVICES[id];
      addItem(id, name, `${w} × ${h}`);
      optgroup.append(new Option(name, id));
    }
    presetSelect.append(optgroup);
  }
}

function syncDeviceMenu() {
  deviceName.textContent = DEVICES[settings.preset]?.name ?? "Responsive";
  for (const item of deviceMenu.querySelectorAll(".item")) {
    item.setAttribute("aria-selected", String(item.dataset.value === settings.preset));
  }
}

function toggleDeviceMenu(open) {
  deviceMenu.hidden = !open;
  deviceButton.setAttribute("aria-expanded", String(open));
  if (open) {
    toggleSettings(false);
    const current = deviceMenu.querySelector('.item[aria-selected="true"]');
    (current ?? deviceMenu.querySelector(".item")).focus();
  }
}

function toggleSettings(open) {
  settingsMenu.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  if (open) toggleDeviceMenu(false);
}

function closeMenus() {
  toggleDeviceMenu(false);
  toggleSettings(false);
}

deviceButton.addEventListener("click", () => toggleDeviceMenu(deviceMenu.hidden));
settingsButton.addEventListener("click", () => toggleSettings(settingsMenu.hidden));

deviceMenu.addEventListener("click", (event) => {
  const item = event.target.closest(".item");
  if (!item) return;
  presetSelect.value = item.dataset.value;
  presetSelect.dispatchEvent(new Event("change"));
  toggleDeviceMenu(false);
  deviceButton.focus();
});

// Arrow keys move through the device list.
deviceMenu.addEventListener("keydown", (event) => {
  const items = [...deviceMenu.querySelectorAll(".item")];
  const index = items.indexOf(document.activeElement);
  const targets = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  };
  if (!(event.key in targets)) return;
  event.preventDefault();
  items[targets[event.key]].focus();
});

document.addEventListener("pointerdown", (event) => {
  const inside = [deviceMenu, deviceButton, settingsMenu, settingsButton].some((node) =>
    node.contains(event.target),
  );
  if (!inside) closeMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!deviceMenu.hidden) {
    toggleDeviceMenu(false);
    deviceButton.focus();
  } else if (!settingsMenu.hidden) {
    toggleSettings(false);
    settingsButton.focus();
  }
});

// Clicking into the mirrored page moves focus into its frame, which this
// document only sees as losing focus.
window.addEventListener("blur", () => {
  if (document.activeElement === frame) closeMenus();
});

// ---------- startup ----------

async function findOwnWindowId() {
  try {
    const win = await chrome.windows.getCurrent();
    if (typeof win?.id === "number") return win.id;
  } catch {
    // fall through
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) return tab.windowId;
  } catch {
    // fall through
  }
  return null;
}

async function start() {
  buildDeviceList();
  presetSelect.value = settings.preset;
  syncDeviceMenu();
  scrollToggle.checked = settings.scrollSync;
  barsToggle.checked = settings.browserBars;
  frameToggle.checked = settings.deviceFrame;
  keyboardToggle.checked = settings.keyboard;
  checkZoomInput();
  updateCalibrationNote();
  new ResizeObserver(layout).observe(stage);
  layout();

  try {
    await installHeaderRules();
  } catch (error) {
    console.error("Could not install header rules", error);
  }

  if (IS_POPOUT) {
    document.body.classList.add("popout");
    const windowId = Number(params.get("win"));
    followWindowId = Number.isInteger(windowId) ? windowId : null;
    await fitWindowToDevice();
  } else {
    followWindowId = await findOwnWindowId();
  }

  if (followWindowId === null) {
    setStatus("Couldn't work out which window to follow.", { bad: true });
    return;
  }
  sync();
}

start();
