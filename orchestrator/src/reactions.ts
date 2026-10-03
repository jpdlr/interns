/**
 * Teach by reacting.
 *
 * The owner long-presses an intern's message and taps a verdict: Perfect,
 * Too long, Too short, Too formal, Too casual, Missed the point. Every
 * reaction reaches the intern's next run straight away (reactionsPrompt). When
 * one kind adds up (4 of the intern's last 10 messages, net of its opposite),
 * the matching personality dial moves one stop: Length for long/short, Tone
 * for formal/casual.
 *
 * The intern moves the dial itself and says so on a card with Undo. Once the
 * owner undoes such a move, or sets that dial by hand, the intern asks first
 * for that dial from then on ("Should I keep it shorter?").
 *
 * Deterministic: no model call. Counting restarts after every move, undo,
 * "Not now" or hand edit of the dial (kv react_since:<slug>:<dial>).
 */
import type { Db, StyleChange } from "./db.js";
import { ownerName } from "./profile.js";
import type { Registry } from "./registry.js";
import { DEFAULT_STYLE, type Style } from "./style.js";
import type { Card, Message, Reaction } from "./types.js";

/** How many of the intern's latest messages are looked at. */
export const REACT_WINDOW = 10;
/** Net reactions of one kind among them before the dial moves. */
export const REACT_THRESHOLD = 4;

export type ReactDial = "tone" | "length";

interface Nudge {
  dial: ReactDial;
  step: 1 | -1;
  opposite: Reaction;
  /** "too long" */
  label: string;
  ask: string;
  apply: string;
  done: string;
}

export const NUDGES: Partial<Record<Reaction, Nudge>> = {
  too_long: { dial: "length", step: -1, opposite: "too_short", label: "too long", ask: "Should I keep it shorter?", apply: "Keep it shorter", done: "I've made myself briefer" },
  too_short: { dial: "length", step: 1, opposite: "too_long", label: "too short", ask: "Should I give you more detail?", apply: "Give me more", done: "I'll give you more detail" },
  too_formal: { dial: "tone", step: -1, opposite: "too_casual", label: "too formal", ask: "Should I loosen up?", apply: "Loosen up", done: "I've loosened up" },
  too_casual: { dial: "tone", step: 1, opposite: "too_formal", label: "too casual", ask: "Should I be more polished?", apply: "Be more polished", done: "I've polished up" },
};

/** Stop names, as on the dials in the app (app/src/style.ts). */
const DIAL_TITLE: Record<ReactDial, string> = { tone: "Tone", length: "Length" };
const STOPS: Record<ReactDial, string[]> = {
  tone: ["Very casual", "Casual", "Natural", "Polished", "Formal"],
  length: ["One-liners", "Brief", "Balanced", "Thorough", "Detailed"],
};
const stop = (dial: ReactDial, v: number) => STOPS[dial][v - 1] ?? String(v);

/** How a reaction reads in the intern's prompt. */
const PROMPT_LABEL: Record<Reaction, string> = {
  perfect: "just right",
  too_long: "too long",
  too_short: "too short",
  too_formal: "too formal",
  too_casual: "too casual",
  missed: "missed the point",
};

const sinceKey = (slug: string, dial: ReactDial) => `react_since:${slug}:${dial}`;
const askKey = (slug: string, dial: ReactDial) => `react_ask:${slug}:${dial}`;

export class ReactionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

/** Does the intern ask before moving this dial? */
export function asksFirst(db: Db, slug: string, dial: ReactDial): boolean {
  return db.getKv(askKey(slug, dial)) === "1";
}

function restartCount(db: Db, slug: string, dial: ReactDial, now: Date): void {
  db.setKv(sinceKey(slug, dial), now.toISOString());
}

