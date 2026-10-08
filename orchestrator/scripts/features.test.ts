/**
 * Feature checks for docs/features (pages, standing orders, Today, debriefs,
 * the front desk and ideas). Same rules as smoke.ts: a throwaway
 * INTERNS_HOME, a fake engine, fake calendar and tagger, dry-run Discord —
 * never a real LLM, Graph or Discord call. The intern-page / intern-rule
 * CLIs are exercised for real against the test API.
 *
 *   npm run test:features
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-features-"));
process.env.INTERNS_HOME = home;

const { loadConfig } = await import("../src/config.js");
const { setProfile } = await import("../src/profile.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { Orchestrator, isSilentReply, isNothingToReport } = await import("../src/orchestrator.js");
const { InternManifestSchema } = await import("../src/types.js");
const { DiscordAdapter } = await import("../src/discord.js");
const { PushService, wirePushNotifications } = await import("../src/push.js");
const notifyRules = await import("../src/notify.js");
const { startApi } = await import("../src/api.js");
const { CapabilityService } = await import("../src/capabilities.js");
const { ApprovalService } = await import("../src/approvals.js");
const { MeetingWatcher } = await import("../src/meetingwatch.js");
const { plainFences, findFences } = await import("../src/fences.js");
const { stripRichBlocks } = await import("../src/standup.js");
const { renderRichBlocks } = await import("../src/render.js");
const { repoMatches, senderMatches, inQuietHours, holdActive, standingOrdersPrompt } = await import("../src/rules.js");
const { awaySummaries, isDecision, localDate } = await import("../src/agenda.js");
const { ideaText } = await import("../src/ideas.js");
const { TOOLS_DIR, allowedToolsFor, CapExceededError, HELPER_AGENT, RESEARCH_AGENT, helperAgent, subagentGuard, countUsage } = await import("../src/engine.js");
const { SMALL_MODEL } = await import("../src/models.js");
const { OVER_BUDGET } = await import("../src/db.js");
import type { Engine, RunResult } from "../src/engine.js";
import type { CalEvent } from "../src/meetingwatch.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.stack?.split("\n").slice(0, 12).join("\n      ") : err}`);
  }
}

async function waitFor(pred: () => boolean, budgetMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > budgetMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ------------------------------------------------------------------ setup

const config = loadConfig(home);
config.port = 0;
config.idle_advisor = false;
// the owner's own organisations: attendees outside these make a meeting external
config.own_domains = ["northwind.example", "sideproject.example"];
const bus = new EventBus();
const db = new Db(bus, home);
db.apiToken = config.api_token;
const registry = new Registry(home);

function hire(slug: string, name: string, role: string, extra: Record<string, unknown> = {}) {
  registry.save(InternManifestSchema.parse({ name, role, system_prompt: `You are ${name}.`, tools: ["fs.read"], ...extra }), slug);
  db.upsertIntern({ slug, name, role, icon: "default" });
}
hire("tessa", "Tessa", "Inbox chief of staff", { triggers: { meeting_brief: true } });
hire("rhea", "Rhea", "Code reviewer");
hire("ingrid", "Ingrid", "Event scout");

/** Fake engine: per-call behaviour scripted by the test; records prompts. */
type Script = (slug: string, input: string) => Promise<string> | string;
let script: Script = () => "ok";
const prompts: { slug: string; input: string }[] = [];
const engine: Engine = {
  async runIntern(slug, input): Promise<RunResult> {
    // the real engine's guardrail: no run past today's limit (+ anything JP added)
    const spend = db.spendToday(slug);
    const cap = registry.get(slug)!.guardrails.daily_token_cap + db.budgetExtra(slug);
    if (spend.input_tokens + spend.output_tokens >= cap) throw new CapExceededError(slug, spend.input_tokens + spend.output_tokens, cap);
    prompts.push({ slug, input });
    const text = await script(slug, input);
    return { ok: true, text, sessionId: null, inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
  },
};

const orch = new Orchestrator(db, registry, engine, config);
// front-desk/room pre-check: "people" → tessa, "events" → ingrid, "hmm" → nobody, else throw
orch.chooseRespondersFn = async (_room, text) => {
  if (/people|follow/i.test(text)) return { responders: ["tessa"], reason: "contacts" };
  if (/event|expo/i.test(text)) return { responders: ["ingrid"], reason: "events" };
  if (/hmm/i.test(text)) return { responders: [], reason: "unclear" };
  throw new Error("simulated outage");
};

let calendarEvents: CalEvent[] = [];
let calendarFails = false;
const tagged: string[] = [];
const discord = new DiscordAdapter(db, registry, bus, config);
const { ConnectorService } = await import("../src/connectors.js");
const connectorService = new ConnectorService({
  db,
  registry,
  config,
  home,
  github: {
    configured: false,
    getApp: async () => { throw new Error("no app"); },
    convertManifest: async () => { throw new Error("no app"); },
    accountType: async () => "User" as const,
    listInstallations: async () => [],
    resetTokens: () => {},
  },
});
const app = await startApi({
  db,
  registry,
  bus,
  config,
  discord,
  push: new PushService(db, config),
  approvals: new ApprovalService(db, new CapabilityService(db, registry, config, home), {} as never, registry),
  capabilities: new CapabilityService(db, registry, config, home),
  github: {} as never,
  orchestrator: orch,
  connectors: connectorService,
  interviewFn: async (draft, question, history) => ({
    answer: `${draft.name} (${history.length} before): ${question.endsWith("?") ? "Here is how I'd go about it." : "Noted."}`,
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.002,
  }),
  home,
  calendar: async () => {
    if (calendarFails) throw new Error("graph-cal down");
    return calendarEvents;
  },
  tagFn: async (idea) => {
    tagged.push(idea);
    return /app/i.test(idea) ? "app" : null;
  },
});
const addr = app.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
// The CLIs read port + token from INTERNS_HOME/config.json.
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...config, port }, null, 2), { mode: 0o600 });
const base = `http://127.0.0.1:${port}`;

