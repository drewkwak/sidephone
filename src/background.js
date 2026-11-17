// Service worker. It keeps almost no state of its own: what it needs is read
// from Chrome (granted permissions, registered scripts, open views) each time
// an event wakes it.
//
// It does five things:
//  - opens the side panel when the toolbar icon is clicked, and asks for
//    access to the site in that tab if it does not have it yet
//  - keeps the content scripts registered for exactly the sites the user has
//    granted
//  - removes the header rules once the last view has closed
//  - offers "Show in Sidephone" in the page's context menu
//  - passes keyboard shortcuts on to the views

const VIEW_PAGE = chrome.runtime.getURL("panel/panel.html");
const MANIFEST = chrome.runtime.getManifest();
const LOCATE_MENU_ID = "show-in-sidephone";

// The two content scripts, as the manifest declares them for localhost. Other
// sites get the same files registered at run time.
const ISOLATED_SCRIPT = MANIFEST.content_scripts.find((script) => script.world !== "MAIN");
const PAGE_WORLD_SCRIPT = MANIFEST.content_scripts.find((script) => script.world === "MAIN");

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

// ---------- content scripts and the context menu, per granted site ----------

const requiredOrigins = () => new Set(MANIFEST.host_permissions ?? []);

async function grantedOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  return origins;
}

/** Register the content scripts for the optional sites the user has granted. */
async function syncOptionalSiteScripts() {
  const required = requiredOrigins();
  const matches = (await grantedOrigins()).filter((origin) => !required.has(origin));

  const scripts = [
    { id: "optional-sites", js: ISOLATED_SCRIPT.js },
    { id: "optional-sites-page", js: PAGE_WORLD_SCRIPT.js, world: "MAIN" },
  ].map((script) => ({ ...script, matches, allFrames: true, runAt: "document_start" }));

  const ids = scripts.map((script) => script.id);
  const existing = new Set(
    (await chrome.scripting.getRegisteredContentScripts({ ids })).map((script) => script.id),
  );

  if (matches.length === 0) {
    if (existing.size) await chrome.scripting.unregisterContentScripts({ ids: [...existing] });
    return;
  }
  const toUpdate = scripts.filter((script) => existing.has(script.id));
  const toRegister = scripts.filter((script) => !existing.has(script.id));
  if (toUpdate.length) await chrome.scripting.updateContentScripts(toUpdate);
  if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);
}

/** "Show in Sidephone" appears on pages the extension can mirror. */
async function syncContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: LOCATE_MENU_ID,
    title: "Show in Sidephone",
    contexts: ["all"],
    documentUrlPatterns: [...new Set([...requiredOrigins(), ...(await grantedOrigins())])],
  });
}

// Run one sync at a time: two grants in quick succession must not interleave.
let syncQueue = Promise.resolve();
function queueSync() {
  syncQueue = syncQueue
    .then(() => Promise.all([syncOptionalSiteScripts(), syncContextMenu()]))
    .catch(console.error);
  return syncQueue;
}

/** Tabs that were open before access was granted have no content scripts yet. */
async function injectIntoOpenTabs(origins) {
  if (!origins?.length) return;
  const tabs = await chrome.tabs.query({ url: origins });
  await Promise.allSettled(
    tabs.flatMap((tab) => [
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ISOLATED_SCRIPT.js }),
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: PAGE_WORLD_SCRIPT.js,
        world: "MAIN",
      }),
    ]),
  );
}

chrome.runtime.onInstalled.addListener(() => {
  queueSync();
  injectIntoOpenTabs([...requiredOrigins()]).catch(console.error);
});

chrome.runtime.onStartup.addListener(queueSync);

chrome.permissions.onAdded.addListener((added) => {
  queueSync();
  injectIntoOpenTabs(added.origins).catch(console.error);
});

chrome.permissions.onRemoved.addListener(queueSync);

// ---------- "Show in Sidephone" ----------
// The content script in the tab describes the element that was right-clicked.
// Views following that tab look for the same element in their copy of the
// page. A view opened by this click asks for the request once it has loaded.

let pendingLocate = null; // { tabId, locator, at }

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== LOCATE_MENU_ID || !tab?.id) return;
  // Opening the panel needs the user gesture, so it comes first.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);

  chrome.tabs
    .sendMessage(tab.id, { type: "context-target" }, { frameId: 0 })
    .then((locator) => {
      if (!locator) return;
      pendingLocate = { tabId: tab.id, locator, at: Date.now() };
      chrome.runtime.sendMessage({ type: "locate", tabId: tab.id, locator }).catch(() => {
        // No view is open yet. The new one asks for pendingLocate.
      });
    })
    .catch(() => {
      // The click was inside an embedded frame, or the page has no content script.
    });
});

// ---------- keyboard shortcuts ----------

chrome.commands.onCommand.addListener((command, tab) => {
  chrome.runtime.sendMessage({ type: "command", command, windowId: tab?.windowId }).catch(() => {
    // No view is open.
  });
});

// ---------- header rules ----------
// A view installs session rules that let its frame load pages which forbid
// framing (see panel/panel.js). They are only needed while a view is open, so
// they are removed when the last one closes.

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

// ---------- messages from views ----------

const LOCATE_EXPIRY_MS = 15_000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages. Content scripts are answered elsewhere.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(VIEW_PAGE)) return;

  switch (message?.type) {
    case "view-closing":
      // The closing view is still listed for a moment.
      setTimeout(() => removeHeaderRulesIfUnused().catch(console.error), 500);
      return;

    // A view asks this before loading a newly granted site, so the content
    // scripts are registered by the time the page starts to load.
    case "sync-content-scripts":
      queueSync().then(() => sendResponse(true));
      return true; // the response is sent asynchronously

    case "take-pending-locate": {
      const fresh =
        pendingLocate &&
        pendingLocate.tabId === message.tabId &&
        Date.now() - pendingLocate.at < LOCATE_EXPIRY_MS;
      sendResponse(fresh ? pendingLocate.locator : null);
      if (fresh) pendingLocate = null;
      return;
    }
  }
});

// A view that was closed while the worker was asleep can leave rules behind.
removeHeaderRulesIfUnused().catch(console.error);
