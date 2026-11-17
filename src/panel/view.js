// One device on the stage: its drawing (body, screen, bars, cutout, keyboard)
// and the frame that holds the mirrored page. The panel creates one per
// device it shows and decides their size; a view only draws itself and keeps
// what its own page has reported.
//
// Everything a page sends is untrusted: the page can post messages to its
// parent just as the content script does. Values are checked here, used as
// text or numbers only, and capped in size.

import { KEYBOARD_MARKUP, keyboardHasFoot, keyboardHeight, keyboardPlatform } from "./keyboard.js";

/** Marks messages as belonging to this extension. Must match content/main.js. */
export const TAG = "side-mirror";

const LOAD_TIMEOUT_MS = 10_000;
const HOME_BUTTON_SIZE = 46;
const MIN_BAR_HEIGHT_FOR_ADDRESS = 44;
const FLASH_MS = 1400;

const ISSUE_KINDS = new Set(["overflow", "tap-target", "input-zoom", "small-text"]);
const MAX_ISSUES = 200;
const MAX_ERRORS = 50;

const px = (n) => `${n}px`;
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const finite = (...values) => values.every(Number.isFinite);

// Page-supplied values are only ever used as colours, and only when the
// browser itself recognises them as one.
const cssColorOrNull = (value) =>
  typeof value === "string" && value.length <= 64 && CSS.supports("color", value) ? value : null;

export class DeviceView {
  /**
   * @param {HTMLTemplateElement} template
   * @param {{onLoadTimeout: (view: DeviceView) => void}} callbacks
   */
  constructor(template, { onLoadTimeout }) {
    this.root = template.content.firstElementChild.cloneNode(true);
    const find = (selector) => this.root.querySelector(selector);
    this.els = {
      label: find(".view-label"),
      name: find(".view-name"),
      size: find(".view-size"),
      remove: find(".view-remove"),
      device: find(".device"),
      shell: find(".shell"),
      screen: find(".screen"),
      barTop: find(".bar-top"),
      barBottom: find(".bar-bottom"),
      statusBar: find(".statusbar"),
      cutout: find(".cutout"),
      homeButton: find(".home-button"),
      keyboard: find(".keyboard"),
      viewport: find(".viewport"),
      frame: find(".frame"),
      outlines: find(".outlines"),
      handle: find(".resize-handle"),
    };
    this.onLoadTimeout = onLoadTimeout;

    this.preset = null; // a device id, or the responsive preset
    this.metrics = null; // from getMetrics, or null when responsive
    this.scale = 1;
    this.url = null;
    this.ready = false;
    this.loadTimer = null;
    this.colors = null;
    this.keyboardState = { open: false, layout: "text" };
    this.keyboardMarkupKey = "";
    this.keyboardInset = 0;
    this.issues = [];
    this.errors = [];
    this.breakpoints = { widths: [], unreadable: 0 };

    // Nothing in the device should ever be scrolled out of place. CSS already
    // forbids it; this puts it back if anything manages to.
    this.els.screen.addEventListener("scroll", () => {
      this.els.screen.scrollTop = 0;
      this.els.screen.scrollLeft = 0;
    });
    // Clicking the keyboard drawing must not take focus away from the page.
    this.els.keyboard.addEventListener("mousedown", (event) => event.preventDefault());
  }

  get frameWindow() {
    return this.els.frame.contentWindow;
  }

  destroy() {
    clearTimeout(this.loadTimer);
    this.root.remove();
  }

  // ---------- the page ----------

