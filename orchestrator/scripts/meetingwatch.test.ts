/**
 * Standalone meetingwatch test — no Graph, no Discord, no Agent SDK.
 * Runs against a temp INTERNS_HOME with a fake graph-cal CLI.
 *
 *   npx tsx scripts/meetingwatch.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "interns-meetingwatch-"));
process.env.INTERNS_HOME = tmpHome;

const { loadConfig } = await import("../src/config.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const {
  MeetingWatcher,
  selectMeetingsToBrief,
  advanceBriefed,
  parseNextOutput,
  eventForPayload,
} = await import("../src/meetingwatch.js");
import type { CalEvent } from "../src/meetingwatch.js";

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

const NOW = new Date("2026-08-24T10:00:00Z");

/** Build a fixture event starting `minutesFromNow` minutes from NOW (negative = already started). */
function event(
  id: string,
  minutesFromNow: number,
  opts: Partial<{ allDay: boolean; attendees: number; subject: string; noStart: boolean }> = {},
): CalEvent {
  const startMs = NOW.getTime() + minutesFromNow * 60_000;
  const startIso = new Date(startMs).toISOString();
  const attendeeCount = opts.attendees ?? 2;
  return {
    id,
    subject: opts.subject ?? `subject ${id}`,
    start: opts.noStart ? { iso: null, local: null, timezone: null } : { iso: startIso, local: startIso, timezone: "UTC" },
    end: { iso: startIso, local: startIso, timezone: "UTC" },
    all_day: opts.allDay ?? false,
    location: "Somewhere",
    organizer: { name: "Organizer", email: "organizer@example.com", response_status: null },
    attendees: Array.from({ length: attendeeCount }, (_, i) => ({
      name: `Attendee ${i}`,
      email: `attendee${i}@example.com`,
      response_status: "none",
    })),
    is_online_meeting: false,
    web_link: "https://example.com/event",
    body_preview: "agenda: talk about things",
  };
}

console.log(`meetingwatch tests (home=${tmpHome})`);

// ------------------------------------------------------------- pure logic

await check("lead-window: an event well within the lead window is selected", () => {
  const picked = selectMeetingsToBrief([event("a", 10)], [], 25, NOW);
  assert.deepEqual(picked.map((e) => e.id), ["a"]);
});

