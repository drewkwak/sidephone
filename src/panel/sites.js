// Which sites may be mirrored.
//
// The extension can only load a site in a mirror view once it has host
// permission for it. Localhost is granted at install. Every other site is
// granted by the user, one site at a time, through Chrome's own permission
// prompt, and Chrome remembers the answer. There is no separate list here:
// Chrome's permission store is the single source of truth.

/**
 * @typedef {object} Site
 * @property {string} host     Hostname with port, for display: "localhost:3000".
 * @property {string} pattern  Match pattern used for the permission: "*://localhost/*".
 */

/**
 * @param {string | undefined} url
 * @returns {Site | null}  null when the URL is unreadable or not a web page.
 */
export function siteOf(url) {
  if (!url) return null;
  try {
    const { protocol, hostname, host } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return { host, pattern: `*://${hostname}/*` };
  } catch {
    return null;
  }
}

/** @param {Site} site */
export const hasAccess = (site) => chrome.permissions.contains({ origins: [site.pattern] });

/** Must be called from a click handler: Chrome shows its permission prompt. */
export const requestAccess = (site) => chrome.permissions.request({ origins: [site.pattern] });

export const removeAccess = (site) => chrome.permissions.remove({ origins: [site.pattern] });

/** Sites granted in the manifest cannot be turned off from inside the extension. */
export function isBuiltIn(site) {
  const required = chrome.runtime.getManifest().host_permissions ?? [];
  return (
    required.includes(site.pattern) || required.some((pattern) => coversSubdomainsOf(pattern, site))
  );
}

// "*://*.localhost/*" covers "*://app.localhost/*".
function coversSubdomainsOf(pattern, site) {
  const match = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(pattern);
  if (!match) return false;
  const siteHost = site.pattern.slice("*://".length, -"/*".length);
  return siteHost === match[1] || siteHost.endsWith(`.${match[1]}`);
}

/**
 * Wait until the content script is registered for the sites the user has
 * granted. The service worker registers it when access is granted, but a view
 * can hear about the grant first and must not load the page before then.
 */
export async function contentScriptReady() {
  try {
    await chrome.runtime.sendMessage({ type: "sync-content-scripts" });
  } catch {
    // The service worker could not be reached. The view still works; it just
    // will not hear from a page that loads without the script.
  }
}
