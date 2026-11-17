// A Sidephone view: the side panel, or a pop-out window opened from it. It
// follows the active tab of one browser window and shows that page in one or
// more devices side by side (view.js draws each one). This file runs the
// toolbar, menus, checks and breakpoints, and the connection to the tab.

import {
  DEFAULT_DEVICE,
  DEFAULT_PX_PER_MM,
  DEVICES,
  DEVICE_GROUPS,
  RESPONSIVE,
  cycleDevice,
  getMetrics,
  isDevice,
  realSizeScale,
} from "./devices.js";
import { clampWidth, fitScales, snapToBreakpoint } from "./layout.js";
import {
  MAX_COMPARE,
  ZOOM_ACTUAL,
  loadSettings,
  rememberSiteDevice,
  saveSettings,
} from "./settings.js";
import {
  contentScriptReady,
  hasAccess,
  isBuiltIn,
  removeAccess,
  requestAccess,
  siteOf,
} from "./sites.js";
import { DeviceView, TAG } from "./view.js";

const el = (id) => document.getElementById(id);
const stage = el("stage");
const viewsEl = el("views");
const template = el("view-template");
const emptyEl = el("empty");
const readout = el("readout");
const scaleEl = el("scale");
const statusEl = el("status");
const statusText = el("status-text");
const statusAction = el("status-action");
const rotateButton = el("rotate");
const popoutButton = el("popout");
const pinToggle = el("pin");
const scrollToggle = el("scroll-sync");
const barsToggle = el("bars");
const frameToggle = el("frame-toggle");
const keyboardToggle = el("kb-toggle");
const inAppToggle = el("in-app");
const outlinesToggle = el("outlines-toggle");
const zoomInputs = [...document.querySelectorAll('input[name="zoom"]')];

const MANIFEST = chrome.runtime.getManifest();
const EXTENSION_NAME = MANIFEST.short_name;
const ISOLATED_FILES = MANIFEST.content_scripts.find((script) => script.world !== "MAIN").js;
const PAGE_WORLD_FILES = MANIFEST.content_scripts.find((script) => script.world === "MAIN").js;

const params = new URLSearchParams(location.search);
const IS_POPOUT = params.get("popout") === "1";

const settings = loadSettings(IS_POPOUT ? params : null);
// The side panel owns the saved defaults; a pop-out's changes are its own.
const persist = () => {
  if (!IS_POPOUT) saveSettings(settings);
};

// Keep a little air around the devices in the side panel. The pop-out window
// is sized to them exactly, so it gets none.
const STAGE_PADDING = IS_POPOUT ? 0 : 8;
const VIEW_GAP = 16;
const LABEL_HEIGHT = 32; // device names above each device when comparing
const HANDLE_WIDTH = 16; // the resize grip beside a responsive page
// Chrome reports a single-page app's route change like any navigation. The
// page reports it too, a moment later, so a load waits this long for that.
const SAME_DOCUMENT_GRACE_MS = 150;

// ---------- state ----------

let followWindowId = null; // the browser window whose active tab is mirrored
let followedTabId = null;
let currentUrl = null; // the page the views were last told to show
let currentHost = null; // its host, for remembering a device per site
let pinned = false;
let tabPort = null; // connection to the content script in the mirrored tab
let tabPortId = null;
let tabErrors = null; // messages of errors seen in the tab, while connected
let lastScrollFraction = 0;
let offeredSite = null; // the site the "Mirror this site" button would grant
let responsiveWidth = 0; // the width a responsive page currently has

/** @type {DeviceView[]} The first is the main device; the rest are compared with it. */
const views = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withoutHash = (url) => url.split("#")[0];
const viewSettings = (view) => ({ ...settings, preset: view.preset });

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------- status ----------

function setLoading(on) {
  document.body.classList.toggle("loading", on);
}

/**
 * Show a notice over the stage, or clear it with an empty string.
 * @param {string} text
 * @param {{bad?: boolean, action?: {label: string, run: () => void}, clearAfter?: number}} [options]
 */
let statusTimer = null;
function setStatus(text, { bad = false, action = null, clearAfter = 0 } = {}) {
  clearTimeout(statusTimer);
  statusText.textContent = text;
  statusEl.hidden = !text;
  statusEl.classList.toggle("bad", bad);
  statusAction.hidden = !action;
  statusAction.textContent = action ? action.label : "";
  statusAction.onclick = action ? action.run : null;
  if (text && clearAfter) statusTimer = setTimeout(() => setStatus(""), clearAfter);
}

