/**
 * What reaches JP's lock screen, and when.
 *
 * Every intern has a level (manifest.notify, default "needs_you"):
 *   all       — every message and card buzzes straight away
 *   needs_you — replies to JP, questions and decisions buzz; the rest waits for the summary
 *   summary   — everything waits for the summary
 *   off       — nothing buzzes (it is all still in the app)
 * Urgent cards always buzz. During quiet hours (global, or an intern's
 * quiet_hours standing order) what would have buzzed waits instead.
 *
 * Held items go out together as one summary notification at JP's summary
 * times, and once more when quiet hours end. Every decision is written to
 * push_log, and the service worker reports which notifications JP opened:
 * an intern whose buzzes he keeps ignoring earns a gentle suggestion to move
 * them to the summary — and, if he likes, to tell them to message less.
 */
import { plainText } from "./notifytext.js";
import { localZone, ownerName } from "./profile.js";
import { inQuietHours } from "./rules.js";
import type { Db, PushDelivery, PushLogEntry } from "./db.js";
import type { Registry } from "./registry.js";
import type { Card, Message, NotifyLevel } from "./types.js";

export interface NotifySettings {
  /** local "HH:MM" times the summary goes out */
  summary_times: string[];
  /** overnight: only urgent things buzz; the rest arrives as one summary when it ends */
  quiet: { enabled: boolean; from: string; to: string };
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  summary_times: ["12:30", "17:30"],
  quiet: { enabled: true, from: "22:00", to: "07:00" },
};

const SETTINGS_KEY = "notify_settings";

export function getNotifySettings(db: Pick<Db, "getKv">): NotifySettings {
  try {
    const stored = JSON.parse(db.getKv(SETTINGS_KEY) ?? "{}") as Partial<NotifySettings>;
    return {
      summary_times: Array.isArray(stored.summary_times) ? stored.summary_times : DEFAULT_NOTIFY_SETTINGS.summary_times,
      quiet: { ...DEFAULT_NOTIFY_SETTINGS.quiet, ...(stored.quiet ?? {}) },
    };
  } catch {
    return DEFAULT_NOTIFY_SETTINGS;
  }
}

