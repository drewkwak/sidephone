# Privacy policy

_Last updated: November 9, 2026_

Sidephone is a browser extension that shows the page in your current tab at phone size in Chrome's side panel.

## Summary

Sidephone does not collect, store, transmit or sell any personal data. It has no servers, no analytics and no advertising, and it makes no network requests of its own.

## What the extension accesses, and why

To do its job, Sidephone handles the following on your device only:

- **The address of your active tab**, on sites you have turned it on for, so that it can load the same page in the side panel. The address is used in memory and is not saved.
- **Page content of mirrored sites.** The side panel loads a second copy of the page directly from the website, the same way a browser tab does. Sidephone does not read, copy or record what is on the page. A small script on mirrored sites reports four things to the side panel: that the page has finished loading, its scroll position, its background and theme colour, and whether a text field has focus. It does not read what you type.
- **Your view settings**: the chosen device, zoom, and which options are switched on. These are stored in the extension's local storage in your browser and are not synced or sent anywhere.

## Site access

Sidephone has access to `localhost` and `127.0.0.1` when installed, because it is a tool for local web development. It has no access to any other website until you turn it on for that site, which Chrome confirms with its own permission prompt. You can remove a site's access at any time from Sidephone's view options or from Chrome's extension settings.

## Changes to web pages

So that a website can be shown inside the side panel, Sidephone removes two response headers that forbid framing (`X-Frame-Options` and `Content-Security-Policy`) from the copy of the page loaded into the side panel. Pages in your normal browser tabs are not modified.

## Data sharing

None. No data leaves your browser because of this extension.

## Changes to this policy

If this policy changes, the new version will be published in the project's repository with an updated date.

## Contact

Questions about this policy: open an issue at https://github.com/drewkwak/sidephone/issues.