function updateEmptyState() {
  const empty = currentUrl === null;
  document.body.classList.toggle("empty", empty);
  emptyEl.hidden = !empty;
}

// ---------- the devices on the stage ----------

/** In-app mode on an Android device shows the page an Android WebView user agent. */
function frameNameFor(view) {
  return settings.inApp && DEVICES[view.preset]?.bars.kind === "android"
    ? "sidephone:android-webview"
    : "";
}

/** Create or remove views so there is one per device, in order. */
function syncViews() {
  const presets = [settings.preset, ...settings.compare];
  while (views.length > presets.length) views.pop().destroy();
  while (views.length < presets.length) {
    const view = new DeviceView(template, { onLoadTimeout: handleLoadTimeout });
    view.els.name.addEventListener("click", () =>
      openDeviceMenu(views.indexOf(view), view.els.name),
    );
    view.els.remove.addEventListener("click", () => removeCompared(views.indexOf(view)));
    setUpResizeHandle(view);
    views.push(view);
    viewsEl.append(view.root);
  }
  views.forEach((view, index) => (view.preset = presets[index]));
  viewsEl.classList.toggle("compare", views.length > 1);

  // New views, and views whose frame must be presented differently, load the page.
  for (const view of views) {
    const frameName = frameNameFor(view);
    if (currentUrl && (!view.url || view.els.frame.name !== frameName)) {
      view.load(view.url ?? currentUrl, { force: true, frameName });
      setLoading(true);
    }
  }
}

const wantedScale = (spec) =>
  settings.zoom === ZOOM_ACTUAL ? realSizeScale(spec, settings.pxPerMm) : settings.zoom;

function layout() {
  const availW = stage.clientWidth;
  const availH = stage.clientHeight;
  if (!availW || !availH || views.length === 0) return;

  const main = getMetrics(viewSettings(views[0]));
  updateControls(main);

  if (!main) {
    layoutResponsive(views[0], availW, availH);
  } else {
    const items = views.map((view) => {
      const m = getMetrics(viewSettings(view));
      return { view, m, w: m.outerW, h: m.outerH, wanted: wantedScale(m.spec) };
    });
    const scales = fitScales(
      items,
      { width: availW, height: availH },
      { gap: VIEW_GAP, padding: STAGE_PADDING, labelHeight: views.length > 1 ? LABEL_HEIGHT : 0 },
    );
    items.forEach(({ view, m }, index) => {
      view.draw(m, scales[index]);
      view.els.handle.hidden = true;
      view.setLabel(m.spec.name, `${m.w} × ${m.h}`, index > 0);
    });

    readout.textContent = `${main.w} × ${main.h}`;
    readout.title = "The size the page lays out at";
    const scale = scales[0];
    const wanted = items[0].wanted;
    scaleEl.textContent = Math.abs(scale - 1) > 0.004 ? `${Math.round(scale * 100)}%` : "";
    if (scale < wanted - 0.004) {
      scaleEl.title =
        "Scaled down to fit. Drag the panel wider or open it in its own window to see it larger.";
    } else {
      scaleEl.title = settings.zoom === ZOOM_ACTUAL ? "Shown at the device's real size" : "Zoom";
    }
  }

  for (const view of views) view.layoutKeyboard(settings.keyboard);
  renderRuler();
}

// Responsive: no device, just the page. Its width is fixed by the resize grip
// or fills the stage; its height always fills the stage.
function layoutResponsive(view, availW, availH) {
  const roomW = availW - 2 * STAGE_PADDING - HANDLE_WIDTH;
  const width = settings.responsiveWidth ?? Math.max(1, Math.floor(roomW));
  const scale = Math.min(1, roomW / width);
  const height = Math.floor((availH - 2 * STAGE_PADDING) / scale);
  responsiveWidth = width;

  view.drawResponsive(width, height, scale);
  view.setLabel("Responsive", `${width} × ${height}`, false);
  const handle = view.els.handle;
  handle.hidden = false;
  handle.setAttribute("aria-valuenow", String(width));
  handle.setAttribute("aria-valuetext", `${width} pixels`);

  readout.textContent = `${width} × ${height}`;
  readout.title = settings.responsiveWidth
    ? "Drag the grip beside the page to change its width. Double-click the grip to fill the panel."
    : "Fills the panel. Drag the grip beside the page to set a width.";
  scaleEl.textContent = scale < 0.996 ? `${Math.round(scale * 100)}%` : "";
  scaleEl.title = "Scaled down to fit";
}

