/**
 * Link cards for messages: an Instagram post or reel linked in a message shows
 * in the app as a card with its image, caption and account, the way a
 * moodboard item does (pagemedia.ts parsePreview).
 *
 * Instagram's image links expire within days, so the image is kept on disk:
 * ~/.interns/link-previews/<key>.{json,jpg|png|webp|gif}, key = sha256(url).
 * A failed fetch is remembered for a day so a busy thread doesn't hammer it.
 * Image URLs are signed like attachments (signAttachment over "link-preview:<key>").
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { signAttachment } from "./attachments.js";
import { defaultFetch, imageExt, parsePreview, PREVIEW_TIMEOUT_MS, PREVIEW_USER_AGENT, type PreviewFetch } from "./pagemedia.js";

const RETRY_FAILED_MS = 86_400_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const KEY = /^[0-9a-f]{24}$/;
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export interface LinkPreview {
  url: string;
  title: string | null;
  source: string | null;
  /** signed, app-relative; null when the page had no usable image */
  image_url: string | null;
}

interface Stored {
  url: string;
  title: string | null;
  source: string | null;
  image: string | null;
  failed?: boolean;
  fetched_at: string;
}

/** Instagram posts, reels and IGTV — the links the app previews. */
export function previewable(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)instagram\.com$/.test(u.hostname) && /^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

export const signLinkPreview = (token: string, key: string) => signAttachment(token, `link-preview:${key}`);

export class LinkPreviews {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<LinkPreview | null>>();

  constructor(
    home: string,
    private readonly token: () => string,
    private readonly fetchFn: PreviewFetch = defaultFetch,
  ) {
    this.dir = path.join(home, "link-previews");
  }

  static keyFor(url: string): string {
    return createHash("sha256").update(url).digest("hex").slice(0, 24);
  }

  /** The card for `url`, fetched once and kept; null when it isn't previewable or has nothing to show. */
  get(url: string): Promise<LinkPreview | null> {
    if (!previewable(url)) return Promise.resolve(null);
    const key = LinkPreviews.keyFor(url);
    const stored = this.read(key);
    if (stored && !(stored.failed && Date.now() - Date.parse(stored.fetched_at) > RETRY_FAILED_MS)) return Promise.resolve(this.view(key, stored));
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(url, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** The kept image for a key, or null. */
  image(key: string): { file: string; type: string } | null {
    if (!KEY.test(key)) return null;
    const stored = this.read(key);
    if (!stored?.image) return null;
    const file = path.join(this.dir, stored.image);
    return fs.existsSync(file) ? { file, type: TYPES[stored.image.split(".").pop()!] ?? "application/octet-stream" } : null;
  }

  private read(key: string): Stored | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${key}.json`), "utf8")) as Stored;
    } catch {
      return null;
    }
  }

  private view(key: string, stored: Stored): LinkPreview | null {
    if (stored.failed || (!stored.title && !stored.image)) return null;
    return {
      url: stored.url,
      title: stored.title,
      source: stored.source,
      image_url: stored.image ? `/link-previews/${key}?sig=${signLinkPreview(this.token(), key)}` : null,
    };
  }

  private async get1(url: string) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT_MS);
    try {
      return await this.fetchFn(url, { headers: { "User-Agent": PREVIEW_USER_AGENT, Accept: "text/html,image/*" }, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch(url: string, key: string): Promise<LinkPreview | null> {
    const stored: Stored = { url, title: null, source: null, image: null, fetched_at: new Date().toISOString() };
    try {
      const res = await this.get1(url);
      if (!res.ok) throw new Error("page");
      const preview = parsePreview((await res.text()).slice(0, 2_000_000), url);
      stored.title = preview.title;
      stored.source = preview.source;
      if (preview.image) {
        const img = await this.get1(preview.image);
        const bytes = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
        const ext = bytes && bytes.length <= MAX_IMAGE_BYTES ? imageExt(bytes) : null;
        if (bytes && ext) {
          fs.mkdirSync(this.dir, { recursive: true });
          fs.writeFileSync(path.join(this.dir, `${key}.${ext}`), bytes);
          stored.image = `${key}.${ext}`;
        }
      }
      if (!stored.title && !stored.image) stored.failed = true;
    } catch {
      stored.failed = true;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(stored));
    return this.view(key, stored);
  }
}
