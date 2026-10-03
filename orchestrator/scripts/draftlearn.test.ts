/**
 * Learning from the owner's draft edits (src/draftlearn.ts), offline: a fake
 * graph-mail runner and a fake pattern call.
 *
 *   npm run test:draftlearn
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-draftlearn-"));
process.env.INTERNS_HOME = home;

const { loadConfig } = await import("../src/config.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { InternManifestSchema } = await import("../src/types.js");
const { DraftLearner, wasEdited, applyDraftLearnAnswer } = await import("../src/draftlearn.js");
import type { SentDraft } from "../src/draftlearn.js";

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

const config = loadConfig(home);
config.mailboxes = ["work"];
const db = new Db(new EventBus(), home);
const registry = new Registry(home);
registry.save(InternManifestSchema.parse({ name: "Sam", role: "Inbox", system_prompt: "You draft mail.", tools: ["mail"] }), "sam");

let outbox: SentDraft[] = [];
const learnCalls: { intern: string; edits: number; rejected: string[] }[] = [];
let verdict: { rule: string | null; why: string } = { rule: "Sign off with just your first name", why: "you cut every sign-off down to your name" };
const learner = new DraftLearner(db, registry, config, {
  home,
  runner: async () => {
    const out = outbox;
    outbox = [];
    return out;
  },
  learn: async ({ intern, edits, rejected }) => {
    learnCalls.push({ intern, edits: edits.length, rejected });
    return verdict;
  },
});
const sent = (id: string, original: string, final: string, intern: string | null = "sam"): SentDraft => ({
  draft_id: id, intern, mailbox: "work", subject: "RE: Demo", intern_body: original, sent_body: final, sent_at: "2026-10-03T10:00:00Z",
});

try {
  await check("an edit is a real change: not identical, not just a signature, not a one-character tweak", () => {
    assert.equal(wasEdited("Hi Ada, Thursday works.", "Hi Ada,  Thursday works."), false, "whitespace");
    assert.equal(wasEdited("Hi Ada, Thursday works.", "Hi Ada, Thursday works.\n\nSam de Wet\nNorthwind | +27 21 000 0000"), false, "signature appended");
    assert.equal(wasEdited("Hi Ada, Thursday works.", ""), false, "nothing came back");
    assert.equal(
      wasEdited("Hi Ada, Thursday at 10:00 works perfectly for the demo. Kind regards, Sam", "Hi Ada, Thursday 10:00 works. Sam"),
      true,
    );
  });

  await check("one edit is kept but not enough to suggest anything", async () => {
    outbox = [sent("d1", "Hi Ada, Thursday works well for us. Kind regards, Sam", "Hi Ada, Thursday works. Sam"), sent("d0", "Same text", "Same text")];
    const cards = await learner.tick();
    assert.equal(cards.length, 0);
    assert.equal(db.unlearnedDraftEdits("sam").length, 1, "the unchanged draft was not kept");
    assert.equal(learnCalls.length, 0);
  });

  await check("unknown interns and repeats are ignored", async () => {
    outbox = [sent("d1", "Hi Ada, Thursday works well for us. Kind regards, Sam", "Hi Ada, Thursday works. Sam"), sent("x9", "A long draft here", "Short", "nobody"), sent("x8", "Draft", "Changed a lot here", null)];
    await learner.tick();
    assert.equal(db.unlearnedDraftEdits("sam").length, 1);
    assert.equal(db.internsWithUnlearnedEdits().length, 1);
  });

  await check("a second edit: one pattern call, and the intern asks to make it a standing order", async () => {
    outbox = [sent("d2", "Hello Lena, attached is the quote you asked for. Warm regards, Sam", "Hello Lena, quote attached. Sam")];
    const cards = await learner.tick();
    assert.equal(learnCalls.length, 1);
    assert.deepEqual(learnCalls[0], { intern: "Sam", edits: 2, rejected: [] });
    assert.equal(cards.length, 1);
    const card = cards[0]!;
    assert.equal(card.intern, "sam");
    assert.equal(card.title, "Learned from your edits");
    assert.match(card.body, /my last 2 drafts before sending: you cut every sign-off down to your name/);
    assert.match(card.body, /> Sign off with just your first name/);
    assert.deepEqual(card.actions.map((a) => a.id), ["save", "not_now", "never"]);
    assert.equal(db.unlearnedDraftEdits("sam").length, 0, "those edits are used up");
  });

  await check("Save it: a standing order the intern announces in its next reply; never saved twice", () => {
    const card = db.listCards("open").find((c) => c.context.kind === "draft_learn")!;
    applyDraftLearnAnswer(db, card, "save");
    applyDraftLearnAnswer(db, card, "save");
    const rules = db.listRules("sam").filter((r) => r.text === "Sign off with just your first name");
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.type, "guidance");
    assert.ok(db.hasPendingAnnouncements("sam", "1970-01-01T00:00:00Z"), "a rule chip rides on the next reply");
    db.resolveCard(card.id, { via: "app", action: "save" });
  });

  await check("a pattern already saved isn't suggested again; Not now snoozes; Never is remembered", async () => {
    outbox = [sent("d3", "Hi Ada, here is the agenda for tomorrow. Kind regards, Sam", "Hi Ada, agenda attached. Sam"), sent("d4", "Hi Ben, thanks for the quick reply! Warm regards, Sam", "Thanks Ben. Sam")];
    assert.equal((await learner.tick()).length, 0, "same rule as the one saved");

    verdict = { rule: "Never use exclamation marks", why: "you took out every exclamation mark" };
    outbox = [sent("d5", "Great news! The demo is booked! Kind regards, Sam", "The demo is booked. Sam"), sent("d6", "Thanks so much! See you soon! Sam", "Thanks, see you soon. Sam")];
    const [card] = await learner.tick();
    assert.ok(card);
    const now = new Date("2026-10-03T12:00:00Z");
    applyDraftLearnAnswer(db, card!, "not_now", now);
    db.resolveCard(card!.id, { via: "app", action: "not_now" });
    outbox = [sent("d7", "Hello! Lovely to meet you! Sam", "Hello, lovely to meet you. Sam"), sent("d8", "Brilliant! Done! Sam", "Done. Sam")];
    assert.equal((await learner.tick(new Date("2026-10-05T12:00:00Z"))).length, 0, "snoozed for a week");
    assert.equal(db.unlearnedDraftEdits("sam").length, 2, "edits wait for the snooze to end");
    const [again] = await learner.tick(new Date("2026-10-11T12:00:00Z"));
    assert.ok(again, "asks again after the snooze");
    applyDraftLearnAnswer(db, again!, "never");
    db.resolveCard(again!.id, { via: "app", action: "never" });
    outbox = [sent("d9", "Wow! Thanks! Sam", "Thanks. Sam"), sent("d10", "Yes! Absolutely! Sam", "Yes. Sam")];
    assert.equal((await learner.tick(new Date("2026-10-20T12:00:00Z"))).length, 0, "never again");
    assert.deepEqual(learnCalls.at(-1)!.rejected, ["Never use exclamation marks"], "and the model is told so");
  });

  await check("a failing pattern call leaves the edits for next time", async () => {
    const failing = new DraftLearner(db, registry, config, {
      home,
      runner: async () => [sent("e1", "A long and winding draft for Ada. Regards, Sam", "Short. Sam"), sent("e2", "Another long and winding draft. Regards, Sam", "Short too. Sam")],
      learn: async () => {
        throw new Error("model unavailable");
      },
    });
    assert.equal((await failing.tick(new Date("2026-10-21T12:00:00Z"))).length, 0);
    assert.equal(db.unlearnedDraftEdits("sam").length, 2);
  });
} finally {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall draft-learning checks passed" : `\n${failures} draft-learning check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