function updateControls(main) {
  rotateButton.disabled = !main || Boolean(main.spec.landscapeOnly);
  for (const input of zoomInputs) input.disabled = !main;
  frameToggle.disabled = !main;
  inAppToggle.disabled = !main;
  barsToggle.disabled = !main || settings.inApp;
}

// The pop-out window resizes itself until the stage fits the devices at 100%.
// It stops after a few passes in case the monitor is too small; scaling
// covers the rest.
async function fitWindowToDevices() {
  if (!IS_POPOUT) return;
  for (let pass = 0; pass < 3; pass++) {
    const main = getMetrics(viewSettings(views[0]));
    let needW;
    let needH;
    if (!main) {
      needW = (settings.responsiveWidth ?? 400) + HANDLE_WIDTH;
      needH = stage.clientHeight;
    } else {
      const sizes = views.map((view) => getMetrics(viewSettings(view)));
      needW = sizes.reduce((sum, m) => sum + m.outerW, 0) + VIEW_GAP * (sizes.length - 1);
      needH = Math.max(...sizes.map((m) => m.outerH)) + (sizes.length > 1 ? LABEL_HEIGHT : 0);
    }
    const dw = Math.ceil(needW - stage.clientWidth);
    const dh = Math.ceil(needH - stage.clientHeight);
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

// ---------- resizing a responsive page ----------

const SNAP_DISTANCE = 6; // screen pixels

function setUpResizeHandle(view) {
  const handle = view.els.handle;
  let drag = null;

  const setWidth = (width) => {
    settings.responsiveWidth = clampWidth(width);
    layout();
  };

  handle.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, width: responsiveWidth, scale: view.scale };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    // The page is centred, so its edge moves half as far as its width changes.
    const width = drag.width + (2 * (event.clientX - drag.x)) / drag.scale;
    setWidth(
      event.shiftKey
        ? width
        : snapToBreakpoint(width, view.breakpoints.widths, SNAP_DISTANCE / drag.scale),
    );
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove("dragging");
    persist();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("dblclick", () => {
    settings.responsiveWidth = null;
    persist();
    layout();
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 10 : 1;
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    setWidth(responsiveWidth + direction * step);
    persist();
  });
}

// ---------- breakpoints ----------

const ruler = el("ruler");
const rulerChips = el("ruler-chips");
let rulerKey = "";

/** The main page's breakpoints, marking the ones its current width is past. */
function renderRuler() {
  const view = views[0];
  const { widths, unreadable } = view.breakpoints;
  const pageWidth = view.metrics ? view.metrics.w : responsiveWidth;
  const comparing = views.length > 1;
  ruler.hidden = currentUrl === null || widths.length === 0;
  ruler.title = unreadable
    ? `${unreadable} stylesheet${unreadable === 1 ? "" : "s"} from another site couldn't be read, so some breakpoints may be missing.`
    : "";

  const key = `${widths.join(",")}|${pageWidth}|${comparing}`;
  if (ruler.hidden || key === rulerKey) return;
  rulerKey = key;
  rulerChips.replaceChildren(
    ...widths.map((width) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip${pageWidth >= width ? " active" : ""}`;
      chip.dataset.width = String(width);
      chip.textContent = String(width);
      chip.disabled = comparing;
      chip.title = comparing
        ? `The layout changes at ${width}px. Remove the compared devices to jump to a width.`
        : `The layout changes at ${width}px. Click to see the page at ${width}px; Shift-click for ${width - 1}px, just below.`;
      return chip;
    }),
  );
}

rulerChips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip || views.length > 1) return;
  settings.preset = RESPONSIVE;
  settings.responsiveWidth = clampWidth(Number(chip.dataset.width) - (event.shiftKey ? 1 : 0));
  applyDeviceChange();
});

// ---------- mobile checks ----------

const checksButton = el("checks-btn");
const checksMenu = el("checks");
const checksList = el("checks-list");
const checksCount = el("checks-count");

const KIND_LABELS = {
  overflow: "Wider than the screen",
  "tap-target": "Small touch targets",
  "input-zoom": "Fields that zoom in on iPhone",
  "small-text": "Small text",
};

let checksQueued = false;
function scheduleChecksRender() {
  if (checksQueued) return;
  checksQueued = true;
  requestAnimationFrame(() => {
    checksQueued = false;
    renderChecksBadge();
    if (!checksMenu.hidden) renderChecksList();
  });
}

function renderChecksBadge() {
  const total = views.reduce((sum, view) => sum + view.issues.length + view.errors.length, 0);
  const severe = views.some(
    (view) => view.errors.length || view.issues.some((issue) => issue.severity === "error"),
  );
  checksCount.hidden = currentUrl === null || total === 0;
  checksCount.textContent = total > 99 ? "99+" : String(total);
  checksCount.classList.toggle("error", severe);
  checksButton.title = total
    ? `Mobile checks: ${total} to look at`
    : "Mobile checks: nothing found on this page";
}

function checkItem({ severity, title, detail, tag, onClick }) {
  const item = document.createElement(onClick ? "button" : "div");
  if (onClick) {
    item.type = "button";
    item.addEventListener("click", onClick);
  }
  item.className = `check-item${severity === "error" ? " error" : ""}`;
  const titleEl = document.createElement("b");
  titleEl.textContent = title;
  const detailEl = document.createElement("span");
  detailEl.textContent = detail;
  if (tag) {
    const tagEl = document.createElement("i");
    tagEl.className = "tag";
    tagEl.textContent = tag;
    detailEl.append(tagEl);
  }
  item.append(titleEl, detailEl);
  return item;
}

function groupLabel(text) {
  const label = document.createElement("div");
  label.className = "check-group";
  label.textContent = text;
  return label;
}

function renderChecksList() {
  const nodes = [];
  for (const view of views) {
    if (views.length > 1) {
      const heading = document.createElement("div");
      heading.className = "check-device";
      heading.textContent = DEVICES[view.preset]?.name ?? "Responsive";
      nodes.push(heading);
    }
    if (!view.ready && view.url) {
      nodes.push(
        Object.assign(document.createElement("div"), {
          className: "check-empty",
          textContent: "Checking…",
        }),
      );
      continue;
    }
    if (view.issues.length === 0 && view.errors.length === 0) {
      nodes.push(
        Object.assign(document.createElement("div"), {
          className: "check-empty",
          textContent: "No problems found on this page.",
        }),
      );
      continue;
    }
    for (const kind of Object.keys(KIND_LABELS)) {
      const issues = view.issues.filter((issue) => issue.kind === kind);
      if (!issues.length) continue;
      nodes.push(groupLabel(`${KIND_LABELS[kind]} (${issues.length})`));
      for (const issue of issues) {
        nodes.push(
          checkItem({
            severity: issue.severity,
            title: issue.label,
            detail: issue.detail,
            onClick: () => view.post({ type: "reveal", id: issue.id }),
          }),
        );
      }
    }
    if (view.errors.length) {
      nodes.push(groupLabel(`JavaScript errors (${view.errors.length})`));
      for (const error of view.errors) {
        const file = error.source.split(/[?#]/)[0].split("/").pop();
        // Errors the desktop page did not throw are likely caused by the mobile layout.
        const mobileOnly = tabErrors !== null && !tabErrors.has(error.message);
        nodes.push(
          checkItem({
            severity: "error",
            title: error.message,
            detail: file ? `${file}${error.line ? `:${error.line}` : ""}` : "",
            tag: mobileOnly ? "Only in the mobile view" : "",
          }),
        );
      }
    }
  }
  checksList.replaceChildren(...nodes);
}

outlinesToggle.addEventListener("change", () => {
  settings.outlines = outlinesToggle.checked;
  persist();
  for (const view of views) view.post({ type: "outlines", on: settings.outlines });
});

// ---------- header rules ----------
// Many sites forbid being shown in a frame, with an X-Frame-Options header or
// a Content-Security-Policy `frame-ancestors` directive. To mirror them, those
// headers are removed, but only from responses that load into a view's
// frames, and only on sites the extension has been granted. Pages in ordinary
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

// ---------- loading the page ----------

function loadAll(url, { force = false } = {}) {
  currentUrl = url;
  for (const view of views) view.load(url, { force, frameName: frameNameFor(view) });
  setLoading(views.some((view) => !view.ready));
  setStatus("");
  updateEmptyState();
  scheduleChecksRender();
  layout();
}

function handleLoadTimeout(view) {
  setLoading(views.some((other) => other.url && !other.ready && other !== view));
  if (view !== views[0]) return;
  setStatus("This page didn't load here. Some sites can't be shown inside another page.", {
    bad: true,
    action: { label: "Open in a window", run: openInOwnWindow },
  });
}

// For sites that cannot be framed at all: a real browser window at the
// device's size. It loses the side-by-side view but nothing can block it.
function openInOwnWindow() {
  if (!currentUrl) return;
  const main = getMetrics(viewSettings(views[0]));
  chrome.windows
    .create({
      url: currentUrl,
      type: "popup",
      width: main ? main.w : responsiveWidth || 400,
      height: main ? main.h : 800,
    })
    .catch((error) => setStatus(`Couldn't open a window: ${error.message}`, { bad: true }));
}

function sendScroll(targets = views) {
  if (!settings.scrollSync) return;
  for (const view of targets) view.post({ type: "scroll", frac: lastScrollFraction });
}

// A route change inside a single-page app, reported by the tab. The views
// change route the same way instead of reloading, when the page allows it.
function followRoute(url) {
  if (pinned || !currentUrl || url === currentUrl) return;
  if (!sameOrigin(url, currentUrl) || views.some((view) => !view.ready)) return; // sync() loads it
  currentUrl = url;
  for (const view of views) {
    view.url = url;
    view.setAddress(url);
    view.post({ type: "navigate", url }, { sameOriginOnly: true });
  }
}

// Messages from the content script in each view's frame.
window.addEventListener("message", (event) => {
  const view = views.find((candidate) => candidate.frameWindow === event.source);
  const message = event.data;
  if (!view || !message || message.source !== TAG || typeof message.type !== "string") return;

  const result = view.receive(message);
  switch (result?.type) {
    case "ready":
      setLoading(views.some((other) => other.url && !other.ready));
      if (views.every((other) => other.ready) && statusEl.classList.contains("bad")) setStatus("");
      sendScroll([view]);
      view.post({ type: "outlines", on: settings.outlines });
      view.layoutKeyboard(settings.keyboard);
      if (view === views[0]) takePendingLocate();
      scheduleChecksRender();
      break;
    case "issues":
    case "error":
      scheduleChecksRender();
      break;
    case "breakpoints":
      if (view === views[0]) renderRuler();
      break;
    case "not-found":
      if (view === views[0]) {
        setStatus("That element isn't on the mobile version of the page.", { clearAfter: 4000 });
      }
      break;
    case "navigated":
      // The page did not react to the route change: load it properly.
      if (!result.ok) view.load(result.url, { force: true, frameName: frameNameFor(view) });
      break;
  }
});

// ---------- connection to the mirrored tab ----------

function disconnectTab() {
  try {
    tabPort?.disconnect();
  } catch {
    // already gone
  }
  tabPort = null;
  tabPortId = null;
  tabErrors = null;
}

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ISOLATED_FILES });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: PAGE_WORLD_FILES,
    world: "MAIN",
  });
}

