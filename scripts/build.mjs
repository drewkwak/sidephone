// Builds the folder that gets uploaded to the Chrome Web Store.
//
//   node scripts/build.mjs
//
// Output:
//   dist/extension/      the extension, ready to load or zip
//   dist/<short name>-<version>.zip
//
// The source in src/ loads in Chrome as it is, with no build step. This build
// only makes it smaller: the panel's modules are bundled into one file, and
// scripts and styles are minified. Nothing is obfuscated, and no code is
// added that is not in src/.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const out = path.join(root, "dist", "extension");

await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(out, "panel"), { recursive: true });

const shared = { minify: true, legalComments: "none", target: "chrome116", logLevel: "warning" };

// The panel: ES modules bundled into a single module.
await build({
  ...shared,
  entryPoints: [path.join(src, "panel", "panel.js")],
  outfile: path.join(out, "panel", "panel.js"),
  bundle: true,
  format: "esm",
});

// The content script and service worker are single classic scripts.
await build({
  ...shared,
  entryPoints: [path.join(src, "content.js"), path.join(src, "background.js")],
  outdir: out,
});

await build({
  ...shared,
  entryPoints: [path.join(src, "panel", "panel.css")],
  outfile: path.join(out, "panel", "panel.css"),
});

await cp(path.join(src, "panel", "panel.html"), path.join(out, "panel", "panel.html"));
await cp(path.join(src, "icons"), path.join(out, "icons"), { recursive: true });

const manifest = JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const slug = (manifest.short_name ?? manifest.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const zipPath = path.join(root, "dist", `${slug}-${manifest.version}.zip`);
execFileSync("zip", ["-qr", zipPath, "."], { cwd: out });
console.log(`Built ${path.relative(root, out)} and ${path.relative(root, zipPath)}`);
