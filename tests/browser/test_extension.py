"""End-to-end checks against a real Chrome with the extension loaded.

    xvfb-run -a python3 tests/browser/test_extension.py [path-to-extension]

The mirror view is exercised through the pop-out window, which is the same
page as the side panel. Two things cannot be driven from here and need a
manual check: opening the actual side panel, and Chrome's permission prompt
for turning on a new site.
"""
import asyncio
import os
import pathlib
import sys

from harness import Harness, click_in_mirror, mirror_frame, wait_for

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SITE = "http://localhost:8765"
UNGRANTED = "http://other.test:8765"  # same server, a host the extension cannot access

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


async def run(ext_dir):
    async with Harness(ext_dir) as h:
        site = await h.open_site(f"{SITE}/")
        window_id = await h.browser_window_id()
        view = await h.open_popout(window_id, "&preset=iphone-16")
        errors = []
        view.on("pageerror", lambda e: errors.append(str(e)))
        view.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        async def frame():
            return mirror_frame(view, "localhost:8765")

        fr = await wait_for(frame)
        check("mirror frame loads a page that forbids framing", fr is not None)
        if fr is None:
            return
        await fr.wait_for_selector("#cookie-seen")
        await wait_for(lambda: view.evaluate("!document.body.classList.contains('loading')"))

        check("SameSite=Lax HttpOnly cookie is sent in the mirror", await fr.inner_text("#cookie-seen") == "cookie-sent=yes", await fr.inner_text("#cookie-seen"))
        check("page lays out at the phone's width", await fr.evaluate("innerWidth") == 393, str(await fr.evaluate("innerWidth")))
        check("mobile media query applies", await fr.is_visible("#layout") and not await fr.is_visible("#layout-d"))
        check("no scrollbar takes space from the layout", await fr.evaluate("document.documentElement.clientWidth") == 393, str(await fr.evaluate("document.documentElement.clientWidth")))
        check("readout shows the page size", await view.inner_text("#readout") == "393 × 692", await view.inner_text("#readout"))
        check("no notice while mirroring", await view.is_hidden("#status") and await view.is_hidden("#site-notice"))
        check("address bar shows the host", "localhost:8765" in await view.inner_text("#bar-bottom .pill"))

        # --- keyboard ---
        await view.bring_to_front()
        await click_in_mirror(view, fr, "#name")
        check("keyboard opens for a text field", await wait_for(lambda: view.evaluate("document.querySelector('#keyboard').classList.contains('open')")))
        check("text layout for a text field", await view.evaluate("document.querySelector('#keyboard').classList.contains('text')"))
        await click_in_mirror(view, fr, "#phone")
        check("number pad for a phone field", await wait_for(lambda: view.evaluate("document.querySelector('#keyboard').classList.contains('numeric')")))
        await click_in_mirror(view, fr, "#hdr")
        check("keyboard closes when the field loses focus", await wait_for(lambda: view.evaluate("!document.querySelector('#keyboard').classList.contains('open')")))

        # --- the screen cannot be scrolled out of place ---
        top = await view.evaluate("(() => { const s = document.querySelector('#screen'); s.scrollTop = 200; return s.scrollTop; })()")
        check("device screen cannot scroll", top == 0, str(top))

        # --- scroll sync ---
        await site.bring_to_front()
        await site.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        scrolled = await wait_for(lambda: fr.evaluate("window.scrollY > 200"))
        check("mirror follows the main tab's scroll", scrolled)

        # --- following navigation ---
        await site.goto(f"{SITE}/b")
        on_b = await wait_for(lambda: asyncio.sleep(0, (mirror_frame(view, "localhost:8765") or fr).url.endswith("/b")))
        check("mirror follows a navigation", on_b, (mirror_frame(view, "localhost:8765") or fr).url)
        fr = mirror_frame(view, "localhost:8765")
        check("top bar takes a dark page's colour", await wait_for(lambda: view.evaluate("document.querySelector('#bar-top').classList.contains('on-dark')")))

        await site.evaluate("window.__spa('/themed')")
        on_themed = await wait_for(lambda: asyncio.sleep(0, mirror_frame(view, "localhost:8765").url.endswith("/themed")))
        check("mirror follows a history.pushState route change", on_themed, mirror_frame(view, "localhost:8765").url)

        # --- reloading the main tab reloads the mirror ---
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, mirror_frame(view, "localhost:8765").url == f"{SITE}/"))
        await asyncio.sleep(1.0)
        navigations = []
        view.on("framenavigated", lambda f: navigations.append(f.url) if f.url.startswith(SITE) else None)
        await site.reload()
        check("reloading the main tab reloads the mirror", await wait_for(lambda: asyncio.sleep(0, len(navigations) >= 1)), str(navigations))
        await asyncio.sleep(0.8)

        # --- navigation started inside the mirror ---
        fr = mirror_frame(view, "localhost:8765")
        await fr.wait_for_selector("#to-b")
        await view.bring_to_front()
        await click_in_mirror(view, fr, "#to-b")
        check("a link clicked inside the mirror loads", await wait_for(lambda: asyncio.sleep(0, mirror_frame(view, "localhost:8765").url.endswith("/b"))))
        fr = mirror_frame(view, "localhost:8765")
        await fr.wait_for_selector("#cookie-seen")

        check("no errors in the view", not errors, "; ".join(errors[:3]))

        # --- the mirrored page cannot replace the view ---
        try:
            await fr.evaluate("window.top.location = 'about:blank'")
        except Exception:
            pass
        await asyncio.sleep(0.5)
        check("mirrored page cannot navigate the view away", "panel/panel.html" in view.url, view.url)

        # --- device menu ---
        await view.click("#device-btn")
        await view.click("#device-menu .item[data-value='pixel-9']")
        check("choosing a device updates the page size", await wait_for(lambda: view.evaluate("document.querySelector('#readout').textContent === '412 × 784'")), await view.inner_text("#readout"))
        check("the mirrored page is resized", await wait_for(lambda: mirror_frame(view, "localhost:8765").evaluate("innerWidth === 412")))
        await view.click("#rotate")
        check("rotate swaps the orientation", await wait_for(lambda: mirror_frame(view, "localhost:8765").evaluate("innerWidth > innerHeight")))
        await view.click("#rotate")

        # --- a site the extension has no access to ---
        other = await h.open_site(f"{UNGRANTED}/")
        notice = await wait_for(lambda: view.is_visible("#site-notice"))
        check("a site without access is not mirrored and says so", notice)
        check("the notice explains how to turn it on", "icon in the toolbar" in await view.inner_text("#site-notice-text"), await view.inner_text("#site-notice-text"))
        check("nothing was loaded for that site", mirror_frame(view, "other.test:8765") is None)
        check("the last mirrored page stays", mirror_frame(view, "localhost:8765") is not None)
        await site.bring_to_front()
        check("the notice goes away back on a mirrored site", await wait_for(lambda: view.is_hidden("#site-notice")))
        await other.close()

        # --- pin ---
        await site.goto(f"{SITE}/")
        await wait_for(lambda: asyncio.sleep(0, mirror_frame(view, "localhost:8765").url == f"{SITE}/"))
        await view.click("label:has(#pin)")
        await site.goto(f"{SITE}/b")
        await asyncio.sleep(1.2)
        check("a pinned view stays on its page", mirror_frame(view, "localhost:8765").url == f"{SITE}/", mirror_frame(view, "localhost:8765").url)
        await view.click("label:has(#pin)")
        check("unpinning catches up", await wait_for(lambda: asyncio.sleep(0, mirror_frame(view, "localhost:8765").url.endswith("/b"))))

        # --- header rules exist only while a view is open ---
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
