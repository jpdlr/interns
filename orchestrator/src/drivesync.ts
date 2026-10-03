/**
 * Photos from Google Drive, kept in sync (the Google Photos connector's
 * second way in; photos.ts is the picker).
 *
 * Google Photos can't be read by any app at large, but Drive can, and the
 * owner can get photos into Drive two ways without touching the server:
 *  - a Google Takeout export of Google Photos delivered to Drive ("Add to
 *    Drive"), once or every two months: the zips land in Drive as
 *    takeout-….zip;
 *  - anything saved into the "Interns Photos" folder (created here), e.g. by
 *    a Shortcut on the phone.
 *
 * Every few hours (and on "Sync now") this lists both, downloads what it
 * hasn't seen to disk ($INTERNS_HOME/photos/import, never memory), and runs
 * tools/photo-import, which keeps photos taken on or after the chosen start
 * date, skips screenshots and duplicates (by content hash), converts HEIC
 * and writes the library copies. Downloaded files are deleted after; the
 * Drive copies are never touched.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TOOLS_DIR } from "./engine.js";
import { photosDir, PhotosError, readLibrary, type GooglePhotos, type LibraryItem } from "./photos.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD_FOLDER_MIME = "application/vnd.google-apps.folder";

export interface SyncSettings {
  /** check Drive on its own every few hours */
  enabled: boolean;
  /** keep photos taken on or after this day (YYYY-MM-DD) */
  from: string;
  /** videos as a still frame */
  videos: boolean;
  skip_screenshots: boolean;
  /** the Drive folder anything dropped in is synced from */
  folder_name: string;
}

interface SyncFile {
  settings: SyncSettings;
  folder_id?: string;
  /** Drive file id → modifiedTime already imported */
  seen: Record<string, string>;
  last_run_at?: string;
  last_result?: { imported: number; files: number; skipped: Record<string, number>; error?: string };
}

export const DEFAULT_SYNC: SyncSettings = { enabled: true, from: "2023-01-01", videos: false, skip_screenshots: true, folder_name: "Interns Photos" };

/** Runs tools/photo-import; tests may swap it. Yields the imported items, then the summary. */
export type ImportRunner = (args: string[], onItem: (item: LibraryItem) => void) => Promise<{ imported: number; skipped: Record<string, number> }>;

type DriveFile = { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; createdTime?: string; imageMediaMetadata?: { time?: string } };

const syncFile = (home: string) => path.join(home, "google-photos", "sync.json");
const importDir = (home: string) => path.join(photosDir(home), "import");

function readSync(home: string): SyncFile {
  try {
    const raw = JSON.parse(fs.readFileSync(syncFile(home), "utf8")) as Partial<SyncFile>;
    return { settings: { ...DEFAULT_SYNC, ...raw.settings }, folder_id: raw.folder_id, seen: raw.seen ?? {}, last_run_at: raw.last_run_at, last_result: raw.last_result };
  } catch {
    return { settings: { ...DEFAULT_SYNC }, seen: {} };
  }
}

function writeSync(home: string, s: SyncFile): void {
  fs.mkdirSync(path.dirname(syncFile(home)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(syncFile(home), JSON.stringify(s, null, 1), { mode: 0o600 });
}

/** Drive's EXIF-style "2023:05:01 10:00:00" (or an ISO time) → ISO, else null. */
export function driveTakenTime(f: DriveFile): string | null {
  const raw = f.imageMediaMetadata?.time;
  if (raw) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    if (!Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  }
  return null;
}

const defaultRunner: ImportRunner = (args, onItem) =>
  new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(TOOLS_DIR, "photo-import"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let summary: { imported: number; skipped: Record<string, number> } | null = null;
    let error = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o.done) summary = { imported: Number(o.imported) || 0, skipped: (o.skipped as Record<string, number>) ?? {} };
        else if (o.error) error = String(o.error);
        else onItem(o as unknown as LibraryItem);
      } catch {
        /* not ours */
      }
    });
    child.stderr.on("data", (d) => (error += String(d).slice(0, 500)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && summary ? resolve(summary) : reject(new Error(error.trim() || `photo-import exited ${code}`))));
  });

