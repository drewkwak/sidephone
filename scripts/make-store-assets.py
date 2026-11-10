"""Build the Chrome Web Store screenshots and promo tiles into store/assets/.

    xvfb-run -a python3 scripts/make-store-assets.py     (drop xvfb-run on a desktop)

Needs Playwright and Pillow. Set CHROME to a Chrome binary if Playwright's own
Chromium is not installed.

What is real and what is drawn:

  * The page on the left and the Sidephone panel on the right are captured
    from a real Chrome running this extension against store/demo-site.
  * The browser window around them (tab strip, toolbar, side panel header)
    and the caption above are drawn here, so the result does not depend on
    the operating system the script runs on.

Automation cannot open Chrome's actual side panel, so the panel page is opened
in a small window of its own. For that, a temporary copy of the extension is
told which browser window to follow. Nothing else differs from src/.
"""

import asyncio
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

from PIL import Image
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests" / "browser"))
from harness import click_in_mirror  # noqa: E402

OUT = ROOT / "store" / "assets"
DEMO_PORT = 3000
DEMO_URL = f"http://localhost:{DEMO_PORT}/"

# Layout of a 1280 x 800 screenshot, in CSS pixels.
CAPTION_H = 88
TAB_STRIP_H = 36
TOOLBAR_H = 40
PANEL_HEADER_H = 40
PANEL_W = 360
PAGE_W = 1280 - PANEL_W - 1  # one pixel for the divider
CONTENT_H = 800 - CAPTION_H - TAB_STRIP_H - TOOLBAR_H
VIEW_H = CONTENT_H - PANEL_HEADER_H

MARK = (
    '<svg viewBox="0 0 70 50" aria-hidden="true"><defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#4c94ff"/><stop offset="1" stop-color="#0a5cff"/></linearGradient></defs>'
    '<rect x="0" y="15" width="40" height="34" rx="7" fill="#fff" fill-opacity="0.24"/>'
    '<rect x="46" y="0" width="24" height="49" rx="7.5" fill="url(#p)"/></svg>'
)


def stroke_icon(paths, size=16):
    return (
        f'<svg viewBox="0 0 16 16" width="{size}" height="{size}" fill="none" stroke="currentColor" '
        f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{paths}</svg>'
    )


ICONS = {
    "back": stroke_icon('<path d="M9.5 3.5 5 8l4.5 4.5"/>'),
    "forward": stroke_icon('<path d="M6.5 3.5 11 8l-4.5 4.5"/>'),
    "reload": stroke_icon('<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2L12.5 6"/><path d="M12.5 3v3h-3"/>'),
    "close": stroke_icon('<path d="m4.5 4.5 7 7m0-7-7 7"/>', 13),
    "plus": stroke_icon('<path d="M8 3.5v9M3.5 8h9"/>', 14),
    "pin": stroke_icon(
        '<path d="M9.6 2.4l4 4-1.9.6-2.2 2.2.3 3.1-1 1-2.8-2.8L2.6 13.9"/>'
        '<path d="M6 10.5L3.2 7.7l1-1 3.1.3 2.2-2.2"/>'
    ),
    "more": (
        '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">'
        '<circle cx="8" cy="3.5" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/></svg>'
    ),
}

# Captions and tiles are set in Funnel Display and Funnel Sans (SIL Open Font
# License), installed as dev dependencies. The drawn browser window uses the
# system UI font, like a real one.
FONTS = ROOT / "node_modules" / "@fontsource-variable"


def font_face(family, slug):
    path = FONTS / slug / "files" / f"{slug}-latin-wght-normal.woff2"
    if not path.exists():
        sys.exit(f"Missing {path.relative_to(ROOT)}. Run `npm install` first.")
    return f"@font-face {{ font-family: '{family}'; font-weight: 300 800; src: url('{path.as_uri()}') format('woff2'); }}"


SHARED_CSS = f"""
{font_face("Funnel Display", "funnel-display")}
{font_face("Funnel Sans", "funnel-sans")}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; }}
body {{ font-family: 'Funnel Sans', sans-serif; -webkit-font-smoothing: antialiased; }}
h1, .brand {{ font-family: 'Funnel Display', sans-serif; }}
.brand {{ display: flex; align-items: center; gap: 0.5em; color: #fff; font-weight: 600; letter-spacing: -0.01em; }}
.brand svg {{ height: 1.15em; width: auto; }}
.window {{ font-family: Inter, system-ui, sans-serif; }}
"""


