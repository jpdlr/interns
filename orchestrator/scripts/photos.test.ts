/**
 * Google Photos connector (src/photos.ts) against a fake Google: setup,
 * sign-in with single-use state, a picker session that imports into the
 * local library, duplicates skipped, and a week-old testing sign-in.
 *
 *   npm run test:photos
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-photos-"));
process.env.INTERNS_HOME = home;

const { Registry } = await import("../src/registry.js");
const { InternManifestSchema } = await import("../src/types.js");
const { GooglePhotos, readLibrary, readGoogle, photosPrompt, PICKER_SCOPE } = await import("../src/photos.js");
import type { HttpFetch } from "../src/photos.js";

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

const registry = new Registry(home);
registry.save(InternManifestSchema.parse({ name: "Milo", role: "Social", system_prompt: "You plan posts.", tools: ["fs.read"] }), "milo");

// ---- a fake Google
const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
let refreshFails = false;
let picked = false;
const ITEMS = [
  { id: "a1", createTime: "2026-09-01T07:00:00Z", type: "PHOTO", mediaFile: { baseUrl: "https://lh3.example/a1", mimeType: "image/jpeg", filename: "IMG_1.jpg", mediaFileMetadata: { width: 4000, height: 3000, cameraMake: "FUJIFILM", cameraModel: "X100V" } } },
  { id: "a2", createTime: "2026-09-02T07:00:00Z", type: "VIDEO", mediaFile: { baseUrl: "https://lh3.example/a2", mimeType: "video/mp4", filename: "VID_2.mp4", mediaFileMetadata: { width: 1920, height: 1080 } } },
  { id: "a3", createTime: "2026-09-03T07:00:00Z", type: "PHOTO", mediaFile: { baseUrl: "https://lh3.example/a3", mimeType: "image/jpeg", filename: "IMG_3.jpg" } },
];
const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
const fake: HttpFetch = async (url, init = {}) => {
  calls.push({ url, method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(init.body ?? "");
    if (form.get("grant_type") === "authorization_code") {
      return form.get("code") === "good" ? json(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
    }
    return refreshFails ? json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }) : json(200, { access_token: "AT2", expires_in: 3600 });
  }
  if (url === "https://photospicker.googleapis.com/v1/sessions" && init.method === "POST") {
    return json(200, { id: "s1", pickerUri: "https://photos.google.com/picker/s1", pollingConfig: { pollInterval: "1s", timeoutIn: "60s" }, mediaItemsSet: false });
  }
  if (url.startsWith("https://photospicker.googleapis.com/v1/sessions/s1")) {
    if (init.method === "DELETE") return json(200, {});
    return json(200, { id: "s1", mediaItemsSet: picked });
  }
  if (url.startsWith("https://photospicker.googleapis.com/v1/mediaItems?")) {
    const token = new URL(url).searchParams.get("pageToken");
    return json(200, token ? { mediaItems: ITEMS.slice(2) } : { mediaItems: ITEMS.slice(0, 2), nextPageToken: "p2" });
  }
  if (url.startsWith("https://lh3.example/")) {
    if (url.startsWith("https://lh3.example/a3")) return json(500, {});
    return { status: 200, ok: true, json: async () => ({}), arrayBuffer: async () => new TextEncoder().encode(`jpeg:${url}`).buffer as ArrayBuffer };
  }
  return json(404, { error: { message: `no fake for ${url}` } });
};

const photos = new GooglePhotos(home, registry, { fetch: fake, pollMs: 20 });
const until = async (what: string, ok: () => boolean) => {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > 5000) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

try {
  await check("setup checks the client before keeping it", () => {
    assert.throws(() => photos.setApp({ client_id: "nope", client_secret: "x".repeat(20) }), /OAuth client ID/);
    assert.throws(() => photos.authUrl("https://interns.example:8444"), /client first/);
    const s = photos.setApp({ client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-secretsecret" });
    assert.equal(s.app.configured, true);
    assert.equal(s.connected, false);
    assert.equal(fs.statSync(path.join(home, "google-photos", "config.json")).mode & 0o777, 0o600);
  });

  await check("sign-in asks only for the picker scope and comes back to this app", async () => {
    const url = new URL(photos.authUrl("https://interns.example:8444/settings"));
    assert.equal(url.searchParams.get("scope"), PICKER_SCOPE);
    assert.equal(url.searchParams.get("redirect_uri"), "https://interns.example:8444/oauth/google/callback");
    assert.equal(url.searchParams.get("access_type"), "offline");
    const state = url.searchParams.get("state")!;
    await assert.rejects(photos.callback("good", "forged"), /expired/);
    const next = await photos.callback("good", state);
    assert.equal(next, "https://interns.example:8444/connectors/google-photos?connected=1");
    await assert.rejects(photos.callback("good", state), /expired/, "state is single use");
    assert.equal(readGoogle(home)!.refresh_token, "RT1");
    assert.equal(photos.status().connected, true);
  });

  await check("declining on Google's page goes back to the app with the reason", async () => {
    const state = new URL(photos.authUrl("https://interns.example:8444")).searchParams.get("state")!;
    assert.equal(await photos.callback("", state, "access_denied"), "https://interns.example:8444/connectors/google-photos?error=access_denied");
  });

  await check("a pick: wait for the owner, then copy every item into the library", async () => {
    const session = await photos.startPick();
    assert.equal(session.picker_uri, "https://photos.google.com/picker/s1");
    assert.equal(photos.status().sessions.length, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(photos.pickStatus("s1").state, "waiting");
    picked = true;
    await until("import", () => photos.pickStatus("s1").state === "done");
    const s = photos.pickStatus("s1");
    assert.deepEqual([s.total, s.imported, s.skipped], [3, 2, 1], "a failed download is skipped, not fatal");
    const lib = readLibrary(home);
    assert.deepEqual(lib.map((i) => i.id), ["a1", "a2"]);
    assert.equal(lib[0]!.camera, "FUJIFILM X100V");
    assert.equal(lib[1]!.type, "video");
    assert.equal(fs.readFileSync(path.join(home, "photos", lib[0]!.file), "utf8"), "jpeg:https://lh3.example/a1=w2048-h2048");
    assert.equal(fs.readFileSync(path.join(home, "photos", lib[0]!.thumb), "utf8"), "jpeg:https://lh3.example/a1=w512-h512");
    assert.ok(calls.filter((c) => c.url.startsWith("https://lh3.example/")).every((c) => c.auth === "Bearer AT1"), "downloads carry the token");
    assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/sessions/s1")), "the session is closed after");
    assert.equal(photos.status().library.count, 2);
  });

  await check("picking the same photos again doesn't duplicate them", async () => {
    await photos.startPick();
    await until("second import", () => photos.pickStatus("s1").state === "done");
    assert.equal(readLibrary(home).length, 2);
    assert.equal(photos.pickStatus("s1").skipped, 3);
  });

  await check("granting the photos tool, and the prompt it brings", () => {
    const s = photos.setInterns({ milo: true, nobody: true });
    assert.equal(s.interns.find((i) => i.slug === "milo")!.enabled, true);
    assert.ok(registry.get("milo")!.tools.includes("photos"));
    const prompt = photosPrompt(registry.get("milo")!, home, "Sam");
    assert.match(prompt, /Sam's photos \(2 shared from Google Photos\)/);
    assert.match(prompt, /photo-library sheet/);
    photos.setInterns({ milo: false });
    assert.equal(photosPrompt(registry.get("milo")!, home), "");
  });

  await check("a week-old testing sign-in: asks to connect again instead of failing quietly", async () => {
    const c = readGoogle(home)!;
    fs.writeFileSync(path.join(home, "google-photos", "config.json"), JSON.stringify({ ...c, expires_at: 0 }));
    refreshFails = true;
    await assert.rejects(photos.startPick(), /Connect again/);
    assert.equal(photos.status().needs_reconnect, true);
    assert.equal(photos.status().connected, false);
  });

  await check("disconnect forgets the sign-in, keeps the library unless asked", () => {
    let s = photos.disconnect();
    assert.equal(s.connected, false);
    assert.equal(s.app.configured, true, "the client stays");
    assert.equal(s.library.count, 2);
    s = photos.disconnect({ library: true });
    assert.equal(s.library.count, 0);
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall photos checks passed" : `\n${failures} photos check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
