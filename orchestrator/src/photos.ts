/**
 * Google Photos: the owner hands photos to the crew through Google's own
 * picker, and they land in a local library interns can browse.
 *
 * Since March 2025 no app can read a Google Photos library at large; the
 * Photos Picker API is the way in. The owner picks photos or albums in a
 * Google-hosted picker; the picked items can then be downloaded for a short
 * while. So every pick is copied here, into $INTERNS_HOME/photos:
 *
 *   photos/library.json   one entry per item (written here, on import)
 *   photos/img/<id>.jpg   up to 2048px on the long edge
 *   photos/thumb/<id>.jpg up to 512px, for contact sheets
 *   photos/tags.json      what interns noted about each photo (tools/photo-library)
 *
 * Setup is the owner's own Google Cloud OAuth client (Web application, with
 * the redirect URI the app shows). Connecting is a normal browser sign-in
 * that comes back to /oauth/google/callback, guarded by single-use state.
 * Only the picker scope is requested: the token can see nothing but what the
 * owner picks. Granting the `photos` tool lets an intern use the library.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TOOLS_DIR } from "./engine.js";
import { ownerName } from "./profile.js";
import type { Registry } from "./registry.js";
import type { InternManifest } from "./types.js";

export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PICKER = "https://photospicker.googleapis.com/v1";
const STATE_TTL_MS = 15 * 60_000;
const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface GoogleConnection {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
  /** epoch ms */
  expires_at?: number;
  connected_at?: string;
  /** set when Google refused the refresh token (testing-mode tokens last a week) */
  needs_reconnect?: boolean;
}

export interface LibraryItem {
  id: string;
  file: string;
  thumb: string;
  type: "photo" | "video";
  filename: string;
  created_at: string | null;
  width: number | null;
  height: number | null;
  camera: string | null;
  imported_at: string;
  batch: string;
}

export interface PickSession {
  id: string;
  picker_uri: string;
  state: "waiting" | "importing" | "done" | "failed" | "expired";
  total: number;
  imported: number;
  skipped: number;
  error: string | null;
  started_at: string;
}

export class PhotosError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const photosDir = (home: string) => path.join(home, "photos");
const configFile = (home: string) => path.join(home, "google-photos", "config.json");

export function readGoogle(home: string): GoogleConnection | null {
  try {
    return JSON.parse(fs.readFileSync(configFile(home), "utf8")) as GoogleConnection;
  } catch {
    return null;
  }
}

function writeGoogle(home: string, c: GoogleConnection | null): void {
  const file = configFile(home);
  if (!c) return void fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function readLibrary(home: string): LibraryItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(photosDir(home), "library.json"), "utf8")) as { items?: LibraryItem[] };
    return parsed.items ?? [];
  } catch {
    return [];
  }
}

function writeLibrary(home: string, items: LibraryItem[]): void {
  const file = path.join(photosDir(home), "library.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1));
  fs.renameSync(tmp, file);
}

export const usesPhotos = (manifest: InternManifest) => manifest.tools.includes("photos");

/** The library, for an intern with the `photos` tool. */
export function photosPrompt(manifest: InternManifest, home: string, owner = ownerName()): string {
  if (!usesPhotos(manifest)) return "";
  const count = readLibrary(home).length;
  const cli = `${TOOLS_DIR}/photo-library`;
  if (!count) return `\n## ${owner}'s photos\nNo photos have been shared yet. When a task needs them, ask ${owner} to share some in Settings › Connectors › Google Photos.`;
  return `
## ${owner}'s photos (${count} shared from Google Photos)
${owner} shares photos with the crew from Google Photos; copies live in ${photosDir(home)}. Look at them through contact sheets (a grid of numbered thumbnails, cheap to read) rather than one by one:
  ${cli} stats                                     # how many, what's tagged, date range
  ${cli} sheet [--untagged | --tag T | --ids a,b] [--limit 12]   # makes a contact sheet; open the printed path with Read
  ${cli} list [--untagged | --tag T] [--limit 50]  # JSON: id, date, camera, tags, note, image path
  ${cli} tag <id> --tags a,b [--note "..."] [--pick]   # record what a photo is; --pick marks it as a strong one
Tag as you go (subject, place, light, mood, and whether it's post-worthy) so later work searches tags instead of looking again. To show ${owner} a photo, attach its image path with intern-attach. These are ${owner}'s private photos: describe them only to ${owner}, and never put people's faces or private details forward for a post without ${owner}'s say-so.`;
}

const defaultFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, json: () => res.json(), arrayBuffer: () => res.arrayBuffer() };
};