await check("lead-window: an event further out than the lead window is NOT selected yet", () => {
  const picked = selectMeetingsToBrief([event("a", 40)], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("lead-window: an event exactly at the lead boundary is selected (<=)", () => {
  const picked = selectMeetingsToBrief([event("a", 25)], [], 25, NOW);
  assert.deepEqual(picked.map((e) => e.id), ["a"]);
});

await check("never brief an event that has already started", () => {
  const picked = selectMeetingsToBrief([event("a", -5)], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("an event starting exactly now is treated as already started", () => {
  const picked = selectMeetingsToBrief([event("a", 0)], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("dedupe: an already-briefed event id is never selected again", () => {
  const picked = selectMeetingsToBrief([event("a", 10)], ["a"], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("dedupe: only the unbriefed event in a mixed batch is selected", () => {
  const picked = selectMeetingsToBrief([event("a", 10), event("b", 10)], ["a"], 25, NOW);
  assert.deepEqual(picked.map((e) => e.id), ["b"]);
});

await check("all-day skip: an all-day event is never briefed regardless of window", () => {
  const picked = selectMeetingsToBrief([event("a", 10, { allDay: true })], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("solo skip: an event with zero attendees (a calendar block) is never briefed", () => {
  const picked = selectMeetingsToBrief([event("a", 10, { attendees: 0 })], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("solo skip does not affect events that DO have attendees", () => {
  const picked = selectMeetingsToBrief([event("a", 10, { attendees: 1 })], [], 25, NOW);
  assert.deepEqual(picked.map((e) => e.id), ["a"]);
});

await check("malformed start: an event with no usable start timestamp is skipped defensively", () => {
  const picked = selectMeetingsToBrief([event("a", 10, { noStart: true })], [], 25, NOW);
  assert.deepEqual(picked, []);
});

await check("multiple qualifying events in one tick are all selected (one task each upstream)", () => {
  const picked = selectMeetingsToBrief([event("a", 5), event("b", 15), event("c", 20)], [], 25, NOW);
  assert.deepEqual(picked.map((e) => e.id).sort(), ["a", "b", "c"]);
});

await check("advanceBriefed prepends new ids and dedupes against existing ones", () => {
  const result = advanceBriefed(["old1", "old2"], ["new1", "old1"]);
  assert.deepEqual(result, ["new1", "old1", "old2"]);
});

await check("advanceBriefed caps the ring at 200", () => {
  const existing = Array.from({ length: 199 }, (_, i) => `e${i}`);
  const result = advanceBriefed(existing, ["fresh1", "fresh2"]);
  assert.equal(result.length, 200);
  assert.equal(result[0], "fresh1");
  assert.equal(result[1], "fresh2");
});

await check("parseNextOutput tolerates junk rows and rejects CLI errors", () => {
  const parsed = parseNextOutput(
    JSON.stringify([
      {
        id: "a",
        subject: "hi",
        start: { iso: "2026-08-24T10:00:00Z", local: "2026-08-24T12:00:00+02:00", timezone: "Africa/Johannesburg" },
        end: { iso: "2026-08-24T11:00:00Z", local: "2026-08-24T13:00:00+02:00", timezone: "Africa/Johannesburg" },
        all_day: false,
        location: "Room 1",
        organizer: { name: "Org", email: "org@example.com", response_status: null },
        attendees: [{ name: "A", email: "a@example.com", response_status: "accepted" }],
        is_online_meeting: true,
        web_link: "https://example.com",
        body_preview: "hello",
      },
      { nope: true },
      null,
    ]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.subject, "hi");
  assert.equal(parsed[0]!.attendees.length, 1);
  assert.throws(() => parseNextOutput(JSON.stringify({ error: "no token cache" })), /no token cache/);
  assert.throws(() => parseNextOutput("not json"));
});

await check("eventForPayload trims to the fields the trigger payload needs", () => {
  const payload = eventForPayload(event("a", 10));
  assert.deepEqual(Object.keys(payload).sort(), [
    "attendees",
    "body_preview",
    "end",
    "id",
    "is_online_meeting",
    "location",
    "organizer",
    "start",
    "subject",
    "web_link",
  ]);
  assert.equal(payload.id, "a");
});

// ------------------------------------------------------ end-to-end ticks
// The watcher's real tick() uses the actual wall clock (new Date()), unlike
// the pure-logic checks above which pin NOW — so fixtures here must be
// relative to real "now", not the fixed NOW constant.
function liveEvent(id: string, minutesFromNow: number, opts: Parameters<typeof event>[2] = {}): CalEvent {
  const startMs = Date.now() + minutesFromNow * 60_000;
  const startIso = new Date(startMs).toISOString();
  const attendeeCount = opts.attendees ?? 2;
  return {
    ...event(id, minutesFromNow, opts),
    start: opts.noStart ? { iso: null, local: null, timezone: null } : { iso: startIso, local: startIso, timezone: "UTC" },
    end: { iso: startIso, local: startIso, timezone: "UTC" },
    attendees: Array.from({ length: attendeeCount }, (_, i) => ({
      name: `Attendee ${i}`,
      email: `attendee${i}@example.com`,
      response_status: "none",
    })),
  };
}

const config = loadConfig(tmpHome);
config.meeting_brief_lead_minutes = 25;
// no calendar_mailbox set: the first configured mailbox is the calendar
config.mailboxes = ["work", "side"];
const bus = new EventBus();
const db = new Db(bus, tmpHome);
const registry = new Registry(tmpHome);

registry.save(
  {
    name: "Briefer",
    role: "assistant",
    icon: "default",
    persona: "",
    system_prompt: "you brief meetings",
    tools: [],
    triggers: { meeting_brief: true },
    backlog: [],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  },
  "briefer",
);
registry.save(
  {
    name: "No Cal",
    role: "other",
    icon: "default",
    persona: "",
    system_prompt: "no calendar for me",
    tools: [],
    triggers: {},
    backlog: [],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  },
  "no-cal",
);

let events: CalEvent[] = [];
let cliCalls = 0;
let failNext = false;
const NEXT_ARGS = ["--mailbox", "work", "next", "--within-minutes", "30"]; // lead(25) + slack(5)

const watcher = new MeetingWatcher(db, registry, config, {
  home: tmpHome,
  runCli: async (args) => {
    if (failNext) throw new Error("boom: graph-cal exploded");
    cliCalls++;
    assert.deepEqual(args, NEXT_ARGS);
    return JSON.stringify(events);
  },
});
watcher.start();
// start() fires an initial tick in the background; let it settle before the
// first explicit check so the two ticks don't race (mirrors mailwatch.test.ts).
await new Promise((r) => setTimeout(r, 20));

/**
 * Queued tasks for `slug`, CONSUMED as they are read.
 *
 * db.nextQueuedTasks() deliberately returns only the oldest queued task per
 * intern (that is what the worker wants). Reading it without consuming means
 * the first check's leftover task masks every later check's task — which is
 * exactly what made this suite fail in cascade. Marking them done as we read
 * mirrors what the real orchestrator worker does.
 */
const tasksFor = (slug: string) => {
  const out = [];
  for (;;) {
    const next = db.nextQueuedTasks().find((t) => t.intern === slug);
    if (!next) break;
    out.push(next);
    db.markTask(next.id, "done");
  }
  return out;
};

await check("no events → no task", async () => {
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 0);
});

await check("one qualifying event → exactly ONE trigger task carrying it", async () => {
  events = [liveEvent("m1", 10)];
  await watcher.tick();
  const tasks = tasksFor("briefer");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.kind, "trigger");
  assert.equal(tasks[0]!.payload.kind, "meeting_brief");
  const payloadEvent = tasks[0]!.payload.event as Record<string, unknown>;
  assert.equal(payloadEvent.id, "m1");
  db.markTask(tasks[0]!.id, "done");
});

await check("the same event never re-fires on a later tick", async () => {
  await watcher.tick(); // events still [m1]
  assert.equal(tasksFor("briefer").length, 0);
});

await check("a second, new qualifying event fires its own task; the old one stays deduped", async () => {
  events = [liveEvent("m1", 8), liveEvent("m2", 12)];
  await watcher.tick();
  const tasks = tasksFor("briefer");
  assert.equal(tasks.length, 1);
  const payloadEvent = tasks[0]!.payload.event as Record<string, unknown>;
  assert.equal(payloadEvent.id, "m2");
  db.markTask(tasks[0]!.id, "done");
});

await check("two new qualifying events in the same tick each get their own task", async () => {
  events = [liveEvent("m3", 5), liveEvent("m4", 15)];
  await watcher.tick();
  const tasks = tasksFor("briefer");
  assert.equal(tasks.length, 2);
  const ids = tasks.map((t) => (t.payload.event as Record<string, unknown>).id).sort();
  assert.deepEqual(ids, ["m3", "m4"]);
  for (const t of tasks) db.markTask(t.id, "done");
});

await check("an event beyond the lead window does not fire until it gets close enough", async () => {
  events = [liveEvent("m5", 29)]; // inside the CLI's 30m window, outside the 25m lead
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 0);

  events = [liveEvent("m5", 20)]; // same event, now inside the lead window
  await watcher.tick();
  const tasks = tasksFor("briefer");
  assert.equal(tasks.length, 1);
  assert.equal((tasks[0]!.payload.event as Record<string, unknown>).id, "m5");
  db.markTask(tasks[0]!.id, "done");
});

await check("an all-day event never fires a brief", async () => {
  events = [liveEvent("m6", 10, { allDay: true })];
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 0);
});

await check("a solo calendar block (no attendees) never fires a brief", async () => {
  events = [liveEvent("m7", 10, { attendees: 0 })];
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 0);
});

await check("interns without triggers.meeting_brief are never touched", () => {
  assert.equal(tasksFor("no-cal").length, 0);
  assert.equal(fs.existsSync(path.join(tmpHome, "no-cal", "meetingwatch.json")), false);
});

await check("state file persists briefed ids across watcher instances", async () => {
  events = [liveEvent("m8", 10)];
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 1); // tasksFor consumes as it reads

  const file = watcher.readStateFile("briefer");
  assert.ok(file.briefed_ids.includes("m8"));

  // A fresh watcher instance reading the same state file must still dedupe m8.
  const watcher2 = new MeetingWatcher(db, registry, config, {
    home: tmpHome,
    runCli: async () => JSON.stringify([liveEvent("m8", 10)]),
  });
  await watcher2.tick();
  assert.equal(tasksFor("briefer").length, 0);
});

await check("a CLI failure skips the tick instead of throwing", async () => {
  failNext = true;
  events = [liveEvent("m9", 10)];
  await watcher.tick();
  await watcher.tick();
  assert.equal(tasksFor("briefer").length, 0);
});

await check("3 consecutive failures back off to 15m ticks", async () => {
  await watcher.tick(); // third failure
  assert.equal(watcher.intervalMinutes(), 15);
});

await check("recovery restores the normal interval and delivers the missed meeting", async () => {
  failNext = false;
  await watcher.tick();
  assert.equal(watcher.intervalMinutes(), config.meeting_poll_minutes);
  const tasks = tasksFor("briefer");
  assert.equal(tasks.length, 1);
  assert.equal((tasks[0]!.payload.event as Record<string, unknown>).id, "m9");
  db.markTask(tasks[0]!.id, "done");
});

await check("cli was actually invoked", () => assert.ok(cliCalls > 0));

await check("calendar_mailbox picks the calendar; no mailbox configured → graph-cal is never called", async () => {
  const seen: string[][] = [];
  const runCli = async (args: string[]) => {
    seen.push(args);
    return JSON.stringify([]);
  };
  // a watcher only ticks once started; start() runs the first tick in the background
  const runOnce = async (cfg: typeof config) => {
    const w = new MeetingWatcher(db, registry, cfg, { home: tmpHome, runCli });
    w.start();
    await new Promise((r) => setTimeout(r, 20));
    await w.stop();
  };
  await runOnce({ ...config, calendar_mailbox: "side" });
  assert.deepEqual(seen.map((a) => a.slice(0, 2)), [["--mailbox", "side"]]);
  await runOnce({ ...config, mailboxes: [], calendar_mailbox: "" });
  assert.equal(seen.length, 1);
});

await watcher.stop();
db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0 ? "meetingwatch: all tests passed" : `meetingwatch: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
