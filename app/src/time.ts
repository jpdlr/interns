/** Relative-time helpers for message and card timestamps (all ISO 8601 UTC). */

export function relativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  // "numeric", not "2-digit": 9:05, not 09:05, in 12-hour locales.
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Thursday, 3 Aug" style separator for message day breaks. */
export function dayKey(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toDateString();
}

export function dayLabel(iso: string, now: number = Date.now()): string {
  const date = new Date(Date.parse(iso));
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - 86_400_000).toDateString();
  if (date.toDateString() === today) return "Today";
  if (date.toDateString() === yesterday) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