export class GooglePhotos {
  private states = new Map<string, { origin: string; expires: number }>();
  private sessions = new Map<string, PickSession>();
  private readonly fetch: HttpFetch;
  private readonly pollMs?: number;

  constructor(
    private home: string,
    private registry: Registry,
    opts: { fetch?: HttpFetch; pollMs?: number } = {},
  ) {
    this.fetch = opts.fetch ?? defaultFetch;
    this.pollMs = opts.pollMs;
  }

  status() {
    const c = readGoogle(this.home);
    const items = readLibrary(this.home);
    const last = items.reduce<string | null>((m, i) => (!m || i.imported_at > m ? i.imported_at : m), null);
    return {
      app: { configured: Boolean(c?.client_id), client_id: c?.client_id ?? null },
      connected: Boolean(c?.refresh_token) && !c?.needs_reconnect,
      needs_reconnect: Boolean(c?.needs_reconnect),
      connected_at: c?.connected_at ?? null,
      library: { count: items.length, photos: items.filter((i) => i.type === "photo").length, last_import: last },
      interns: this.registry.list().map(({ slug, manifest }) => ({ slug, name: manifest.name, enabled: usesPhotos(manifest) })),
      sessions: [...this.sessions.values()].filter((s) => s.state === "waiting" || s.state === "importing"),
    };
  }

  setApp(input: { client_id: string; client_secret: string }) {
    const client_id = input.client_id.trim();
    const client_secret = input.client_secret.trim();
    if (!CLIENT_ID.test(client_id)) throw new PhotosError(400, "That doesn't look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).");
    if (client_secret.length < 10) throw new PhotosError(400, "Paste the client secret too.");
    const previous = readGoogle(this.home);
    // A different client can't use the old sign-in.
    writeGoogle(this.home, previous?.client_id === client_id ? { ...previous, client_secret } : { client_id, client_secret });
    return this.status();
  }