export function setNotifySettings(db: Pick<Db, "getKv" | "setKv">, patch: { summary_times?: string[]; quiet?: Partial<NotifySettings["quiet"]> }): NotifySettings {
  const current = getNotifySettings(db);
  const next: NotifySettings = {
    summary_times: patch.summary_times ? [...new Set(patch.summary_times)].sort() : current.summary_times,
    quiet: { ...current.quiet, ...(patch.quiet ?? {}) },
  };
  db.setKv(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export type Importance = "urgent" | "needs_you" | "fyi";

/** The one rule: level × importance × quiet → buzz now, hold for the summary, or leave in the app. */
export function decide(level: NotifyLevel, importance: Importance, quiet: boolean): PushDelivery {
  if (importance === "urgent") return "now";
  if (level === "off") return "off";
  if (level === "summary") return "summary";
  if (level === "needs_you" && importance === "fyi") return "summary";
  return quiet ? "summary" : "now";
}

export function cardImportance(card: Card): Importance {
  return card.severity === "urgent" ? "urgent" : card.severity === "action" ? "needs_you" : "fyi";
}

/** Answering JP or asking him something matters now; work an intern did on its own can wait. */
export function messageImportance(msg: Message): Importance {
  return msg.cause === "reply" || msg.cause === "ask" ? "needs_you" : "fyi";
}

export function levelOf(registry: Registry, slug: string): NotifyLevel {
  if (slug === "coordinator") return "needs_you";
  return registry.get(slug)?.notify ?? "needs_you";
}

/** "HH:MM" on the owner's clock. */
export function localHhmm(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: localZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

export function globalQuiet(settings: NotifySettings, now: Date): boolean {
  return settings.quiet.enabled && inQuietHours({ from: settings.quiet.from, to: settings.quiet.to }, now);
}

/** One notification for everything held: a line per intern, the newest few first. */
export function summaryText(pending: PushLogEntry[], nameOf: (slug: string) => string): { title: string; body: string } {
  const by = new Map<string, PushLogEntry[]>();
  for (const entry of pending) by.set(entry.intern, [...(by.get(entry.intern) ?? []), entry]);
  const lines = [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([slug, items]) => {
      const first = items[0]!;
      const what = first.kind === "card" ? plainText(first.title).replace(/^[^:]+:\s*/, "") : plainText(first.body);
      const line = `${nameOf(slug)}: ${what.replace(/\s+/g, " ").slice(0, 90)}`;
      return items.length > 1 ? `${line} (+${items.length - 1} more)` : line;
    });
  return { title: `${pending.length} update${pending.length === 1 ? "" : "s"} from the crew`, body: lines.join("\n") };
}

// --------------------------------------------------------------- learning

const SUGGEST_WINDOW_DAYS = 14;
const SUGGEST_MIN_BUZZES = 6;
const SUGGEST_MAX_OPEN_RATE = 0.2;
const SUGGEST_SNOOZE_DAYS = 30;

/** The guidance a "ask them to message less" answer leaves with the intern. */
export const messageLessGuidance = (owner = ownerName()) =>
  `Only message ${owner} unprompted when something needs their decision or can't wait. Everything else goes on your pages or into your next reply — ${owner} sees it in the summary.`;

/**
 * Interns JP keeps not opening: buzzed at least 6 times in two weeks and
 * opened at most one in five. One card each, at most once a month.
 */
export function suggestQuieter(db: Db, registry: Registry, now: Date = new Date()): Card[] {
  const since = new Date(now.getTime() - SUGGEST_WINDOW_DAYS * 86_400_000).toISOString();
  const cards: Card[] = [];
  for (const { slug, manifest } of registry.list()) {
    const level = manifest.notify ?? "needs_you";
    if (level === "summary" || level === "off") continue;
    const last = db.getKv(`notify_suggest:${slug}`);
    if (last && now.getTime() - Date.parse(last) < SUGGEST_SNOOZE_DAYS * 86_400_000) continue;
    const stats = db.pushStats(slug, since);
    if (stats.now < SUGGEST_MIN_BUZZES || stats.opened / stats.now > SUGGEST_MAX_OPEN_RATE) continue;
    db.setKv(`notify_suggest:${slug}`, now.toISOString());
    const { summary_times } = getNotifySettings(db);
    const when = summary_times.length ? `the ${summary_times.join(" and ")} summary` : "the app";
    cards.push(
      db.createCard({
        intern: "coordinator",
        title: `You rarely open ${manifest.name}'s notifications`,
        body:
          `${manifest.name} buzzed your phone ${stats.now} times in the last two weeks and you opened ${stats.opened === 0 ? "none" : stats.opened}. ` +
          `Move ${manifest.name} to the summary? Nothing gets lost: it's all still in the app and in ${when}. ` +
          `Urgent things still come through.`,
        severity: "info",
        actions: [
          { id: "summary", label: "Summary only", style: "primary", kind: "button" },
          { id: "summary_teach", label: `Summary, and ask ${manifest.name} to message less`, style: "neutral", kind: "button" },
          { id: "keep", label: "Keep buzzing", style: "neutral", kind: "button" },
        ],
        context: { kind: "notify_suggest", intern: slug },
      }),
    );
  }
  return cards;
}

/** JP answered a "rarely open" card (approvals.ts). */
export function applyQuieterAnswer(db: Db, registry: Registry, card: Card, actionId: string): void {
  const slug = String(card.context.intern ?? "");
  const manifest = registry.get(slug);
  if (!manifest || (actionId !== "summary" && actionId !== "summary_teach")) return;
  registry.save({ ...manifest, notify: "summary" }, slug);
  const guidance = messageLessGuidance();
  if (actionId === "summary_teach" && !db.listRules(slug).some((r) => r.text === guidance && !r.removed_at)) {
    db.createRule({ intern: slug, kind: "soft", type: "guidance", params: {}, text: guidance });
  }
}
