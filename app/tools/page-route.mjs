/**
 * Which exported HTML page renders a URL — a copy of the orchestrator's
 * src/appshell.ts for the dev servers here (mock-orchestrator, serve-dist),
 * so deep links hydrate over their own route's page exactly as in
 * production. Serving another route's HTML fails hydration with React #418.
 *
 * Static names beat dynamic ones, "(group)" dirs are transparent, [param]
 * takes one segment and [...rest] the remainder. Only names from the
 * directory listing are joined into the path, so URLs can't escape `root`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const isGroup = (name) => /^\(.+\)$/.test(name);
const isCatchAll = (name) => /^\[\.\.\..+\]$/.test(name);
const isParam = (name) => /^\[[^.].*\]$/.test(name);

function list(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function match(root, rel, segments) {
  const entries = list(join(root, rel));
  const file = (name) => entries.some((e) => e.isFile() && e.name === name);
  const page = (route) => entries.find((e) => e.isFile() && e.name.endsWith(".html") && route(e.name.slice(0, -".html".length)))?.name;
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const [segment, ...rest] = segments;

  if (segment === undefined) {
    if (file("index.html")) return join(rel, "index.html");
  } else {
    if (!rest.length && file(`${segment}.html`)) return join(rel, `${segment}.html`);
    if (dirs.includes(segment)) {
      const found = match(root, join(rel, segment), rest);
      if (found) return found;
    }
  }
  for (const group of dirs.filter(isGroup)) {
    const found = match(root, join(rel, group), segments);
    if (found) return found;
  }
  if (segment === undefined) return null;
  const param = page(isParam);
  if (!rest.length && param) return join(rel, param);
  for (const dir of dirs.filter(isParam)) {
    const found = match(root, join(rel, dir), rest);
    if (found) return found;
  }
  const catchAll = page(isCatchAll);
  return catchAll ? join(rel, catchAll) : null;
}

/** The page for `url` relative to `root`, or null if no route matches. */
export function resolvePage(root, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, "http://shell").pathname);
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || s.startsWith("+"))) return null;
  return match(root, "", segments);
}

/** Where to send a URL no route matches: Expo's own not-found page, else the root shell. */
export function notFoundPage(root) {
  return list(root).some((e) => e.isFile() && e.name === "+not-found.html") ? "+not-found.html" : "index.html";
}

/** A browser loading the URL itself (address bar, reload, notification tap), not a fetch. */
export function isNavigation(req) {
  return req.method === "GET" && (req.headers["sec-fetch-mode"] === "navigate" || /\btext\/html\b/.test(req.headers.accept ?? ""));
}
