/**
 * Google Drive photo sync (src/drivesync.ts) with the real tools/photo-import
 * against a fake Drive: a Takeout zip (dated photos, an old one, a
 * screenshot, an iPhone HEIC) and a photo dropped in the Interns folder.
 *
 *   npm run test:drivesync
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-drivesync-"));
process.env.INTERNS_HOME = home;

const { Registry } = await import("../src/registry.js");
const { GooglePhotos, readLibrary, DRIVE_SCOPES, PICKER_SCOPE } = await import("../src/photos.js");
const { DriveSync, driveTakenTime } = await import("../src/drivesync.js");

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

// ---- fixtures: a Takeout zip and a loose photo, made with Pillow
const fixtures = path.join(home, "fixtures");
fs.mkdirSync(fixtures);
const made = execFileSync("python3", [
  "-c",
  `
import io, json, os, sys, zipfile
from PIL import Image
out = sys.argv[1]
def jpg(color, exif_date=None):
    im = Image.new("RGB", (1200, 900), color)
    b = io.BytesIO()
    kw = {}
    if exif_date:
        ex = Image.Exif(); ex[0x0132] = exif_date; ex[0x010f] = "Apple"; ex[0x0110] = "iPhone 15 Pro"; kw["exif"] = ex.tobytes()
    im.save(b, "JPEG", **kw); return b.getvalue()
def png(color):
    b = io.BytesIO(); Image.new("RGB", (1179, 2556), color).save(b, "PNG"); return b.getvalue()
heic = None
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    b = io.BytesIO(); Image.new("RGB", (800, 600), (10, 120, 200)).save(b, "HEIF"); heic = b.getvalue()
except Exception:
    pass
with zipfile.ZipFile(os.path.join(out, "takeout.zip"), "w") as z:
    z.writestr("Takeout/Google Photos/Photos from 2024/IMG_1001.JPG", jpg((200, 80, 40)))
    z.writestr("Takeout/Google Photos/Photos from 2024/IMG_1001.JPG.supplemental-metadata.json", json.dumps({"photoTakenTime": {"timestamp": "1717236000"}}))
    z.writestr("Takeout/Google Photos/Photos from 2021/IMG_0500.JPG", jpg((40, 160, 90), "2021:03:04 10:00:00"))
    z.writestr("Takeout/Google Photos/Photos from 2024/IMG_1002.PNG", png((250, 250, 250)))
    z.writestr("Takeout/Google Photos/Photos from 2024/IMG_1003.MOV", b"not a real video")
    z.writestr("Takeout/Google Photos/Photos from 2024/metadata.json", "{}")
    if heic:
        z.writestr("Takeout/Google Photos/Photos from 2025/IMG_2001.HEIC", heic)
        z.writestr("Takeout/Google Photos/Photos from 2025/IMG_2001.HEIC.json", json.dumps({"photoTakenTime": {"timestamp": "1748768400"}}))
open(os.path.join(out, "loose.jpg"), "wb").write(jpg((90, 90, 200)))
print("heic" if heic else "noheic")
`,
  fixtures,
]);
const HEIC = String(made).trim() === "heic";

// ---- Google: signed in with Drive
fs.mkdirSync(path.join(home, "google-photos"), { recursive: true });
fs.writeFileSync(
  path.join(home, "google-photos", "config.json"),
  JSON.stringify({ client_id: "1-a.apps.googleusercontent.com", client_secret: "secretsecret", refresh_token: "RT", access_token: "AT", expires_at: Date.now() + 3_600_000, scopes: [PICKER_SCOPE, ...DRIVE_SCOPES] }),
);
const registry = new Registry(home);
const photos = new GooglePhotos(home, registry);

const files = {
  zip: { id: "z1", name: "takeout-20261003T120000Z-001.zip", mimeType: "application/zip", size: String(fs.statSync(path.join(fixtures, "takeout.zip")).size), modifiedTime: "2026-10-03T12:00:00Z" },
  loose: { id: "f1", name: "IMG_3001.jpg", mimeType: "image/jpeg", modifiedTime: "2026-10-03T13:00:00Z", imageMediaMetadata: { time: "2024:06:01 10:00:00" } },
};
const calls: string[] = [];
let folderCreated = 0;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/files?") && init?.method === "POST") {
    folderCreated++;
    return json({ id: "folder1" });
  }
  if (url.includes("/files?")) {
    const q = new URL(url).searchParams.get("q") ?? "";
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return json({ files: [] });
    if (q.includes("takeout-")) return json({ files: [files.zip] });
    if (q.includes("'folder1' in parents")) return json({ files: [files.loose] });
    return json({ files: [] });
  }
  if (url.includes("/files/z1?alt=media")) return new Response(fs.readFileSync(path.join(fixtures, "takeout.zip")));
  if (url.includes("/files/f1?alt=media")) return new Response(fs.readFileSync(path.join(fixtures, "loose.jpg")));
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const sync = new DriveSync(home, photos, { fetch: fakeFetch });

try {
  await check("Drive's EXIF-style time becomes ISO", () => {
    assert.equal(driveTakenTime({ id: "x", name: "a", mimeType: "image/jpeg", modifiedTime: "", imageMediaMetadata: { time: "2024:06:01 10:00:00" } }), "2024-06-01T10:00:00Z");
    assert.equal(driveTakenTime({ id: "x", name: "a", mimeType: "image/jpeg", modifiedTime: "" }), null);
  });

  await check("settings: from 2023 by default, a bad date is refused", () => {
    assert.equal(sync.status().settings.from, "2023-01-01");
    assert.throws(() => sync.update({ from: "last year" }), /must be a day/);
  });

  await check("a sync: makes the folder, imports the Takeout zip and the loose photo, keeps only 2023 on", async () => {
    await sync.run();
    const st = sync.status();
    assert.equal(st.last_result?.error, undefined, st.last_result?.error);
    assert.equal(folderCreated, 1);
    assert.equal(st.folder?.id, "folder1");
    const lib = readLibrary(home);
    const names = lib.map((i) => i.filename).sort();
    assert.deepEqual(names, HEIC ? ["IMG_1001.JPG", "IMG_2001.HEIC", "IMG_3001.jpg"] : ["IMG_1001.JPG", "IMG_3001.jpg"]);
    const takeout = lib.find((i) => i.filename === "IMG_1001.JPG")!;
    assert.equal(takeout.created_at, "2024-06-01T10:00:00Z", "the date comes from Takeout's sidecar");
    assert.equal(lib.find((i) => i.filename === "IMG_3001.jpg")!.created_at, "2024-06-01T10:00:00Z", "and from Drive's metadata");
    assert.ok(fs.existsSync(path.join(home, "photos", takeout.file)) && fs.existsSync(path.join(home, "photos", takeout.thumb)));
    assert.ok(takeout.sha && takeout.batch.startsWith("drive:"));
    const skipped = st.last_result!.skipped;
    assert.equal(skipped["before the start date"], 1, JSON.stringify(skipped));
    assert.equal(skipped.screenshot, 1);
    assert.equal(skipped.video, 1);
    assert.equal(fs.readdirSync(path.join(home, "photos", "import")).filter((f) => !f.endsWith(".txt") && !f.endsWith(".json")).length, 0, "downloads are deleted");
  });

  await check("the next sync downloads nothing it has already seen", async () => {
    const before = calls.filter((c) => c.includes("alt=media")).length;
    await sync.run();
    assert.equal(calls.filter((c) => c.includes("alt=media")).length, before);
    assert.equal(sync.status().last_result?.files, 0);
  });

  await check("moving the start date earlier looks again, without duplicates", async () => {
    const count = readLibrary(home).length;
    sync.update({ from: "2020-01-01" });
    await sync.run();
    const lib = readLibrary(home);
    assert.equal(lib.length, count + 1, "only the 2021 photo is new");
    assert.ok(lib.some((i) => i.filename === "IMG_0500.JPG" && i.created_at?.startsWith("2021-03-04")));
  });

  await check("without Drive access it says so instead of failing quietly", async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "google-photos", "config.json"), "utf8"));
    fs.writeFileSync(path.join(home, "google-photos", "config.json"), JSON.stringify({ ...cfg, scopes: [PICKER_SCOPE] }));
    await sync.run();
    assert.match(sync.status().last_result?.error ?? "", /Connect Google Drive first/);
    assert.equal(photos.status().drive, false);
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall drive-sync checks passed" : `\n${failures} drive-sync check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
