# Submission checklist

## Before the first upload

- [ ] Register a Chrome Web Store developer account (one-time fee) and verify the contact email.
- [ ] Make sure the repository is public, so `PRIVACY.md` has a public URL.
- [ ] Work through the manual checks below.

To rename the extension, update `name`, `short_name` and `action.default_title` in `src/manifest.json`, the `<title>` in `src/panel/panel.html`, `name` in `package.json`, and the text in `README.md`, `PRIVACY.md` and `store/LISTING.md`.

## Manual checks

The automated tests drive the mirror view through the pop-out window. These paths need a person, in a normal Chrome profile with `src` (or `dist/extension`) loaded unpacked:

**Toolbar icon and side panel**

- [ ] On a `localhost` page, clicking the icon opens the side panel and the page appears in the phone, with no permission prompt.
- [ ] Switching tabs and navigating in the tab updates the phone.
- [ ] Closing and reopening the panel works, in more than one window.

**Turning on another site**

- [ ] On a site that is not localhost, with the panel open, the panel says the tab is not mirrored.
- [ ] Clicking the toolbar icon there shows Chrome's permission prompt for that one site.
- [ ] After allowing, the site appears in the phone, and stays allowed after restarting Chrome.
- [ ] After denying, the panel shows "Not mirroring (site)" with a "Mirror this site" button, and the button brings the prompt back.
- [ ] View options shows a "Mirror (site)" switch for that site, and switching it off removes the site from `chrome://extensions` > Details > Site access.
- [ ] Scroll sync works on a newly allowed site without reloading the tab.

**Windows and sizes**

- [ ] Pop out opens a window sized to the device. This could not be checked in the automated environment, which has no window manager.
- [ ] Real size, after calibrating against a bank card, matches a physical phone held to the screen.
- [ ] Light and dark mode both look right.

**A site that cannot be framed**

- [ ] On a site that refuses to load in the panel, the notice appears after about ten seconds and "Open in a window" opens the page in a phone-sized window.

**Incognito**

- [ ] With "Allow in Incognito" on, the panel in an incognito window mirrors the incognito tab and uses the incognito session, not the regular one.

## Build and upload

```sh
npm ci
npm run check        # lint, format, unit tests, build
xvfb-run -a python3 tests/browser/test_extension.py dist/extension   # or without xvfb-run on a desktop
```

- [ ] Upload `dist/sidephone-<version>.zip` in the developer dashboard.
- [ ] Fill in the Store listing, Privacy and Test instructions tabs from `LISTING.md`.
- [ ] Distribution: Public, all regions, free.
- [ ] Submit for review.

## What to expect from review

- Requesting optional access to all sites (`*://*/*`) and modifying response headers both get a closer look. The justifications in `LISTING.md` are written for that, and nothing broad is granted at install.
- The install prompt lists access to localhost and 127.0.0.1 only.
- If a reviewer asks why the Content-Security-Policy header is removed and not edited: `declarativeNetRequest` can only remove, set or append a header, and the directive that blocks framing cannot be removed on its own.

## Releasing an update

1. Bump `version` in `src/manifest.json` and `package.json`, and add an entry to `CHANGELOG.md`.
2. `npm run check`, run the browser tests, and repeat the manual checks that the change touches.
3. Upload the new zip. A change to permissions triggers a fresh review and may disable the extension for existing users until they accept.