/**
 * Connect to the content script in a tab, which reports scroll position,
 * route changes and errors.
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
  tabErrors = new Set();
  let heardFromTab = false;

  port.onMessage.addListener((message) => {
    heardFromTab = true;
    if (port !== tabPort || !message) return;
    switch (message.type) {
      case "scroll":
        if (!Number.isFinite(message.frac)) return;
        lastScrollFraction = message.frac;
        sendScroll();
        break;
      case "errors":
        tabErrors = new Set(
          (Array.isArray(message.items) ? message.items : []).map((error) =>
            String(error?.message),
          ),
        );
        scheduleChecksRender();
        break;
      case "error":
        tabErrors?.add(String(message.error?.message));
        scheduleChecksRender();
        break;
      case "route":
        if (typeof message.url === "string") followRoute(message.url);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // Reading lastError marks it as handled. It is set when nothing in the
    // tab was listening.
    const nobodyListening = Boolean(chrome.runtime.lastError) && !heardFromTab;
    if (port !== tabPort) return;
    tabPort = null;
    tabPortId = null;
    tabErrors = null;
    if (nobodyListening && injectIfMissing) {
      injectContentScripts(tabId)
        .then(() => connectTab(tabId, false))
        .catch(() => {
          // The page does not allow scripts (an error page, the Web Store).
        });
    }
  });
}

// ---------- following the active tab ----------

const siteNotice = el("site-notice");
const siteNoticeText = el("site-notice-text");
const siteEnable = el("site-enable");
const siteRow = el("site-row");
const siteLabel = el("site-label");
const siteToggle = el("site-toggle");

/**
 * Update the places that show whether the main tab's site is mirrored: the
 * notice over the stage and the switch in View options.
 *
 * @param {"mirrored" | "not-granted" | "unreadable" | "not-web"} state
 * @param {import("./sites.js").Site | null} site
 */
