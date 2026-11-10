"""Tiny test site. Every page forbids framing and sets a Lax cookie, so the
extension has to strip headers and send cookies for the mirror to work."""
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
  <input id="bottom" type="text" placeholder="Bottom field">
</main>
<script>
  document.getElementById("hdr").dataset.w = String(window.innerWidth);
  window.__spa = (path) => {{ history.pushState({{}}, "", path); }};
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
        elif path == "/favicon.ico":
            self.send_response(204); self.end_headers(); return
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
