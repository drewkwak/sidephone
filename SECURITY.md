# Security

## Reporting a problem

Please report security issues privately, through GitHub's "Report a vulnerability" button on this repository (Security tab). Do not open a public issue for something that could be exploited.

## What to know when reviewing

Sidephone loads web pages into a frame inside an extension page, and removes two response headers to make that possible. These are the decisions that keep that safe, and the trade-offs that remain.

**Scope of the header rules**

- The rules remove `X-Frame-Options` and `Content-Security-Policy` from sub-frame documents only.
- They match documents loaded by the extension's own pages, into the side panel's frame, or into a pop-out window's tab. They never match documents in ordinary tabs.
- They use `declarativeNetRequestWithHostAccess`, so they only apply on sites the user has granted.
- They are session rules, installed when a mirror view opens and removed when the last one closes.

**Known trade-offs**

- The whole `Content-Security-Policy` header is removed from the mirrored copy of a page, because `declarativeNetRequest` cannot edit a header's value. That copy runs without the site's CSP.
- While a view is open, the side panel rule matches any sub-frame request that does not belong to a tab, on granted sites. In practice that is the mirror frame and frames nested inside it.

**Isolation of the mirrored page**

- The frame is sandboxed without `allow-top-navigation`, so the page cannot navigate the view.
- The view accepts `postMessage` data only from the frame's own `contentWindow` and only messages carrying the extension's tag. Of the values a page can influence, only colours are used, after validation with `CSS.supports`, and only by assigning to `backgroundColor`.
- Messages sent into the frame carry a scroll fraction or a pixel inset and nothing else.
- No page content is inserted into the extension's DOM. The only `innerHTML` assignments use constant markup defined in the source.

**Content script**

- Injected only on `localhost` and on sites the user has granted.
- Acts only in the top frame of a tab or in a frame whose single ancestor is this extension's own page.
- Reads scroll position, page colours and the type of the focused field. It does not read page text, form values, cookies or storage.

**No remote code, no network**

The extension ships all of its code, loads nothing at run time and makes no requests of its own.