function showSiteState(state, site) {
  offeredSite = state === "not-granted" ? site : null;

  // With no page shown yet, the empty state explains what to do instead.
  const showNotice =
    !pinned && (state === "not-granted" || (state === "unreadable" && currentUrl !== null));
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

  // Sites the user turned on can be turned off again. Localhost is always on.
  const canTurnOff = state === "mirrored" && !isBuiltIn(site);
  siteRow.hidden = !canTurnOff;
  if (canTurnOff) {
    siteLabel.textContent = `Mirror ${site.host}`;
    siteToggle.checked = true;
  }
}

/** Each site remembers the devices last used with it. */
function applySiteDevices(host) {
  if (host === currentHost) return;
  currentHost = host;
  const remembered = settings.siteDevices[host];
  if (!remembered) return;
  const same =
    remembered.preset === settings.preset &&
    remembered.rotated === settings.rotated &&
    remembered.compare.join() === settings.compare.join();
  if (same) return;
  settings.preset = remembered.preset;
  settings.compare = [...remembered.compare];
  settings.rotated = remembered.rotated;
  refreshDevices();
}

let syncRun = 0;
const scriptConfirmedFor = new Set(); // site patterns known to have the content scripts

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
  followedTabId = tab.id;

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

  // Localhost has the content scripts from the manifest. Other sites get them
  // registered when access is granted, which may still be in progress.
  if (!isBuiltIn(site) && !scriptConfirmedFor.has(site.pattern)) {
    await contentScriptReady();
    if (run !== syncRun) return;
    scriptConfirmedFor.add(site.pattern);
  }

  showSiteState("mirrored", site);
  applySiteDevices(site.host);

  if (tab.url !== currentUrl) {
    // Give the tab's own report of a same-document route change a moment to
    // arrive; followRoute() then handles it without a reload.
    if (currentUrl && tabPortId === tab.id && sameOrigin(tab.url, currentUrl)) {
      await sleep(SAME_DOCUMENT_GRACE_MS);
      if (run !== syncRun) return;
    }
    if (tab.url !== currentUrl) {
      if (currentUrl === null || withoutHash(tab.url) !== withoutHash(currentUrl)) {
        lastScrollFraction = 0;
      }
      loadAll(tab.url);
    }
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
      loadAll(currentUrl, { force: true });
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

// ---------- "Show in Sidephone" and keyboard shortcuts ----------

const cleanLocator = (locator) =>
  locator && typeof locator === "object"
    ? Object.fromEntries(
        ["path", "id", "testId", "tag", "text"].map((key) => [
          key,
          typeof locator[key] === "string" ? locator[key].slice(0, 500) : "",
        ]),
      )
    : null;

function locate(locator) {
  const clean = cleanLocator(locator);
  if (!clean || !currentUrl) return;
  for (const view of views) view.post({ type: "locate", locator: clean }, { sameOriginOnly: true });
}

// A view opened by the context menu asks for the request once its page is in.
async function takePendingLocate() {
  if (followedTabId === null) return;
  const locator = await chrome.runtime
    .sendMessage({ type: "take-pending-locate", tabId: followedTabId })
    .catch(() => null);
  if (locator) locate(locator);
}

function runCommand(command) {
  if (command === "rotate") rotate();
  else if (command === "next-device") stepDevice(1);
  else if (command === "previous-device") stepDevice(-1);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !message) return;
  if (message.type === "locate" && message.tabId === followedTabId && !pinned) {
    locate(message.locator);
  }
  if (message.type === "command" && (message.windowId ?? followWindowId) === followWindowId) {
    runCommand(message.command);
  }
});

