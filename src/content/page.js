// Runs in the page's own JavaScript world, the only place that can see the
// page's uncaught errors and change what the page reads from
// navigator.userAgent. It passes errors to the isolated content script
// (content/main.js) as DOM events with a JSON string payload, and does nothing
// else. It has no access to extension APIs.
//
// It acts only in the top frame of a tab and in a frame whose single ancestor
// is an extension page (a Sidephone view).
(() => {
  const GUARD = Symbol.for("sidephone.page-world");
  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  const isTopFrame = window === window.top;
  const ancestors = location.ancestorOrigins;
  const isMirrorFrame =
    !isTopFrame && ancestors?.length === 1 && ancestors[0].startsWith("chrome-extension://");
  if (!isTopFrame && !isMirrorFrame) return;

  // In-app mode on an Android device: a view names its frame like this so the
  // page sees an Android WebView user agent from its very first script.
  // Android WebView marks itself with "; wv" and "Version/4.0".
  if (isMirrorFrame && window.name === "sidephone:android-webview") {
    const major = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "130";
    const userAgent =
      "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Version/4.0 Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    const overrides = {
      userAgent,
      appVersion: userAgent.slice("Mozilla/".length),
      platform: "Linux armv81",
    };
    for (const [name, value] of Object.entries(overrides)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }

  const MAX_MESSAGE = 500;
  const report = (message, source = "", line = 0) => {
    const detail = JSON.stringify({ message: String(message).slice(0, MAX_MESSAGE), source, line });
    document.dispatchEvent(new CustomEvent("sidephone:error", { detail }));
  };

  window.addEventListener("error", (event) => {
    // Failed image or script loads also arrive as "error" events, but not as
    // ErrorEvents. Only uncaught exceptions are reported.
    if (!(event instanceof ErrorEvent)) return;
    report(event.message || "Uncaught error", event.filename || "", event.lineno || 0);
  });

  window.addEventListener("unhandledrejection", (event) => {
    let reason;
    try {
      const value = event.reason;
      reason = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    } catch {
      reason = "a value that could not be read";
    }
    report(`Uncaught (in promise) ${reason}`);
  });
})();
