/**
 * @mentions between JP and interns, and between interns.
 *
 * `@Rhea`, `@rhea`, `@code-reviewer` (slug) and `@Rhea_Smith` all resolve
 * against the directory (slug + display name, case-insensitive; a multi-word
 * name matches on its first word too). `@everyone` / `@all` / `@team` expand
 * to the whole directory given. Unknown mentions are left alone — they are
 * ordinary text to the renderer as well.
 *
 * A mention is how work moves between interns: the orchestrator enqueues a
 * task for every mentioned intern with the thread as context (see
 * Orchestrator.routeMentions). `MAX_MENTION_HOPS` bounds a conversation that
 * interns keep among themselves, so two interns cannot ping-pong forever;
 * a message from JP resets the depth.
 */
export interface DirectoryEntry {
  slug: string;
  name: string;
}

export const MAX_MENTION_HOPS = 4;

const MENTION_RE = /(^|[^\w@/.-])@([\w][\w.-]*)/g;
const EVERYONE = new Set(["everyone", "all", "team", "here"]);

export function extractMentionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push(m[2]!.replace(/[.]+$/, ""));
  return out;
}

/** Aliases that mean "the whole group" on top of @everyone/@all — e.g. the room's own name. */
export function groupAliases(name: string): string[] {
  const n = name.trim().toLowerCase();
  if (!n) return [];
  return [...new Set([n, n.replace(/\s+/g, "_"), n.replace(/\s+/g, "-"), n.split(/\s+/)[0]!])];
}

/** Resolve mentions to slugs, in order of first appearance, without duplicates. */
export function resolveMentions(text: string, directory: DirectoryEntry[], everyoneAliases: string[] = []): { slugs: string[]; everyone: boolean } {
  const slugs: string[] = [];
  let everyone = false;
  const seen = new Set<string>();
  const push = (slug: string) => {
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  };
  for (const token of extractMentionTokens(text)) {
    const key = token.toLowerCase();
    if (EVERYONE.has(key) || everyoneAliases.includes(key)) {
      everyone = true;
      for (const entry of directory) push(entry.slug);
      continue;
    }
    const hit = directory.find((e) => e.slug.toLowerCase() === key)
      ?? directory.find((e) => e.name.toLowerCase() === key || e.name.toLowerCase().replace(/\s+/g, "_") === key || e.name.toLowerCase().replace(/\s+/g, "-") === key)
      ?? directory.find((e) => e.name.toLowerCase().split(/\s+/)[0] === key);
    if (hit) push(hit.slug);
  }
  return { slugs, everyone };
}

/** Thread keys for group chats are `room-<uuid>`; everything else is an intern slug. */
export function isRoomKey(key: string): boolean {
  return key.startsWith("room-");
}
