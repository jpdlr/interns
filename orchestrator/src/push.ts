/**
 * Web Push — buzzes JP's installed PWA (iOS 16.4+ home-screen installs only;
 * see app/README.md) when an intern raises a card or messages him.
 *
 * Subscriptions (one per browser install) live in SQLite (push_subscriptions,
 * db.ts). notify() fans a payload out to every stored subscription and
 * prunes any the push service reports as gone (404/410 — the browser
 * unsubscribed, cleared storage, or the endpoint expired). Individual send
 * failures never throw past notify(); callers (index.ts) still wrap the call
 * defensively since a bug here must never take the office down.
 */
import webpush from "web-push";
import { NOTIFY_BODY_CHARS, NOTIFY_TITLE_CHARS, notificationText, plainText } from "./notifytext.js";
import { cardImportance, decide, getNotifySettings, globalQuiet, levelOf, localHhmm, messageImportance, suggestQuieter, summaryText, type Importance } from "./notify.js";
import { quietNow } from "./rules.js";
import https from "node:https";
import type { Config } from "./config.js";
import type { Db, PushLogEntry } from "./db.js";
import type { EventBus } from "./events.js";
import type { Registry } from "./registry.js";
import type { Card, Message } from "./types.js";
import { coordinatorName } from "./profile.js";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface NotifyPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** push_log id: the service worker reports a tap on it (POST /push/opened/:id) */
  push_id?: string;
}

export interface PushDeliveryReport {
  attempted_at: string;
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  errors: string[];
}

export class PushService {
  private readonly ipv4Agent = new https.Agent({ keepAlive: true, family: 4 });
  private lastDelivery: PushDeliveryReport | null = null;

  constructor(
    private db: Db,
    private config: Config,
  ) {
    if (config.push.vapid_public && config.push.vapid_private) {
      webpush.setVapidDetails(config.push.subject, config.push.vapid_public, config.push.vapid_private);
    }
  }

  get vapidPublicKey(): string {
    return this.config.push.vapid_public;
  }

  subscribe(sub: PushSubscriptionJSON): void {
    this.db.upsertPushSubscription(sub);
  }

  unsubscribe(endpoint: string): void {
    this.db.deletePushSubscription(endpoint);
  }

  status(): { configured: boolean; subscriptions: number; last_delivery: PushDeliveryReport | null } {
    return {
      configured: Boolean(this.config.push.vapid_public && this.config.push.vapid_private),
      subscriptions: this.db.listPushSubscriptions().length,
      last_delivery: this.lastDelivery,
    };
  }

  /**
   * Fan out to every stored subscription. Never throws — failures are logged
   * and swallowed. Title and body are flattened from markdown here rather
   * than at each call site, so nothing an intern writes can leak raw markup
   * onto the lock screen.
   */
  async notify(input: NotifyPayload): Promise<PushDeliveryReport> {
    const payload: NotifyPayload = {
      ...input,
      title: notificationText(input.title, NOTIFY_TITLE_CHARS) || "Interns",
      body: notificationText(input.body, NOTIFY_BODY_CHARS),
    };
    const subs = this.db.listPushSubscriptions();
    const report: PushDeliveryReport = {
      attempted_at: new Date().toISOString(),
      subscriptions: subs.length,
      sent: 0,
      failed: 0,
      removed: 0,
      errors: [],
    };
    if (subs.length === 0) {
      this.lastDelivery = report;
      return report;
    }
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            {
              // This host intentionally has no IPv6 default route. Pinning the
              // push request to IPv4 avoids Node selecting Apple's AAAA record
              // first and waiting for a network timeout.
              agent: this.ipv4Agent,
              timeout: 15_000,
              TTL: 300,
              urgency: "normal",
            },
          );
          report.sent += 1;
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // Endpoint gone — the browser dropped the subscription; stop trying it.
            this.db.deletePushSubscription(sub.endpoint);
            report.removed += 1;
          } else {
            report.failed += 1;
            const message = err instanceof Error ? err.message : String(err);
            report.errors.push(message.slice(0, 240));
            console.error(`[push] send to ${sub.endpoint.slice(0, 60)}… failed:`, err);
          }
        }
      }),
    );
    this.lastDelivery = report;
    return report;
  }
}

/** A chatty intern must not spam the lock screen: at most one message notification per thread per minute. */
const MESSAGE_NOTIFY_DEBOUNCE_MS = 60_000;

export interface Notifier {
  /** Call once a minute: sends summaries at JP's summary times and when quiet hours end, and once a day looks for interns he never opens. */
  tick(now?: Date): Promise<void>;
  /** Send whatever is held right now as one summary (tests, and "send it now"). */
  sendSummary(): Promise<PushLogEntry | null>;
}

/**
 * Push notifications on card + message bus events, through the rules in
 * notify.ts: each one buzzes now, waits for the next summary, or stays in
 * the app — and is logged so opens can be counted. Independent of the
 * Discord adapter (which subscribes to the same bus events for its own
 * rendering). Called once from index.ts wherever the EventBus is wired up.
 */