def window_html(page_png, view_png, dark):
    """A drawn browser window holding the two real captures."""
    c = (
        dict(strip="#17181b", tab="#2a2b30", bar="#2a2b30", field="#1b1c20", ink="#e7e8ea", muted="#9a9da3", line="#3a3b40", hover="#3a3d45")
        if dark
        else dict(strip="#dfe3e8", tab="#ffffff", bar="#ffffff", field="#eef1f4", ink="#1f2124", muted="#676b72", line="#d9dce1", hover="#e4e9f2")
    )
    icon = (ROOT / "src" / "icons" / "icon-32.png").as_uri()
    return f"""
<div class="window" style="--strip:{c['strip']};--tab:{c['tab']};--bar:{c['bar']};--field:{c['field']};--ink:{c['ink']};--muted:{c['muted']};--line:{c['line']};--hover:{c['hover']}">
  <div class="strip">
    <div class="tab"><i></i><span>Fernway</span>{ICONS['close']}</div>
    <div class="newtab">{ICONS['plus']}</div>
  </div>
  <div class="bar">
    <span class="nav">{ICONS['back']}</span><span class="nav dim">{ICONS['forward']}</span><span class="nav">{ICONS['reload']}</span>
    <div class="field">localhost:{DEMO_PORT}</div>
    <span class="ext"><img src="{icon}" width="18" height="18" alt=""></span>
    <span class="nav">{ICONS['more']}</span>
  </div>
  <div class="content">
    <img src="{page_png.as_uri()}" width="{PAGE_W}" height="{CONTENT_H}" alt="">
    <div class="panel">
      <div class="panel-head"><img src="{icon}" width="16" height="16" alt=""><b>Sidephone</b><span>{ICONS['pin']}</span><span>{ICONS['close']}</span></div>
      <img src="{view_png.as_uri()}" width="{PANEL_W}" height="{VIEW_H}" alt="">
    </div>
  </div>
</div>
<style>
.window {{ width: 1280px; color: var(--ink); font-size: 12.5px; }}
.window img {{ display: block; }}
.strip {{ display: flex; align-items: flex-end; gap: 6px; height: {TAB_STRIP_H}px; padding: 0 10px; background: var(--strip); }}
.tab {{ display: flex; align-items: center; gap: 8px; width: 210px; height: 29px; padding: 0 9px 0 11px; border-radius: 9px 9px 0 0; background: var(--tab); }}
.tab i {{ width: 14px; height: 14px; border-radius: 4.5px 4.5px 4.5px 1.5px; background: #1f7a5a; }}
.tab span {{ flex: 1; }}
.tab svg, .newtab {{ color: var(--muted); }}
.newtab {{ display: grid; place-items: center; width: 26px; height: 29px; }}
.bar {{ display: flex; align-items: center; gap: 4px; height: {TOOLBAR_H}px; padding: 0 10px; background: var(--bar); border-bottom: 1px solid var(--line); }}
.nav {{ display: grid; place-items: center; width: 28px; height: 28px; color: var(--muted); }}
.nav.dim {{ opacity: 0.4; }}
.field {{ flex: 1; height: 28px; margin: 0 6px; padding: 0 14px; border-radius: 99px; line-height: 28px; font-size: 13px; background: var(--field); }}
.ext {{ display: grid; place-items: center; width: 28px; height: 28px; border-radius: 99px; background: var(--hover); }}
.content {{ display: flex; height: {CONTENT_H}px; }}
.panel {{ width: {PANEL_W + 1}px; border-left: 1px solid var(--line); background: var(--bar); }}
.panel-head {{ display: flex; align-items: center; gap: 8px; height: {PANEL_HEADER_H}px; padding: 0 10px 0 12px; border-bottom: 1px solid var(--line); font-size: 13px; }}
.panel-head b {{ flex: 1; font-weight: 600; }}
.panel-head span {{ display: grid; place-items: center; width: 24px; height: 24px; color: var(--muted); }}
</style>"""


def screenshot_html(window, title, subtitle):
    return f"""<!doctype html><meta charset="utf-8"><style>{SHARED_CSS}
body {{ width: 1280px; height: 800px; overflow: hidden; background: #0c0d10; }}
.caption {{ display: flex; align-items: center; height: {CAPTION_H}px; padding: 0 30px; background: linear-gradient(#17191d, #0c0d10); }}
.caption h1 {{ margin: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; color: #fff; }}
.caption p {{ margin: 4px 0 0; font-size: 15.5px; color: #98a0ab; }}
.caption .brand {{ margin-left: auto; font-size: 19px; }}
</style>
<div class="caption"><div><h1>{title}</h1><p>{subtitle}</p></div><div class="brand">{MARK}Sidephone</div></div>
{window}"""


