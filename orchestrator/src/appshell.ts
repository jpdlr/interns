/**
 * Which exported HTML page renders a URL. `expo export` (web.output "static")
 * writes one pre-rendered page per route — spend.html, chat/[slug].html,
 * (tabs)/index.html, … — and React hydrates over it. Hydrating a page with
 * another route's HTML (the old blanket index.html fallback) fails with React
 * #418 and re-renders the whole tree, so deep links must get their own page.
 *
 * Mirrors Expo Router matching: static names beat dynamic ones, "(group)"
 * directories are transparent, [param] takes one segment and [...rest] the
 * remainder. Only names read from the directory listing are ever joined into
 * the path, so a crafted URL can't escape the dist root.
 */
import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";

const isGroup = (name: string) => /^\(.+\)$/.test(name);
const isCatchAll = (name: string) => /^\[\.\.\..+\]$/.test(name);
const isParam = (name: string) => /^\[[^.].*\]$/.test(name);

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function match(root: string, rel: string, segments: string[]): string | null {
  const entries = list(path.join(root, rel));
  const file = (name: string) => entries.some((e) => e.isFile() && e.name === name);
  const page = (route: (name: string) => boolean) =>
    entries.find((e) => e.isFile() && e.name.endsWith(".html") && route(e.name.slice(0, -".html".length)))?.name;
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const [segment, ...rest] = segments;

  if (segment === undefined) {
    if (file("index.html")) return path.join(rel, "index.html");
  } else {
    if (!rest.length && file(`${segment}.html`)) return path.join(rel, `${segment}.html`);
    if (dirs.includes(segment)) {
      const found = match(root, path.join(rel, segment), rest);
      if (found) return found;
    }
  }
  for (const group of dirs.filter(isGroup)) {
    const found = match(root, path.join(rel, group), segments);
    if (found) return found;
  }
  if (segment === undefined) return null;
  const param = page(isParam);
  if (!rest.length && param) return path.join(rel, param);
  for (const dir of dirs.filter(isParam)) {
    const found = match(root, path.join(rel, dir), rest);
    if (found) return found;
  }
  const catchAll = page(isCatchAll);
  return catchAll ? path.join(rel, catchAll) : null;
}

/** The page for `url` relative to `root`, or null if no route matches. */
export function resolvePage(root: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, "http://shell").pathname);
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  // "+not-found", "_sitemap" and friends are Expo internals, not routes to match by name.
  if (segments.some((s) => s === "." || s === ".." || s.startsWith("+"))) return null;
  return match(root, "", segments);
}

/** Where to send a URL no route matches: Expo's own not-found page, else the root shell. */
export function notFoundPage(root: string): string {
  return list(root).some((e) => e.isFile() && e.name === "+not-found.html") ? "+not-found.html" : "index.html";
}