export function wirePushNotifications(bus: EventBus, registry: Registry, push: Pick<PushService, "notify">, db: Db): Notifier {
  // A quiet_hours standing order holds an intern's lock-screen pings (the message/card still lands in the app).
  const internQuiet = (slug: string): boolean => (slug !== "coordinator" && !slug.startsWith("room-") ? quietNow(db, slug) : false);
  const internName = (slug: string): string =>
    slug === "coordinator" ? coordinatorName() : (registry.get(slug)?.name ?? slug);
  const messageTitle = (msg: Message): string => {
    const who = msg.author === "coordinator" ? coordinatorName() : internName(msg.speaker ?? msg.intern);
    if (msg.intern.startsWith("room-")) return `${who} · ${db.getRoom(msg.intern)?.name ?? "group"}`;
    return msg.speaker && msg.speaker !== msg.intern ? `${who} · in ${internName(msg.intern)}'s thread` : who;
  };
  const lastMessageNotifyAt = new Map<string, number>(); // thread -> ms epoch

  const route = (input: { intern: string; kind: "card" | "message"; ref: string; importance: Importance; title: string; body: string; url: string; tag: string; thread?: string }): void => {
    const quiet = globalQuiet(getNotifySettings(db), new Date()) || internQuiet(input.intern);
    const delivery = decide(levelOf(registry, input.intern), input.importance, quiet);
    // Bursts: the first buzz of a minute in a thread stands for the rest (its tag replaces it on the lock screen anyway).
    if (delivery === "now" && input.thread) {
      const now = Date.now();
      if (now - (lastMessageNotifyAt.get(input.thread) ?? 0) < MESSAGE_NOTIFY_DEBOUNCE_MS) return;
      lastMessageNotifyAt.set(input.thread, now);
    }
    const entry = db.logPush({ intern: input.intern, kind: input.kind, ref: input.ref, title: input.title, body: input.body, url: input.url, delivery });
    if (delivery !== "now") return;
    void push
      .notify({ title: input.title, body: input.body, url: input.url, tag: input.tag, push_id: entry.id })
      .catch((err) => console.error(`[push] ${input.kind} notify failed:`, err));
  };

  bus.on("card", (card: Card) => {
    route({
      intern: card.intern,
      kind: "card",
      ref: card.id,
      importance: cardImportance(card),
      title: `${internName(card.intern)}: ${plainText(card.title)}`,
      body: card.body,
      // /cards is also the JSON API route, so a cold browser navigation
      // cannot use it (it has no bearer header). /inbox is a public app-only
      // bridge that immediately replaces itself with the tab route.
      url: `/inbox?card=${encodeURIComponent(card.id)}`,
      tag: `card-${card.id}`,
    });
  });

  bus.on("message", (msg: Message) => {
    if (msg.author !== "intern" && msg.author !== "coordinator") return; // never JP's own messages
    // The coordinator acknowledging what JP just did ("💡 Saved to Ideas", "Group created") is not news,
    // and the morning standup in its own thread has its own notification (orchestrator.runStandup).
    if (msg.author === "coordinator" && (msg.reply_to || msg.cause === "reply" || msg.intern === "coordinator")) return;
    route({
      thread: msg.intern,
      intern: msg.author === "coordinator" ? "coordinator" : (msg.speaker ?? msg.intern),
      kind: "message",
      ref: msg.id,
      importance: messageImportance(msg),
      title: messageTitle(msg),
      body: msg.text,
      url: `/chat/${msg.intern}?message=${encodeURIComponent(msg.id)}`,
      tag: `msg-${msg.intern}`,
    });
  });

  const sendSummary = async (): Promise<PushLogEntry | null> => {
    const pending = db.pendingSummary();
    if (pending.length === 0) return null;
    const { title, body } = summaryText(pending, internName);
    const entry = db.logPush({ intern: "coordinator", kind: "summary", title, body, url: "/today", delivery: "now" });
    db.markSummarized(pending.map((p) => p.id), entry.id);
    try {
      await push.notify({ title, body, url: "/today", tag: "summary", push_id: entry.id });
    } catch (err) {
      console.error("[push] summary notify failed:", err);
    }
    return entry;
  };

  let lastMinute = "";
  let lastSuggestDay = "";
  return {
    sendSummary,
    async tick(now = new Date()) {
      const hhmm = localHhmm(now);
      if (hhmm === lastMinute) return;
      lastMinute = hhmm;
      const settings = getNotifySettings(db);
      // "Never" means held updates just wait in the app — no morning summary either.
      const quietEnds = settings.quiet.enabled && hhmm === settings.quiet.to && settings.summary_times.length > 0;
      if (quietEnds || (settings.summary_times.includes(hhmm) && !globalQuiet(settings, now))) await sendSummary();
      // Once a day, early evening: anyone whose buzzes JP keeps ignoring?
      const day = now.toISOString().slice(0, 10);
      if (hhmm >= "18:00" && day !== lastSuggestDay) {
        lastSuggestDay = day;
        try {
          suggestQuieter(db, registry, now);
        } catch (err) {
          console.error("[notify] quieter suggestions failed:", err);
        }
      }
    },
  };
}
