/**
 * "N changes since you looked" is a device-local notion, like unread: we
 * remember the page version JP last opened and compare it to the current
 * one (docs/features/contracts.md §2). Kept in memory too, so every preview
 * of the same page updates the moment the page screen marks it seen.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "interns.pageSeen.v1";

type SeenVersions = Record<string, number>;

let cache: SeenVersions | null = null;
const listeners = new Set<() => void>();

export async function loadPageSeen(): Promise<SeenVersions> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as SeenVersions) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export async function markPageSeen(id: string, version: number): Promise<void> {
  const seen = await loadPageSeen();
  if ((seen[id] ?? 0) >= version) return;
  seen[id] = version;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seen)).catch(() => {});
  for (const listener of listeners) listener();
}

export function onPageSeenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener) as unknown as void;
}

/** Display string for unseen changes: "" when none or never opened, "9+" past nine. */
export function changesLabel(seenVersion: number | undefined, version: number): string {
  if (seenVersion === undefined) return "";
  const n = version - seenVersion;
  if (n <= 0) return "";
  return `${n > 9 ? "9+" : n} change${n === 1 ? "" : "s"} since you looked`;
}