def small_tile_html():
    return f"""<!doctype html><meta charset="utf-8"><style>{SHARED_CSS}
body {{ width: 440px; height: 280px; display: grid; place-content: center; justify-items: center; text-align: center;
       background: radial-gradient(120% 90% at 50% 0%, #22252c 0%, #0c0d10 70%); }}
.mark svg {{ display: block; height: 84px; }}
h1 {{ margin: 22px 0 0; font-size: 38px; font-weight: 600; letter-spacing: -0.025em; color: #fff; }}
p {{ margin: 6px 0 0; font-size: 15.5px; color: #98a0ab; }}
</style>
<div class="mark">{MARK}</div><h1>Sidephone</h1><p>Mobile and desktop, side by side</p>"""


def marquee_html(window_png):
    return f"""<!doctype html><meta charset="utf-8"><style>{SHARED_CSS}
body {{ position: relative; width: 1400px; height: 560px; overflow: hidden;
       background: radial-gradient(90% 120% at 12% 0%, #23262d 0%, #0c0d10 62%); }}
.copy {{ position: absolute; left: 56px; top: 158px; width: 480px; }}
.brand {{ font-size: 25px; }}
h1 {{ margin: 30px 0 0; font-size: 50px; line-height: 1.05; white-space: nowrap; font-weight: 600; letter-spacing: -0.025em; color: #fff; }}
p {{ margin: 20px 0 0; max-width: 430px; font-size: 19px; line-height: 1.45; color: #98a0ab; }}
.shot {{ position: absolute; left: 566px; top: 63px; width: 780px; border-radius: 12px; overflow: hidden;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.1), 0 30px 80px rgba(0,0,0,0.6); }}
.shot img {{ display: block; width: 100%; }}
</style>
<div class="copy"><div class="brand">{MARK}Sidephone</div>
<h1>Mobile and desktop,<br>side by side</h1>
<p>Your page at phone size in Chrome's side panel, following your tab as you work.</p></div>
<div class="shot"><img src="{window_png.as_uri()}" alt=""></div>"""


def patched_extension(tmp):
    """A copy of src/ whose panel can be told which window to follow."""
    ext = pathlib.Path(tmp) / "extension"
    shutil.copytree(ROOT / "src", ext)
    panel = ext / "panel" / "panel.js"
    source = panel.read_text()
    original = "followWindowId = await findOwnWindowId();"
    assert source.count(original) == 1, "panel.js changed; update the patch in this script"
    panel.write_text(
        source.replace(original, 'followWindowId = Number(params.get("win")) || (await findOwnWindowId());')
    )
    return ext


async def until(page, expression, timeout=10.0):
    """Poll a JavaScript expression until it is true.

    Playwright's wait_for_function uses eval, which an extension page's
    Content-Security-Policy does not allow.
    """
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await page.evaluate(expression):
            return
        await asyncio.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for: {expression}")