// Shortcuts inside the panel itself.
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable], .resize-handle")) return;
  const command = { r: "rotate", R: "rotate", "]": "next-device", "[": "previous-device" }[
    event.key
  ];
  if (!command) return;
  event.preventDefault();
  runCommand(command);
});

el("shortcuts-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {});
});

// ---------- controls ----------

/** Apply a change of device, rotation or comparison to everything that shows it. */
function refreshDevices() {
  // Comparing needs real devices; the main one cannot be responsive then.
  if (settings.compare.length && settings.preset === RESPONSIVE) settings.preset = DEFAULT_DEVICE;
  persist();
  syncViews();
  syncDeviceMenu();
  layout();
  scheduleChecksRender();
  fitWindowToDevices();
}

function applyDeviceChange() {
  if (currentHost) rememberSiteDevice(settings, currentHost);
  refreshDevices();
}

function rotate() {
  if (rotateButton.disabled) return;
  settings.rotated = !settings.rotated;
  applyDeviceChange();
}

function stepDevice(step) {
  settings.preset = cycleDevice(isDevice(settings.preset) ? settings.preset : "", step);
  applyDeviceChange();
}

function removeCompared(index) {
  if (index < 1) return;
  settings.compare.splice(index - 1, 1);
  applyDeviceChange();
}

