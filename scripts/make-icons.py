"""Render scripts/icon.svg and icon-small.svg to the PNG sizes the manifest and the store need.

Usage: python3 scripts/make-icons.py
Needs Playwright and a Chrome it can drive (set CHROME to its path if it is
not found automatically).

The 16 and 32 pixel icons fill the square. The 48 and 128 pixel icons keep the
transparent margin the Chrome Web Store asks for (96 of 128 pixels are artwork).
"""
import asyncio
import os
import pathlib

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = (ROOT / "scripts" / "icon.svg").read_text()
SVG_SMALL = (ROOT / "scripts" / "icon-small.svg").read_text()  # bolder shapes for small sizes
OUT = ROOT / "src" / "icons"
SIZES = {16: 0, 32: 0, 48: 6, 128: 16}  # size -> transparent margin


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("CHROME") or None)
        for size, margin in SIZES.items():
            page = await browser.new_page(viewport={"width": size, "height": size})
            inner = size - 2 * margin
            await page.set_content(
                f"<style>html,body{{margin:0;background:transparent}}"
                f"svg{{display:block;margin:{margin}px;width:{inner}px;height:{inner}px}}</style>"
                f"{SVG_SMALL if size <= 32 else SVG}"
            )
            await page.screenshot(path=str(OUT / f"icon-{size}.png"), omit_background=True)
            await page.close()
        await browser.close()


asyncio.run(main())
