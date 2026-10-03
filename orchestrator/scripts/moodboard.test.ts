/**
 * Moodboards (pagemedia.ts) and the table aliases (types.ts), offline:
 * images stored with the page, signed URLs, link previews from a fake web.
 *
 *   npm run test:moodboard
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-moodboard-"));
process.env.INTERNS_HOME = home;

const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { validatePageData, addItem } = await import("../src/pages.js");
const { fillPreviews, ingestImagePath, saveMedia, withMediaUrls, parsePreview, readMedia, signMedia, MediaError } = await import("../src/pagemedia.js");
import type { PreviewFetch } from "../src/pagemedia.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.stack?.split("\n").slice(0, 6).join("\n      ") : err}`);
  }
}

const db = new Db(new EventBus(), home);
db.upsertIntern({ slug: "milo", name: "Milo", role: "Social", icon: "face-01" });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

try {
  await check("tables take items and labels too: rows no longer vanish", () => {
    const data = validatePageData("table", {
      columns: [{ key: "ref", label: "Reference" }, { key: "link", title: "Link" }],
      items: [{ id: "p1", ref: "Underwater reel", link: "https://www.instagram.com/reel/abc/" }],
    }) as { columns: { title: string }[]; rows: unknown[] };
    assert.equal(data.rows.length, 1);
    assert.equal(data.columns[0]!.title, "Reference");
  });

  await check("a moodboard item needs something to show; images are media: or https", () => {
    assert.throws(() => validatePageData("moodboard", { items: [{ id: "a" }] }), /needs a title, link, image or note/);
    assert.throws(() => validatePageData("moodboard", { items: [{ id: "a", image: "/etc/passwd" }] }), /media:<name> or an https URL/);
    assert.throws(() => validatePageData("moodboard", { items: [{ id: "a", url: "javascript:alert(1)" }] }), /http/);
    const ok = validatePageData("moodboard", { items: [{ id: "a", url: "https://example.com/x", tags: ["dive"] }] });
    assert.equal((ok.items as unknown[]).length, 1);
  });

  await check("images are stored with the page; only real images", () => {
    assert.throws(() => saveMedia(home, "pg_x", Buffer.from("<svg/>")), (e: unknown) => e instanceof MediaError && e.status === 415);
    const name = saveMedia(home, "pg_x", JPEG);
    assert.match(name, /^[0-9a-f-]+\.jpg$/);
    assert.deepEqual(readMedia(home, "pg_x", name)!.bytes, JPEG);
    assert.equal(readMedia(home, "pg_x", "../../config.json"), null, "no path tricks");
  });

  await check("image_path copies a local image under the interns home, nothing else", () => {
    const photo = path.join(home, "photos", "img", "a1.jpg");
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, JPEG);
    const item = ingestImagePath(home, "pg_x", { id: "i1", title: "Alpinist", image_path: photo });
    assert.match(String(item.image), /^media:.+\.jpg$/);
    assert.equal("image_path" in item, false);
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.jpg`);
    fs.writeFileSync(outside, JPEG);
    assert.throws(() => ingestImagePath(home, "pg_x", { id: "i2", image_path: outside }), /under the interns home/);
    fs.rmSync(outside);
  });

  await check("Instagram's preview: the caption's first line as title, the account as source", () => {
    const html = `<meta property="og:image" content="https://cdn.example/p.jpg?a=1&amp;b=2" /><meta property="og:title" content="Caitlin Grace | Underwater Photographer &#x1f30a; on Instagram: &quot;oceanholic\nmore&quot;" />`;
    assert.deepEqual(parsePreview(html, "https://www.instagram.com/reel/abc/"), { image: "https://cdn.example/p.jpg?a=1&b=2", title: "oceanholic", source: "Caitlin Grace" });
    assert.deepEqual(parsePreview(`<meta name="og:title" content="A post">`, "https://www.example.com/x"), { image: null, title: "A post", source: "example.com" });
  });

  await check("links get their preview image kept on the board; failures are tried once", async () => {
    const page = db.createPage({
      intern: "milo",
      thread_key: "milo",
      kind: "moodboard",
      title: "References",
      summary: "",
      data: validatePageData("moodboard", {
        items: [
          { id: "r1", url: "https://www.instagram.com/reel/abc/" },
          { id: "r2", url: "https://broken.example/x", title: "Kept title" },
          { id: "r3", title: "Just a note", note: "no link" },
        ],
      }),
    });
    const fetched: string[] = [];
    const fake: PreviewFetch = async (url) => {
      fetched.push(url);
      const html = `<meta property="og:image" content="https://cdn.example/r1.jpg"><meta property="og:title" content="Ocean Diver on Instagram: &quot;blue hour&quot;">`;
      if (url === "https://www.instagram.com/reel/abc/") return { ok: true, headers: { get: () => "text/html" }, text: async () => html, arrayBuffer: async () => new ArrayBuffer(0) };
      if (url === "https://cdn.example/r1.jpg") return { ok: true, headers: { get: () => "image/jpeg" }, text: async () => "", arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength) };
      return { ok: false, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const updated = await fillPreviews(db, home, page.id, fake);
    const items = updated!.data.items as Record<string, unknown>[];
    assert.match(String(items[0]!.image), /^media:/);
    assert.equal(items[0]!.title, "blue hour");
    assert.equal(items[0]!.source, "Ocean Diver");
    assert.equal(items[1]!.preview, "none");
    assert.equal(items[1]!.title, "Kept title", "an item's own title wins");
    assert.equal(items[2]!.image, undefined);
    const before = fetched.length;
    assert.equal(await fillPreviews(db, home, page.id, fake), null, "nothing left to try");
    assert.equal(fetched.length, before);

    const viewed = withMediaUrls(db.getPage(page.id)!, "token");
    const url = String((viewed.data.items as Record<string, unknown>[])[0]!.image_url);
    const name = String(items[0]!.image).slice(6);
    assert.equal(url, `/pages/${page.id}/media/${name}?sig=${signMedia("token", page.id, name)}`);
    assert.notEqual(signMedia("token", page.id, name), signMedia("token", "pg_other", name), "a signature is for one page");
  });

  await check("adding an item keeps working through the normal page functions", () => {
    const page = db.listPages("milo")[0]!;
    const next = addItem(db, page, { id: "r4", title: "Pasted", image: "media:0123456789abcdef.jpg", by: "owner" });
    assert.equal((next.data.items as unknown[]).length, 4);
  });
} finally {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall moodboard checks passed" : `\n${failures} moodboard check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
