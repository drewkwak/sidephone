# Privacy policy

_Last updated: November 17, 2026_

Sidephone is a browser extension that shows the page in your current tab at phone size in Chrome's side panel.

## Summary

Sidephone does not collect, store, transmit or sell any personal data. It has no servers, no analytics and no advertising, and it makes no network requests of its own.

## What the extension accesses, and why

To do its job, Sidephone handles the following on your device only:

- **The address of your active tab**, on sites you have turned it on for, so that it can load the same page in the side panel. The address is used in memory and is not saved.
- **Page content of mirrored sites.** The side panel loads a second copy of the page directly from the website, the same way a browser tab does. Scripts on mirrored sites report the following to the side panel, and nothing else:
  - that the page has loaded, its scroll position, its background and theme colour, and whether a text field has focus (not what you type in it)
  - for the mobile checks: the size and position of elements that don't fit a phone screen, with a short label made from the element's tag, id, classes and the start of its text
  - the widths in the page's CSS media queries
  - the messages of uncaught JavaScript errors
  - when you choose Show in Sidephone: a description of the element you right-clicked, so the same element can be found in the mobile copy

  All of this stays in the side panel while it is open. None of it is saved or sent anywhere.

- **Your view settings**: the chosen devices, zoom, which options are switched on, and the device you last used on each site (stored by the site's host name, such as `localhost:3000`). These are stored in the extension's local storage in your browser and are not synced or sent anywhere.

## Site access

Sidephone has access to `localhost` and `127.0.0.1` when installed, because it is a tool for local web development. It has no access to any other website until you turn it on for that site, which Chrome confirms with its own permission prompt. You can remove a site's access at any time from Sidephone's view options or from Chrome's extension settings.

## Changes to web pages

So that a website can be shown inside the side panel, Sidephone removes two response headers that forbid framing (`X-Frame-Options` and `Content-Security-Policy`) from the copy of the page loaded into the side panel. In in-app mode on an Android device, that copy is also told it is running in an Android WebView. Pages in your normal browser tabs are not modified.

## Data sharing

None. No data leaves your browser because of this extension.

## Changes to this policy

If this policy changes, the new version will be published in the project's repository with an updated date.

## Contact

Questions about this policy: open an issue at https://github.com/drewkwak/sidephone/issues.