def save_exact(png_bytes_path, size):
    """Captures are taken at 2x for sharp edges, then reduced to the size the store wants."""
    image = Image.open(png_bytes_path).convert("RGB")
    if image.size != size:
        image = image.resize(size, Image.LANCZOS)
    image.save(png_bytes_path, optimize=True)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="sidephone-assets-")
    ext = patched_extension(tmp)
    raw = pathlib.Path(tmp) / "raw"
    raw.mkdir()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(DEMO_PORT), "--bind", "127.0.0.1", "--directory", str(ROOT / "store" / "demo-site")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    await asyncio.sleep(0.6)

    try:
        async with async_playwright() as pw:
            ctx = await pw.chromium.launch_persistent_context(
                str(pathlib.Path(tmp) / "profile"),
                executable_path=os.environ.get("CHROME") or None,
                headless=False,
                args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--no-sandbox"],
                viewport={"width": PAGE_W, "height": CONTENT_H},
                device_scale_factor=2,
                color_scheme="light",
            )
            worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")

            # Opened first, so the demo page ends up as the window's active tab.
            composer = await ctx.new_page()
            site = await ctx.new_page()
            await site.goto(DEMO_URL)
            # macOS draws scrollbars over the page; match that on any platform.
            await site.add_style_tag(content="::-webkit-scrollbar { display: none; }")
            await site.bring_to_front()
            windows = await worker.evaluate("() => chrome.windows.getAll({windowTypes: ['normal']})")

            async with ctx.expect_page() as opened:
                await worker.evaluate(
                    "(id) => chrome.windows.create({url: chrome.runtime.getURL(`panel/panel.html?win=${id}`), type: 'popup', width: 500, height: 800})",
                    windows[0]["id"],
                )
            view = await opened.value
            await view.set_viewport_size({"width": PANEL_W, "height": VIEW_H})

            def mirror():
                return next((f for f in view.frames if f.url.startswith(DEMO_URL)), None)

            async def settle(ms=700):
                await until(view, "!document.body.classList.contains('loading')")
                await asyncio.sleep(ms / 1000)

            async def choose_device(device_id):
                await view.click("#device-btn")
                await view.click(f"#device-menu .item[data-value='{device_id}']")
                await settle()

            async def set_theme(scheme):
                for page in (site, view):
                    await page.emulate_media(color_scheme=scheme)
                await settle()

            windows_only = {}

            async def compose(index, title, subtitle, dark=False):
                page_png, view_png = raw / f"page-{index}.png", raw / f"view-{index}.png"
                await view.mouse.move(PANEL_W - 4, VIEW_H - 4)  # no stray hover states
                await site.screenshot(path=str(page_png))
                await view.screenshot(path=str(view_png))
                window = window_html(page_png, view_png, dark)

                html = raw / f"shot-{index}.html"
                html.write_text(screenshot_html(window, title, subtitle))
                await composer.set_viewport_size({"width": 1280, "height": 800})
                await composer.goto(html.as_uri())
                target = OUT / f"screenshot-{index}.png"
                await composer.screenshot(path=str(target))
                save_exact(target, (1280, 800))

                # The window alone, for the marquee tile.
                html.write_text(f"<!doctype html><meta charset='utf-8'><style>{SHARED_CSS}</style>{window}")
                await composer.set_viewport_size({"width": 1280, "height": 800 - CAPTION_H})
                await composer.goto(html.as_uri())
                windows_only[index] = raw / f"window-{index}.png"
                await composer.screenshot(path=str(windows_only[index]))

            await until(view, "document.querySelector('#frame').src !== ''")
            await settle(1200)

            # 1. The product in one picture.
            await choose_device("iphone-16")
            await compose(1, "See mobile and desktop side by side", "Your page at phone size in the side panel, following your tab as you work.")

            # 2. The device list.
            await view.click("#device-btn")
            await view.evaluate("document.querySelector('#device-menu').scrollTop = 0")
            await asyncio.sleep(0.4)
            await compose(2, "The device list from Chrome DevTools", "iPhone, Pixel, Galaxy, foldables, iPad and more.")
            await view.keyboard.press("Escape")

            # 3. The keyboard.
            await view.bring_to_front()
            await click_in_mirror(view, mirror(), "#note")
            await until(view, "document.querySelector('#keyboard').classList.contains('open')")
            await asyncio.sleep(1.0)
            await compose(3, "See what the keyboard covers", "Focus a field and the phone's keyboard slides up over your page.")
            await mirror().evaluate("document.activeElement.blur()")
            await until(view, "!document.querySelector('#keyboard').classList.contains('open')")

            # 4. A tablet, in dark mode.
            await set_theme("dark")
            await choose_device("ipad-mini")
            await compose(4, "Tablets and foldables too", "Check every breakpoint, in light or dark.", dark=True)

            # 5. View options.
            await set_theme("light")
            await choose_device("pixel-9")
            await view.click("#settings-btn")
            await asyncio.sleep(0.4)
            await compose(5, "Set it up your way", "Device frame, browser bars, keyboard, scroll sync and real-size mode.")

            # Promo tiles.
            for name, html, size in (
                ("promo-small-440x280.png", small_tile_html(), (440, 280)),
                ("promo-marquee-1400x560.png", marquee_html(windows_only[1]), (1400, 560)),
            ):
                source = raw / f"{name}.html"
                source.write_text(html)
                await composer.set_viewport_size({"width": size[0], "height": size[1]})
                await composer.goto(source.as_uri())
                await composer.screenshot(path=str(OUT / name))
                save_exact(OUT / name, size)

            await ctx.close()
    finally:
        server.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    for path in sorted(OUT.glob("*.png")):
        print(path.relative_to(ROOT), Image.open(path).size)


asyncio.run(main())