  /**
   * @param {string} url
   * @param {{force?: boolean, frameName?: string}} [options]  A frame name
   *   tells content/page.js how to present the page (see in-app mode).
   */
  load(url, { force = false, frameName = "" } = {}) {
    const withoutHash = (value) => value.split("#")[0];
    const nameChanged = this.els.frame.name !== frameName;
    const sameDocument = this.url !== null && withoutHash(this.url) === withoutHash(url);
    // Chrome gives a page its frame's name only if the name was set before the
    // frame was added to the document, so a new name needs a new frame.
    if (nameChanged) {
      const fresh = this.els.frame.cloneNode(false);
      fresh.removeAttribute("src");
      fresh.name = frameName;
      this.els.frame.replaceWith(fresh);
      this.els.frame = fresh;
    }
    this.url = url;
    this.setAddress(url);
    this.els.frame.src = url;

    // A hash-only change does not reload the frame.
    if (sameDocument && !force && !nameChanged) return;

    this.ready = false;
    this.colors = null;
    this.issues = [];
    this.errors = [];
    this.setKeyboard(false, "text", false);
    this.drawOutlines([]);
    this.paint();
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      if (!this.ready) this.onLoadTimeout(this);
    }, LOAD_TIMEOUT_MS);
  }

  /**
   * Send a message to the content script in the frame. Messages that carry
   * anything from the user's page go only to that page's origin; the rest
   * carry a number at most, and also reach the page after it navigates.
   */
  post(message, { sameOriginOnly = false } = {}) {
    let target = "*";
    if (sameOriginOnly) {
      try {
        target = new URL(this.url).origin;
      } catch {
        return;
      }
    }
    this.frameWindow?.postMessage({ source: TAG, ...message }, target);
  }

  /**
   * Take in a message from the frame. Returns the cleaned message for the
   * panel to act on, or null if it was not valid.
   */
  receive(message) {
    switch (message.type) {
      case "ready":
        this.ready = true;
        clearTimeout(this.loadTimer);
        return { type: "ready" };

      case "colors":
        this.colors = {
          theme: cssColorOrNull(message.theme),
          background: cssColorOrNull(message.background),
        };
        this.paint();
        return null;

      case "keyboard":
        this.setKeyboard(Boolean(message.open), message.layout);
        return null;

      case "issues": {
        if (!Array.isArray(message.items)) return null;
        this.issues = message.items
          .slice(0, MAX_ISSUES)
          .filter((item) => Number.isInteger(item?.id) && ISSUE_KINDS.has(item.kind))
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            severity: item.severity === "error" ? "error" : "warning",
            label: text(item.label, 120),
            detail: text(item.detail, 240),
          }));
        return { type: "issues" };
      }

      case "error": {
        const error = message.error;
        const clean = {
          message: text(error?.message, 500),
          source: text(error?.source, 300),
          line: Number.isInteger(error?.line) ? error.line : 0,
        };
        if (!clean.message) return null;
        this.errors.push(clean);
        if (this.errors.length > MAX_ERRORS) this.errors.shift();
        return { type: "error" };
      }

      case "breakpoints": {
        if (!Array.isArray(message.widths)) return null;
        const widths = message.widths.filter((w) => Number.isInteger(w) && w > 0 && w < 10000);
        this.breakpoints = {
          widths: [...new Set(widths)].sort((a, b) => a - b).slice(0, 60),
          unreadable: Number.isInteger(message.unreadable) ? message.unreadable : 0,
        };
        return { type: "breakpoints" };
      }

      case "outlines":
        if (Array.isArray(message.items)) this.drawOutlines(message.items.slice(0, MAX_ISSUES));
        return null;

      case "flash":
        if (finite(message.x, message.y, message.w, message.h)) this.flash(message);
        return null;

      case "not-found":
        return { type: "not-found" };

      case "navigated":
        return typeof message.url === "string"
          ? { type: "navigated", url: message.url, ok: message.ok === true }
          : null;

      default:
        return null;
    }
  }

  // ---------- drawing ----------

  /** The drawn address bars show the mirrored page's host. */
  setAddress(url) {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      // leave it empty
    }
    for (const pill of this.root.querySelectorAll(".pill")) pill.textContent = host;
  }

  setLabel(name, size, removable) {
    this.els.name.textContent = name;
    this.els.size.textContent = size;
    this.els.remove.hidden = !removable;
  }

  /** Responsive: no device, just the page at the given size. */
  drawResponsive(width, height, scale) {
    const { shell, screen, frame, viewport, device } = this.els;
    this.metrics = null;
    this.scale = scale;
    shell.className = "shell boxed";
    shell.style.cssText = "";
    shell.style.width = px(width);
    shell.style.height = px(height);
    shell.style.transform = scale !== 1 ? `scale(${scale})` : "";
    for (const node of [screen, viewport, frame]) {
      node.style.width = px(width);
      node.style.height = px(height);
    }
    screen.style.borderRadius = "";
    device.style.width = px(Math.floor(width * scale));
    device.style.height = px(Math.floor(height * scale));
    for (const node of [
      this.els.barTop,
      this.els.barBottom,
      this.els.cutout,
      this.els.homeButton,
    ]) {
      node.hidden = true;
    }
    this.paint();
    this.layoutKeyboard();
  }

  /** A device, drawn from getMetrics() at the given scale. */
  draw(m, scale) {
    const { spec, rotated, framed } = m;
    const { shell, screen, frame, viewport, device, barTop, barBottom, statusBar } = this.els;
    this.metrics = m;
    this.scale = scale;

    shell.className = `shell ${framed ? "framed" : "boxed"}`;
    shell.style.width = px(m.outerW);
    shell.style.height = px(m.outerH);
    shell.style.padding = `${px(m.padY)} ${px(m.padX)}`;
    shell.style.borderRadius = framed
      ? px(spec.bodyRadius ?? spec.radius + Math.min(m.padX, m.padY))
      : "";
    shell.style.transform = scale !== 1 ? `scale(${scale})` : "";

    screen.style.width = px(m.screenW);
    screen.style.height = px(m.screenH);
    screen.style.borderRadius = framed ? px(spec.radius) : "";

    for (const node of [viewport, frame]) {
      node.style.width = px(m.w);
      node.style.height = px(m.h);
    }

    // Bars are drawn only inside the device frame. In a browser the address
    // goes where the device normally shows it, unless that bar is too thin in
    // this orientation. In an app there is no address bar at all.
    const topH = framed ? m.bars.top : 0;
    const bottomH = framed ? m.bars.bottom : 0;
    const showAddress = !m.inApp;
    const addressAtTop = spec.bars.address === "top" || bottomH < MIN_BAR_HEIGHT_FOR_ADDRESS;
    this.layoutBar(barTop, topH, showAddress && addressAtTop);
    this.layoutBar(barBottom, bottomH, showAddress && !addressAtTop);

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
    // instead of a swipe indicator; in an app, nothing.
    const hasToolbar =
      !m.inApp && Boolean(spec.homeButton) && bottomH >= MIN_BAR_HEIGHT_FOR_ADDRESS;
    barBottom.querySelector(".indicator").hidden = Boolean(spec.homeButton);
    barBottom.querySelector(".browser-tools").hidden = !hasToolbar;
    barBottom.classList.toggle("tools", hasToolbar);
    barBottom.classList.toggle("in-app", m.inApp);

    // Camera cutout: at the top in portrait, on the left side when rotated.
    const cutout = framed ? spec.cutout : null;
    this.els.cutout.hidden = !cutout;
    if (cutout) {
      const w = rotated ? cutout.h : cutout.w;
      const h = rotated ? cutout.w : cutout.h;
      Object.assign(this.els.cutout.style, {
        width: px(w),
        height: px(h),
        left: px(rotated ? cutout.top : (m.sw - w) / 2),
        top: px(rotated ? (m.sh - h) / 2 : cutout.top),
      });
    }

    // Home button: in the chin below the display, or to its right when rotated.
    const showHome = framed && Boolean(spec.homeButton);
    this.els.homeButton.hidden = !showHome;
    if (showHome) {
      const chin = rotated ? m.padX : m.padY;
      const inset = (chin - HOME_BUTTON_SIZE) / 2;
      this.els.homeButton.style.left = px(
        rotated ? m.outerW - chin + inset : (m.outerW - HOME_BUTTON_SIZE) / 2,
      );
      this.els.homeButton.style.top = px(
        rotated ? (m.outerH - HOME_BUTTON_SIZE) / 2 : m.outerH - chin + inset,
      );
    }

    device.style.width = px(Math.floor(m.outerW * scale));
    device.style.height = px(Math.floor(m.outerH * scale));
    screen.scrollTop = 0;
    screen.scrollLeft = 0;
    this.paint();
    this.layoutKeyboard();
  }

  layoutBar(bar, height, showAddress) {
    bar.hidden = height <= 0;
    bar.style.height = px(height);
    bar.querySelector(".pill").hidden = !showAddress || height < MIN_BAR_HEIGHT_FOR_ADDRESS;
  }

  // A phone tints the bar above the page to match it: Safari and apps use the
  // page's theme colour or background; Chrome on Android uses the theme colour
  // when the page sets one.
  paint() {
    const m = this.metrics;
    const { barTop, screen } = this.els;
    const kind = m ? m.spec.bars.kind : "ios";
    const followsBackground = kind !== "android" || m?.inApp;
    let color = "";
    if (this.colors) {
      color = followsBackground ? this.colors.theme || this.colors.background : this.colors.theme;
    }
    if (!color && followsBackground) color = "#fff";

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

    // The screen behind the page takes the page's colour: it shows in the
    // strips beside the page in landscape, as on a phone, and nowhere else.
    // An app's home indicator area is the page's colour too.
    const pageColor = this.colors?.background || "#fff";
    screen.style.backgroundColor = pageColor;
    this.els.barBottom.style.backgroundColor = m?.inApp ? pageColor : "";
    this.els.barBottom.classList.toggle("on-dark", Boolean(m?.inApp) && isDark);
  }

  // ---------- on-screen keyboard ----------

  layoutKeyboard(enabled = this.keyboardEnabled ?? true) {
    this.keyboardEnabled = enabled;
    const m = this.metrics;
    const kind = m ? m.spec.bars.kind : "ios";
    const platform = keyboardPlatform(kind);
    const layoutName = this.keyboardState.layout;
    const landscape = Boolean(m?.rotated);
    const screenHeight = m ? m.screenH : this.els.screen.offsetHeight;
    const height = keyboardHeight(kind, layoutName, landscape, screenHeight);
    const visible = enabled && this.keyboardState.open;

    const markupKey = `${platform}-${layoutName}`;
    if (markupKey !== this.keyboardMarkupKey) {
      this.els.keyboard.innerHTML = KEYBOARD_MARKUP[markupKey]; // fixed markup, see keyboard.js
      this.keyboardMarkupKey = markupKey;
    }

    this.els.keyboard.className = [
      "keyboard",
      platform,
      layoutName,
      keyboardHasFoot(kind, landscape) ? "has-foot" : "",
      landscape ? "landscape" : "",
      visible ? "open" : "",
    ].join(" ");
    this.els.keyboard.style.height = px(height);

    // The keyboard rises from the bottom of the screen, so it covers the bottom
    // bar first and the page after that.
    const belowPage = m?.framed ? m.bars.bottom : 0;
    this.keyboardInset = visible ? Math.max(0, height - belowPage) : 0;
  }

  setKeyboard(open, layoutName = "text", notify = true) {
    this.keyboardState = { open, layout: layoutName === "numeric" ? "numeric" : "text" };
    this.layoutKeyboard();
    if (open && notify) this.post({ type: "keyboard-inset", inset: this.keyboardInset });
  }

  // ---------- outlines over the page ----------

  drawOutlines(items) {
    const layer = this.els.outlines;
    const boxes = items
      .filter((item) => finite(item?.x, item?.y, item?.w, item?.h) && Number.isInteger(item.id))
      .map((item) => {
        const box = document.createElement("div");
        box.className = `outline ${item.severity === "error" ? "error" : "warning"}`;
        Object.assign(box.style, {
          left: px(item.x),
          top: px(item.y),
          width: px(item.w),
          height: px(item.h),
        });
        return box;
      });
    layer.querySelectorAll(".outline").forEach((box) => box.remove());
    layer.append(...boxes);
  }

  flash(rect) {
    const box = document.createElement("div");
    box.className = "flash";
    Object.assign(box.style, {
      left: px(rect.x),
      top: px(rect.y),
      width: px(rect.w),
      height: px(rect.h),
    });
    this.els.outlines.append(box);
    setTimeout(() => box.remove(), FLASH_MS);
  }
}
