/**
 * Unread is a client-side notion: the orchestrator has no read receipts, so
 * we remember the newest timestamp JP has seen per intern and treat anything
 * newer (that JP did not write) as unread.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "interns.lastSeen.v1";

export type SeenMap = Record<string, string>;

export async function loadSeen(): Promise<SeenMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SeenMap) : {};
  } catch {
    return {};
  }
}

export async function markSeen(slug: string, ts: string): Promise<SeenMap> {
  const seen = await loadSeen();
  if (!seen[slug] || seen[slug] < ts) {
    seen[slug] = ts;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seen)).catch(() => {});
  }
  return seen;
}

export function isUnread(seen: SeenMap, slug: string, lastTs?: string, lastAuthor?: string): boolean {
  if (!lastTs || lastAuthor === "jp") return false;
  const mark = seen[slug];
  return !mark || mark < lastTs;
}