rotateButton.addEventListener("click", rotate);

frameToggle.addEventListener("change", () => {
  settings.deviceFrame = frameToggle.checked;
  refreshDevices();
});

barsToggle.addEventListener("change", () => {
  settings.browserBars = barsToggle.checked;
  refreshDevices();
});

inAppToggle.addEventListener("change", () => {
  settings.inApp = inAppToggle.checked;
  refreshDevices(); // also reloads frames that now need a different user agent
});

keyboardToggle.addEventListener("change", () => {
  settings.keyboard = keyboardToggle.checked;
  persist();
  for (const view of views) {
    view.layoutKeyboard(settings.keyboard);
    if (settings.keyboard && view.keyboardState.open) {
      view.post({ type: "keyboard-inset", inset: view.keyboardInset });
    }
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
  const query = new URLSearchParams({
    popout: "1",
    win: String(followWindowId),
    preset: settings.preset,
    compare: settings.compare.join(","),
    rotated: settings.rotated ? "1" : "0",
    bars: settings.browserBars ? "1" : "0",
    frame: settings.deviceFrame ? "1" : "0",
    inapp: settings.inApp ? "1" : "0",
    width: String(settings.responsiveWidth ?? ""),
  });
  const sizes = views.map((view) => getMetrics(viewSettings(view)));
  const width = sizes.every(Boolean)
    ? sizes.reduce((sum, m) => sum + m.outerW, 0) + VIEW_GAP * (sizes.length - 1)
    : (settings.responsiveWidth ?? 400) + HANDLE_WIDTH;
  const height = sizes.every(Boolean) ? Math.max(...sizes.map((m) => m.outerH)) : 800;
  try {
    // A rough first size; the pop-out then fits itself to the devices exactly.
    await chrome.windows.create({
      url: chrome.runtime.getURL(`panel/panel.html?${query}`),
      type: "popup",
      width: Math.round(width) + 16,
      height: Math.round(height) + 120,
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
  calibrationCard.style.width = `${CARD_MM.short * pxPerMm}px`;
  calibrationCard.style.height = `${CARD_MM.long * pxPerMm}px`;
  calibrationCard.style.borderRadius = `${CARD_MM.radius * pxPerMm}px`;
}

calibrationSlider.addEventListener("input", drawCalibrationCard);

el("cal-btn").addEventListener("click", () => {
  closeMenus();
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

// ---------- menus: device list, checks and view options ----------

const deviceButton = el("device-btn");
const deviceMenu = el("device-menu");
const deviceName = el("device-name");
const settingsButton = el("settings-btn");
const settingsMenu = el("settings");

/** Which device the device menu changes: an index into `views`, or "add". */
let menuTarget = 0;
let menuAnchor = deviceButton;

const CHECK_ICON =
  '<svg class="check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const PLUS_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';

function buildDeviceMenu() {
  const title = document.createElement("div");
  title.className = "menu-label menu-title";
  title.textContent = "Compare with";
  deviceMenu.append(title);

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
    item.insertAdjacentHTML("beforeend", CHECK_ICON); // fixed markup
    deviceMenu.append(item);
  };

  addItem(RESPONSIVE, "Responsive", "");
  for (const group of DEVICE_GROUPS) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = group.label;
    deviceMenu.append(label);
    for (const id of group.ids) {
      const { name, w, h } = DEVICES[id];
      addItem(id, name, `${w} × ${h}`);
    }
  }

  const separator = document.createElement("div");
  separator.className = "menu-sep";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "item action";
  add.dataset.action = "add";
  add.insertAdjacentHTML("afterbegin", PLUS_ICON); // fixed markup
  const addLabel = document.createElement("span");
  addLabel.textContent = "Compare with another device";
  add.append(addLabel);
  add.title = "Show another device beside this one. Each loads its own copy of the page.";
  deviceMenu.append(separator, add);
}

function syncDeviceMenu() {
  deviceName.textContent = DEVICES[settings.preset]?.name ?? "Responsive";
}

function openDeviceMenu(target, anchor = deviceButton) {
  menuTarget = target;
  menuAnchor = anchor;
  const adding = target === "add";
  const selected = adding ? null : views[target]?.preset;
  for (const item of deviceMenu.querySelectorAll(".item[data-value]")) {
    item.setAttribute("aria-selected", String(item.dataset.value === selected));
  }
  const canBeResponsive = target === 0 && settings.compare.length === 0;
  deviceMenu.querySelector(`[data-value="${RESPONSIVE}"]`).hidden = !canBeResponsive;
  const canAdd = target === 0 && settings.compare.length < MAX_COMPARE;
  deviceMenu.querySelector("[data-action=add]").hidden = !canAdd;
  deviceMenu.querySelector(".menu-sep").hidden = !canAdd;
  deviceMenu.querySelector(".menu-title").hidden = !adding;

  // Open under whatever was clicked: the toolbar button or a device's name.
  const rect = anchor.getBoundingClientRect();
  deviceMenu.style.top = `${Math.round(rect.bottom + 4)}px`;
  deviceMenu.style.left = `${Math.round(Math.max(6, Math.min(rect.left, innerWidth - 270)))}px`;

  toggleSettings(false);
  toggleChecks(false);
  deviceMenu.hidden = false;
  deviceButton.setAttribute("aria-expanded", String(anchor === deviceButton));
  const current = deviceMenu.querySelector('.item[aria-selected="true"]');
  (current ?? deviceMenu.querySelector(".item:not([hidden])")).focus();
}

function closeDeviceMenu() {
  deviceMenu.hidden = true;
  deviceButton.setAttribute("aria-expanded", "false");
}

function toggleSettings(open) {
  settingsMenu.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    closeDeviceMenu();
    toggleChecks(false);
  }
}

function toggleChecks(open) {
  checksMenu.hidden = !open;
  checksButton.setAttribute("aria-expanded", String(open));
  if (open) {
    closeDeviceMenu();
    toggleSettings(false);
    renderChecksList();
  }
}

function closeMenus() {
  closeDeviceMenu();
  toggleSettings(false);
  toggleChecks(false);
}

deviceButton.addEventListener("click", () =>
  deviceMenu.hidden || menuAnchor !== deviceButton ? openDeviceMenu(0) : closeDeviceMenu(),
);
settingsButton.addEventListener("click", () => toggleSettings(settingsMenu.hidden));
checksButton.addEventListener("click", () => toggleChecks(checksMenu.hidden));

deviceMenu.addEventListener("click", (event) => {
  const item = event.target.closest(".item");
  if (!item) return;
  if (item.dataset.action === "add") {
    openDeviceMenu("add", menuAnchor);
    return;
  }
  const value = item.dataset.value;
  if (menuTarget === "add") settings.compare.push(value);
  else if (menuTarget === 0) settings.preset = value;
  else settings.compare[menuTarget - 1] = value;
  closeDeviceMenu();
  menuAnchor.focus();
  applyDeviceChange();
});

// Arrow keys move through the device list.
deviceMenu.addEventListener("keydown", (event) => {
  const items = [...deviceMenu.querySelectorAll(".item:not([hidden])")];
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
  const inside = [deviceMenu, settingsMenu, checksMenu, deviceButton, settingsButton, checksButton]
    .concat(views.map((view) => view.els.name))
    .some((node) => node.contains(event.target));
  if (!inside) closeMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!deviceMenu.hidden) {
    closeDeviceMenu();
    menuAnchor.focus();
  } else if (!settingsMenu.hidden) {
    toggleSettings(false);
    settingsButton.focus();
  } else if (!checksMenu.hidden) {
    toggleChecks(false);
    checksButton.focus();
  }
});

// Clicking into a mirrored page moves focus into its frame, which this
// document only sees as losing focus.
window.addEventListener("blur", () => {
  if (document.activeElement?.tagName === "IFRAME") closeMenus();
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
  if (settings.compare.length && settings.preset === RESPONSIVE) settings.preset = DEFAULT_DEVICE;
  buildDeviceMenu();
  syncViews();
  syncDeviceMenu();
  scrollToggle.checked = settings.scrollSync;
  barsToggle.checked = settings.browserBars;
  frameToggle.checked = settings.deviceFrame;
  keyboardToggle.checked = settings.keyboard;
  inAppToggle.checked = settings.inApp;
  outlinesToggle.checked = settings.outlines;
  checkZoomInput();
  updateCalibrationNote();
  updateEmptyState();
  renderChecksBadge();
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
    await fitWindowToDevices();
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
