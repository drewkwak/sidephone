"""Tiny test site. Every page forbids framing and sets a Lax cookie, so the
extension has to strip headers and send cookies for the mirror to work.

    /            a plain page with a few breakpoints
    /b           the same page on a dark background
    /themed      the same page with a theme colour
    /issues      a page with one of each layout problem, and two errors
    /spa/...     a single-page app with its own router
"""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROWS = "".join(f"<p>Row {i} of page content.</p>" for i in range(60))


def page(title, bg, fg, cookie, extra_head=""):
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>{extra_head}
<style>
  body {{ margin: 0; font: 16px system-ui; background: {bg}; color: {fg}; }}
  header {{ position: sticky; top: 0; padding: 14px; background: #2563eb; color: #fff; }}
  main {{ padding: 0 16px; }}
  .desktop {{ display: none; }}
  @media (min-width: 700px) {{ .desktop {{ display: block; }} .mobile {{ display: none; }} }}
  @media (max-width: 479.98px) {{ .narrow {{ letter-spacing: 0; }} }}
  @media (640px <= width < 1024px) {{ .mid {{ letter-spacing: 0; }} }}
  input {{ display: block; margin: 12px 0; padding: 10px; font-size: 16px; width: 80%; }}
</style></head>
<body>
<header id="hdr">{title}</header>
<main>
  <p id="cookie-seen">cookie-sent={cookie}</p>
  <p class="mobile" id="layout">layout=mobile</p>
  <p class="desktop" id="layout-d">layout=desktop</p>
  <p><a id="to-b" href="/b">Go to page B</a> <a id="to-a" href="/">Go to page A</a></p>
  <input id="name" type="text" placeholder="Name">
  <input id="phone" type="tel" placeholder="Phone">
  {ROWS}
  <p id="far-down">Far down the page</p>
  <input id="bottom" type="text" placeholder="Bottom field">
</main>
<script>
  document.getElementById("hdr").dataset.w = String(window.innerWidth);
  document.getElementById("hdr").dataset.webview = String(navigator.userAgent.includes("; wv)"));
  window.__spa = (path) => {{ history.pushState({{}}, "", path); }};
</script>
</body></html>"""


ISSUES = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issues</title>
<style>
  body { margin: 0; font: 16px system-ui; }
  main { padding: 16px; }
  .wide { width: 520px; height: 40px; background: #fca5a5; }
  .tiny-button { width: 30px; height: 30px; }
  .small-field { font-size: 14px; padding: 12px; width: 60%; }
  .fine-print { font-size: 10px; }
  .big-button { display: block; width: 200px; height: 48px; margin: 12px 0; }
  .carousel { overflow-x: auto; white-space: nowrap; }
  .carousel div { display: inline-block; width: 300px; height: 40px; background: #bfdbfe; }
</style></head>
<body><main>
  <p>A <a href="/">link inside a sentence</a> is fine.</p>
  <div class="wide" id="wide">Fixed width box</div>
  <button class="tiny-button" id="tiny">x</button>
  <input class="small-field" id="small-field" type="text" placeholder="Small text field">
  <p class="fine-print" id="fine">Fine print</p>
  <button class="big-button">Big enough</button>
  <div class="carousel"><div>One</div><div>Two</div></div>
</main>
<script>
  // Thrown only at phone width: the kind of error the checks should single out.
  if (innerWidth < 600) setTimeout(() => { throw new Error("mobile only failure"); }, 30);
  setTimeout(() => { throw new Error("everywhere failure"); }, 30);
</script>
</body></html>"""


# A single-page app: links change the route with pushState, and the router
# renders on popstate. __loadId shows whether the page was reloaded.
SPA = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SPA</title>
<style>body { margin: 0; font: 16px system-ui; } nav a { margin-right: 12px; }</style></head>
<body>
<nav><a href="/spa/one" data-route>One</a><a href="/spa/two" data-route>Two</a></nav>
<h1 id="route"></h1>
<script>
  window.__loadId = Math.random().toString(36).slice(2);
  const render = () => { document.getElementById("route").textContent = "route:" + location.pathname; };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (!link) return;
    event.preventDefault();
    history.pushState(null, "", link.getAttribute("href"));
    render();
  });
  window.addEventListener("popstate", render);
  render();
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        cookie = "yes" if "sid=abc" in (self.headers.get("Cookie") or "") else "no"
        path = self.path.split("?")[0]
        if path == "/b":
            body = page("Page B", "rgb(18, 22, 34)", "#eee", cookie)
        elif path == "/themed":
            body = page("Themed", "#fff", "#111", cookie, '<meta name="theme-color" content="#0b57d0">')
        elif path == "/issues":
            body = ISSUES
        elif path == "/spa" or path.startswith("/spa/"):
            body = SPA
        elif path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        else:
            body = page("Page A", "#fff", "#111", cookie)
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("Set-Cookie", "sid=abc; Path=/; SameSite=Lax; HttpOnly")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
