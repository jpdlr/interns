#!/usr/bin/env node
/**
 * Stamps the build id into dist/sw.js after an export.
 *
 * The stamp is the point: a service worker is only re-installed when its bytes
 * change, so without this a re-exported dist/ would keep serving the old shell
 * from the old worker. Run automatically by `npm run export:web`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const swPath = join(root, "dist", "sw.js");

if (!existsSync(swPath)) {
  console.error("stamp-sw: dist/sw.js not found — did the export run?");
  process.exit(1);
}

const build = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const source = readFileSync(swPath, "utf8");
if (!source.includes("__BUILD__")) {
  console.log(`stamp-sw: already stamped, leaving as is`);
  process.exit(0);
}
writeFileSync(swPath, source.replace("__BUILD__", build), "utf8");
writeFileSync(join(root, "dist", "build.json"), JSON.stringify({ build }, null, 2) + "\n", "utf8");
console.log(`stamp-sw: dist/sw.js stamped ${build}`);