  /** The Google sign-in URL; the browser comes back to <origin>/oauth/google/callback. */
  authUrl(origin: string): string {
    const c = readGoogle(this.home);
    if (!c?.client_id) throw new PhotosError(409, "Add your Google OAuth client first.");
    let base: URL;
    try {
      base = new URL(origin);
    } catch {
      throw new PhotosError(400, "Unknown app address.");
    }
    const now = Date.now();
    for (const [k, v] of this.states) if (v.expires < now) this.states.delete(k);
    const state = randomBytes(24).toString("base64url");
    this.states.set(state, { origin: base.origin, expires: now + STATE_TTL_MS });
    const q = new URLSearchParams({
      client_id: c.client_id,
      redirect_uri: `${base.origin}/oauth/google/callback`,
      response_type: "code",
      scope: PICKER_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Back from Google: swap the code for tokens. Returns where to send the browser. */
  async callback(code: string, state: string, error?: string): Promise<string> {
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expires < Date.now()) throw new PhotosError(403, "This sign-in link has expired. Start again from the app.");
    if (error) return `${pending.origin}/connectors/google-photos?error=${encodeURIComponent(error)}`;
    const c = readGoogle(this.home);
    if (!c) throw new PhotosError(409, "Add your Google OAuth client first.");
    const tokens = await this.token({ code, grant_type: "authorization_code", redirect_uri: `${pending.origin}/oauth/google/callback` }, c);
    if (!tokens.refresh_token) throw new PhotosError(502, "Google didn't return a refresh token. Remove Interns from your Google account's third-party access and connect again.");
    writeGoogle(this.home, {
      ...c,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      connected_at: new Date().toISOString(),
      needs_reconnect: false,
    });
    return `${pending.origin}/connectors/google-photos?connected=1`;
  }

  private async token(params: Record<string, string>, c: GoogleConnection): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: c.client_id, client_secret: c.client_secret }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant" && params.grant_type === "refresh_token") {
        writeGoogle(this.home, { ...c, needs_reconnect: true });
        throw new PhotosError(409, "Google signed Interns out (testing-mode sign-ins last a week). Connect again.");
      }
      throw new PhotosError(502, `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    return body as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  private async accessToken(): Promise<string> {
    const c = readGoogle(this.home);
    if (!c?.refresh_token || c.needs_reconnect) throw new PhotosError(409, "Connect Google Photos first.");
    if (c.access_token && (c.expires_at ?? 0) > Date.now() + 60_000) return c.access_token;
    const t = await this.token({ grant_type: "refresh_token", refresh_token: c.refresh_token }, c);
    writeGoogle(this.home, { ...c, access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return t.access_token;
  }

  private async picker<T>(method: string, route: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetch(`${PICKER}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new PhotosError(res.status === 403 ? 403 : 502, `Google Photos: ${err.error?.message ?? `HTTP ${res.status}`}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Open a picker. The app sends the owner to picker_uri; import starts once they're done. */
  async startPick(): Promise<PickSession> {
    const s = await this.picker<{ id: string; pickerUri: string; pollingConfig?: { pollInterval?: string; timeoutIn?: string } }>("POST", "/sessions", {});
    const session: PickSession = { id: s.id, picker_uri: s.pickerUri, state: "waiting", total: 0, imported: 0, skipped: 0, error: null, started_at: new Date().toISOString() };
    this.sessions.set(s.id, session);
    const every = this.pollMs ?? Math.max(2000, (parseFloat(s.pollingConfig?.pollInterval ?? "5") || 5) * 1000);
    const until = Date.now() + Math.min(60 * 60_000, (parseFloat(s.pollingConfig?.timeoutIn ?? "1800") || 1800) * 1000);
    void this.watch(session, every, until);
    return session;
  }

  pickStatus(id: string): PickSession {
    const s = this.sessions.get(id);
    if (!s) throw new PhotosError(404, "No such picker session.");
    return s;
  }

  async cancelPick(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.state !== "waiting") return;
    s.state = "expired";
    await this.picker("DELETE", `/sessions/${encodeURIComponent(id)}`).catch(() => {});
  }

  private async watch(session: PickSession, every: number, until: number): Promise<void> {
    try {
      while (session.state === "waiting") {
        if (Date.now() > until) {
          session.state = "expired";
          break;
        }
        await new Promise((r) => setTimeout(r, every));
        if (session.state !== "waiting") break;
        const s = await this.picker<{ mediaItemsSet?: boolean }>("GET", `/sessions/${encodeURIComponent(session.id)}`);
        if (s.mediaItemsSet) {
          session.state = "importing";
          await this.importSession(session);
          session.state = "done";
        }
      }
    } catch (err) {
      session.state = "failed";
      session.error = err instanceof Error ? err.message : String(err);
    } finally {
      await this.picker("DELETE", `/sessions/${encodeURIComponent(session.id)}`).catch(() => {});
    }
  }

  private async importSession(session: PickSession): Promise<void> {
    type Picked = {
      id: string;
      createTime?: string;
      type?: string;
      mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string; mediaFileMetadata?: { width?: number; height?: number; cameraMake?: string; cameraModel?: string } };
    };
    const picked: Picked[] = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({ sessionId: session.id, pageSize: "100", ...(pageToken ? { pageToken } : {}) });
      const page = await this.picker<{ mediaItems?: Picked[]; nextPageToken?: string }>("GET", `/mediaItems?${q}`);
      picked.push(...(page.mediaItems ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    session.total = picked.length;

    const dir = photosDir(this.home);
    fs.mkdirSync(path.join(dir, "img"), { recursive: true });
    fs.mkdirSync(path.join(dir, "thumb"), { recursive: true });
    const library = readLibrary(this.home);
    const known = new Set(library.map((i) => i.id));
    const token = await this.accessToken();
    const download = async (url: string, file: string) => {
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new PhotosError(502, `download failed (HTTP ${res.status})`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    };
    const queue = [...picked];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const base = item.mediaFile?.baseUrl;
        if (!base || known.has(item.id)) {
          session.skipped++;
          continue;
        }
        const safe = item.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
        const file = path.join("img", `${safe}.jpg`);
        const thumb = path.join("thumb", `${safe}.jpg`);
        try {
          // "=wN-hN" is an image for photos and a still frame for videos.
          await download(`${base}=w2048-h2048`, path.join(dir, file));
          await download(`${base}=w512-h512`, path.join(dir, thumb));
        } catch {
          session.skipped++;
          continue;
        }
        const meta = item.mediaFile?.mediaFileMetadata ?? {};
        const camera = [meta.cameraMake, meta.cameraModel].filter(Boolean).join(" ") || null;
        library.push({
          id: item.id,
          file,
          thumb,
          type: item.type === "VIDEO" ? "video" : "photo",
          filename: item.mediaFile?.filename ?? "",
          created_at: item.createTime ?? null,
          width: meta.width ?? null,
          height: meta.height ?? null,
          camera,
          imported_at: new Date().toISOString(),
          batch: session.id,
        });
        known.add(item.id);
        session.imported++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    writeLibrary(this.home, library);
  }

  /** Who may use the library (the `photos` tool). */
  setInterns(interns: Record<string, boolean>) {
    for (const [slug, on] of Object.entries(interns)) {
      const manifest = this.registry.get(slug);
      if (!manifest) continue;
      if (on && !usesPhotos(manifest)) this.registry.save({ ...manifest, tools: [...manifest.tools, "photos"] }, slug);
      if (!on && usesPhotos(manifest)) this.registry.save({ ...manifest, tools: manifest.tools.filter((t) => t !== "photos") }, slug);
    }
    return this.status();
  }

  /** Forget the Google sign-in. The library stays unless `library` is set. */
  disconnect(opts: { library?: boolean } = {}) {
    const c = readGoogle(this.home);
    if (c) writeGoogle(this.home, { client_id: c.client_id, client_secret: c.client_secret });
    if (opts.library) fs.rmSync(photosDir(this.home), { recursive: true, force: true });
    return this.status();
  }
}

export function registerPhotosRoutes(app: FastifyInstance, photos: GooglePhotos): void {
  const run = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T> | T) => {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof PhotosError ? err.status : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.get("/connectors/google-photos", async () => photos.status());
  app.put("/connectors/google-photos/app", async (req, reply) => {
    const body = z.object({ client_id: z.string(), client_secret: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "client_id and client_secret required" });
    return run(reply, () => photos.setApp(body.data));
  });
  app.post("/connectors/google-photos/connect", async (req, reply) => {
    const body = z.object({ origin: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "origin required" });
    return run(reply, () => ({ url: photos.authUrl(body.data.origin) }));
  });
  app.post("/connectors/google-photos/sessions", async (_req, reply) => run(reply, () => photos.startPick()));
  app.get<{ Params: { id: string } }>("/connectors/google-photos/sessions/:id", async (req, reply) => run(reply, () => photos.pickStatus(req.params.id)));
  app.delete<{ Params: { id: string } }>("/connectors/google-photos/sessions/:id", async (req, reply) => run(reply, async () => (await photos.cancelPick(req.params.id), { ok: true })));
  app.patch("/connectors/google-photos", async (req, reply) => {
    const body = z.object({ interns: z.record(z.string(), z.boolean()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "interns map required" });
    return run(reply, () => photos.setInterns(body.data.interns));
  });
  app.delete<{ Querystring: { library?: string } }>("/connectors/google-photos", async (req) => photos.disconnect({ library: req.query.library === "1" }));

  // The browser coming back from Google (no bearer token; single-use state guards it).
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/oauth/google/callback", async (req, reply) => {
    try {
      return reply.redirect(await photos.callback(req.query.code ?? "", req.query.state ?? "", req.query.error));
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).replace(/[<>&]/g, "");
      return reply
        .code(err instanceof PhotosError ? err.status : 502)
        .type("text/html")
        .send(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Photos</title>` +
            `<style>body{font:17px system-ui;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:480px;padding:24px}</style></head>` +
            `<body><main><h1>Couldn't connect Google Photos</h1><p>${message} <a href="/connectors/google-photos">Back to the app</a></p></main></body></html>`,
        );
    }
  });
}
