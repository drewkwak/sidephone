"""Loads the unpacked extension in a real Chrome and returns handles for tests.

Chrome runs headed (extensions need it), so on a machine without a display run
the tests under xvfb:  xvfb-run -a python3 tests/browser/test_extension.py
Set CHROME to the browser binary if Playwright's own Chromium is not installed.
"""
import asyncio, os, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))

class Harness:
    def __init__(self, ext_dir):
        self.ext_dir = ext_dir
        self.servers = []

    async def __aenter__(self):
        for port in (8765,):
            self.servers.append(subprocess.Popen([sys.executable, os.path.join(HERE, "site.py"), str(port)]))
        time.sleep(0.6)
        self.pw = await async_playwright().start()
        self.profile = tempfile.mkdtemp(prefix="ext-test-profile-")
        self.ctx = await self.pw.chromium.launch_persistent_context(
            self.profile,
            executable_path=os.environ.get("CHROME") or None,
            headless=False,
            args=[
                f"--disable-extensions-except={self.ext_dir}",
                f"--load-extension={self.ext_dir}",
                "--no-sandbox",
                "--window-size=1300,900",
                # Any *.test host resolves to the local test site, which gives
                # the tests a site the extension has no access to.
                "--host-resolver-rules=MAP *.test 127.0.0.1",
            ],
            viewport=None,
        )
        sw = self.ctx.service_workers[0] if self.ctx.service_workers else await self.ctx.wait_for_event("serviceworker", timeout=15000)
        self.sw = sw
        self.ext_id = sw.url.split("/")[2]
        return self

    async def __aexit__(self, *exc):
        try:
            await self.ctx.close()
            await self.pw.stop()
        finally:
            for s in self.servers:
                s.kill()

    async def open_site(self, url):
        page = await self.ctx.new_page()
        await page.goto(url)
        await page.bring_to_front()
        return page

    async def browser_window_id(self):
        windows = await self.sw.evaluate("() => chrome.windows.getAll({windowTypes: ['normal']})")
        return windows[0]["id"]

    async def session_rules_empty(self):
        return len(await self.session_rules()) == 0

    async def session_rules(self):
        return await self.sw.evaluate("() => chrome.declarativeNetRequest.getSessionRules()")

    async def open_popout(self, window_id, query=""):
        url = f"panel/panel.html?popout=1&win={window_id}{query}"
        async with self.ctx.expect_page() as info:
            await self.sw.evaluate(
                "(u) => chrome.windows.create({url: chrome.runtime.getURL(u), type: 'popup', width: 520, height: 1000})", url)
        page = await info.value
        await page.wait_for_load_state()
        return page

def mirror_frame(popout, host):
    for f in popout.frames:
        if f.url.startswith("http://" + host) or f.url.startswith("https://" + host):
            return f
    return None

async def wait_for(fn, timeout=8.0, step=0.15):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = await fn()
            if last:
                return last
        except Exception as e:  # noqa
            last = e
        await asyncio.sleep(step)
    return last



async def click_in_mirror(view, frame, selector):
    """Click an element inside the mirrored page with real mouse events.

    Synthetic input sent to the view's window is not routed into the frame of
    an extension page, so the events are dispatched to the frame's own target,
    in the frame's coordinates. Focus is emulated for the same reason: without
    it the frame's document never counts as focused.
    """
    cdp = await view.context.new_cdp_session(frame)
    try:
        await cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
        x, y = await frame.evaluate(
            """(sel) => { const el = document.querySelector(sel); el.scrollIntoView({block: 'center'});
                          const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }""",
            selector,
        )
        for kind in ("mousePressed", "mouseReleased"):
            await cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
    finally:
        await cdp.detach()
