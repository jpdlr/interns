/**
 * Instagram research, as the orchestrator sees it: the connection stored
 * under ~/.interns/instagram/, connecting it from a Graph API Explorer token,
 * and the prompt block for interns with the `instagram` tool.
 *
 * The Instagram API with Facebook Login needs a Business or Creator account
 * linked to a Facebook Page, and a Meta app the owner creates. The owner
 * pastes the app's ID and secret and a short-lived user token; connecting
 * exchanges it for a long-lived one and keeps the linked Page's token, which
 * doesn't expire. tools/ig-research reads that token and only ever reads:
 * public Business/Creator profiles (Business Discovery) and hashtags.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TOOLS_DIR } from "./engine.js";
import { ownerName } from "./profile.js";
import type { InternManifest } from "./types.js";

export const GRAPH_BASE = "https://graph.facebook.com/v25.0";

/** What research needs; Business Discovery fails with "(#10) no permission" without instagram_manage_insights. */
export const REQUIRED_SCOPES = ["instagram_basic", "pages_show_list", "pages_read_engagement", "instagram_manage_insights"];
/** Granted scopes that could act on the account; ig-research never uses them, the app says so. */
const ACTING_SCOPES = ["instagram_content_publish", "instagram_manage_contents", "instagram_manage_comments", "instagram_manage_messages", "instagram_manage_engagement"];

export interface InstagramConnection {
  app_id: string;
  app_secret: string;
  user_token: string;
  /** ISO; the user token is only used to re-derive the Page token */
  user_token_expires_at: string | null;
  page_id: string;
  page_name: string;
  page_token: string;
  /** ISO, or null when the Page token doesn't expire */
  page_token_expires_at: string | null;
  ig_user_id: string;
  ig_username: string;
  scopes: string[];
  connected_at: string;
}

export function instagramFile(home: string): string {
  return path.join(home, "instagram", "config.json");
}

export function readInstagram(home: string): InstagramConnection | null {
  try {
    const raw = JSON.parse(fs.readFileSync(instagramFile(home), "utf8")) as Partial<InstagramConnection>;
    if (!raw.ig_user_id || !(raw.page_token || raw.user_token)) return null;
    return {
      app_id: raw.app_id ?? "",
      app_secret: raw.app_secret ?? "",
      user_token: raw.user_token ?? "",
      user_token_expires_at: raw.user_token_expires_at ?? null,
      page_id: raw.page_id ?? "",
      page_name: raw.page_name ?? "",
      page_token: raw.page_token ?? "",
      page_token_expires_at: raw.page_token_expires_at ?? null,
      ig_user_id: raw.ig_user_id,
      ig_username: raw.ig_username ?? "",
      scopes: raw.scopes ?? [],
      connected_at: raw.connected_at ?? "",
    };
  } catch {
    return null;
  }
}

export function writeInstagram(home: string, connection: InstagramConnection): void {
  const file = instagramFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(connection, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Forget the tokens; keep nothing else (there is no history worth keeping). */
export function removeInstagram(home: string): void {
  fs.rmSync(instagramFile(home), { force: true });
}

export function usesInstagram(manifest: Pick<InternManifest, "tools">): boolean {
  return manifest.tools.includes("instagram");
}

export function missingScopes(scopes: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}

export function actingScopes(scopes: string[]): string[] {
  return ACTING_SCOPES.filter((s) => scopes.includes(s));
}

/** The system-prompt block for interns with the instagram tool ("" without it). */
export function instagramPrompt(manifest: InternManifest, home: string, owner = ownerName()): string {
  if (!usesInstagram(manifest)) return "";
  const connection = readInstagram(home);
  if (!connection) return `\n## Instagram\nInstagram isn't connected yet. If a task needs it, say so and point ${owner} to Settings › Connectors › Instagram instead of trying.`;
  const cli = `${TOOLS_DIR}/ig-research`;
  return `
## Instagram research (read only)
You can research Instagram through @${connection.ig_username || "the owner's account"}, ${owner}'s connected account:
  ${cli} profile <username> [--posts 12]    # a public Business or Creator account: bio, followers, recent posts with likes/comments, engagement
  ${cli} hashtag <tag> [--recent] [--limit 15]   # top posts for a hashtag, or the newest with --recent
  ${cli} quota                              # hashtags searched in the last 7 days
Limits Instagram sets: personal and private accounts can't be looked up; hashtag results don't say who posted (open the permalink); only 30 different hashtags per rolling 7 days for the whole crew. Run quota before a batch of hashtag searches, reuse hashtags already searched (free), and pick hashtags deliberately rather than trying many.
This is research only: never post, comment, like, follow or message anyone. Cite the post or profile links you base findings on, and keep a page (table or board) when ${owner} asks for ongoing tracking.`;
}

// --------------------------------------------------------------- Graph API

export type GraphFetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export async function graphGet<T>(fetchFn: GraphFetch, route: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH_BASE}/${route}?${new URLSearchParams(params)}`;
  let res: Awaited<ReturnType<GraphFetch>>;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new GraphError(`Can't reach Facebook: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (res.status >= 400 || body.error) throw new GraphError(body.error?.message ?? `Facebook answered ${res.status}`, body.error?.code);
  return body;
}

/** Unix seconds (0 = never) → ISO or null. */
export function expiry(seconds: number | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}