/** Net count of `reaction` among the intern's latest messages, counting since the dial last moved. */
export function tally(db: Db, slug: string, reaction: Reaction): number {
  const nudge = NUDGES[reaction];
  if (!nudge) return 0;
  const since = db.getKv(sinceKey(slug, nudge.dial)) ?? "";
  let n = 0;
  for (const m of db.latestBySpeaker(slug, REACT_WINDOW)) {
    if (!m.reaction || !m.reacted_at || m.reacted_at < since) continue;
    if (m.reaction === reaction) n++;
    else if (m.reaction === nudge.opposite) n--;
  }
  return Math.max(0, n);
}

function setDial(registry: Registry, slug: string, dial: ReactDial, value: number): boolean {
  const manifest = registry.get(slug);
  if (!manifest) return false;
  const style: Style = { ...DEFAULT_STYLE, ...manifest.style, [dial]: value };
  registry.save({ ...manifest, style }, slug);
  return true;
}

export interface ReactResult {
  message: Message;
  /** the dial the intern just moved on its own */
  change: StyleChange | null;
  /** its card: "I've made myself briefer" (with Undo) or "Should I keep it shorter?" */
  card: Card | null;
}

/** The owner reacted to a message (null takes the reaction back). */
export function reactTo(db: Db, registry: Registry, messageId: string, reaction: Reaction | null, now: Date = new Date()): ReactResult {
  const existing = db.getMessage(messageId);
  if (!existing) throw new ReactionError("no such message", 404);
  const slug = existing.speaker ?? existing.intern;
  const manifest = existing.author === "intern" ? registry.get(slug) : undefined;
  if (!manifest) throw new ReactionError("only an intern's messages take reactions", 400);
  const message = db.setReaction(messageId, reaction, now)!;
  const nudge = reaction ? NUDGES[reaction] : undefined;
  if (!reaction || !nudge) return { message, change: null, card: null };

  const count = tally(db, slug, reaction);
  if (count < REACT_THRESHOLD) return { message, change: null, card: null };
  const from = (manifest.style ?? DEFAULT_STYLE)[nudge.dial];
  const to = Math.min(5, Math.max(1, from + nudge.step));
  if (to === from) return { message, change: null, card: null }; // already at the end of the dial
  const why = `You marked ${count} of my last ${REACT_WINDOW} messages ${nudge.label}`;
  const context = { dial: nudge.dial, from, to, reaction, reactions: count };

  if (asksFirst(db, slug, nudge.dial)) {
    const open = db.listCards("open").some((c) => c.intern === slug && c.context.kind === "style_suggest" && c.context.dial === nudge.dial);
    if (open) return { message, change: null, card: null };
    const card = db.createCard({
      intern: slug,
      title: nudge.ask,
      body: `${why}. Shall I move ${DIAL_TITLE[nudge.dial]} from ${stop(nudge.dial, from)} to ${stop(nudge.dial, to)}?`,
      severity: "info",
      actions: [
        { id: "apply", label: nudge.apply, style: "primary", kind: "button" },
        { id: "not_now", label: "Not now", style: "neutral", kind: "button" },
      ],
      context: { kind: "style_suggest", ...context },
    });
    return { message, change: null, card };
  }

  setDial(registry, slug, nudge.dial, to);
  restartCount(db, slug, nudge.dial, now);
  const change = db.addStyleChange({ intern: slug, dial: nudge.dial, from_value: from, to_value: to, reaction, reactions: count, asked: false, created_at: now.toISOString() });
  const card = db.createCard({
    intern: slug,
    title: nudge.done,
    body: `${why}, so I moved ${DIAL_TITLE[nudge.dial]} from ${stop(nudge.dial, from)} to ${stop(nudge.dial, to)}. Undo it if that's not what you meant, and I'll ask first next time.`,
    severity: "info",
    actions: [
      { id: "keep", label: "Keep it", style: "primary", kind: "button" },
      { id: "undo", label: "Undo", style: "neutral", kind: "button" },
    ],
    context: { kind: "style_changed", change_id: change.id, ...context },
  });
  return { message, change, card };
}

/**
 * Put a dial back where it was. From then on the intern asks before moving
 * that dial. The change's card, if still open, is closed.
 */