export class DriveSync {
  private running: Promise<void> | null = null;
  private progress: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly runner: ImportRunner;

  constructor(
    private home: string,
    private photos: GooglePhotos,
    opts: { fetch?: typeof fetch; runner?: ImportRunner } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.runner = opts.runner ?? defaultRunner;
  }

  status() {
    const s = readSync(this.home);
    return {
      settings: s.settings,
      drive: this.photos.driveGranted(),
      folder: s.folder_id ? { id: s.folder_id, name: s.settings.folder_name, url: `https://drive.google.com/drive/folders/${s.folder_id}` } : null,
      running: Boolean(this.running),
      progress: this.progress,
      last_run_at: s.last_run_at ?? null,
      last_result: s.last_result ?? null,
    };
  }

  update(patch: Partial<SyncSettings>) {
    const s = readSync(this.home);
    const next = { ...s.settings, ...patch };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.from) || Number.isNaN(Date.parse(next.from))) throw new PhotosError(400, "The start date must be a day, like 2023-01-01.");
    // An earlier start date or videos switched on: look through everything again (duplicates are skipped by hash).
    const widened = next.from < s.settings.from || (next.videos && !s.settings.videos) || (!next.skip_screenshots && s.settings.skip_screenshots);
    // A different folder name: find (or make) that folder next time.
    const folder_id = next.folder_name !== s.settings.folder_name ? undefined : s.folder_id;
    writeSync(this.home, { ...s, settings: next, folder_id, seen: widened ? {} : s.seen });
    return this.status();
  }

  /** Start a sync unless one is running; resolves when it's done. Never throws (errors are in last_result). */
  run(): Promise<void> {
    if (!this.running) {
      this.running = this.sync().finally(() => {
        this.running = null;
        this.progress = null;
      });
    }
    return this.running;
  }

  private async drive<T>(route: string, init: RequestInit = {}): Promise<T> {
    const token = await this.photos.accessToken();
    const res = await this.fetch(`${DRIVE}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new PhotosError(res.status === 403 ? 403 : 502, `Google Drive: ${body.error?.message ?? `HTTP ${res.status}`}`);
    }
    return (await res.json()) as T;
  }

  private async list(q: string, fields: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", spaces: "drive", ...(pageToken ? { pageToken } : {}) });
      const page = await this.drive<{ files?: DriveFile[]; nextPageToken?: string }>(`/files?${params}`);
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  /** The folder anything dropped in is synced from; made on first sync if missing. */
  private async folder(s: SyncFile): Promise<string> {
    if (s.folder_id) return s.folder_id;
    const name = s.settings.folder_name.replace(/'/g, "\\'");
    const found = await this.list(`name = '${name}' and mimeType = '${UPLOAD_FOLDER_MIME}' and trashed = false`, "id,name,mimeType,modifiedTime");
    const id =
      found[0]?.id ??
      (await this.drive<{ id: string }>("/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: s.settings.folder_name, mimeType: UPLOAD_FOLDER_MIME }) })).id;
    s.folder_id = id;
    writeSync(this.home, s);
    return id;
  }

  private async download(f: DriveFile, to: string): Promise<void> {
    const token = await this.photos.accessToken();
    const res = await this.fetch(`${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok || !res.body) throw new PhotosError(502, `Google Drive: couldn't download ${f.name} (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(to));
  }

  private async sync(): Promise<void> {
    const s = readSync(this.home);
    const result = { imported: 0, files: 0, skipped: {} as Record<string, number>, error: undefined as string | undefined };
    const tmp = importDir(this.home);
    try {
      if (!this.photos.driveGranted()) throw new PhotosError(409, "Connect Google Drive first.");
      fs.mkdirSync(tmp, { recursive: true });
      this.progress = "Looking in Google Drive…";
      const folderId = await this.folder(s);
      const fields = "id,name,mimeType,size,modifiedTime,createdTime,imageMediaMetadata(time)";
      const zips = (await this.list("name contains 'takeout-' and (mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed') and trashed = false", fields)).filter(
        (f) => s.seen[f.id] !== f.modifiedTime,
      );
      const loose = (await this.list(`'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`, fields)).filter(
        (f) => s.seen[f.id] !== f.modifiedTime,
      );

      const known = path.join(tmp, "known.txt");
      const common = () => {
        fs.writeFileSync(known, readLibrary(this.home).map((i) => i.sha).filter(Boolean).join("\n"));
        return ["--out", photosDir(this.home), "--from", s.settings.from, "--known", known, ...(s.settings.skip_screenshots ? ["--skip-screenshots"] : []), ...(s.settings.videos ? ["--videos"] : [])];
      };
      const batch = `drive:${new Date().toISOString().slice(0, 10)}`;
      const take = async (args: string[]) => {
        const items: LibraryItem[] = [];
        const summary = await this.runner(args, (item) => {
          items.push({ ...item, imported_at: new Date().toISOString(), batch });
          if (items.length % 25 === 0) this.photos.addToLibrary(items.splice(0));
        });
        this.photos.addToLibrary(items);
        result.imported += summary.imported;
        for (const [k, v] of Object.entries(summary.skipped)) result.skipped[k] = (result.skipped[k] ?? 0) + v;
      };

      for (const [n, zip] of zips.entries()) {
        const size = zip.size ? ` (${(Number(zip.size) / 1e9).toFixed(1)} GB)` : "";
        this.progress = `Downloading ${zip.name}${size}, ${n + 1} of ${zips.length}…`;
        const local = path.join(tmp, `${zip.id}.zip`);
        try {
          await this.download(zip, local);
          this.progress = `Importing ${zip.name}…`;
          await take([...common(), "--zip", local]);
        } finally {
          fs.rmSync(local, { force: true });
        }
        s.seen[zip.id] = zip.modifiedTime;
        result.files++;
        writeSync(this.home, s);
      }

      for (let i = 0; i < loose.length; i += 40) {
        const chunk = loose.slice(i, i + 40);
        this.progress = `Copying photos from ${s.settings.folder_name}, ${Math.min(i + chunk.length, loose.length)} of ${loose.length}…`;
        const local: { path: string; name: string; taken: string | null }[] = [];
        try {
          for (const f of chunk) {
            const to = path.join(tmp, `${f.id}${path.extname(f.name) || ".bin"}`);
            await this.download(f, to);
            local.push({ path: to, name: f.name, taken: driveTakenTime(f) });
          }
          const spec = path.join(tmp, "files.json");
          fs.writeFileSync(spec, JSON.stringify(local));
          await take([...common(), "--files", spec]);
        } finally {
          for (const l of local) fs.rmSync(l.path, { force: true });
        }
        for (const f of chunk) s.seen[f.id] = f.modifiedTime;
        result.files += chunk.length;
        writeSync(this.home, s);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`[drivesync] ${result.error}`);
    } finally {
      const latest = readSync(this.home);
      writeSync(this.home, { ...latest, seen: { ...latest.seen, ...s.seen }, folder_id: s.folder_id ?? latest.folder_id, last_run_at: new Date().toISOString(), last_result: result });
    }
  }
}

export function registerDriveSyncRoutes(app: FastifyInstance, sync: DriveSync): void {
  app.get("/connectors/google-photos/sync", async () => sync.status());
  app.patch("/connectors/google-photos/sync", async (req, reply) => {
    const body = z
      .object({ enabled: z.boolean(), from: z.string(), videos: z.boolean(), skip_screenshots: z.boolean(), folder_name: z.string().trim().min(1).max(100) })
      .partial()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid sync settings" });
    try {
      return sync.update(body.data);
    } catch (err) {
      return reply.code(err instanceof PhotosError ? err.status : 500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/connectors/google-photos/sync/run", async () => {
    void sync.run();
    return sync.status();
  });
}
