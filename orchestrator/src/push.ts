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
import { quietNow } from "./rules.js";
import https from "node:https";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Registry } from "./registry.js";
import type { Card, Message } from "./types.js";

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

/** A chatty intern must not spam the lock screen: at most one message notification per intern per minute. */
const MESSAGE_NOTIFY_DEBOUNCE_MS = 60_000;

/**
 * Push notifications on card + message bus events. Independent of the
 * Discord adapter (which subscribes to the same bus events for its own
 * rendering) — this never reuses or duplicates its send logic. Called once
 * from index.ts wherever the EventBus is wired up.
 */
export function wirePushNotifications(bus: EventBus, registry: Registry, push: PushService, db?: Pick<Db, "getRoom" | "listRules" | "recordRuleHit">): void {
  // A quiet_hours standing order holds an intern's lock-screen pings (the message/card still lands in the app).
  const quiet = (slug: string): boolean => (db && slug !== "coordinator" && !slug.startsWith("room-") ? quietNow(db, slug) : false);
  const internName = (slug: string): string =>
    slug === "coordinator" ? "Chaos Coordinator" : (registry.get(slug)?.name ?? slug);
  const messageTitle = (msg: Message): string => {
    const who = msg.author === "coordinator" ? "Chaos Coordinator" : internName(msg.speaker ?? msg.intern);
    if (msg.intern.startsWith("room-")) return `${who} · ${db?.getRoom(msg.intern)?.name ?? "group"}`;
    return msg.speaker && msg.speaker !== msg.intern ? `${who} · in ${internName(msg.intern)}'s thread` : who;
  };
  const lastMessageNotifyAt = new Map<string, number>(); // intern slug -> ms epoch

  bus.on("card", (card: Card) => {
    if (card.severity !== "urgent" && quiet(card.intern)) return;
    void push
      .notify({
        title: `${internName(card.intern)}: ${plainText(card.title)}`,
        body: card.body,
        // /cards is also the JSON API route, so a cold browser navigation
        // cannot use it (it has no bearer header). /inbox is a public app-only
        // bridge that immediately replaces itself with the tab route.
        url: `/inbox?card=${encodeURIComponent(card.id)}`,
        tag: `card-${card.id}`,
      })
      .catch((err) => console.error("[push] card notify failed:", err));
  });

  bus.on("message", (msg: Message) => {
    if (msg.author !== "intern" && msg.author !== "coordinator") return; // never JP's own messages
    // The coordinator acknowledging what JP just did ("💡 Saved to Ideas", "Who should take this?") is not news.
    if (msg.author === "coordinator" && msg.reply_to) return;
    if (quiet(msg.speaker ?? msg.intern)) return;
    const now = Date.now();
    const last = lastMessageNotifyAt.get(msg.intern) ?? 0;
    if (now - last < MESSAGE_NOTIFY_DEBOUNCE_MS) return;
    lastMessageNotifyAt.set(msg.intern, now);
    void push
      .notify({
        title: messageTitle(msg),
        body: msg.text,
        url: `/chat/${msg.intern}?message=${encodeURIComponent(msg.id)}`,
        tag: `msg-${msg.intern}`,
      })
      .catch((err) => console.error("[push] message notify failed:", err));
  });
}