async function api(urlPath: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${config.api_token}` }),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const toolPath = (name: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", name);
async function cli(name: string, args: string[]): Promise<any> {
  try {
    const { stdout } = await execFileAsync(toolPath(name), args, { env: { ...process.env, INTERNS_HOME: home } });
    return JSON.parse(stdout);
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { exit: e.code, ...(e.stdout ? JSON.parse(e.stdout) : {}) };
  }
}

/** Send as JP through the API (as the app does), then drain the queue. */
async function say(thread: string, text: string, replyTo?: string) {
  const res = await api(`/interns/${thread}/messages`, { method: "POST", body: { text, ...(replyTo ? { reply_to: replyTo } : {}) } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await orch.drain();
  return res.body as { message: { id: string }; targets: string[] };
}
const lastMessage = (thread: string) => db.listMessages(thread, 1)[0]!;

try {
  // --------------------------------------------------------------- fences

  await check("fences: page/rule/quick-replies/checklist fall back to text on Discord and push", async () => {
    const text = [
      "Here you go.",
      '```page\n{"id":"pg_1","title":"My people","kind":"people"}\n```',
      '```rule\n{"id":"rl_1","text":"Ignore all webapp PRs","kind":"hard"}\n```',
      '```quick-replies\n{"options":["Went well","Skip"]}\n```',
      '```checklist\n{"id":"c","title":"Next steps","items":[{"id":"1","text":"Draft thank-you","checked":true},{"id":"2","text":"Tell Lena","checked":false}]}\n```',
    ].join("\n\n");
    const discordText = plainFences(text, "discord");
    assert.match(discordText, /📄 \*\*My people\*\* \(open in the app\)/);
    assert.match(discordText, /📌 Standing order: Ignore all webapp PRs/);
    assert.match(discordText, /Reply with: Went well \/ Skip/);
    assert.match(discordText, /1\. ☑ Draft thank-you\n2\. ☐ Tell Lena/);
    assert.ok(!discordText.includes("{"), "no raw JSON on Discord");
    const push = stripRichBlocks(text);
    assert.match(push, /📄 My people/);
    assert.ok(!push.includes("Reply with"), "quick replies are dropped on the lock screen");
    assert.ok(!push.includes("{"));
    const rendered = await renderRichBlocks(text);
    assert.ok(!rendered.text.includes("```"), "Discord renderer converts fences too");
    assert.equal(findFences(text, "page")[0]!.id, "pg_1");
    assert.equal(plainFences("```page\nnot json\n```"), "", "invalid JSON never leaks");
  });

  // ---------------------------------------------------------------- rules

  await check("rules: matchers (repo, sender, quiet hours across midnight, hold dates)", () => {
    assert.ok(repoMatches("northwind/webapp", "Northwind/WebApp"));
    assert.ok(repoMatches("webapp", "northwind/webapp"));
    assert.ok(repoMatches("northwind/*", "northwind/webapp"));
    assert.ok(!repoMatches("webapp", "northwind/webapp-api"));
    assert.ok(senderMatches({ domain: "willowbrook-vet.example" }, "a@mail.willowbrook-vet.example"));
    assert.ok(senderMatches({ address: "Deploy@x.io" }, "deploy@x.io"));
    assert.ok(!senderMatches({ domain: "willowbrook-vet.example" }, "a@notwillowbrook-vet.example"));
    // explicit zone: the default is the machine's, which varies between boxes
    const at = (hhmm: string) => new Date(`2026-10-02T${hhmm}:00Z`);
    const tz = "UTC";
    assert.ok(inQuietHours({ from: "21:00", to: "07:00", tz }, at("22:30")));
    assert.ok(inQuietHours({ from: "21:00", to: "07:00", tz }, at("06:59")));
    assert.ok(!inQuietHours({ from: "21:00", to: "07:00", tz }, at("07:00")));
    assert.ok(inQuietHours({ from: "12:00", to: "13:00", tz }, at("12:30")));
    assert.ok(holdActive({ until: "2026-10-05" }, at("12:00")));
    assert.ok(!holdActive({ until: "2026-10-02" }, at("12:00")));
  });

  await check("rules: intern-rule add → reply carries the rule chip; hard mute drops PR work silently with a hit", async () => {
    script = async (slug) => {
      if (slug === "rhea") {
        const out = await cli("intern-rule", ["add", "--intern", "rhea", "--type", "mute_repo", "--repo", "northwind/webapp", "--text", "Ignore all webapp PRs"]);
        assert.equal(out.kind, "hard", JSON.stringify(out));
        return "Got it — webapp PRs are off my list.";
      }
      return "ok";
    };
    await say("rhea", "Ignore webapp PRs completely from now on");
    const reply = lastMessage("rhea");
    const chip = findFences(reply.text, "rule")[0];
    assert.ok(chip, `rule chip missing: ${reply.text}`);
    assert.equal(chip.text, "Ignore all webapp PRs");
    const ruleId = String(chip.id);

    const before = prompts.length;
    const muted = db.enqueueTask("rhea", "trigger", { type: "github_pull_request", repository: "northwind/webapp", pull_number: 111, title: "x" });
    const other = db.enqueueTask("rhea", "trigger", { type: "github_pull_request", repository: "northwind/dashboard", pull_number: 7, title: "y" });
    await orch.drain();
    assert.equal(db.getTask(muted.id)!.status, "cancelled");
    assert.match(db.getTask(muted.id)!.error ?? "", /^standing order/);
    assert.equal(db.getTask(other.id)!.status, "done");
    assert.equal(prompts.length - before, 1, "only the unmuted PR reached the intern");
    const rule = (await api(`/rules/${ruleId}`)).body;
    assert.equal(rule.hits, 1);
    assert.equal(rule.hits_7d, 1);
  });

  await check("rules: direct messages are never filtered; mail batches lose muted senders; an emptied batch is dropped", async () => {
    await cli("intern-rule", ["add", "--intern", "tessa", "--type", "mute_sender", "--domain", "deploymanager.io", "--text", "Ignore Deployment Manager digests"]);
    script = () => "triaged";
    const before = prompts.length;
    const mixed = db.enqueueTask("tessa", "trigger", {
      kind: "new_mail",
      mailbox: "work",
      count: 2,
      messages: [
        { from: "digest@deploymanager.io", subject: "DAILY digest" },
        { from: "ada@willowbrook-vet.example", subject: "Re: ClinicFlow" },
      ],
    });
    const allMuted = db.enqueueTask("tessa", "trigger", { kind: "new_mail", mailbox: "work", count: 1, messages: [{ from: "digest@deploymanager.io", subject: "again" }] });
    await orch.drain();
    assert.equal(db.getTask(mixed.id)!.status, "done");
    assert.equal(db.getTask(allMuted.id)!.status, "cancelled");
    const prompt = prompts.slice(before).map((p) => p.input).join("\n");
    assert.ok(prompt.includes("ada@willowbrook-vet.example") && !prompt.includes("deploymanager"), "muted mail never reaches the prompt");
    // JP's own message mentioning the muted sender still gets through
    const sent = await say("tessa", "What did deploymanager.io send?");
    assert.deepEqual(sent.targets, ["tessa"]);
  });

  await check("rules: soft rules land in the system prompt; app can disable, undo (soft delete) and list with hits", async () => {
    const add = await cli("intern-rule", ["add", "--intern", "tessa", "--type", "guidance", "--text", "Write to Kettle Labs in Afrikaans"]);
    assert.equal(add.kind, "soft");
    const prompt = standingOrdersPrompt(db.listRules("tessa"));
    assert.match(prompt, /Write to Kettle Labs in Afrikaans/);
    assert.match(prompt, /never mention skipping/);
    const list = (await api("/interns/tessa/rules")).body.rules;
    assert.equal(list.length, 2);
    const off = await api(`/rules/${add.rule_id}`, { method: "PATCH", body: { enabled: false } });
    assert.equal(off.body.enabled, false);
    assert.doesNotMatch(standingOrdersPrompt(db.listRules("tessa")), /Afrikaans/);
    const undo = await api(`/rules/${add.rule_id}`, { method: "DELETE" });
    assert.ok(undo.body.rule.removed_at);
    assert.equal((await api(`/rules/${add.rule_id}`)).status, 200, "removed rules stay readable so old chips can say so");
    assert.equal((await api("/interns/tessa/rules")).body.rules.length, 1);
    assert.equal((await api(`/rules/${add.rule_id}`, { method: "PATCH", body: { enabled: true } })).status, 409);
    const bad = await api("/interns/tessa/rules", { method: "POST", body: { type: "quiet_hours", text: "quiet", params: { from: "9pm" } } });
    assert.equal(bad.status, 400);
  });

  await check("rules: hold_until parks matching mail and releases it on the date (never dropped)", async () => {
    const add = await cli("intern-rule", ["add", "--intern", "tessa", "--type", "hold_until", "--match", "Maya", "--until", "2099-01-01", "--text", "Hold Maya until next year"]);
    assert.equal(add.kind, "hard");
    script = () => "triaged";
    const task = db.enqueueTask("tessa", "trigger", { kind: "new_mail", mailbox: "work", count: 1, messages: [{ from: "maya@brightline.example", subject: "Re: Maya — proposal" }] });
    await orch.drain();
    assert.equal(db.getTask(task.id)!.status, "cancelled");
    assert.match(db.getTask(task.id)!.error ?? "", /^held by standing order until 2099-01-01/);
    const holds = db.listHolds();
    assert.equal(holds.length, 1);
    assert.equal((holds[0]!.payload.messages as unknown[]).length, 1);
    // the day comes: the heartbeat hands it back as a trigger (rule disabled so it isn't re-held)
    await api(`/rules/${add.rule_id}`, { method: "DELETE" });
    db.setKv("holds", JSON.stringify(holds.map((h) => ({ ...h, until: "2000-01-01" }))));
    const before = prompts.length;
    await orch.heartbeat();
    await orch.drain();
    assert.equal(db.listHolds().length, 0);
    assert.ok(prompts.slice(before).some((p) => p.slug === "tessa" && /maya@brightline\.example/.test(p.input) && /released_hold/.test(p.input)));
  });

  await check('"Nothing." is a real answer in a 1:1 thread; "(nothing)" in a shared thread is silence', async () => {
    script = () => "Nothing.";
    await say("tessa", "anything from Kettle Labs today?");
    assert.equal(lastMessage("tessa").text, "Nothing.");
    assert.ok(isSilentReply("Nothing."), "shared threads still treat it as silence");
    assert.ok(!isSilentReply("Nothing.", true));
  });

  await check('"(nothing)" is never posted, in a 1:1 thread too', async () => {
    assert.ok(isSilentReply("(nothing)"));
    script = () => "(nothing)";
    const count = db.listMessages("rhea", 500).length;
    db.enqueueTask("rhea", "trigger", { type: "github_pull_request", repository: "acme/widget", pull_number: 1 });
    await orch.drain();
    assert.equal(db.listMessages("rhea", 500).length, count);
  });

  await check("background runs: told to stay quiet, and a nothing-to-report reply is dropped", async () => {
    const count = db.listMessages("tessa", 500).length;
    const before = prompts.length;
    script = () => "Same oscillation, nothing new. No card.";
    db.enqueueTask("tessa", "trigger", { kind: "new_mail", mailbox: "work", count: 1, messages: [{ from: "alerts@nuvflow.example", subject: "Back online" }] });
    await orch.drain();
    assert.match(prompts.slice(before).find((p) => p.slug === "tessa")!.input, /reply with exactly \(nothing\)/);
    assert.equal(db.listMessages("tessa", 500).length, count, "not posted");
    script = () => "Ada at Willowbrook Vet replied: she wants Thursday at 10. Draft ready.";
    db.enqueueTask("tessa", "trigger", { kind: "new_mail", mailbox: "work", count: 1, messages: [{ from: "ada@willowbrook-vet.example", subject: "Re: demo" }] });
    await orch.drain();
    assert.equal(db.listMessages("tessa", 500).length, count + 1, "real news is posted");
    // the same words in answer to the owner are kept: they asked
    script = () => "Nothing new. No card.";
    await say("tessa", "anything new?");
    assert.equal(lastMessage("tessa").text, "Nothing new. No card.");
    assert.ok(!isNothingToReport("Nothing new from Ada, but should I nudge her?"), "a question is kept");
    assert.ok(isNothingToReport("Absorbed."));
  });

  // ---------------------------------------------------------------- pages

  let peopleId = "";
  await check("pages: intern-page create during a run → page fence on the reply; validation rejects bad data", async () => {
    const dataFile = path.join(home, "people.json");
    fs.writeFileSync(
      dataFile,
      JSON.stringify({
        people: [
          { id: "p1", name: "Ada Okafor", company: "Willowbrook Vet", tags: ["lead"], next_follow_up: "2026-10-01", stage: "meeting" },
          { id: "p2", name: "Danny Reyes", company: "Kettle Labs", tags: ["expo:mining-week"], next_follow_up: localDate() },
          { id: "p3", name: "Maya", tags: [], next_follow_up: "2099-01-01" },
        ],
      }),
    );
    script = async (slug) => {
      if (slug !== "tessa") return "ok";
      const bad = await cli("intern-page", ["create", "--intern", "tessa", "--kind", "people", "--title", "Bad", "--data", '{"people":[{"id":"x"}]}']);
      assert.equal(bad.exit, 1);
      assert.match(bad.error, /invalid people data/);
      const made = await cli("intern-page", ["create", "--intern", "tessa", "--kind", "people", "--title", "My people", "--summary", "3 people", "--data-file", dataFile]);
      peopleId = made.page_id;
      return "Here are your people.";
    };
    await say("tessa", "Give me all my people");
    const reply = lastMessage("tessa");
    const fenceBody = findFences(reply.text, "page")[0];
    assert.ok(fenceBody, reply.text);
    assert.equal(fenceBody.id, peopleId);
    assert.equal(fenceBody.title, "My people");
    assert.ok(reply.text.startsWith("Here are your people."));
  });

  await check("pages: patch-item bumps the version and emits a page event; dup/missing ids are refused", async () => {
    const events: number[] = [];
    const off = bus.on("page", (p) => events.push(p.version));
    const out = await cli("intern-page", ["patch-item", peopleId, "p1", "--set", '{"stage":"signed","next_follow_up":null}']);
    off();
    assert.equal(out.version, 2);
    assert.deepEqual(events, [2]);
    const page = (await api(`/pages/${peopleId}`)).body;
    const p1 = page.data.people.find((p: any) => p.id === "p1");
    assert.equal(p1.stage, "signed");
    assert.equal(p1.next_follow_up, undefined, "null clears a field");
    assert.equal((await cli("intern-page", ["patch-item", peopleId, "nope", "--set", "{}"])).exit, 1);
    assert.equal((await api(`/pages/${peopleId}/items`, { method: "POST", body: { item: { id: "p2", name: "dup" } } })).status, 400);
  });

  await check("pages: board columns are enforced; list endpoint, pin, show attaches an existing page to the next reply", async () => {
    const board = await api("/pages", {
      method: "POST",
      body: { intern: "tessa", kind: "board", title: "Pipeline", data: { columns: [{ id: "new", title: "New" }], items: [{ id: "b1", column: "won", title: "x" }] } },
    });
    assert.equal(board.status, 400);
    const list = (await api("/interns/tessa/pages")).body.pages;
    assert.equal(list.length, 1);
    assert.equal(list[0].items, 3);
    assert.equal(list[0].data, undefined, "list returns headers only");
    const pinned = await api(`/pages/${peopleId}/pin`, { method: "POST", body: { pinned: true } });
    assert.equal(pinned.body.pinned, true);
    assert.equal(pinned.body.version, 2, "pinning is not a content change");
    script = async (slug) => {
      if (slug === "tessa") await cli("intern-page", ["show", peopleId]);
      return "Still the same list.";
    };
    await say("tessa", "show me my people again");
    assert.equal(findFences(lastMessage("tessa").text, "page")[0]?.id, peopleId);
  });

  await check("pages: interns can read owner likes/tags and curate moodboards through the CLI", async () => {
    const made = await cli("intern-page", ["create", "--intern", "tessa", "--kind", "moodboard", "--title", "Photo picks", "--no-show", "--data", JSON.stringify({ items: [{ id: "photo", title: "Wrist", tags: ["wrist"] }] })]);
    assert.ok(made.page_id, JSON.stringify(made));
    const pageId = made.page_id;
    const owner = await api(`/pages/${pageId}/items/photo`, { method: "PATCH", body: { set: { liked: true, tags: ["wrist", "lead frame"] } } });
    assert.equal(owner.status, 200);
    const read = await cli("intern-page", ["get", pageId]);
    assert.equal(read.data.items[0].liked, true);
    assert.deepEqual(read.data.items[0].tags, ["wrist", "lead frame"]);
    const curated = await cli("intern-page", ["patch-item", pageId, "photo", "--set", JSON.stringify({ liked: false, tags: [...read.data.items[0].tags, "use next"] })]);
    assert.equal(curated.version, owner.body.version + 1);
    const seen = (await api(`/pages/${pageId}`)).body.data.items[0];
    assert.equal(seen.liked, false);
    assert.deepEqual(seen.tags, ["wrist", "lead frame", "use next"]);
    await cli("intern-page", ["patch-item", pageId, "photo", "--set", JSON.stringify({ liked: true, tags: ["wrist", "use next"] })]);
    const final = await cli("intern-page", ["get", pageId]);
    assert.equal(final.data.items[0].liked, true);
    assert.deepEqual(final.data.items[0].tags, ["wrist", "use next"]);
    await cli("intern-page", ["archive", pageId]);
  });

  await check("pages: draft kind accepts graph-mail's JSON as-is", async () => {
    const draft = {
      draft_id: "AAMk1",
      mailbox: "side",
      kind: "reply_all",
      intended_reply: true,
      threaded: true,
      to: ["ada@willowbrook-vet.example"],
      cc: ["lena@sideproject.example"],
      subject: "RE: ClinicFlow",
      conversation_id: "c1",
      in_reply_to: "m1",
      web_link: "https://outlook.office.com/x",
      body: "Hi Ada",
      thread: [{ from: "ada@willowbrook-vet.example", date: "2026-09-29T10:00:00Z", preview: "Hi JP" }],
      note: "in JP's Drafts for review — never sent",
    };
    const res = await api("/pages", { method: "POST", body: { intern: "tessa", kind: "draft", title: "RE: ClinicFlow", data: draft, announce: false } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.kind, "reply_all");
  });

  await check("pages search: 'Kettle Labs' finds Danny on the people page; tags, items, drafts and auth", async () => {
    const hit = (await api("/pages/search?q=Kettle Labs")).body.hits;
    assert.equal(hit[0].label, "Danny Reyes", JSON.stringify(hit));
    assert.equal(hit[0].page_id, peopleId);
    assert.equal(hit[0].item_id, "p2");
    assert.match(hit[0].detail, /Kettle Labs/);
    assert.equal((await api("/pages/search?q=mining%20week")).body.hits[0].label, "Danny Reyes", "tags are searched");
    assert.equal((await api("/pages/search?q=ada%20vet")).body.hits[0].item_id, "p1", "every word must match, in any field");
    const draft = (await api("/pages/search?q=ClinicFlow")).body.hits.find((h: any) => h.kind === "draft");
    assert.ok(draft && draft.item_id === null, "a draft page matches on its email");
    assert.deepEqual((await api("/pages/search?q=")).body.hits, []);
    assert.equal((await api("/pages/search?q=Kettle Labs", { auth: false })).status, 401);
  });

  // ---------------------------------------------------- briefs + Today

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const meeting: CalEvent = {
    id: "ev-ada",
    subject: "ClinicFlow demo — Willowbrook Vet",
    start: { iso: iso(now - 90 * 60_000), local: null, timezone: null },
    end: { iso: iso(now - 30 * 60_000), local: null, timezone: null },
    all_day: false,
    location: "Teams",
    organizer: null,
    attendees: [
      { name: "Ada", email: "ada@willowbrook-vet.example", response_status: "accepted" },
      { name: "Lena", email: "lena@sideproject.example", response_status: "accepted" },
    ],
    is_online_meeting: true,
    web_link: null,
    body_preview: null,
  };
  const internal: CalEvent = { ...meeting, id: "ev-internal", subject: "IoT Check-In", attendees: [{ name: "Pieter", email: "pieter@northwind.example", response_status: null }] };

  await check("briefs: a meeting_brief reply is filed under its meeting and shows on Today (no card)", async () => {
    script = (slug, input) => {
      assert.match(input, /Your reply IS the brief/);
      return "**Willowbrook Vet** — single-vet practice, asked about LabLink.";
    };
    db.enqueueTask("tessa", "trigger", { kind: "meeting_brief", event: meeting });
    db.enqueueTask("tessa", "trigger", { kind: "meeting_brief", event: internal });
    await orch.drain();
    calendarEvents = [meeting, internal];
    const today = (await api(`/agenda?date=${localDate()}`)).body;
    const entry = today.schedule.find((e: any) => e.event_id === "ev-ada");
    assert.ok(entry?.brief?.markdown.includes("Willowbrook"), JSON.stringify(entry));
    assert.equal(entry.debrief.state, "pending", "ended external meeting awaits its debrief");
    assert.equal(today.schedule.find((e: any) => e.event_id === "ev-internal").debrief, undefined, "internal meetings are never debriefed");
    assert.equal(db.listCards("open").filter((c) => /Willowbrook/.test(c.title)).length, 0);
  });

  await check("Today: calendar outage still shows briefed meetings; follow-ups due; away summary; decisions vs FYI; bad date → 400", async () => {
    calendarFails = true;
    const day = (await api(`/agenda?date=${localDate()}`)).body;
    calendarFails = false;
    assert.match(day.schedule_error, /graph-cal down/);
    assert.ok(day.schedule.some((e: any) => e.event_id === "ev-ada"), "briefs carry the meeting through an outage");
    assert.deepEqual(day.follow_ups.map((f: any) => f.name), ["Danny Reyes"], "only due/overdue follow-ups (p1 was cleared, p3 is future)");
    assert.ok(day.away.some((a: any) => a.intern === "rhea" && /muted 1 by standing order/.test(a.summary)), JSON.stringify(day.away));
    db.createCard({ intern: "tessa", title: "FYI only", body: "b", severity: "info" });
    db.createCard({ intern: "tessa", title: "Approve draft", body: "b", severity: "info", actions: [{ id: "approve", label: "Approve", style: "primary", kind: "button" }] });
    const again = (await api(`/agenda?date=${localDate()}`)).body;
    assert.ok(again.fyi.some((c: any) => c.title === "FYI only"));
    assert.ok(again.needs_you.some((c: any) => c.title === "Approve draft"), "an info card with a real action is still a decision");
    assert.equal((await api("/agenda?date=02-10-2026")).status, 400);
    assert.equal((await api("/agenda", { auth: false })).status, 401);
  });

  await check("Seen: info cards get a Seen action; seen also resolves legacy info cards without one", async () => {
    const card = db.createCard({ intern: "tessa", title: "Heads-up", body: "b", severity: "info" });
    assert.deepEqual(card.actions.map((a) => a.id), ["seen"]);
    const legacy = db.createCard({ intern: "tessa", title: "Old", body: "b", severity: "info", actions: [{ id: "ack", label: "Read", style: "neutral", kind: "button" }] });
    const res = await api(`/cards/${legacy.id}/actions/seen`, { method: "POST", body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "resolved");
    assert.equal(res.body.resolution.action, "seen");
    assert.ok(isDecision({ ...legacy, severity: "action" }));
  });

  // ------------------------------------------------------------- debriefs

  await check("debrief: asked once for the ended external meeting, with quick replies; never for internal ones", async () => {
    const watcher = new MeetingWatcher(db, registry, config, { home, runCli: async () => "[]" });
    assert.equal(watcher.askDebriefs(), 1);
    assert.equal(watcher.askDebriefs(), 0, "asked once, never chased");
    const q = lastMessage("tessa");
    assert.match(q.text, /How did \*\*ClinicFlow demo — Willowbrook Vet\*\* go\? \(with Ada\)/);
    assert.deepEqual(findFences(q.text, "quick-replies")[0]!.options, ["Went well", "Needs follow-up", "Didn't happen", "Skip"]);
    const today = (await api(`/agenda?date=${localDate()}`)).body;
    assert.equal(today.schedule.find((e: any) => e.event_id === "ev-ada").debrief.state, "asked");
  });

  await check("debrief: an answer reaches the intern with the meeting + checklist instructions; Skip closes it quietly", async () => {
    const question = lastMessage("tessa");
    let seen = "";
    script = (_slug, input) => {
      seen = input;
      return 'Great news.\n\n```checklist\n{"id":"n","title":"Next steps","items":[{"id":"1","text":"Move to Signed","checked":true}],"submit":"Do these"}\n```';
    };
    await say("tessa", "Went well — they are signing up", question.id);
    assert.match(seen, /answering your debrief question about the meeting "ClinicFlow demo — Willowbrook Vet"/);
    assert.match(seen, /checklist/);
    assert.equal(db.getDebrief("ev-ada", "tessa")!.state, "answered");
    // a second meeting, skipped
    const other = { ...meeting, id: "ev-2", subject: "Call with Kettle Labs" };
    db.recordMeetingBrief({ event_id: "ev-2", intern: "tessa", event: other as never, start_at: other.start.iso!, end_at: other.end.iso!, task_id: "t-x" });
    new MeetingWatcher(db, registry, config, { home, runCli: async () => "[]" }).askDebriefs();
    const q2 = lastMessage("tessa");
    const before = prompts.length;
    const sent = await say("tessa", "Skip", q2.id);
    assert.deepEqual(sent.targets, []);
    assert.equal(prompts.length, before, "Skip does not wake the intern");
    assert.equal(db.getDebrief("ev-2", "tessa")!.state, "skipped");
  });

  await check("replies carry what JP quoted (swipe-to-reply is visible to the intern)", async () => {
    let seen = "";
    script = (_s, input) => ((seen = input), "noted");
    const target = db.addMessage({ intern: "ingrid", author: "intern", speaker: "ingrid", text: "AI Expo Africa is on 22 Oct.", surface: "system" });
    await say("ingrid", "Book it in", target.id);
    assert.match(seen, /Boss is replying to your earlier message: "AI Expo Africa is on 22 Oct\."/);
  });

  // ------------------------------------------------- front desk + ideas

  await check("front desk: routed to one intern by the pre-check; reply lands in the coordinator thread with a speaker", async () => {
    let seen = "";
    script = (slug, input) => {
      seen = `${slug}:${input}`;
      return "Here are your follow-ups.";
    };
    const sent = await say("coordinator", "who do I owe a follow-up?");
    assert.deepEqual(sent.targets, ["tessa"]);
    assert.match(seen, /^tessa:Boss wrote in the front desk/);
    const reply = lastMessage("coordinator");
    assert.equal(reply.speaker, "tessa");
    assert.equal(reply.author, "intern");
  });

  await check("front desk: replying to an intern keeps it; @mention picks; unclear → coordinator asks, chip answer routes the original", async () => {
    script = (slug) => `${slug} here`;
    const tessaReply = lastMessage("coordinator");
    assert.deepEqual((await say("coordinator", "and Maya?", tessaReply.id)).targets, ["tessa"]);
    assert.deepEqual((await say("coordinator", "@Rhea anything open?")).targets, ["rhea"]);
    const unclear = await say("coordinator", "hmm, thoughts?");
    assert.deepEqual(unclear.targets, []);
    const ask = lastMessage("coordinator");
    assert.equal(ask.author, "coordinator");
    assert.deepEqual([...(findFences(ask.text, "quick-replies")[0]!.options as string[])].sort(), ["Ingrid", "Rhea", "Tessa"]);
    let seen = "";
    script = (slug, input) => ((seen = `${slug}:${input}`), "on it");
    const picked = await say("coordinator", "Ingrid", ask.id);
    assert.deepEqual(picked.targets, ["ingrid"]);
    assert.match(seen, /Boss just said: hmm, thoughts\?/, "the original question is what gets routed");
    assert.deepEqual((await say("coordinator", "outage please")).targets, [], "pre-check failure asks instead of guessing");
    // a colleague's @mention at the front desk is attributed to the colleague, not JP
    let mentionPrompt = "";
    script = (slug, input) => {
      if (slug === "tessa") return "@Rhea can you check the webapp PR?";
      if (slug === "rhea") mentionPrompt = input;
      return "(nothing)";
    };
    await say("coordinator", "@Tessa anything for Rhea?");
    assert.match(mentionPrompt, /Tessa just said, mentioning you: @Rhea can you check/);
    assert.doesNotMatch(mentionPrompt, /Boss just said: @Rhea/);
  });

  await check("ideas: 'idea:' in any chat is filed (not sent to the intern), acked, tagged; first one shows the Ideas page", async () => {
    const before = prompts.length;
    const sent = await say("rhea", "idea: let the app show a weekly people digest");
    assert.deepEqual(sent.targets, []);
    assert.equal(prompts.length, before, "the intern is not woken for an idea");
    const ack = lastMessage("rhea");
    assert.equal(ack.author, "coordinator");
    assert.match(ack.text, /^💡 Saved to Ideas \(1\)/);
    const ideasFence = findFences(ack.text, "page")[0]!;
    assert.equal(ideasFence.title, "Ideas");
    await waitFor(() => (db.getPage(String(ideasFence.id))!.data.items as any[])[0]?.tags?.[0] === "app");
    await say("coordinator", "💡 podcast about vet tech");
    assert.doesNotMatch(lastMessage("coordinator").text, /```page/, "the page fence is only on the first capture");
    const res = await api("/ideas", { method: "POST", body: { text: "Save-as-idea from a message", source: { thread_key: "ingrid", message_id: "m" } } });
    assert.equal(res.body.count, 3);
    const page = db.getPage(res.body.page_id)!;
    assert.equal(page.pinned, true);
    assert.equal(page.summary, "3 ideas");
    assert.equal((page.data.items as any[])[2].source.thread_key, "ingrid");
    // JP ticks an idea done from the app
    const done = await api(`/pages/${page.id}/items/${(page.data.items as any[])[0].id}`, { method: "PATCH", body: { set: { done: true } } });
    assert.equal(done.status, 200);
    assert.equal(ideaText("Idea: shorter standups"), "shorter standups");
    assert.equal(ideaText("Idea-wise, what should we pitch?"), null, "only 'idea:' or 💡 count");
    assert.equal(ideaText("ideally we'd ship"), null);
  });

  // --------------------------------------------------------- misc wiring

  await check("engine: tool paths exist on this box; pages + rules are base tools", () => {
    assert.ok(fs.existsSync(path.join(TOOLS_DIR, "intern-page")));
    const tools = allowedToolsFor(registry.get("rhea")!);
    assert.ok(tools.includes(`Bash(${TOOLS_DIR}/intern-page *)`) && tools.includes(`Bash(${TOOLS_DIR}/intern-rule *)`));
  });

  await check("engine: subagents are the Haiku 5.5 helper and general-purpose only, always in the foreground", async () => {
    assert.equal(SMALL_MODEL, "claude-haiku-5-5");
    assert.equal(helperAgent().model, SMALL_MODEL);
    assert.deepEqual(helperAgent().disallowedTools, ["Agent"], "a helper can't start helpers");
    assert.equal(RESEARCH_AGENT, "general-purpose");
    const signal = new AbortController().signal;
    const call = (tool_input: Record<string, unknown>) =>
      subagentGuard({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "" } as never, "t1", { signal }) as Promise<any>;
    for (const subagent_type of [HELPER_AGENT, RESEARCH_AGENT]) {
      const ok = (await call({ description: "Tag photos", prompt: "tag 1-20", subagent_type, model: "haiku", effort: "max", isolation: "remote", run_in_background: true })).hookSpecificOutput;
      assert.equal(ok.permissionDecision, "allow", subagent_type);
      assert.deepEqual(ok.updatedInput, { description: "Tag photos", prompt: "tag 1-20", subagent_type, run_in_background: false }, "model/effort/isolation overrides dropped");
    }
    for (const subagent_type of ["Explore", "Plan", "fork", undefined]) {
      assert.equal((await call({ description: "x", prompt: "y", subagent_type })).hookSpecificOutput.permissionDecision, "deny", String(subagent_type));
    }
  });

  await check("engine: helper tokens count a fortieth against the daily cap; cost stays real", () => {
    const counted = countUsage({
      "claude-opus-5-5": { inputTokens: 1000, cacheCreationInputTokens: 200, outputTokens: 300, costUSD: 0.05 },
      "claude-haiku-5-5": { inputTokens: 3000, cacheCreationInputTokens: 1000, outputTokens: 800, costUSD: 0.001 },
    });
    assert.equal(counted.inputTokens, 1200 + 100);
    assert.equal(counted.outputTokens, 300 + 20);
    assert.ok(Math.abs(counted.costUsd - 0.051) < 1e-9);
  });

  await check("away summaries are deterministic one-liners", () => {
    const t = (over: Record<string, unknown>) => ({ id: "x", intern: "tessa", kind: "trigger", payload: {}, status: "done", priority: 0, created_at: "", started_at: null, finished_at: "", error: null, ...over }) as never;
    const out = awaySummaries(
      [t({ payload: { kind: "new_mail", count: 3 } }), t({ payload: { kind: "new_mail", count: 2 } }), t({ kind: "message" }), t({ status: "failed" })],
      () => "Tessa",
    );
    assert.equal(out[0]!.summary, "Tessa triaged 5 emails, answered 1 message, 1 failed");
  });

  // ----------------------------------------------------- pause an intern

  await check("pause: automatic work is dropped, JP's own messages still reach them", async () => {
    const patched = await api("/interns/ingrid/manifest", { method: "PATCH", body: { paused: true } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.paused, true);
    assert.equal((await api("/interns")).body.find((i: { slug: string }) => i.slug === "ingrid").on_pause, true);

    // a trigger (mail, PR, restart recovery…) is cancelled, not run
    const before = prompts.length;
    const task = db.enqueueTask("ingrid", "trigger", { kind: "new_mail", count: 1 });
    await orch.drain();
    assert.equal(db.getTask(task.id)!.status, "cancelled");
    assert.equal(db.getTask(task.id)!.error, "intern paused");
    assert.equal(prompts.length, before);

    // another intern's @mention doesn't wake them; JP writing to them does
    assert.deepEqual(orch.routeMentions("tessa", "tessa", "@Ingrid any expos?", 1), []);
    await say("ingrid", "Anything on the expo?");
    assert.equal(prompts.at(-1)!.slug, "ingrid");

    // the front desk never routes to them ("events" would pick Ingrid)
    const routed = await orch.routeFrontDesk("which events are next?");
    assert.ok(!routed.includes("ingrid"), JSON.stringify(routed));

    // held work stays parked while paused
    db.addHold({ intern: "ingrid", until: "2000-01-01", rule: "test", payload: { kind: "new_mail" } });
    assert.equal(db.takeDueHolds("2099-01-01", (i) => registry.get(i)?.paused === true).length, 0);
    assert.equal(db.listHolds().filter((h) => h.intern === "ingrid").length, 1);

    const resumed = await api("/interns/ingrid/manifest", { method: "PATCH", body: { paused: false } });
    assert.equal(resumed.body.paused, false);
    assert.equal(db.takeDueHolds("2099-01-01", (i) => registry.get(i)?.paused === true).filter((h) => h.intern === "ingrid").length, 1);
  });

  await check("mentions switch: off stops other interns' @mentions, never JP's", async () => {
    assert.equal((await api("/interns/tessa/manifest")).body.triggers.mentions, true, "on unless switched off");
    const off = await api("/interns/tessa/manifest", { method: "PATCH", body: { triggers: { mentions: false } } });
    assert.equal(off.body.triggers.mentions, false);
    assert.deepEqual(orch.routeMentions("rhea", "rhea", "@Tessa who is Danny?", 1), []);
    assert.deepEqual(orch.routeMentions("rhea", "jp", "@Tessa who is Danny?", 0), ["tessa"]);
    await api("/interns/tessa/manifest", { method: "PATCH", body: { triggers: { mentions: true } } });
    assert.deepEqual(orch.routeMentions("rhea", "rhea", "@Tessa who is Danny?", 1), ["tessa"]);
    await orch.drain();
  });

  // ------------------------------------------------ over the daily limit

  await check("budget: at the limit work waits, one card asks, \"double it\" resumes it", async () => {
    const cap = registry.get("rhea")!.guardrails.daily_token_cap;
    db.recordSpend("rhea", cap, 0, 0);
    script = () => "On it.";
    const before = prompts.length;
    await say("rhea", "Review the webapp PR please");
    await say("rhea", "And the API one");
    assert.equal(prompts.length, before, "nothing ran past the limit");
    const held = db.budgetHeldTasks("rhea");
    assert.equal(held.length, 2);
    assert.ok(held.every((t) => t.status === "paused" && t.error === OVER_BUDGET));

    const cards = db.listCards("open").filter((c) => c.intern === "rhea" && c.context.kind === "budget");
    assert.equal(cards.length, 1, "asked once, not per task");
    assert.equal(cards[0]!.title, "Can I go over my limit today?");
    assert.match(cards[0]!.body, /Still waiting: your message\./);
    assert.deepEqual(cards[0]!.actions.map((a) => a.label), ["Double it for today", "Not today"]);
    const manifest = (await api("/interns/rhea/manifest")).body;
    assert.deepEqual(manifest.budget, { extra_today: 0, held: 2 });

    const res = await api(`/cards/${cards[0]!.id}/actions/extend`, { method: "POST", body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.budgetExtra("rhea"), cap);
    await orch.drain();
    assert.equal(prompts.length, before + 2, "both held tasks ran after the yes");
    assert.equal(db.budgetHeldTasks("rhea").length, 0);
  });

  await check("budget: \"not today\" keeps work for tomorrow and doesn't ask again; a raised limit releases it", async () => {
    const cap = registry.get("rhea")!.guardrails.daily_token_cap;
    db.recordSpend("rhea", cap, 0, 0); // past the doubled limit too
    await say("rhea", "One more thing");
    const card = db.listCards("open").find((c) => c.intern === "rhea" && c.context.kind === "budget")!;
    assert.equal(card.title, "Can I go over my limit again today?");
    assert.equal(card.actions[0]!.label, `Another ${Math.round(cap / 1000)}k today`);
    await api(`/cards/${card.id}/actions/not_today`, { method: "POST", body: {} });
    await say("rhea", "And another");
    assert.equal(db.budgetHeldTasks("rhea").length, 2);
    assert.equal(db.listCards("open").filter((c) => c.intern === "rhea" && c.context.kind === "budget").length, 0, "not asked again today");

    const before = prompts.length;
    const raised = await api("/interns/rhea/manifest", { method: "PATCH", body: { guardrails: { drafts_only: true, daily_token_cap: cap * 10 } } });
    assert.equal(raised.status, 200);
    await orch.drain();
    assert.equal(prompts.length, before + 2, "raising the limit lets held work carry on");
  });

  await check("week: an intern's last seven days", async () => {
    const week = (await api("/interns/rhea/week")).body;
    assert.equal(week.days.length, 7);
    assert.match(week.summary, /^[A-Z].*answered \d+ messages/);
    assert.ok(week.messages >= 4, JSON.stringify(week)); // the four "On it." replies above
    assert.ok(week.done >= 4);
    assert.ok(week.tokens > 0 && week.days.at(-1).tokens === db.spendToday("rhea").input_tokens + db.spendToday("rhea").output_tokens);
    assert.equal((await api("/interns/nobody/week")).status, 404);
  });

  // ------------------------------------------------------- notifications

  await check("notifications: level × importance × quiet", () => {
    const { decide } = notifyRules;
    assert.equal(decide("needs_you", "needs_you", false), "now");
    assert.equal(decide("needs_you", "fyi", false), "summary");
    assert.equal(decide("needs_you", "needs_you", true), "summary", "quiet hours hold it");
    assert.equal(decide("all", "fyi", false), "now");
    assert.equal(decide("summary", "needs_you", false), "summary");
    assert.equal(decide("off", "needs_you", false), "off");
    assert.equal(decide("off", "urgent", true), "now", "urgent always gets through");
  });

  await check("notifications: replies and decisions buzz, the rest waits for one summary that learns from opens", async () => {
    const sent: { title: string; body: string; push_id?: string; tag: string }[] = [];
    const notifier = wirePushNotifications(bus, registry, { notify: async (p) => (sent.push(p), {} as never) }, db);
    notifyRules.setNotifySettings(db, { quiet: { enabled: false } });
    await notifier.sendSummary(); // clear anything earlier checks queued
    sent.length = 0;

    assert.equal((await api("/interns/tessa/manifest")).body.notify, "needs_you", "the default");
    db.addMessage({ intern: "tessa", author: "intern", speaker: "tessa", text: "Pipeline updated overnight.", surface: "system", cause: "work" });
    db.addMessage({ intern: "rhea", author: "intern", speaker: "rhea", text: "Done — the PR is approved.", surface: "system", cause: "reply" });
    db.createCard({ intern: "tessa", title: "Send the Side Project reply?", body: "Draft is ready.", severity: "action", actions: [{ id: "ok", label: "OK", style: "primary", kind: "button" }] });
    db.createCard({ intern: "ingrid", title: "Three new expos listed", body: "FYI", severity: "info" });
    assert.deepEqual(sent.map((p) => p.title), ["Rhea", "Tessa: Send the Side Project reply?"]);
    assert.ok(sent.every((p) => p.push_id), "every buzz carries its log id");

    // everything / nothing
    await api("/interns/ingrid/manifest", { method: "PATCH", body: { notify: "all" } });
    db.addMessage({ intern: "ingrid", author: "intern", speaker: "ingrid", text: "Found another one.", surface: "system", cause: "work" });
    await api("/interns/ingrid/manifest", { method: "PATCH", body: { notify: "off" } });
    db.addMessage({ intern: "ingrid", author: "intern", speaker: "ingrid", text: "And one more.", surface: "system", cause: "reply" });
    db.createCard({ intern: "ingrid", title: "Server down", body: "!", severity: "urgent" });
    assert.deepEqual(sent.slice(2).map((p) => p.title), ["Ingrid", "Ingrid: Server down"]);

    // quiet hours: a reply waits, urgent doesn't
    notifyRules.setNotifySettings(db, { quiet: { enabled: true, from: "00:00", to: "23:59" } });
    db.addMessage({ intern: "rhea", author: "intern", speaker: "rhea", text: "Late answer.", surface: "system", cause: "reply" });
    assert.equal(sent.length, 4);
    notifyRules.setNotifySettings(db, { quiet: { enabled: false } });

    // one summary for everything held
    const summary = await notifier.sendSummary();
    const last = sent.at(-1)!;
    assert.equal(last.title, "3 updates from the crew");
    assert.match(last.body, /Tessa: Pipeline updated overnight\./);
    assert.match(last.body, /Ingrid: Three new expos listed/);
    assert.match(last.body, /Rhea: Late answer\./);
    assert.equal(await notifier.sendSummary(), null, "nothing held twice");

    // the service worker reports a tap without the token; a summary tap counts for its items
    const opened = await api(`/push/opened/${summary!.id}`, { method: "POST", auth: false });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.ok, true);
    assert.equal((await api("/push/opened/not-a-uuid", { method: "POST", auth: false })).status, 401);
    const stats = (await api("/interns/rhea/manifest")).body.notify_stats;
    assert.equal(stats.now, 1);
    assert.equal(stats.summary, 1);
    await api("/interns/ingrid/manifest", { method: "PATCH", body: { notify: "needs_you" } });
  });

  await check("notifications: the summary goes out at summary times and when quiet hours end — not with \"Never\"", async () => {
    setProfile({ owner_name: "Boss", timezone: "Africa/Johannesburg" }); // the times below are SAST
    const sent: { title: string }[] = [];
    const notifier = wirePushNotifications(bus, registry, { notify: async (p) => (sent.push(p), {} as never) }, db);
    notifyRules.setNotifySettings(db, { summary_times: ["12:30"], quiet: { enabled: true, from: "22:00", to: "07:00" } });
    const held = () => db.logPush({ intern: "tessa", kind: "message", title: "Tessa", body: "FYI", url: "/", delivery: "summary" });
    await notifier.sendSummary();
    sent.length = 0;
    held();
    await notifier.tick(new Date("2026-10-05T10:29:00Z")); // 12:29 SAST
    assert.equal(sent.length, 0);
    await notifier.tick(new Date("2026-10-05T10:30:00Z")); // 12:30 SAST
    assert.equal(sent.length, 1);
    held();
    await notifier.tick(new Date("2026-10-06T05:00:00Z")); // 07:00 SAST, quiet hours over
    assert.equal(sent.length, 2);
    notifyRules.setNotifySettings(db, { summary_times: [] });
    held();
    await notifier.tick(new Date("2026-10-07T05:00:00Z"));
    assert.equal(sent.length, 2, "never: held updates wait in the app");
    notifyRules.setNotifySettings(db, { summary_times: ["12:30", "17:30"] });
    setProfile({ owner_name: "Boss", timezone: "" });
  });

  await check("notifications: never opened → suggest the summary, and teach them to message less", async () => {
    for (let i = 0; i < 6; i++) db.logPush({ intern: "julia-x", kind: "message", title: "x", body: "x", url: "/", delivery: "now" });
    hire("julia-x", "Julia", "Tester");
    for (let i = 0; i < 7; i++) db.logPush({ intern: "julia-x", kind: "message", title: "Julia", body: "Morning!", url: "/", delivery: "now" });
    const opened = db.logPush({ intern: "julia-x", kind: "message", title: "Julia", body: "Hi", url: "/", delivery: "now" });
    db.markPushOpened(opened.id);
    const cards = notifyRules.suggestQuieter(db, registry);
    assert.equal(cards.length, 1, JSON.stringify(cards.map((c) => c.title)));
    assert.equal(cards[0]!.title, "You rarely open Julia's notifications");
    assert.match(cards[0]!.body, /buzzed your phone 14 times in the last two weeks and you opened 1/);
    assert.equal(notifyRules.suggestQuieter(db, registry).length, 0, "once a month at most");

    const res = await api(`/cards/${cards[0]!.id}/actions/summary_teach`, { method: "POST", body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(registry.get("julia-x")!.notify, "summary");
    assert.ok(db.listRules("julia-x").some((r) => r.text === notifyRules.messageLessGuidance()), "she is told to message less");
  });

  await check("notifications: settings", async () => {
    const bad = await api("/notify/settings", { method: "PATCH", body: { summary_times: ["25:00"] } });
    assert.equal(bad.status, 400);
    const ok = await api("/notify/settings", { method: "PATCH", body: { summary_times: ["17:30", "08:30"], quiet: { enabled: true, from: "21:00", to: "07:00" } } });
    assert.deepEqual(ok.body, { summary_times: ["08:30", "17:30"], quiet: { enabled: true, from: "21:00", to: "07:00" } });
    assert.deepEqual((await api("/notify/settings")).body, ok.body);
    assert.equal((await api("/notify/settings", { auth: false })).status, 401);
  });

  await check("connectors: token-gated API; GitHub's browser return is not; manifest mailboxes and meeting briefs", async () => {
    assert.equal((await api("/connectors", { auth: false })).status, 401);
    const overview = await api("/connectors");
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.github.connected, false);
    const back = await fetch(`${base}/oauth/github/installed`, { redirect: "manual" });
    assert.equal(back.status, 200, "a browser navigation from github.com reaches the route without a bearer token");
    assert.match(await back.text(), /Nothing changed here/, "but without one of our states it changes nothing");
    // that sync saved config.json from memory (port 0 here); the CLIs need the real port back
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...config, port }, null, 2), { mode: 0o600 });

    config.mailboxes.splice(0, config.mailboxes.length, "work");
    const bad = await api("/interns/tessa/manifest", { method: "PATCH", body: { mailboxes: ["nope"] } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.valid, ["work"]);
    assert.deepEqual((await api("/interns/tessa/manifest", { method: "PATCH", body: { mailboxes: ["work"] } })).body.mailboxes, ["work"]);
    assert.equal((await api("/interns/tessa/manifest", { method: "PATCH", body: { mailboxes: null } })).body.mailboxes, null, "null lifts the limit");
    assert.equal(registry.get("tessa")!.mailboxes, undefined);
    const briefs = await api("/interns/tessa/manifest", { method: "PATCH", body: { triggers: { meeting_brief: true } } });
    assert.equal(briefs.body.triggers.meeting_brief, true);
    assert.equal(briefs.body.triggers.mentions, true, "other triggers untouched");
    config.mailboxes.splice(0);
  });

  // ------------------------------------------------------------ hiring

  await check("style: dials become a Style block; the middle adds nothing", async () => {
    const { stylePrompt, DEFAULT_STYLE } = await import("../src/style.js");
    assert.equal(stylePrompt(undefined), "");
    assert.equal(stylePrompt(DEFAULT_STYLE), "");
    const block = stylePrompt({ tone: 1, length: 1, initiative: 5, humour: 3 });
    assert.match(block, /^\n## Style\n- Write casually/);
    assert.match(block, /extremely brief/);
    assert.match(block, /highly proactive/);
    assert.ok(!/\bwit\b|jokes|playful|serious/i.test(block), "humour at 3 adds nothing");
  });

  await check("style: manifest GET defaults to the middle, PATCH merges one dial at a time", async () => {
    assert.deepEqual((await api("/interns/rhea/manifest")).body.style, { tone: 3, length: 3, initiative: 3, humour: 3 });
    const one = await api("/interns/rhea/manifest", { method: "PATCH", body: { style: { length: 1 } } });
    assert.deepEqual(one.body.style, { tone: 3, length: 1, initiative: 3, humour: 3 });
    const two = await api("/interns/rhea/manifest", { method: "PATCH", body: { style: { humour: 5 } } });
    assert.deepEqual(two.body.style, { tone: 3, length: 1, initiative: 3, humour: 5 });
    assert.equal((await api("/interns/rhea/manifest", { method: "PATCH", body: { style: { tone: 9 } } })).status, 400);
  });

  await check("hire: interview a candidate before hiring; the coordinator pays", async () => {
    const draft = InternManifestSchema.parse({ name: "Wren", role: "Researcher", system_prompt: "You research.", style: { tone: 2, length: 2, initiative: 4, humour: 3 } });
    const before = db.spendToday("coordinator");
    const res = await api("/hire/interview", { method: "POST", body: { draft, question: "How would you brief me before a meeting?", history: [{ question: "Hi", answer: "Hello" }] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.answer, "Wren (1 before): Here is how I'd go about it.");
    const after = db.spendToday("coordinator");
    assert.equal(after.input_tokens - before.input_tokens, 120);
    assert.equal((await api("/hire/interview", { method: "POST", body: { draft, question: "?" } })).status, 400);
    assert.ok(!registry.get("wren"), "an interview hires nobody");
  });

  await check("hire: confirming keeps the dials, and starters come with presets", async () => {
    const templates = (await api("/templates")).body as { id: string }[];
    const starter = (await api("/hire/template", { method: "POST", body: { id: templates[0]!.id } })).body;
    assert.ok(starter.draft.style && starter.draft.style.tone >= 1, JSON.stringify(starter.draft.style));
    const draft = { ...starter.draft, name: "Juno", style: { tone: 5, length: 4, initiative: 2, humour: 1 } };
    const hired = await api("/hire/confirm", { method: "POST", body: { draft, icon: "face-03" } });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    assert.deepEqual(registry.get(hired.body.slug)!.style, { tone: 5, length: 4, initiative: 2, humour: 1 });
  });

  await check("SSE streams page, rule and agenda events", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${config.api_token}` }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
      }
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    await cli("intern-page", ["patch-item", peopleId, "p2", "--set", '{"stage":"contacted"}']);
    await cli("intern-rule", ["add", "--intern", "ingrid", "--type", "guidance", "--text", "Skip Singularity — too expensive"]);
    db.notifyAgenda(localDate());
    await waitFor(() => /event: page/.test(buf) && /event: rule/.test(buf) && /event: agenda/.test(buf));
    ctrl.abort();
    await pump;
  });

  await check("templates: every starter is a valid manifest and hires without a model call", async () => {
    const list = (await api("/templates")).body as { id: string; name: string; needs: string[]; ready: boolean }[];
    for (const id of ["inbox-assistant", "meeting-briefer", "researcher", "code-reviewer", "ops-watchdog", "writer", "chief-of-staff"]) {
      assert.ok(list.some((t) => t.id === id), `template ${id} is listed`);
    }
    const reviewer = list.find((t) => t.id === "code-reviewer")!;
    assert.deepEqual(reviewer.needs, ["github"]);
    assert.equal(reviewer.ready, false, "no GitHub App in the test config");
    assert.deepEqual(list.find((t) => t.id === "inbox-assistant")!.needs, ["outlook"]);
    const candidate = (await api("/hire/template", { method: "POST", body: { id: "researcher" } })).body;
    assert.equal(candidate.draft.name, "Iris");
    assert.deepEqual(candidate.required_capabilities, []);
    assert.equal((await api("/hire/template", { method: "POST", body: { id: "nope" } })).status, 404);
    const github = (await api("/hire/template", { method: "POST", body: { id: "code-reviewer" } })).body;
    assert.deepEqual(github.required_capabilities.map((r: { id: string }) => r.id), ["github"]);
  });

  await check("templates: a local ~/.interns/templates file overrides the repo one", async () => {
    fs.mkdirSync(path.join(home, "templates"), { recursive: true });
    fs.writeFileSync(path.join(home, "templates", "researcher.yaml"), "summary: Local\nname: Quinn\nrole: Researcher\nsystem_prompt: Research.\n");
    const list = (await api("/templates")).body as { id: string; name: string; summary: string }[];
    assert.equal(list.filter((t) => t.id === "researcher").length, 1);
    assert.equal(list.find((t) => t.id === "researcher")!.name, "Quinn");
    fs.rmSync(path.join(home, "templates"), { recursive: true, force: true });
  });

  await check("owner: setup saves name, zone and domains; bad input is refused", async () => {
    const before = (await api("/owner")).body;
    assert.equal(before.setup_complete, true, "a crew already exists here");
    assert.equal((await api("/owner", { method: "PATCH", body: { timezone: "Mars/Olympus" } })).status, 400);
    assert.equal((await api("/owner", { method: "PATCH", body: { colour: "red" } })).status, 400);
    const saved = (await api("/owner", { method: "PATCH", body: { owner_name: "Sam", timezone: "Europe/London", own_domains: ["Example.com"], setup_complete: true } })).body;
    assert.equal(saved.owner_name, "Sam");
    assert.equal(saved.timezone, "Europe/London");
    assert.deepEqual(saved.own_domains, ["example.com"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(onDisk.owner_name, "Sam");
    assert.ok(onDisk.setup_completed_at);
    assert.equal((await api("/owner", { auth: false })).status, 401);
    setProfile({ owner_name: "Boss", timezone: "" });
  });
} finally {
  await app.close();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall feature checks passed" : `\n${failures} feature check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
