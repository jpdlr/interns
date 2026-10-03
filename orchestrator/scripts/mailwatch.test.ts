/**
 * Standalone mailwatch test — no Graph, no Discord, no Agent SDK.
 * Runs against a temp INTERNS_HOME with a fake graph-mail CLI.
 *
 *   npx tsx scripts/mailwatch.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "interns-mailwatch-"));
process.env.INTERNS_HOME = tmpHome;

const { loadConfig } = await import("../src/config.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { MailWatcher, selectNewMessages, advanceWatermark, parseInboxOutput, summarize, isIgnoredMessage, isVipMessage } =
  await import("../src/mailwatch.js");
import type { MailMessage, MailboxWatermark } from "../src/mailwatch.js";
import type { Config } from "../src/config.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err}`);
  }
}

function mail(id: string, received: string, subject = `subject ${id}`): MailMessage {
  return { id, conversationId: `c-${id}`, from: "someone@example.com", subject, received, preview: "hello" };
}

console.log(`mailwatch tests (home=${tmpHome})`);

// ------------------------------------------------------------- pure logic

await check("no watermark yet → nothing is new (first tick adopts a baseline)", () => {
  assert.deepEqual(selectNewMessages([mail("a", "2026-08-23T10:00:00Z")], undefined), []);
});

await check("messages after the watermark are new", () => {
  const mark: MailboxWatermark = { last_received: "2026-08-23T10:00:00Z", seen_ids: ["a"], updated_at: "x" };
  const fresh = selectNewMessages([mail("b", "2026-08-23T10:05:00Z"), mail("a", "2026-08-23T10:00:00Z")], mark);
  assert.deepEqual(fresh.map((m) => m.id), ["b"]);
});

await check("already-seen ids never re-fire, even at the same timestamp", () => {
  const mark: MailboxWatermark = { last_received: "2026-08-23T10:00:00Z", seen_ids: ["a", "b"], updated_at: "x" };
  assert.deepEqual(selectNewMessages([mail("a", "2026-08-23T10:00:00Z"), mail("b", "2026-08-23T10:00:00Z")], mark), []);
});

await check("unseen message tied at the watermark timestamp is new", () => {
  const mark: MailboxWatermark = { last_received: "2026-08-23T10:00:00Z", seen_ids: ["a"], updated_at: "x" };
  assert.deepEqual(selectNewMessages([mail("z", "2026-08-23T10:00:00Z")], mark).map((m) => m.id), ["z"]);
});

await check("older mail below the watermark is ignored", () => {
  const mark: MailboxWatermark = { last_received: "2026-08-23T10:00:00Z", seen_ids: [], updated_at: "x" };
  assert.deepEqual(selectNewMessages([mail("old", "2026-08-22T09:00:00Z")], mark), []);
});

await check("advanceWatermark moves forward only and remembers ids", () => {
  const first = advanceWatermark([mail("a", "2026-08-23T10:00:00Z")], undefined);
  assert.equal(first.last_received, "2026-08-23T10:00:00Z");
  assert.deepEqual(first.seen_ids, ["a"]);
  const second = advanceWatermark([mail("b", "2026-08-23T10:05:00Z"), mail("a", "2026-08-23T10:00:00Z")], first);
  assert.equal(second.last_received, "2026-08-23T10:05:00Z");
  assert.deepEqual(second.seen_ids, ["b", "a"]);
  // a late, backdated message must not drag the mark backwards
  const third = advanceWatermark([mail("c", "2026-08-23T09:00:00Z")], second);
  assert.equal(third.last_received, "2026-08-23T10:05:00Z");
  assert.ok(third.seen_ids.includes("c"));
});

await check("parseInboxOutput tolerates junk rows and rejects CLI errors", () => {
  const parsed = parseInboxOutput(
    JSON.stringify([
      { id: "a", conversationId: "c", from: "x@y.z", subject: "hi", received: "2026-08-23T10:00:00Z", preview: "p" },
      { nope: true },
      null,
    ]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.subject, "hi");
  assert.throws(() => parseInboxOutput(JSON.stringify({ error: "no token cache" })), /no token cache/);
  assert.throws(() => parseInboxOutput("not json"));
});

await check("summary is human-readable", () => {
  const text = summarize([mail("a", "2026-08-23T10:00:00Z", "Invoice")], "default");
  assert.match(text, /^New mail arrived: 1 message\./);
  assert.match(text, /Invoice/);
});

const defaultTriage: Config["mail_triage"] = {
  ignore_from: ["noreply", "no-reply", "notifications?@", "mailer-daemon", "newsletter", "list-"],
  ignore_subject: ["unsubscribe"],
  vip_from: ["boss@"],
};

await check("Layer 1: ignore_from matches case-insensitively", () => {
  assert.equal(isIgnoredMessage({ ...mail("a", "x"), from: "NoReply@service.com" }, defaultTriage), true);
  assert.equal(isIgnoredMessage({ ...mail("a", "x"), from: "notifications@app.io" }, defaultTriage), true);
  assert.equal(isIgnoredMessage({ ...mail("a", "x"), from: "friend@example.com" }, defaultTriage), false);
});

await check("Layer 1: ignore_subject matches regardless of sender", () => {
  const m = { ...mail("a", "x", "please Unsubscribe now"), from: "friend@example.com" };
  assert.equal(isIgnoredMessage(m, defaultTriage), true);
});

await check("Layer 1: vip_from is independent of ignore lists", () => {
  const vip = { ...mail("a", "x"), from: "boss@company.com" };
  assert.equal(isIgnoredMessage(vip, defaultTriage), false);
  assert.equal(isVipMessage(vip, defaultTriage), true);
  assert.equal(isVipMessage({ ...mail("a", "x"), from: "friend@example.com" }, defaultTriage), false);
});

// ------------------------------------------------------ end-to-end ticks

const config = loadConfig(tmpHome);
// These legacy checks below predate layered triage and assert "fresh mail
// always fires immediately" — disable the cooldown gate so that behaviour is
// preserved, and inject a fake Layer-3 gate that always wakes (mirrors the
// fake CLI: no real Agent SDK / network calls in this test). Cooldown/VIP/hold
// behaviour gets its own dedicated watcher+checks further down.
config.mail_trigger_cooldown_minutes = 0;
// two mailboxes: "work" carries the mail, "side" is polled alongside it
config.mailboxes = ["work", "side"];
const bus = new EventBus();
const db = new Db(bus, tmpHome);
const registry = new Registry(tmpHome);

registry.save(
  {
    name: "Mail PA",
    role: "assistant",
    icon: "default",
    persona: "",
    system_prompt: "you read mail",
    tools: [],
    triggers: { mail_push: true },
    backlog: [],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  },
  "mail-pa",
);
registry.save(
  {
    name: "No Mail",
    role: "other",
    icon: "default",
    persona: "",
    system_prompt: "no mail for me",
    tools: [],
    triggers: {},
    backlog: [],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  },
  "no-mail",
);

let inbox: MailMessage[] = [mail("m1", "2026-08-23T10:00:00Z")];
let cliCalls = 0;
let failNext = false;
const watcher = new MailWatcher(db, registry, config, {
  home: tmpHome,
  runCli: async (args) => {
    const INBOX = ["inbox", "--days", "1", "--top", "25"];
    // failure simulation hits every mailbox — backoff only engages when ALL fail
    if (failNext) throw new Error("boom: graph exploded");
    // every poll names its mailbox, and the flag must PRECEDE the subcommand
    assert.equal(args[0], "--mailbox");
    assert.deepEqual(args.slice(2), INBOX);
    // "side" polls ride the same watcher — serve them an empty inbox so the
    // assertions below stay single-mailbox focused.
    if (args[1] === "side") return JSON.stringify([]);
    assert.equal(args[1], "work");
    cliCalls++;
    return JSON.stringify(inbox);
  },
  classify: async () => "wake",
});
watcher.start();

const tasksFor = (slug: string) => db.nextQueuedTasks().filter((t) => t.intern === slug);

await check("first tick sets a baseline and enqueues nothing", async () => {
  await watcher.tick();
  assert.equal(tasksFor("mail-pa").length, 0);
  assert.ok(fs.existsSync(path.join(tmpHome, "mail-pa", "mailwatch.json")));
});

await check("no new mail → no task", async () => {
  await watcher.tick();
  assert.equal(tasksFor("mail-pa").length, 0);
});

await check("two new messages → exactly ONE trigger task carrying both", async () => {
  inbox = [mail("m3", "2026-08-23T10:20:00Z", "Second"), mail("m2", "2026-08-23T10:10:00Z", "First"), ...inbox];
  await watcher.tick();
  const tasks = tasksFor("mail-pa");
  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.kind, "trigger");
  assert.equal(task.payload.kind, "new_mail");
  assert.equal(task.payload.count, 2);
  const messages = task.payload.messages as MailMessage[];
  assert.deepEqual(messages.map((m) => m.id), ["m2", "m3"]); // oldest first
  assert.match(String(task.payload.summary), /New mail in work: 2 message/);
  assert.match(JSON.stringify(task.payload.messages), /Second/); // detail rides in messages, not summary
});

await check("watermark advanced → the same mail does not re-fire", async () => {
  db.markTask(tasksFor("mail-pa")[0]!.id, "done");
  await watcher.tick();
  assert.equal(tasksFor("mail-pa").length, 0);
});

await check("interns without triggers.mail_push are never touched", () => {
  assert.equal(tasksFor("no-mail").length, 0);
  assert.equal(fs.existsSync(path.join(tmpHome, "no-mail", "mailwatch.json")), false);
});

await check("a CLI failure skips the tick instead of throwing", async () => {
  failNext = true;
  inbox = [mail("m4", "2026-08-23T10:30:00Z"), ...inbox];
  await watcher.tick();
  await watcher.tick();
  assert.equal(tasksFor("mail-pa").length, 0);
});

await check("3 consecutive failures back off to 15m ticks", async () => {
  await watcher.tick(); // third failure
  assert.equal(watcher.intervalMinutes(), 15);
});

await check("recovery restores the normal interval and delivers the missed mail", async () => {
  failNext = false;
  await watcher.tick();
  assert.equal(watcher.intervalMinutes(), config.mail_poll_minutes);
  const tasks = tasksFor("mail-pa");
  assert.equal(tasks.length, 1);
  assert.equal((tasks[0]!.payload.messages as MailMessage[])[0]!.id, "m4");
});

await check("cli was actually invoked", () => assert.ok(cliCalls > 0));

// --------------------------------------------- layered triage (L1/L2/L3)
// Separate intern + watcher with realistic cooldown/max-wait so these checks
// don't fight the "immediate fire" legacy checks above. A wholly separate
// tmpHome/db/registry — sharing the original `registry` would make
// triageWatcher.watchingInterns() also pick up "mail-pa" (it filters by
// registry contents, not by which watcher "owns" which intern) and the two
// watchers would fight over mail-pa's watermark file.
const tmpHome2 = fs.mkdtempSync(path.join(os.tmpdir(), "interns-mailwatch-triage-"));
const config2 = loadConfig(tmpHome2);
config2.mail_trigger_cooldown_minutes = 30;
config2.mail_batch_max_wait_minutes = 120;
config2.mailboxes = ["work", "side"];
config2.mail_triage = {
  ignore_from: ["noreply", "no-reply", "notifications?@", "mailer-daemon", "newsletter", "list-"],
  ignore_subject: ["unsubscribe"],
  vip_from: ["boss@"],
};
const bus2 = new EventBus();
const db2 = new Db(bus2, tmpHome2);
const registry2 = new Registry(tmpHome2);

registry2.save(
  {
    name: "Triage PA",
    role: "assistant",
    icon: "default",
    persona: "",
    system_prompt: "you read mail",
    tools: [],
    triggers: { mail_push: true },
    backlog: [],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  },
  "mail-triage",
);

let triageInbox: MailMessage[] = [];
let classifyImpl: (messages: MailMessage[]) => Promise<"wake" | "hold"> = async () => "wake";
let classifyCalls = 0;

const triageWatcher = new MailWatcher(db2, registry2, config2, {
  home: tmpHome2,
  runCli: async (args) => {
    const INBOX = ["inbox", "--days", "1", "--top", "25"];
    assert.equal(args[0], "--mailbox");
    assert.deepEqual(args.slice(2), INBOX);
    if (args[1] === "side") return JSON.stringify([]); // side stays empty for these checks
    assert.equal(args[1], "work");
    return JSON.stringify(triageInbox);
  },
  classify: async (messages) => {
    classifyCalls++;
    return classifyImpl(messages);
  },
});
triageWatcher.start();
// start() fires an initial tick in the background (`void this.tick()`); unlike
// the legacy checks above (whose first two checks don't care exactly which
// tick did the baselining), the checks below assert on a *specific* tick's
// outcome from the first one, so let that background tick fully settle first
// — otherwise it races the first explicit tick() call below (ticking===true
// makes tick() a silent no-op) and the baseline lands one check late.
await new Promise((r) => setTimeout(r, 20));

const triageTasks = () => db2.nextQueuedTasks().filter((t) => t.intern === "mail-triage");
const bumpCooldownIntoThePast = () => {
  const file = triageWatcher.readWatermarkFile("mail-triage");
  file.mailboxes["work"]!.last_trigger_at = new Date(Date.now() - 31 * 60_000).toISOString();
  triageWatcher.writeWatermarkFile("mail-triage", file);
};

await check("triage: first tick sets a baseline", async () => {
  await triageWatcher.tick();
  assert.equal(triageTasks().length, 0);
});

await check("Layer 1: ignored sender/subject dropped, kept mail fires (no cooldown started yet)", async () => {
  triageInbox = [
    mail("t1", "2026-08-23T11:00:00Z", "hi there"), // kept
    { ...mail("t2", "2026-08-23T11:01:00Z", "Special offer"), from: "noreply@service.com" }, // filtered: sender
    mail("t1b", "2026-08-23T11:02:00Z", "please unsubscribe from this list"), // filtered: subject
  ];
  await triageWatcher.tick();
  const tasks = triageTasks();
  assert.equal(tasks.length, 1, "kept mail should fire immediately — no prior trigger, so cooldown is a no-op");
  assert.deepEqual((tasks[0]!.payload.messages as MailMessage[]).map((m) => m.id), ["t1"]);
  db2.markTask(tasks[0]!.id, "done");

  const file = triageWatcher.readWatermarkFile("mail-triage");
  const seen = file.mailboxes["work"]!.seen_ids;
  assert.ok(seen.includes("t2") && seen.includes("t1b"), "filtered mail still advances the watermark");
});

await check("Layer 1: filtered/already-seen mail never re-surfaces on the next tick", async () => {
  await triageWatcher.tick(); // same inbox, nothing new
  assert.equal(triageTasks().length, 0);
});

await check("Layer 2: within cooldown, new mail batches instead of firing", async () => {
  triageInbox = [...triageInbox, mail("t3", "2026-08-23T11:05:00Z", "quick question")];
  await triageWatcher.tick();
  assert.equal(triageTasks().length, 0, "still inside the cooldown window from the t1 trigger");
  const file = triageWatcher.readWatermarkFile("mail-triage");
  assert.deepEqual((file.mailboxes["work"]!.pending ?? []).map((m) => m.id), ["t3"]);
});

await check("Layer 2: batch accumulates across further ticks while cooldown holds", async () => {
  triageInbox = [...triageInbox, mail("t4", "2026-08-23T11:06:00Z", "another one")];
  await triageWatcher.tick();
  assert.equal(triageTasks().length, 0);
  const file = triageWatcher.readWatermarkFile("mail-triage");
  assert.deepEqual((file.mailboxes["work"]!.pending ?? []).map((m) => m.id), ["t3", "t4"]);
});

await check("Layer 2: once cooldown has passed, the accumulated batch fires as ONE task", async () => {
  bumpCooldownIntoThePast();
  await triageWatcher.tick(); // no new mail this tick — the stale batch alone should fire
  const tasks = triageTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.payload.count, 2);
  assert.deepEqual((tasks[0]!.payload.messages as MailMessage[]).map((m) => m.id), ["t3", "t4"]);
  db2.markTask(tasks[0]!.id, "done");
});

await check("Layer 2: VIP mail bypasses cooldown and fires immediately", async () => {
  triageInbox = [...triageInbox, { ...mail("t5", "2026-08-23T11:10:00Z", "need this today"), from: "boss@company.com" }];
  await triageWatcher.tick(); // cooldown just restarted above; VIP must not wait for it
  const tasks = triageTasks();
  assert.equal(tasks.length, 1, "VIP message must not wait for cooldown");
  assert.deepEqual((tasks[0]!.payload.messages as MailMessage[]).map((m) => m.id), ["t5"]);
  db2.markTask(tasks[0]!.id, "done");
});

await check("Layer 3: a hold verdict clears the batch into `held`, no task enqueued", async () => {
  classifyImpl = async () => "hold";
  bumpCooldownIntoThePast();
  triageInbox = [...triageInbox, mail("t6", "2026-08-23T11:15:00Z", "HeldMarker")];
  await triageWatcher.tick();
  assert.equal(triageTasks().length, 0);
  const file = triageWatcher.readWatermarkFile("mail-triage");
  assert.deepEqual((file.mailboxes["work"]!.held ?? []).map((m) => m.id), ["t6"]);
  assert.deepEqual(file.mailboxes["work"]!.pending ?? [], []);
});

await check("Layer 3: held items drain into the NEXT wake trigger's payload", async () => {
  classifyImpl = async () => "wake";
  bumpCooldownIntoThePast();
  triageInbox = [...triageInbox, mail("t7", "2026-08-23T11:20:00Z", "real question")];
  await triageWatcher.tick();
  const tasks = triageTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.payload.count, 1); // t6 is a digest, not part of the fresh batch
  assert.deepEqual((tasks[0]!.payload.messages as MailMessage[]).map((m) => m.id), ["t7"]);
  const held = tasks[0]!.payload.held as string[] | undefined;
  assert.ok(held && held.length === 1 && held[0]!.includes("HeldMarker"));
  db2.markTask(tasks[0]!.id, "done");

  const file = triageWatcher.readWatermarkFile("mail-triage");
  assert.deepEqual(file.mailboxes["work"]!.held ?? [], []); // drained
});

await check("Layer 3: classification errors fail OPEN to wake (mail is never silently dropped)", async () => {
  classifyImpl = async () => {
    throw new Error("triage exploded");
  };
  bumpCooldownIntoThePast();
  triageInbox = [...triageInbox, mail("t8", "2026-08-23T11:25:00Z", "fail open check")];
  await triageWatcher.tick();
  const tasks = triageTasks();
  assert.equal(tasks.length, 1, "a triage error must fail open to wake, never silently drop mail");
  db2.markTask(tasks[0]!.id, "done");
});

await check("drainHeld() exposes and clears a held digest (used for the scheduled/cron path)", async () => {
  classifyImpl = async () => "hold";
  bumpCooldownIntoThePast();
  triageInbox = [...triageInbox, mail("t9", "2026-08-23T11:30:00Z", "DrainMarker")];
  await triageWatcher.tick();
  assert.equal(triageTasks().length, 0);

  const drained = triageWatcher.drainHeld("mail-triage");
  assert.equal(drained.length, 1);
  assert.ok(drained[0]!.includes("DrainMarker"));
  assert.deepEqual(triageWatcher.drainHeld("mail-triage"), []); // drained clears it
});

await check("triage classify() was actually invoked", () => assert.ok(classifyCalls > 0));

await triageWatcher.stop();
db2.close();
fs.rmSync(tmpHome2, { recursive: true, force: true });

await watcher.stop();
db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0 ? "mailwatch: all tests passed" : `mailwatch: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