export function undoStyleChange(db: Db, registry: Registry, changeId: string, now: Date = new Date()): StyleChange | null {
  const change = db.getStyleChange(changeId);
  if (!change) return null;
  if (!change.undone_at) {
    const manifest = registry.get(change.intern);
    // Only if nobody has moved it since; a later hand edit wins.
    if (manifest && (manifest.style ?? DEFAULT_STYLE)[change.dial] === change.to_value) setDial(registry, change.intern, change.dial, change.from_value);
    db.markStyleChangeUndone(change.id, now);
    db.setKv(askKey(change.intern, change.dial), "1");
    restartCount(db, change.intern, change.dial, now);
  }
  for (const card of db.listCards("open")) {
    if (card.context.kind === "style_changed" && card.context.change_id === change.id) db.resolveCard(card.id, { via: "app", action: "undo" });
  }
  return db.getStyleChange(change.id) ?? null;
}

/** The owner answered a reaction card (approvals.ts). */
export function applyStyleCardAnswer(db: Db, registry: Registry, card: Card, actionId: string, now: Date = new Date()): void {
  const slug = card.intern;
  const dial = card.context.dial === "tone" || card.context.dial === "length" ? card.context.dial : null;
  if (!dial) return;
  if (card.context.kind === "style_changed") {
    if (actionId === "undo" && typeof card.context.change_id === "string") undoStyleChange(db, registry, card.context.change_id, now);
    return;
  }
  if (card.context.kind !== "style_suggest") return;
  restartCount(db, slug, dial, now);
  if (actionId !== "apply") return;
  const manifest = registry.get(slug);
  const from = Number(card.context.from);
  const to = Number(card.context.to);
  if (!manifest || (manifest.style ?? DEFAULT_STYLE)[dial] !== from) return; // moved by hand meanwhile
  setDial(registry, slug, dial, to);
  db.addStyleChange({
    intern: slug,
    dial,
    from_value: from,
    to_value: to,
    reaction: String(card.context.reaction) as Reaction,
    reactions: Number(card.context.reactions) || 0,
    asked: true,
    created_at: now.toISOString(),
  });
}

/** The owner set a dial by hand (PATCH /interns/:slug): the intern asks before moving it again. */
export function ownerSetStyle(db: Db, slug: string, before: Style, after: Style, now: Date = new Date()): void {
  for (const dial of ["tone", "length"] as const) {
    if (before[dial] === after[dial]) continue;
    db.setKv(askKey(slug, dial), "1");
    restartCount(db, slug, dial, now);
  }
}

/** For the personality editor's "Learned from you". */
export function learnedView(db: Db, slug: string, now: Date = new Date()) {
  const week = db.reactionsSince(slug, new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const counts: Partial<Record<Reaction, number>> = {};
  for (const r of week) counts[r.reaction] = (counts[r.reaction] ?? 0) + 1;
  const progress = (Object.keys(NUDGES) as Reaction[])
    .map((reaction) => ({ reaction, dial: NUDGES[reaction]!.dial, count: tally(db, slug, reaction) }))
    .filter((p) => p.count > 0);
  return {
    window: REACT_WINDOW,
    threshold: REACT_THRESHOLD,
    week: counts,
    progress,
    asks_first: { tone: asksFirst(db, slug, "tone"), length: asksFirst(db, slug, "length") },
    changes: db.listStyleChanges(slug, 10),
  };
}

/**
 * The owner's recent reactions, for the intern's system prompt, so a single
 * "too long" already shapes the next reply. The last three days, at most six.
 */
export function reactionsPrompt(db: Db, slug: string, now: Date = new Date()): string {
  const recent = db.reactionsSince(slug, new Date(now.getTime() - 3 * 86_400_000).toISOString()).slice(-6);
  if (!recent.length) return "";
  const owner = ownerName();
  const lines = recent.map((r) => {
    const snippet = r.text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
    return `- "${snippet}${snippet.length >= 90 ? "…" : ""}": ${PROMPT_LABEL[r.reaction]}`;
  });
  return `\n## How ${owner} reacted to your recent messages\n${lines.join("\n")}\nLet this shape how you write from now on, without mentioning it.`;
}
