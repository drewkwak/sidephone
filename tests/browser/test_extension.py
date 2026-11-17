"""End-to-end checks against a real Chrome with the extension loaded.

    xvfb-run -a python3 tests/browser/test_extension.py [path-to-extension]

The view is exercised through the pop-out window, which is the same page as
the side panel. Some things cannot be driven from here and need a manual
check: opening the actual side panel, Chrome's permission prompt for a new
site, the context menu itself, and Chrome's keyboard shortcuts. The code
behind the last two is exercised by sending the same messages they send.
"""
import asyncio
import os
import pathlib
import sys

from harness import Harness, click_in_mirror, mirror_frame, mirror_frames, wait_for

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
HOST = "localhost:8765"
SITE = f"http://{HOST}"
OTHER_LOCAL = "http://127.0.0.1:8765"  # also built in, but a different site
UNGRANTED = "http://other.test:8765"  # same server, a host the extension cannot access

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


async def run(ext_dir):
    async with Harness(ext_dir) as h:
        window_id = await h.browser_window_id()

        # ---------- empty state ----------
        view = await h.open_popout(window_id, "&preset=iphone-16")
        errors = []
        # The /issues test page throws two errors on purpose; anything else is a bug.
        deliberate = ("mobile only failure", "everywhere failure")
        view.on("pageerror", lambda e: errors.append(str(e)) if not any(d in str(e) for d in deliberate) else None)
        view.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        check("with no web page open, the empty state shows", await wait_for(lambda: view.is_visible("#empty")))

        site = await h.open_site(f"{SITE}/")

        def frame():
            return mirror_frame(view, HOST)

        async def page_ready():
            return await view.evaluate("!document.body.classList.contains('loading')")

        fr = await wait_for(lambda: asyncio.sleep(0, frame()))
        check("mirror frame loads a page that forbids framing", fr is not None)
        if fr is None:
            return
        await fr.wait_for_selector("#cookie-seen")
        await wait_for(page_ready)
        check("the empty state goes away", await view.is_hidden("#empty"))

        check("SameSite=Lax HttpOnly cookie is sent in the mirror", await fr.inner_text("#cookie-seen") == "cookie-sent=yes", await fr.inner_text("#cookie-seen"))
        check("page lays out at the phone's width", await fr.evaluate("innerWidth") == 393, str(await fr.evaluate("innerWidth")))
        check("mobile media query applies", await fr.is_visible("#layout") and not await fr.is_visible("#layout-d"))
        check("no scrollbar takes space from the layout", await fr.evaluate("document.documentElement.clientWidth") == 393, str(await fr.evaluate("document.documentElement.clientWidth")))
        check("readout shows the page size", await view.inner_text("#readout") == "393 × 692", await view.inner_text("#readout"))
        check("no notice while mirroring", await view.is_hidden("#status") and await view.is_hidden("#site-notice"))
        check("address bar shows the host", HOST in await view.inner_text(".bar-bottom .pill"))

        # ---------- keyboard ----------
        await view.bring_to_front()
        await click_in_mirror(view, fr, "#name")
        check("keyboard opens for a text field", await wait_for(lambda: view.evaluate("document.querySelector('.keyboard').classList.contains('open')")))
        check("text layout for a text field", await view.evaluate("document.querySelector('.keyboard').classList.contains('text')"))
        await click_in_mirror(view, fr, "#phone")
        check("number pad for a phone field", await wait_for(lambda: view.evaluate("document.querySelector('.keyboard').classList.contains('numeric')")))
        await click_in_mirror(view, fr, "#hdr")
        check("keyboard closes when the field loses focus", await wait_for(lambda: view.evaluate("!document.querySelector('.keyboard').classList.contains('open')")))

        top = await view.evaluate("(() => { const s = document.querySelector('.screen'); s.scrollTop = 200; return s.scrollTop; })()")
        check("device screen cannot scroll", top == 0, str(top))

        # ---------- breakpoints ----------
        chips = await wait_for(lambda: view.evaluate("[...document.querySelectorAll('#ruler-chips .chip')].map(c => c.textContent).join(',')"))
        check("breakpoints are read from the page's CSS, in both syntaxes", chips == "480,640,700,1024", str(chips))
        await view.click("#ruler-chips .chip[data-width='700']")
        check("a breakpoint chip switches to that width", await wait_for(lambda: frame().evaluate("innerWidth === 700")), str(await frame().evaluate("innerWidth")))
        check("the page shows its layout from that breakpoint", await wait_for(lambda: frame().is_visible("#layout-d")))
        await view.click("#ruler-chips .chip[data-width='700']", modifiers=["Shift"])
        check("Shift-click goes just below the breakpoint", await wait_for(lambda: frame().evaluate("innerWidth === 699")))
        await view.focus(".resize-handle")
        await view.keyboard.press("ArrowRight")
        check("the width grip moves by keyboard", await wait_for(lambda: frame().evaluate("innerWidth === 700")))
        await view.click("#device-btn")
        await view.click("#device-menu .item[data-value='iphone-16']")
        await wait_for(lambda: frame().evaluate("innerWidth === 393"))

        # ---------- scroll sync ----------
        await site.bring_to_front()
        await site.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        check("mirror follows the main tab's scroll", await wait_for(lambda: frame().evaluate("window.scrollY > 200")))

        # ---------- following navigation ----------
        await site.goto(f"{SITE}/b")
        check("mirror follows a navigation", await wait_for(lambda: asyncio.sleep(0, frame().url.endswith("/b"))), frame().url)
        check("top bar takes a dark page's colour", await wait_for(lambda: view.evaluate("document.querySelector('.bar-top').classList.contains('on-dark')")))

        # A page without a router ignores the route change, so the mirror reloads.
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, frame().url == f"{SITE}/"))
        await wait_for(page_ready)
        await site.evaluate("window.__spa('/themed')")
        check("a route change the page ignores falls back to a reload",
              await wait_for(lambda: frame().evaluate("document.getElementById('hdr')?.textContent === 'Themed'")),
              frame().url)

        # A single-page app follows the route without reloading.
        await site.goto(f"{SITE}/spa/one")
        await wait_for(lambda: asyncio.sleep(0, frame().url == f"{SITE}/spa/one"))
        await wait_for(page_ready)
        load_id = await frame().evaluate("window.__loadId")
        await site.click("a[href='/spa/two']")
        check("a single-page app's route change reaches the mirror",
              await wait_for(lambda: frame().evaluate("document.getElementById('route').textContent === 'route:/spa/two'")))
        await asyncio.sleep(0.6)
        check("...without reloading it", await frame().evaluate("window.__loadId") == load_id)

        # ---------- reloading ----------
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, frame().url == f"{SITE}/"))
        await asyncio.sleep(1.0)
        navigations = []
        view.on("framenavigated", lambda f: navigations.append(f.url) if f.url.startswith(SITE) else None)
        await site.reload()
        check("reloading the main tab reloads the mirror", await wait_for(lambda: asyncio.sleep(0, len(navigations) >= 1)), str(navigations))
        await asyncio.sleep(0.8)

        # ---------- "Show in Sidephone" ----------
        await wait_for(page_ready)
        await site.bring_to_front()
        await site.evaluate("window.scrollTo(0, 0)")
        await site.dispatch_event("#far-down", "contextmenu")
        tab_id = await h.sw.evaluate("async () => (await chrome.tabs.query({active: true, windowId: %d}))[0].id" % window_id)
        # What background.js does when the menu item is clicked.
        await h.sw.evaluate(
            """async (tabId) => {
                const locator = await chrome.tabs.sendMessage(tabId, {type: 'context-target'}, {frameId: 0});
                await chrome.runtime.sendMessage({type: 'locate', tabId, locator});
            }""",
            tab_id,
        )
        in_view = await wait_for(lambda: frame().evaluate(
            "(() => { const r = document.getElementById('far-down').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"))
        check("the right-clicked element is scrolled into view in the mirror", in_view)
        check("...and highlighted", await wait_for(lambda: view.evaluate("!!document.querySelector('.flash')")))

        # ---------- mobile checks ----------
        await site.goto(f"{SITE}/issues")
        await wait_for(lambda: asyncio.sleep(0, frame().url.endswith("/issues")))
        await wait_for(page_ready)
        badge = await wait_for(lambda: view.evaluate("(() => { const b = document.getElementById('checks-count'); return !b.hidden && Number(b.textContent) >= 6; })()"))
        check("the checks badge counts the problems", badge, await view.inner_text("#checks-count"))
        check("the badge is red when something is broken", await view.evaluate("document.getElementById('checks-count').classList.contains('error')"))
        await view.click("#checks-btn")
        listing = await view.inner_text("#checks-list")
        for heading in ("Wider than the screen", "Small touch targets", "Fields that zoom in on iPhone", "Small text", "JavaScript errors"):
            check(f"checks list: {heading}", heading in listing, listing[:300])
        check("the box that is too wide is named", "div#wide" in listing)
        check("a link inside a sentence is not flagged", "link inside a sentence" not in listing)
        check("a sideways-scrolling carousel is not flagged", '"One"' not in listing and "carousel" not in listing)
        check("a big enough button is not flagged", "Big enough" not in listing)
        error_rows = await view.evaluate("[...document.querySelectorAll('#checks-list .check-item.error')].map(e => e.textContent)")
        mobile_only = [row for row in error_rows if "mobile only failure" in row]
        everywhere = [row for row in error_rows if "everywhere failure" in row]
        check("an error thrown only at phone width is marked as mobile-only", mobile_only and "Only in the mobile view" in mobile_only[0], str(error_rows))
        check("an error the desktop page also throws is not", everywhere and "Only in the mobile view" not in everywhere[0], str(error_rows))
        await view.click("#checks-list button.check-item")
        check("clicking a problem highlights it in the mirror", await wait_for(lambda: view.evaluate("!!document.querySelector('.flash')")))
        await view.click("label.inline-switch")
        check("outlines are drawn over the page", await wait_for(lambda: view.evaluate("document.querySelectorAll('.outline').length >= 4")))
        await view.click("label.inline-switch")
        check("and removed again", await wait_for(lambda: view.evaluate("document.querySelectorAll('.outline').length === 0")))
        await view.keyboard.press("Escape")

        # ---------- comparing devices ----------
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, frame().url == f"{SITE}/"))
        await view.click("#device-btn")
        await view.click("#device-menu [data-action='add']")
        await view.click("#device-menu .item[data-value='iphone-se']")
        check("a second device appears", await wait_for(lambda: view.evaluate("document.querySelectorAll('.view').length === 2")))
        await wait_for(lambda: asyncio.sleep(0, len(mirror_frames(view, HOST)) == 2))
        widths = []
        for f in mirror_frames(view, HOST):
            await f.wait_for_selector("#cookie-seen")
            widths.append(await f.evaluate("innerWidth"))
        check("each device lays the page out at its own width", sorted(widths) == [375, 393], str(widths))
        names = await view.evaluate("[...document.querySelectorAll('.view-name')].map(n => n.textContent)")
        check("devices are labelled when comparing", names == ["iPhone 16", "iPhone SE"], str(names))
        await view.click(".view:nth-child(2) .view-remove")
        check("a compared device can be removed", await wait_for(lambda: view.evaluate("document.querySelectorAll('.view').length === 1")))

        # ---------- in-app (WebView) mode ----------
        await view.click("#device-btn")
        await view.click("#device-menu .item[data-value='pixel-9']")
        await view.click("#settings-btn")
        await view.click("label:has(#in-app)")
        await view.keyboard.press("Escape")
        check("in-app mode gives the page the room the browser bars took",
              await wait_for(lambda: view.evaluate("document.getElementById('readout').textContent === '412 × 840'")),
              await view.inner_text("#readout"))
        check("an Android device reports a WebView user agent",
              await wait_for(lambda: frame().evaluate("navigator.userAgent.includes('; wv)')")))
        check("...from the page's very first script", await frame().evaluate("document.getElementById('hdr').dataset.webview === 'true'"))
        await view.click("#settings-btn")
        await view.click("label:has(#in-app)")
        await view.keyboard.press("Escape")
        check("turning it off restores the normal user agent",
              await wait_for(lambda: frame().evaluate("!navigator.userAgent.includes('; wv)')")))

        # ---------- a device remembered per site ----------
        await site.goto(f"{OTHER_LOCAL}/")
        await wait_for(lambda: asyncio.sleep(0, bool(mirror_frame(view, "127.0.0.1:8765"))))
        await view.click("#device-btn")
        await view.click("#device-menu .item[data-value='iphone-se']")
        await site.goto(f"{SITE}/")
        check("going back to a site brings back its device",
              await wait_for(lambda: view.evaluate("document.getElementById('device-name').textContent === 'Pixel 9'")),
              await view.inner_text("#device-name"))
        await site.goto(f"{OTHER_LOCAL}/")
        check("...for each site", await wait_for(lambda: view.evaluate("document.getElementById('device-name').textContent === 'iPhone SE'")))
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, frame() is not None and frame().url == f"{SITE}/"))

        # ---------- shortcuts ----------
        await h.sw.evaluate("(windowId) => chrome.runtime.sendMessage({type: 'command', command: 'next-device', windowId})", window_id)
        check("the next-device shortcut changes device",
              await wait_for(lambda: view.evaluate("document.getElementById('device-name').textContent === 'Pixel 9 Pro'")),
              await view.inner_text("#device-name"))
        await view.bring_to_front()
        await view.focus("#device-btn")
        await view.keyboard.press("[")
        check("[ in the panel goes back a device", await wait_for(lambda: view.evaluate("document.getElementById('device-name').textContent === 'Pixel 9'")))

        check("no errors in the view", not errors, "; ".join(errors[:3]))

        # ---------- the mirrored page cannot replace the view ----------
        fr = frame()
        await fr.wait_for_selector("#cookie-seen")
        try:
            await fr.evaluate("window.top.location = 'about:blank'")
        except Exception:
            pass
        await asyncio.sleep(0.5)
        check("mirrored page cannot navigate the view away", "panel/panel.html" in view.url, view.url)

        # ---------- a site the extension has no access to ----------
        other = await h.open_site(f"{UNGRANTED}/")
        check("a site without access is not mirrored and says so", await wait_for(lambda: view.is_visible("#site-notice")))
        check("the notice explains how to turn it on", "icon in the toolbar" in await view.inner_text("#site-notice-text"), await view.inner_text("#site-notice-text"))
        check("nothing was loaded for that site", mirror_frame(view, "other.test:8765") is None)
        check("the last mirrored page stays", frame() is not None)
        await site.bring_to_front()
        check("the notice goes away back on a mirrored site", await wait_for(lambda: view.is_hidden("#site-notice")))
        await other.close()

        # ---------- pin ----------
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, frame().url == f"{SITE}/"))
        await view.click("label:has(#pin)")
        await site.goto(f"{SITE}/b")
        await asyncio.sleep(1.2)
        check("a pinned view stays on its page", frame().url == f"{SITE}/", frame().url)
        await view.click("label:has(#pin)")
        check("unpinning catches up", await wait_for(lambda: asyncio.sleep(0, frame().url.endswith("/b"))))

        # ---------- header rules exist only while a view is open ----------
        check("header rules are installed while a view is open", len(await h.session_rules()) >= 2, str(await h.session_rules()))
        await view.close()
        gone = await wait_for(h.session_rules_empty, timeout=6)
        check("header rules are removed when the last view closes", gone, str(await h.session_rules()))


async def main():
    ext_dir = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "src")
    await run(os.path.abspath(ext_dir))
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
