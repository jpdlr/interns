/**
 * Images on moodboard pages (docs/features/02-pages.md).
 *
 * A moodboard item can carry a link, an image, or both. Images live with the
 * page, not as chat attachments (those belong to a message):
 *
 *   $INTERNS_HOME/page-media/<page_id>/<name>
 *
 * and an item refers to one as "media:<name>". The app gets a signed URL per
 * image (same HMAC as attachments, keyed by page and name), because <img src>
 * can't send the bearer token.
 *
 * Three ways in:
 *  - the owner pastes or picks an image in the app (POST /pages/:id/media);
 *  - an intern adds an item with "image_path" pointing at a file under
 *    $INTERNS_HOME (a shared photo, a downloaded post), which is copied in;
 *  - an item with a link and no image gets the link's preview image
 *    (og:image) fetched and kept, with its title and source if the item has
 *    none. Instagram's CDN links expire, so keeping a copy is the point.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { signAttachment } from "./attachments.js";
import type { Db } from "./db.js";
import type { Page } from "./types.js";

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 12_000;
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export const mediaDir = (home: string, pageId: string) => path.join(home, "page-media", pageId.replace(/[^A-Za-z0-9_-]/g, "_"));
const NAME = /^[A-Za-z0-9_-]{8,80}\.(jpg|png|webp|gif)$/;

/** jpg/png/webp/gif by their first bytes, or null. */
export function imageExt(bytes: Buffer): "jpg" | "png" | "webp" | "gif" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (bytes.length > 6 && bytes.subarray(0, 4).toString() === "GIF8") return "gif";
  return null;
}

export function saveMedia(home: string, pageId: string, bytes: Buffer): string {
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaError(413, `images are limited to ${MAX_MEDIA_BYTES / 1024 / 1024} MB`);
  const ext = imageExt(bytes);
  if (!ext) throw new MediaError(415, "that isn't a JPEG, PNG, WebP or GIF image");
  const dir = mediaDir(home, pageId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), bytes);
  return name;
}

export function readMedia(home: string, pageId: string, name: string): { bytes: Buffer; type: string } | null {
  if (!NAME.test(name)) return null;
  try {
    const bytes = fs.readFileSync(path.join(mediaDir(home, pageId), name));
    return { bytes, type: IMAGE_TYPES[name.split(".").pop()!] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

const sigKey = (pageId: string, name: string) => `page-media:${pageId}/${name}`;
export const signMedia = (token: string, pageId: string, name: string) => signAttachment(token, sigKey(pageId, name));

export function mediaUrl(token: string, pageId: string, name: string): string {
  return `/pages/${encodeURIComponent(pageId)}/media/${encodeURIComponent(name)}?sig=${signMedia(token, pageId, name)}`;
}

export class MediaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The page as the app sees it: each moodboard image gets `image_url`. */
export function withMediaUrls(page: Page, token: string): Page {
  if (page.kind !== "moodboard") return page;
  const items = (page.data.items as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...page,
    data: {
      ...page.data,
      items: items.map((item) => {
        const image = typeof item.image === "string" ? item.image : "";
        if (image.startsWith("media:")) return { ...item, image_url: mediaUrl(token, page.id, image.slice(6)) };
        if (/^https:\/\//.test(image)) return { ...item, image_url: image };
        return item;
      }),
    },
  };
}

/**
 * An intern's `image_path`: copy a local image (anywhere under the interns
 * home, e.g. a shared photo) into the page. Anything else is refused.
 */
export function ingestImagePath(home: string, pageId: string, item: Record<string, unknown>): Record<string, unknown> {
  if (typeof item.image_path !== "string") return item;
  const { image_path, ...rest } = item;
  const real = (() => {
    try {
      return fs.realpathSync(String(image_path));
    } catch {
      throw new MediaError(400, `image_path not found: ${String(image_path)}`);
    }
  })();
  const root = fs.realpathSync(home);
  if (!real.startsWith(root + path.sep)) throw new MediaError(400, "image_path must be a file under the interns home (a shared photo, an attachment, a downloaded image)");
  return { ...rest, image: `media:${saveMedia(home, pageId, fs.readFileSync(real))}` };
}

// --------------------------------------------------------------- previews

export type PreviewFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decode(content).trim() : null;
}

/** A link's preview: image URL, a title and who it's from. */
export function parsePreview(html: string, url: string): { image: string | null; title: string | null; source: string | null } {
  const image = meta(html, "og:image") ?? meta(html, "twitter:image");
  const ogTitle = meta(html, "og:title");
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  // Instagram: 'Name | Bio on Instagram: "caption…"'
  const ig = ogTitle ? /^(.*?) on Instagram: ["“]([\s\S]*)["”]?$/.exec(ogTitle) : null;
  if (ig) {
    const caption = ig[2]!.replace(/["”]$/, "").split("\n")[0]!.trim();
    return { image, title: caption ? caption.slice(0, 90) : null, source: ig[1]!.split("|")[0]!.trim() || "Instagram" };
  }
  return { image, title: ogTitle ? ogTitle.slice(0, 90) : null, source: meta(html, "og:site_name") ?? host };
}

const defaultFetch: PreviewFetch = (url, init) => fetch(url, { ...init, redirect: "follow" });

/**
 * Fill in previews for linked items without an image. Each item is tried
 * once ("preview": "none" marks a failure). Never throws; returns the page
 * if it changed.
 */
export async function fillPreviews(db: Db, home: string, pageId: string, fetchFn: PreviewFetch = defaultFetch): Promise<Page | null> {
  const page = db.getPage(pageId);
  if (!page || page.kind !== "moodboard") return null;
  const items = (page.data.items as Record<string, unknown>[] | undefined) ?? [];
  const todo = items.filter((i) => typeof i.url === "string" && !i.image && i.preview !== "none");
  if (!todo.length) return null;
  const found = new Map<string, Record<string, unknown>>();
  for (const item of todo) {
    const url = String(item.url);
    const set: Record<string, unknown> = {};
    try {
      const get = async (u: string) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT_MS);
        try {
          return await fetchFn(u, { headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", Accept: "text/html,image/*" }, signal: ctl.signal });
        } finally {
          clearTimeout(timer);
        }
      };
      const res = await get(url);
      if (!res.ok) throw new Error("page");
      const preview = parsePreview((await res.text()).slice(0, 2_000_000), url);
      if (!item.title && preview.title) set.title = preview.title;
      if (!item.source && preview.source) set.source = preview.source;
      if (preview.image) {
        const img = await get(preview.image);
        const bytes = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
        if (bytes && imageExt(bytes)) set.image = `media:${saveMedia(home, pageId, bytes)}`;
      }
      if (!set.image) set.preview = "none";
    } catch {
      set.preview = "none";
    }
    found.set(String(item.id), set);
  }
  // Re-read: the owner or the intern may have changed the page meanwhile.
  const latest = db.getPage(pageId);
  if (!latest) return null;
  const next = ((latest.data.items as Record<string, unknown>[] | undefined) ?? []).map((i) => {
    const set = found.get(String(i.id));
    if (!set || i.image) return i;
    return { ...set, ...i, image: set.image ?? i.image, preview: set.preview ?? i.preview, title: i.title ?? set.title, source: i.source ?? set.source };
  });
  return db.updatePage(pageId, { data: { ...latest.data, items: next } }) ?? null;
}
