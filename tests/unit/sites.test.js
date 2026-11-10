import assert from "node:assert/strict";
import { test } from "node:test";

import { siteOf } from "../../src/panel/sites.js";

test("a web URL becomes a host and a permission pattern", () => {
  assert.deepEqual(siteOf("http://localhost:3000/dashboard?x=1#top"), {
    host: "localhost:3000",
    pattern: "*://localhost/*",
  });
  assert.deepEqual(siteOf("https://example.com/"), {
    host: "example.com",
    pattern: "*://example.com/*",
  });
});

test("anything that is not a web page is rejected", () => {
  for (const url of [
    undefined,
    "",
    "chrome://extensions",
    "about:blank",
    "file:///tmp/a.html",
    "not a url",
  ]) {
    assert.equal(siteOf(url), null, String(url));
  }
});
