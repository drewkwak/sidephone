// Content script, isolated world. It is only injected on localhost and on
// sites the user has turned on, and it only does something in two places:
//
//  1. The top frame of a normal tab. While a Sidephone view is connected, it
//     reports the page's scroll position, route changes and JavaScript errors.
//     It also remembers what was right-clicked, for "Show in Sidephone".
//
//  2. The frame directly inside a Sidephone view (the side panel or the
//     pop-out window). There it reports when the page has loaded, its colour,
//     text-field focus, errors, layout problems and breakpoints, and it carries
//     out what the view asks: scroll, change route, show an element.
//
// It reads layout and styles, never form values, cookies or storage, and it
// only talks to this extension's own pages.
(() => {
  // The script can arrive twice: once declared, once injected into a tab that
  // was already open. The isolated world's global is private to this extension.
  if (globalThis.__sideMirrorContentScript) return;
  globalThis.__sideMirrorContentScript = true;

  /** Marks messages as belonging to this extension. Must match panel/panel.js. */
  const TAG = "side-mirror";
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
  const Checks = globalThis.SidephoneChecks;

  const isTopFrame = window === window.top;
  const isMirrorFrame =
    !isTopFrame &&
    location.ancestorOrigins?.length === 1 &&
    location.ancestorOrigins[0] === EXTENSION_ORIGIN;

  if (!isTopFrame && !isMirrorFrame) return;

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  // ---------- errors, from content/page.js ----------

  const MAX_ERRORS = 30;
  const errors = [];
  let onError = null; // set once there is somewhere to send errors

  document.addEventListener("sidephone:error", (event) => {
    let error;
    try {
      error = JSON.parse(event.detail);
    } catch {
      return;
    }
    const clean = {
      message: String(error?.message ?? "").slice(0, 500),
      source: String(error?.source ?? "").slice(0, 300),
      line: Number.isFinite(error?.line) ? error.line : 0,
    };
    if (!clean.message) return;
    errors.push(clean);
    if (errors.length > MAX_ERRORS) errors.shift();
    onError?.(clean);
  });

  if (isTopFrame) {
    serveConnectedView();
    rememberRightClicks();
  } else {
    hideScrollbars();
    whenDomReady(runInMirrorFrame);
  }

  // ---------- top frame of a tab ----------

  function serveConnectedView() {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== TAG) return;

      const post = (message) => {
        try {
          port.postMessage(message);
        } catch {
          // The view closed, or the extension was reloaded.
        }
      };
      const scrollFraction = () => {
        const max = maxScroll();
        return max > 0 ? window.scrollY / max : 0;
      };

      post({ type: "scroll", frac: scrollFraction() });
      post({ type: "errors", items: errors });
      onError = (error) => post({ type: "error", error });

      let queued = false;
      const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          post({ type: "scroll", frac: scrollFraction() });
        });
      };

      // A route change inside a single-page app looks like any other
      // navigation to the rest of Chrome. Only the page can tell them apart,
      // and a same-document change can be followed without reloading.
      const onNavigate = (event) => {
        if (!event.destination.sameDocument || event.hashChange) return;
        post({ type: "route", url: event.destination.url });
      };

      window.addEventListener("scroll", onScroll, { passive: true });
      window.navigation?.addEventListener("navigate", onNavigate);
      port.onDisconnect.addListener(() => {
        window.removeEventListener("scroll", onScroll);
        window.navigation?.removeEventListener("navigate", onNavigate);
        onError = null;
      });
    });
  }

  // "Show in Sidephone" in the context menu asks which element was clicked.
  function rememberRightClicks() {
    let target = null;
    document.addEventListener("contextmenu", (event) => (target = event.composedPath()[0]), true);
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "context-target") return;
      sendResponse(target?.nodeType === Node.ELEMENT_NODE ? Checks.locatorFor(target) : null);
    });
  }

  // ---------- frame inside a mirror view ----------

  function whenDomReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  const tellView = (message) =>
    window.parent.postMessage({ source: TAG, ...message }, EXTENSION_ORIGIN);

  // Phones draw scrollbars over the content. Desktop platforms with classic
  // scrollbars would otherwise take about 15px out of the mirrored layout.
  // A constructed stylesheet adds no node to the page's DOM.
  function hideScrollbars() {
    const css = "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}";
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      whenDomReady(() => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head?.append(style);
      });
    }
  }

  function runInMirrorFrame() {
    tellView({ type: "ready", url: location.href });
    for (const error of errors) tellView({ type: "error", error });
    onError = (error) => tellView({ type: "error", error });
    reportPageColors();
    reportTextFieldFocus();
    watchLayout();
    listenToView();
  }

  // A phone browser tints the bar above the page to match it, so the view
  // needs the page's theme colour and background.
  function reportPageColors() {
    const isTransparent = (color) =>
      !color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);

    const readColors = () => {
      let theme = null;
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        const media = meta.getAttribute("media");
        if (media && !window.matchMedia(media).matches) continue;
        theme = meta.getAttribute("content");
        if (theme) break;
      }
      let background = null;
      for (const node of [document.body, document.documentElement]) {
        if (!node) continue;
        const color = getComputedStyle(node).backgroundColor;
        if (!isTransparent(color)) {
          background = color;
          break;
        }
      }
      return { theme: theme || null, background };
    };

    let lastSent = "";
    const send = () => {
      const colors = readColors();
      const key = JSON.stringify(colors);
      if (key === lastSent) return;
      lastSent = key;
      tellView({ type: "colors", ...colors });
    };
    send();

    // Pages change theme without reloading (dark mode toggles, route changes).
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(send, 200);
    };
    const themeAttributes = {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-mode"],
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, themeAttributes);
    if (document.body) observer.observe(document.body, themeAttributes);
    if (document.head) {
      observer.observe(document.head, { childList: true, subtree: true, attributes: true });
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
  }

  // The view draws a phone keyboard while a text field has focus.
  let focusedField = null;

  function reportTextFieldFocus() {
    // Which keyboard a phone would show for an element, or null for none.
    const keyboardFor = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE || node.disabled || node.readOnly)
        return null;
      const mode = (node.getAttribute("inputmode") || "").toLowerCase();
      if (mode === "none") return null;
      const numeric = ["numeric", "decimal", "tel"].includes(mode);
      if (node.isContentEditable || node.tagName === "TEXTAREA")
        return numeric ? "numeric" : "text";
      if (node.tagName === "INPUT") {
        const type = (node.getAttribute("type") || "text").toLowerCase();
        if (["tel", "number"].includes(type)) return "numeric";
        if (["text", "search", "email", "url", "password"].includes(type))
          return numeric ? "numeric" : "text";
      }
      return null;
    };

    // The focused element, even when focus is inside a shadow root.
    const deepActiveElement = () => {
      let node = document.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      return node;
    };

    document.addEventListener(
      "focusin",
      (event) => {
        const node = event.composedPath()[0];
        const layout = keyboardFor(node);
        if (!layout) return;
        focusedField = node;
        tellView({ type: "keyboard", open: true, layout });
      },
      true,
    );

    document.addEventListener(
      "focusout",
      () => {
        // Wait a moment: focus may just be moving to another text field.
        setTimeout(() => {
          if (document.hasFocus() && keyboardFor(deepActiveElement())) return;
          focusedField = null;
          tellView({ type: "keyboard", open: false });
        }, 60);
      },
      true,
    );
  }

  // ---------- layout checks, breakpoints and outlines ----------

  let issues = []; // from Checks.findIssues; the view refers to them by index
  let outlinesOn = false;
  let lastBreakpoints = "";

  function watchLayout() {
    let timer = null;
    const schedule = (delay = 700) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const run = () => inspect();
        if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1500 });
        else run();
      }, delay);
    };

    schedule(300);
    window.addEventListener("load", () => schedule(200), { once: true });
    document.fonts?.ready.then(() => schedule(200));
    window.addEventListener("resize", () => schedule(250));
    // Style attributes are left out: animations change them constantly.
    new MutationObserver(() => schedule()).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "open"],
    });

    let queued = false;
    const onScroll = () => {
      if (!outlinesOn || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sendOutlines();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  }

  function inspect() {
    issues = Checks.findIssues();
    tellView({
      type: "issues",
      items: issues.map(({ kind, severity, label, detail }, id) => ({
        id,
        kind,
        severity,
        label,
        detail,
      })),
    });
    if (outlinesOn) sendOutlines();

    const { widths, unreadable } = Checks.readBreakpoints();
    const key = `${widths.join(",")}|${unreadable}`;
    if (key !== lastBreakpoints) {
      lastBreakpoints = key;
      tellView({ type: "breakpoints", widths, unreadable });
    }
  }

  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  };

  // Outlines are drawn by the view, over the frame. Nothing is added to the page.
  function sendOutlines() {
    const items = outlinesOn
      ? issues
          .map((issue, id) => ({ id, issue }))
          .filter(({ issue }) => issue.element.isConnected)
          .map(({ id, issue }) => ({ id, severity: issue.severity, ...rectOf(issue.element) }))
      : [];
    tellView({ type: "outlines", items });
  }

  function reveal(element) {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    requestAnimationFrame(() => tellView({ type: "flash", ...rectOf(element) }));
  }

  // ---------- requests from the view ----------

  // Change route the way the page's own router would on Back or Forward, and
  // report whether the page reacted. If it did not, the view reloads instead.
  function navigateInPlace(url) {
    let target;
    try {
      target = new URL(url);
    } catch {
      tellView({ type: "navigated", url, ok: false });
      return;
    }
    if (target.origin !== location.origin) {
      tellView({ type: "navigated", url, ok: false });
      return;
    }
    if (target.href === location.href) {
      tellView({ type: "navigated", url, ok: true });
      return;
    }
    let changed = false;
    const observer = new MutationObserver(() => (changed = true));
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    history.pushState(null, "", target.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    setTimeout(() => {
      observer.disconnect();
      tellView({ type: "navigated", url: target.href, ok: changed });
    }, 500);
  }

  function listenToView() {
    window.addEventListener("message", (event) => {
      if (event.origin !== EXTENSION_ORIGIN) return;
      const message = event.data;
      if (!message || message.source !== TAG) return;

      switch (message.type) {
        case "scroll": {
          if (!Number.isFinite(message.frac)) return;
          const frac = Math.min(1, Math.max(0, message.frac));
          window.scrollTo({ top: frac * maxScroll(), behavior: "instant" });
          break;
        }
        // How much of the page's bottom the keyboard now covers. Like a
        // phone, bring the focused field into view if it is underneath.
        case "keyboard-inset": {
          if (!focusedField || !(message.inset > 0)) return;
          const rect = focusedField.getBoundingClientRect();
          if (rect.bottom > window.innerHeight - message.inset - 12) {
            focusedField.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          break;
        }
        case "outlines":
          outlinesOn = Boolean(message.on);
          sendOutlines();
          break;
        case "reveal": {
          const issue = issues[message.id];
          if (issue?.element.isConnected) reveal(issue.element);
          break;
        }
        case "locate": {
          const element = message.locator ? Checks.findByLocator(message.locator) : null;
          if (element) reveal(element);
          else tellView({ type: "not-found" });
          break;
        }
        case "navigate":
          navigateInPlace(message.url);
          break;
      }
    });
  }
})();
