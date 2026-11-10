// Service worker. It holds no state of its own: everything it needs is read
// from Chrome (granted permissions, registered scripts, open views) each time
// an event wakes it.
//
// It does three things:
//  - opens the side panel when the toolbar icon is clicked, and asks for
//    access to the site in that tab if it does not have it yet
//  - keeps the content script registered for exactly the sites the user has
//    granted
//  - removes the header rules once the last mirror view has closed

const OPTIONAL_SITES_SCRIPT_ID = "optional-sites";
const VIEW_PAGE = chrome.runtime.getURL("panel/panel.html");

// The click handler below needs the event; without this Chrome would open the
// panel itself and never deliver it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

/** "https://example.com:3000/x" -> "*://example.com/*", or null for non-web URLs. */
function sitePattern(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? `*://${hostname}/*` : null;
  } catch {
    return null;
  }
}

// ---------- toolbar icon ----------

chrome.action.onClicked.addListener((tab) => {
  // Both calls need the user gesture, so neither may wait on the other.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);

  // `tab.url` is readable here because the click grants activeTab.
  const pattern = tab.url ? sitePattern(tab.url) : null;
  if (!pattern) return;

  // Resolves at once, without a prompt, when access is already granted.
  chrome.permissions.request({ origins: [pattern] }).catch(() => {
    // Declined or dismissed. The panel offers the same choice again.
  });
});

// ---------- content script registration ----------

const requiredOrigins = () => new Set(chrome.runtime.getManifest().host_permissions ?? []);

/** Register the content script for the optional sites the user has granted. */
async function syncOptionalSiteScript() {
  const { origins = [] } = await chrome.permissions.getAll();
  const required = requiredOrigins();
  const matches = origins.filter((origin) => !required.has(origin));

  const [existing] = await chrome.scripting.getRegisteredContentScripts({
    ids: [OPTIONAL_SITES_SCRIPT_ID],
  });

  if (matches.length === 0) {
    if (existing)
      await chrome.scripting.unregisterContentScripts({ ids: [OPTIONAL_SITES_SCRIPT_ID] });
    return;
  }

  const script = {
    id: OPTIONAL_SITES_SCRIPT_ID,
    js: ["content.js"],
    matches,
    allFrames: true,
    runAt: "document_start",
  };
  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

// Run one sync at a time: two grants in quick succession must not interleave.
let syncQueue = Promise.resolve();
function queueScriptSync() {
  syncQueue = syncQueue.then(syncOptionalSiteScript).catch(console.error);
  return syncQueue;
}

/** Tabs that were open before access was granted have no content script yet. */
async function injectIntoOpenTabs(origins) {
  if (!origins?.length) return;
  const tabs = await chrome.tabs.query({ url: origins });
  await Promise.allSettled(
    tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }),
    ),
  );
}

chrome.runtime.onInstalled.addListener(() => {
  queueScriptSync();
  injectIntoOpenTabs([...requiredOrigins()]).catch(console.error);
});

chrome.runtime.onStartup.addListener(queueScriptSync);

chrome.permissions.onAdded.addListener((added) => {
  queueScriptSync();
  injectIntoOpenTabs(added.origins).catch(console.error);
});

chrome.permissions.onRemoved.addListener(queueScriptSync);

// ---------- header rules ----------
// A mirror view installs session rules that let its frame load pages which
// forbid framing (see panel/panel.js). They are only needed while a view is
// open, so they are removed when the last one closes.

async function removeHeaderRulesIfUnused() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL", "TAB"] });
  const viewOpen = contexts.some((context) => context.documentUrl?.startsWith(VIEW_PAGE));
  if (viewOpen) return;

  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message?.type === "view-closing") {
    // The closing view is still listed for a moment.
    setTimeout(() => removeHeaderRulesIfUnused().catch(console.error), 500);
    return;
  }

  // A view asks this before loading a newly granted site, so the content
  // script is registered by the time the page starts to load.
  if (message?.type === "sync-content-scripts") {
    queueScriptSync().then(() => sendResponse(true));
    return true; // the response is sent asynchronously
  }
});

// A view that was closed while the worker was asleep can leave rules behind.
removeHeaderRulesIfUnused().catch(console.error);
