/**
 * Teach by reacting (src/reactions.ts), offline.
 *
 *   npm run test:reactions
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-reactions-"));
process.env.INTERNS_HOME = home;

const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { InternManifestSchema } = await import("../src/types.js");
const { DEFAULT_STYLE } = await import("../src/style.js");
const { ApprovalService } = await import("../src/approvals.js");
const { reactTo, undoStyleChange, applyStyleCardAnswer, ownerSetStyle, learnedView, reactionsPrompt, asksFirst, ReactionError } = await import("../src/reactions.js");
import type { Reaction } from "../src/types.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.stack?.split("\n").slice(0, 8).join("\n      ") : err}`);
  }
}

const db = new Db(new EventBus(), home);
const registry = new Registry(home);
registry.save(InternManifestSchema.parse({ name: "Ingrid", role: "Event scout", system_prompt: "You find events.", tools: [] }), "ingrid");
const approvals = new ApprovalService(db, {} as never, {} as never, registry);

// Ahead of the wall clock: card answers (approvals.handle) use the real time.
let clock = Date.now() + 3_600_000;
const tick = () => new Date((clock += 60_000));
const say = (text = "There are three expos worth a look, and here is a long explanation of each.") =>
  db.addMessage({ intern: "ingrid", author: "intern", speaker: "ingrid", text, surface: "app", ts: tick().toISOString() });
const react = (id: string, r: Reaction | null) => reactTo(db, registry, id, r, tick());
const style = () => ({ ...DEFAULT_STYLE, ...registry.get("ingrid")!.style });
const dial = (d: "tone" | "length") => style()[d];
const setStyle = (d: "tone" | "length", v: number) => registry.save({ ...registry.get("ingrid")!, style: { ...style(), [d]: v } }, "ingrid");

try {
  await check("only an intern's own messages take reactions", () => {
    const mine = db.addMessage({ intern: "ingrid", author: "jp", text: "Any expos?", surface: "app" });
    assert.throws(() => react(mine.id, "too_long"), (e: unknown) => e instanceof ReactionError && e.status === 400);
    assert.throws(() => react("nope", "too_long"), (e: unknown) => e instanceof ReactionError && e.status === 404);
  });

  await check("a reaction sticks to the message and reaches the next run's prompt at once", () => {
    const m = say("Vet Congress has the most decision-makers but the booths are pricey.");
    const { message, change } = react(m.id, "too_long");
    assert.equal(message.reaction, "too_long");
    assert.equal(db.getMessage(m.id)!.reaction, "too_long");
    assert.equal(change, null);
    const prompt = reactionsPrompt(db, "ingrid", new Date(clock));
    assert.match(prompt, /## How .+ reacted to your recent messages/);
    assert.match(prompt, /"Vet Congress has the most decision-makers but the booths are pricey\.": too long/);
    react(m.id, null);
    assert.equal(db.getMessage(m.id)!.reaction, null, "taken back");
    assert.equal(reactionsPrompt(db, "ingrid", new Date(clock)), "");
  });

  await check("four 'too long' of the last ten: she moves Length herself and says so, with Undo", () => {
    const ms = [say(), say(), say(), say()];
    for (const m of ms.slice(0, 3)) assert.equal(react(m.id, "too_long").change, null);
    assert.equal(dial("length"), 3);
    const { change, card } = react(ms[3]!.id, "too_long");
    assert.ok(change && card);
    assert.equal(dial("length"), 2);
    assert.deepEqual([change.dial, change.from_value, change.to_value, change.reactions, change.asked], ["length", 3, 2, 4, false]);
    assert.equal(card.intern, "ingrid");
    assert.equal(card.title, "I've made myself briefer");
    assert.match(card.body, /You marked 4 of my last 10 messages too long, so I moved Length from Balanced to Brief/);
    assert.deepEqual(card.actions.map((a) => a.id), ["keep", "undo"]);
  });

  await check("counting starts over after a move", () => {
    assert.equal(react(say().id, "too_long").change, null);
    assert.equal(dial("length"), 2);
  });

  await check("opposite reactions cancel out", () => {
    const ms = [say(), say(), say(), say(), say()];
    react(ms[0]!.id, "too_formal");
    react(ms[1]!.id, "too_formal");
    react(ms[2]!.id, "too_casual");
    react(ms[3]!.id, "too_formal");
    assert.equal(react(ms[4]!.id, "perfect").change, null);
    assert.equal(dial("tone"), 3, "net two, not four");
  });

  await check("only her last ten messages count", () => {
    const old = say();
    react(old.id, "too_formal"); // net 3 with the ones above, but…
    for (let i = 0; i < 10; i++) say("Fresh message.");
    const latest = say("Newest.");
    assert.equal(react(latest.id, "too_formal").change, null, "the others fell out of the window");
    assert.equal(dial("tone"), 3);
  });

  await check("Undo puts the dial back, closes the card, and she asks first from then on", async () => {
    const card = db.listCards("open").find((c) => c.context.kind === "style_changed")!;
    await approvals.handle(card.id, "undo", { via: "app", action: "undo" });
    assert.equal(dial("length"), 3);
    assert.equal(asksFirst(db, "ingrid", "length"), true);
    assert.equal(asksFirst(db, "ingrid", "tone"), false);
    assert.equal(db.listStyleChanges("ingrid")[0]!.undone_at !== null, true);
    assert.equal(db.getCard(card.id)!.state, "resolved");
  });

  await check("asking first: a question card, nothing moves until the owner says yes", async () => {
    const ms = [say(), say(), say(), say()];
    for (const m of ms) react(m.id, "too_long");
    assert.equal(dial("length"), 3);
    const asks = db.listCards("open").filter((c) => c.context.kind === "style_suggest");
    assert.equal(asks.length, 1);
    const ask = asks[0]!;
    assert.equal(ask.title, "Should I keep it shorter?");
    assert.match(ask.body, /Shall I move Length from Balanced to Brief\?/);
    assert.deepEqual(ask.actions.map((a) => a.label), ["Keep it shorter", "Not now"]);
    react(say().id, "too_long");
    assert.equal(db.listCards("open").filter((c) => c.context.kind === "style_suggest").length, 1, "never two questions about one dial");
    applyStyleCardAnswer(db, registry, ask, "apply", tick());
    db.resolveCard(ask.id, { via: "app", action: "apply" });
    assert.equal(dial("length"), 2);
    assert.equal(db.listStyleChanges("ingrid")[0]!.asked, true);
  });

  await check("Not now starts the count again", async () => {
    const ms = [say(), say(), say(), say()];
    for (const m of ms) react(m.id, "too_short");
    const ask = db.listCards("open").find((c) => c.context.kind === "style_suggest")!;
    assert.equal(ask.title, "Should I give you more detail?");
    applyStyleCardAnswer(db, registry, ask, "not_now", tick());
    db.resolveCard(ask.id, { via: "app", action: "not_now" });
    assert.equal(dial("length"), 2);
    assert.equal(react(say().id, "too_short").card, null);
  });

  await check("setting a dial by hand makes her ask about that dial", () => {
    assert.equal(asksFirst(db, "ingrid", "tone"), false);
    ownerSetStyle(db, "ingrid", { tone: 3, length: 2, initiative: 3, humour: 3 }, { tone: 4, length: 2, initiative: 3, humour: 3 }, tick());
    assert.equal(asksFirst(db, "ingrid", "tone"), true);
  });

  await check("a dial at its end doesn't move further", () => {
    setStyle("tone", 1);
    db.setKv("react_ask:ingrid:tone", "0");
    for (let i = 0; i < 4; i++) react(say().id, "too_formal");
    assert.equal(dial("tone"), 1);
    assert.equal(db.listCards("open").filter((c) => c.context.kind === "style_suggest" && c.context.dial === "tone").length, 0);
  });

  await check("undo after a hand edit leaves the hand edit alone", () => {
    db.setKv("react_ask:ingrid:length", "0");
    db.setKv("react_since:ingrid:length", new Date(clock).toISOString()); // a clean count
    setStyle("length", 3);
    let change = null;
    for (let i = 0; i < 4; i++) change = react(say().id, "too_long").change ?? change;
    assert.ok(change);
    assert.equal(dial("length"), 2);
    setStyle("length", 5);
    const undone = undoStyleChange(db, registry, change.id, tick());
    assert.ok(undone?.undone_at);
    assert.equal(dial("length"), 5);
  });

  await check("Learned from you: this week's reactions, progress and changes", () => {
    const view = learnedView(db, "ingrid", new Date(clock));
    assert.equal(view.window, 10);
    assert.equal(view.threshold, 4);
    assert.ok((view.week.too_long ?? 0) >= 8);
    assert.ok((view.week.too_formal ?? 0) >= 4);
    assert.equal(view.week.perfect, 1);
    assert.deepEqual(view.asks_first, { tone: false, length: true });
    assert.equal(view.changes.length, 3);
  });
} finally {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall reaction checks passed" : `\n${failures} reaction check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
