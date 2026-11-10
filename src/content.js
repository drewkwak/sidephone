// Content script. It is only injected on sites the user has turned on (and on
// localhost), and it only does something in two places:
//
//  1. The top frame of a normal tab. When a mirror view connects, it reports
//     the page's scroll position so the mirror can follow along. Nothing is
//     sent unless a view is connected.
//
//  2. The frame directly inside a mirror view (the side panel or the pop-out
//     window). There it tells the view when the page has loaded, what colour
//     it is, and when a text field has focus, and it applies scroll positions
//     the view sends.
//
// It never reads page content, form values, cookies or storage, and it never
// talks to anything except this extension's own pages.
(() => {
  // The script can arrive twice: once declared, once injected into a tab that
  // was already open. The isolated world's global is private to this extension.
  if (globalThis.__sideMirrorContentScript) return;
  globalThis.__sideMirrorContentScript = true;

  /** Marks messages as belonging to this extension. Must match panel/panel.js. */
  const TAG = "side-mirror";
  const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

  const isTopFrame = window === window.top;
  const isMirrorFrame =
    !isTopFrame &&
    location.ancestorOrigins?.length === 1 &&
    location.ancestorOrigins[0] === EXTENSION_ORIGIN;

  if (!isTopFrame && !isMirrorFrame) return;

  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  if (isTopFrame) {
    reportScrollWhileConnected();
  } else {
    hideScrollbars();
    whenDomReady(runInMirrorFrame);
  }

  // ---------- top frame of a tab ----------

  function reportScrollWhileConnected() {
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

      let queued = false;
      const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          post({ type: "scroll", frac: scrollFraction() });
        });
      };

      window.addEventListener("scroll", onScroll, { passive: true });
      port.onDisconnect.addListener(() => window.removeEventListener("scroll", onScroll));
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
    tellView({ type: "ready" });
    reportPageColors();
    reportTextFieldFocus();
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

  function listenToView() {
    window.addEventListener("message", (event) => {
      if (event.origin !== EXTENSION_ORIGIN) return;
      const message = event.data;
      if (!message || message.source !== TAG) return;

      if (message.type === "scroll") {
        if (!Number.isFinite(message.frac)) return;
        const frac = Math.min(1, Math.max(0, message.frac));
        window.scrollTo({ top: frac * maxScroll(), behavior: "instant" });
        return;
      }

      // The view says how much of the page's bottom the keyboard now covers.
      // Like a phone, bring the focused field into view if it is underneath.
      if (message.type === "keyboard-inset") {
        if (!focusedField || !(message.inset > 0)) return;
        const rect = focusedField.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - message.inset - 12) {
          focusedField.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    });
  }
})();
