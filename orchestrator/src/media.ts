/**
 * Video and picture derivatives for attachments, made with ffmpeg/ffprobe
 * (already on the box; no image library in node_modules):
 *  - probeVideo: a video's size and length, when it is uploaded
 *  - poster: a video's first frame as JPEG, shown before it plays
 *  - thumbnail: a picture (or a poster) scaled down to one of THUMB_WIDTHS,
 *    so a grid on mobile data loads small files and the viewer the full one
 *
 * Derivatives are cached beside the attachment under .derived/ and made on
 * first request. Every failure returns null: callers serve the original.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

/** The widths the app asks for; anything else is rounded up to one of these. */
export const THUMB_WIDTHS = [320, 640, 1080] as const;

export function thumbWidth(requested: number): number {
  return THUMB_WIDTHS.find((w) => w >= requested) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
}

export async function probeVideo(file: string): Promise<{ width: number; height: number; duration: number | null } | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", file],
      { timeout: TIMEOUT_MS },
    );
    const info = JSON.parse(stdout) as { streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string } };
    const stream = info.streams?.[0];
    if (!stream?.width || !stream.height) return null;
    // phone video is often stored landscape with a rotation flag
    const turned = Math.abs(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) === 90;
    const duration = Number(info.format?.duration);
    return {
      width: turned ? stream.height : stream.width,
      height: turned ? stream.width : stream.height,
      duration: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
    };
  } catch {
    return null;
  }
}

/** The .derived/ dir beside an attachment (a derivative's own dir when given one). */
function derivedDir(file: string): string {
  const dir = path.dirname(file);
  return path.basename(dir) === ".derived" ? dir : path.join(dir, ".derived");
}

function derivedPath(file: string, suffix: string): string {
  return path.join(derivedDir(file), `${path.basename(file, path.extname(file))}.${suffix}.jpg`);
}

async function cached(out: string, make: (tmp: string) => Promise<unknown>): Promise<string | null> {
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${randomUUID()}.tmp.jpg`;
  try {
    await make(tmp);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    fs.renameSync(tmp, out);
    return out;
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A video's opening frame (a tenth of a second in, past any black first frame). */
export function poster(file: string): Promise<string | null> {
  return cached(derivedPath(file, "poster"), (tmp) =>
    run("ffmpeg", ["-v", "error", "-y", "-ss", "0.1", "-i", file, "-frames:v", "1", "-q:v", "3", tmp], { timeout: TIMEOUT_MS }),
  );
}

/** `file` scaled to at most `width` pixels wide (never up), as JPEG. */
export function thumbnail(file: string, width: number): Promise<string | null> {
  return cached(derivedPath(file, `w${width}`), (tmp) =>
    run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-q:v", "4", tmp], { timeout: TIMEOUT_MS }),
  );
}
