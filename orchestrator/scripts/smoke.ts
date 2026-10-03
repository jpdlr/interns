/**
 * Smoke test: no Discord, no real Agent SDK calls. Runs everything against a
 * temp INTERNS_HOME with a fake engine and asserts the core flows:
 * registry save/load, message task through the orchestrator queue, spend
 * recording + cap card, card create/resolve through db + event bus, archive.
 *
 *   npm run smoke
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "interns-smoke-"));
process.env.INTERNS_HOME = tmpHome;

const { loadConfig } = await import("../src/config.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { cronMatches } = await import("../src/orchestrator.js");
const { allowedToolsFor, INTERN_ASSIGNABLE_TOOL_NAMES, TOOL_CATALOG, TOOLS_DIR } = await import("../src/engine.js");
const { stripAttachmentMarkers } = await import("../src/orchestrator.js");
const { imageSize, kindFor, resolveMime, safeName, signAttachment } = await import("../src/attachments.js");
const { spendChartBlock, stripRichBlocks, easterEggVoice } = await import("../src/standup.js");
const { resolveMentions, MAX_MENTION_HOPS } = await import("../src/mentions.js");
const { isSilentReply } = await import("../src/orchestrator.js");
const { renderRichBlocks } = await import("../src/render.js");
const { collectEvidence, runSuggestions, isSuppressed, loadMemory, wireSuggestionDecisions } = await import("../src/suggest.js");
const { chartToSvg, normalizeChartSpec } = await import("../src/chartsvg.js");
const { mermaidToSvg } = await import("../src/mermaidsvg.js");
const { InternManifestSchema } = await import("../src/types.js");
const { ICONS } = await import("../src/icons.js");
const { DiscordAdapter } = await import("../src/discord.js");
const { PushService } = await import("../src/push.js");
const { plainText, notificationText } = await import("../src/notifytext.js");
const { startApi } = await import("../src/api.js");
const { CapabilityService } = await import("../src/capabilities.js");
const { ApprovalService } = await import("../src/approvals.js");
const { GithubWatcher } = await import("../src/githubwatch.js");
import type { Engine, RunResult } from "../src/engine.js";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err) => {
      failures++;
      console.error(`FAIL  ${name}\n      ${err}`);
    });
}

const config = loadConfig(tmpHome);
const bus = new EventBus();
const db = new Db(bus, tmpHome);
const registry = new Registry(tmpHome);

// ---- fake engine: records calls, returns canned text + usage
const engineCalls: { slug: string; input: string }[] = [];
const fakeEngine: Engine = {
  async runIntern(slug, input): Promise<RunResult> {
    engineCalls.push({ slug, input });
    db.recordSpend(slug, 1000, 200, 0.01);
    return { ok: true, text: `did: ${input.slice(0, 40)}`, sessionId: "sess-1", inputTokens: 1000, outputTokens: 200, costUsd: 0.01 };
  },
};

await check("config created with token, 0600", () => {
  assert.ok(config.api_token.length > 20);
  const mode = fs.statSync(path.join(tmpHome, "config.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

const manifest = InternManifestSchema.parse({
  name: "Milo",
  role: "test intern",
  icon: "fox",
  persona: "Cheerful. Brief.",
  system_prompt: "You are Milo, a test intern.",
  tools: ["fs.read", "web"],
  triggers: { cron: "*/5 * * * *", mentions: true },
  backlog: ["tidy the memory dir", "write a haiku"],
  guardrails: { drafts_only: true, daily_token_cap: 50_000 },
});

await check("registry save/load roundtrip + memory dir", () => {
  const slug = registry.save(manifest);
  assert.equal(slug, "milo");
  assert.ok(fs.existsSync(path.join(tmpHome, "milo", "intern.yaml")));
  assert.ok(fs.statSync(path.join(tmpHome, "milo", "memory")).isDirectory());
  assert.deepEqual(registry.get("milo"), manifest);
  assert.equal(registry.list().length, 1);
});

db.upsertIntern({ slug: "milo", name: manifest.name, role: manifest.role, icon: manifest.icon });

await check("tool catalog mapping", () => {
  // intern-attach is a base tool: every intern can send JP files.
  assert.deepEqual(allowedToolsFor(manifest).sort(), [
    `Bash(${TOOLS_DIR}/intern-attach *)`,
    `Bash(${TOOLS_DIR}/intern-page *)`,
    `Bash(${TOOLS_DIR}/intern-rule *)`,
    `Bash(${TOOLS_DIR}/room-pad *)`,
    "Glob",
    "Grep",
    "Read",
    "WebFetch",
    "WebSearch",
  ]);
});

await check("cron matcher", () => {
  const at = (m: number, h: number) => new Date(2026, 7, 23, h, m);
  assert.ok(cronMatches("*/5 * * * *", at(10, 9)));
  assert.ok(!cronMatches("*/5 * * * *", at(7, 9)));
  assert.ok(cronMatches("0 7 * * 1-5", new Date(2026, 7, 24, 7, 0))); // Monday
  assert.ok(!cronMatches("0 7 * * 1-5", new Date(2026, 7, 23, 7, 0))); // Sunday
});

await check("message task flows through orchestrator to engine", async () => {
  const events: string[] = [];
  const off = bus.on("message", (m) => events.push(`${m.author}:${m.text.slice(0, 10)}`));
  const orch = new Orchestrator(db, registry, fakeEngine, config);
  db.addMessage({ intern: "milo", author: "jp", text: "hello Milo", surface: "app" });
  const task = db.enqueueTask("milo", "message", { text: "hello Milo" });
  await orch.pump();
  await orch.drain();
  off();
  assert.equal(engineCalls.length, 1);
  assert.equal(engineCalls[0]!.slug, "milo");
  assert.equal(engineCalls[0]!.input, "hello Milo");
  assert.equal(db.getTask(task.id)!.status, "done");
  assert.ok(events.some((e) => e.startsWith("jp:")) && events.some((e) => e.startsWith("intern:")));
  assert.equal(db.spendToday("milo").input_tokens, 1000);
});

await check("task controls pause, prioritize, resume and cancel real queue state", async () => {
  const orch = new Orchestrator(db, registry, fakeEngine, config);
  const task = db.enqueueTask("milo", "trigger", { kind: "control-test" });
  assert.equal(orch.pauseTask(task.id).status, "paused");
  assert.equal(db.countTasks("milo", "paused"), 1);
  assert.ok(orch.prioritizeTask(task.id).priority > 0);
  assert.equal(orch.resumeTask(task.id).status, "running");
  await orch.drain();
  assert.equal(db.getTask(task.id)?.status, "done");

  const cancelled = db.enqueueTask("milo", "trigger", { kind: "do-not-run" });
  assert.equal(orch.cancelTask(cancelled.id).status, "cancelled");
  assert.equal(db.getTask(cancelled.id)?.error, "cancelled by Boss");
});

await check("card create/resolve via db + event bus", () => {
  let created: string | null = null;
  let stateChanges: string[] = [];
  const off1 = bus.on("card", (c) => (created = c.id));
  const off2 = bus.on("card_state", (c) => stateChanges.push(`${c.state}:${c.resolution?.action}`));
  const card = db.createCard({
    intern: "milo",
    title: "Approve draft?",
    body: "A draft email to Bob.",
    severity: "action",
    actions: [
      { id: "approve", label: "Approve", style: "success", kind: "button" },
      { id: "note", label: "Note", style: "neutral", kind: "text" },
    ],
  });
  assert.equal(created, card.id);
  assert.equal(db.listCards("open").length, 1);
  const resolved = db.resolveCard(card.id, { via: "app", action: "approve" });
  off1();
  off2();
  assert.equal(resolved!.state, "resolved");
  assert.ok(resolved!.resolved_at);
  assert.deepEqual(stateChanges, ["resolved:approve"]);
  assert.equal(db.listCards("open").length, 0);
});

await check("daily token cap: the engine refuses past the limit + today's extra", async () => {
  db.recordSpend("milo", 60_000, 0, 0.5); // push over the 50k cap
  const before = db.listCards("open").length;
  // Real engine path: SdkEngine's own cap check. Asking JP for more is the
  // orchestrator's job (features.test.ts), so the engine raises no card.
  const { SdkEngine } = await import("../src/engine.js");
  const engine = new SdkEngine(db, registry, config);
  await assert.rejects(() => engine.runIntern("milo", "anything"), /daily token cap for milo: used \d+ of 50000/);
  assert.equal(db.listCards("open").length, before);
  db.addBudgetExtra("milo", 5_000);
  await assert.rejects(() => engine.runIntern("milo", "anything"), /used \d+ of 55000/);
});

await check("backlog heartbeat enqueues FIFO item when idle (idle_advisor off)", async () => {
  // reset spend cap concern: fake engine doesn't check caps. idle_advisor is
  // explicitly disabled here so this exercises the plain FIFO path without
  // depending on network/real-LLM behaviour — advisor judgment gets its own
  // dedicated checks below with an injected fake.
  // The manifest's cron fixture may match the wall-clock minute and correctly
  // take precedence over idle backlog work. Remove it for this isolated FIFO
  // assertion so the test is not dependent on which minute it starts.
  registry.save({ ...manifest, triggers: {} }, "milo");
  const orch = new Orchestrator(db, registry, fakeEngine, { ...config, idle_advisor: false });
  await orch.heartbeat();
  await orch.drain();
  // heartbeat→queue→worker handoff is async; poll briefly instead of racing it
  let backlogCall;
  // 15s budget: the 2s original lost this race whenever the box was busy
  for (let i = 0; i < 300 && !backlogCall; i++) {
    backlogCall = engineCalls.find((c) => c.input.includes("tidy the memory dir"));
    if (!backlogCall) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(backlogCall, "backlog item should reach the engine");
});

// ---------------------------------------------------------------------------
// Idle-priority advisor (advisor.ts / Orchestrator.advise()) — all against an
// injected fake AdviseFn, never the real Agent SDK query(). Each check uses
// its own fresh intern to avoid the backlog_cooldown_minutes gate.
// ---------------------------------------------------------------------------

async function waitFor(pred: () => boolean, budgetMs = 15_000): Promise<void> {
  const step = 50;
  for (let waited = 0; waited < budgetMs && !pred(); waited += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}

await check("idle advisor: injected verdict picks a non-first backlog item", async () => {
  const m = InternManifestSchema.parse({
    name: "Ada",
    role: "test intern",
    icon: "fox",
    persona: "",
    system_prompt: "test",
    tools: [],
    triggers: {},
    backlog: ["low priority chore", "URGENT: reply to client"],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  });
  const slug = registry.save(m, "ada");
  db.upsertIntern({ slug, name: m.name, role: m.role, icon: m.icon });
  let seenArgs: { name: string; backlog: string[] } | null = null;
  const fakeAdvise = async (intern: { name: string; role: string }, backlog: string[]) => {
    seenArgs = { name: intern.name, backlog };
    return { choice: 2, reason: "client is waiting" };
  };
  const orch = new Orchestrator(db, registry, fakeEngine, config, undefined, undefined, undefined, fakeAdvise);
  await orch.heartbeat();
  await orch.drain();
  let backlogCall: { slug: string; input: string } | undefined;
  await waitFor(() => !!(backlogCall = engineCalls.find((c) => c.input.includes("URGENT: reply to client"))));
  assert.ok(backlogCall, "the advisor's chosen (non-first) backlog item should reach the engine");
  assert.deepEqual(seenArgs, { name: "Ada", backlog: m.backlog });
});

await check("idle advisor: verdict choice=null keeps the intern idle (no task enqueued)", async () => {
  const m = InternManifestSchema.parse({
    name: "Beau",
    role: "test intern",
    icon: "fox",
    persona: "",
    system_prompt: "test",
    tools: [],
    triggers: {},
    backlog: ["only item"],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  });
  const slug = registry.save(m, "beau");
  db.upsertIntern({ slug, name: m.name, role: m.role, icon: m.icon });
  const fakeAdvise = async () => ({ choice: null, reason: "nothing urgent, stay idle" });
  const orch = new Orchestrator(db, registry, fakeEngine, config, undefined, undefined, undefined, fakeAdvise);
  const before = engineCalls.length;
  await orch.heartbeat();
  await orch.drain();
  await new Promise((r) => setTimeout(r, 200)); // give a wrongly-enqueued task a chance to show up
  assert.equal(engineCalls.length, before, "no backlog task should be enqueued when the advisor says stay idle");
});

await check("idle advisor: an error falls back to FIFO, never throws into the heartbeat", async () => {
  const m = InternManifestSchema.parse({
    name: "Cleo",
    role: "test intern",
    icon: "fox",
    persona: "",
    system_prompt: "test",
    tools: [],
    triggers: {},
    backlog: ["first thing", "second thing"],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  });
  const slug = registry.save(m, "cleo");
  db.upsertIntern({ slug, name: m.name, role: m.role, icon: m.icon });
  const fakeAdvise = async () => {
    throw new Error("simulated advisor outage");
  };
  const orch = new Orchestrator(db, registry, fakeEngine, config, undefined, undefined, undefined, fakeAdvise);
  await orch.heartbeat();
  await orch.drain();
  let backlogCall: { slug: string; input: string } | undefined;
  await waitFor(() => !!(backlogCall = engineCalls.find((c) => c.input.includes("first thing"))));
  assert.ok(backlogCall, "FIFO fallback item should reach the engine after an advisor error");
});

await check("idle advisor: config.idle_advisor=false skips the advisor call entirely", async () => {
  const m = InternManifestSchema.parse({
    name: "Dax",
    role: "test intern",
    icon: "fox",
    persona: "",
    system_prompt: "test",
    tools: [],
    triggers: {},
    backlog: ["only item"],
    guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  });
  const slug = registry.save(m, "dax");
  db.upsertIntern({ slug, name: m.name, role: m.role, icon: m.icon });
  let called = false;
  const fakeAdvise = async () => {
    called = true;
    return { choice: 1, reason: "x" };
  };
  const orch = new Orchestrator(
    db,
    registry,
    fakeEngine,
    { ...config, idle_advisor: false },
    undefined,
    undefined,
    undefined,
    fakeAdvise,
  );
  await orch.heartbeat();
  await orch.drain();
  await waitFor(() => engineCalls.some((c) => c.slug === "dax"));
  assert.equal(called, false, "advisor fn must not be invoked when idle_advisor is false");
  assert.ok(engineCalls.some((c) => c.slug === "dax" && c.input.includes("only item")), "FIFO item should still run");
});

// ---------------------------------------------------------------------------
// Scheduled standup (Orchestrator.runStandup / standup_cron) — injected fake
// StandupFn (never the real Agent SDK query()) plus fake Discord/push
// surfaces that just record what they were called with.
// ---------------------------------------------------------------------------

await check("scheduled standup: cron match delivers to db + #office + push, never throws", async () => {
  const officePosts: string[] = [];
  const pushNotifies: { title: string; body: string; url: string; tag: string }[] = [];
  const fakeDiscord = {
    postToOffice: async (text: string) => {
      officePosts.push(text);
    },
  };
  const fakePush = {
    notify: async (payload: { title: string; body: string; url: string; tag: string }) => {
      pushNotifies.push(payload);
    },
  };
  const fakeStandup = async () => "Digest: everyone did great.";
  // idle_advisor:false + "*/1 * * * *" (matches every minute) — this heartbeat
  // must not touch the real advisor for the other interns already registered.
  const cronConfig = { ...config, idle_advisor: false, standup_cron: "*/1 * * * *" };
  const orch = new Orchestrator(db, registry, fakeEngine, cronConfig, undefined, fakeDiscord, fakePush, undefined, fakeStandup);
  const before = db.listMessages("coordinator").length;
  await orch.heartbeat();
  assert.deepEqual(officePosts, ["Digest: everyone did great."]);
  assert.deepEqual(pushNotifies, [{ title: "Morning standup", body: "Digest: everyone did great.", url: "/today", tag: "standup" }]);
  const coordinatorMessages = db.listMessages("coordinator");
  assert.equal(coordinatorMessages.length, before + 1);
  const last = coordinatorMessages[coordinatorMessages.length - 1]!;
  assert.equal(last.text, "Digest: everyone did great.");
  assert.equal(last.author, "coordinator");
});

await check("scheduled standup: discord/push failures are swallowed, digest still recorded", async () => {
  const fakeDiscord = {
    postToOffice: async () => {
      throw new Error("discord is down");
    },
  };
  const fakePush = {
    notify: async () => {
      throw new Error("push is down");
    },
  };
  const fakeStandup = async () => "Digest: resilience check.";
  const cronConfig = { ...config, idle_advisor: false, standup_cron: "*/1 * * * *" };
  const orch = new Orchestrator(db, registry, fakeEngine, cronConfig, undefined, fakeDiscord, fakePush, undefined, fakeStandup);
  const before = db.listMessages("coordinator").length;
  await orch.heartbeat(); // must not throw despite both surfaces failing
  const coordinatorMessages = db.listMessages("coordinator");
  assert.equal(coordinatorMessages.length, before + 1);
  assert.equal(coordinatorMessages[coordinatorMessages.length - 1]!.text, "Digest: resilience check.");
});

await check("archive moves intern to _fired", () => {
  registry.archive("milo");
  assert.ok(!fs.existsSync(path.join(tmpHome, "milo")));
  assert.ok(fs.existsSync(path.join(tmpHome, "_fired", "milo", "intern.yaml")));
  assert.ok(!registry.list().some((i) => i.slug === "milo"));
});

// ---------------------------------------------------------------------------
// /interns/:slug/manifest + /meta — HTTP round-trip against a throwaway
// INTERNS_HOME with dry_run Discord, mirroring how card routes are exercised.
// Isolated from the tmpHome above so it doesn't disturb the orchestrator/
// engine checks already run.
// ---------------------------------------------------------------------------
{
  const apiHome = fs.mkdtempSync(path.join(os.tmpdir(), "interns-smoke-api-"));
  const apiConfig = loadConfig(apiHome);
  apiConfig.port = 0; // OS-assigned ephemeral port, avoids collisions
  const apiBus = new EventBus();
  const apiDb = new Db(apiBus, apiHome);
  const apiRegistry = new Registry(apiHome);
  const apiDiscord = new DiscordAdapter(apiDb, apiRegistry, apiBus, apiConfig); // dry_run by default
  const provisionedDiscordInterns: string[] = [];
  apiDiscord.ensureInternChannel = async (slug) => {
    provisionedDiscordInterns.push(slug);
    return null;
  };
  const apiPush = new PushService(apiDb, apiConfig);
  const fakeGithubKey = path.join(apiHome, "github-test.pem");
  fs.writeFileSync(fakeGithubKey, "fixture only", { mode: 0o600 });
  apiConfig.github = {
    ...apiConfig.github,
    app_id: "123",
    installation_id: "456",
    private_key_path: fakeGithubKey,
    webhook_secret: "github-smoke-secret",
    repositories: ["acme/widget"],
    reviewer_slug: "code-reviewer",
  };
  const apiCapabilities = new CapabilityService(apiDb, apiRegistry, apiConfig, apiHome);
  const publishedReviews: any[] = [];
  const apiApprovals = new ApprovalService(apiDb, apiCapabilities, {
    publishReview: async (proposal: any) => {
      publishedReviews.push(proposal);
      return { id: 991, state: proposal.event };
    },
  });
  const apiGithub = {
    listInstallationRepositories: async () => ["acme/widget"],
    getPullRequest: async () => ({
      title: "Fix widget edge case",
      html_url: "https://github.com/acme/widget/pull/42",
      changed_files: 3,
      additions: 48,
      deletions: 9,
    }),
    getChecks: async () => ({
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ],
    }),
  };

  const apiManifest = InternManifestSchema.parse({
    name: "Nova",
    role: "test intern for the manifest API",
    icon: "face-01",
    persona: "Calm. Exact.",
    system_prompt: "You are Nova, a test intern.",
    tools: ["fs.read"],
    triggers: { cron: "0 7 * * 1-5", mentions: true },
    backlog: ["item one", "item two"],
    guardrails: { drafts_only: true, daily_token_cap: 100_000 },
  });
  apiRegistry.save(apiManifest, "nova");
  apiDb.upsertIntern({ slug: "nova", name: apiManifest.name, role: apiManifest.role, icon: apiManifest.icon });
  const apiOrchestrator = new Orchestrator(apiDb, apiRegistry, {
    runIntern: async () => ({ ok: true, text: "", sessionId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  }, apiConfig);
  // Fake room pre-check: "numbers" → the research intern (orion); "thanks" → nobody; anything else → throw (fail open).
  const responderCalls: string[] = [];
  apiOrchestrator.chooseRespondersFn = async (room, text) => {
    responderCalls.push(text);
    if (/numbers/i.test(text)) return { responders: [room.members.find((m) => m.slug === "orion")?.slug ?? ""].filter(Boolean), reason: "orion owns numbers" };
    if (/thanks/i.test(text)) return { responders: [], reason: "social, nobody needs to reply" };
    throw new Error("simulated pre-check outage");
  };

  // A miniature `expo export` for the app-shell routing checks below.
  const apiDist = path.join(apiHome, "dist");
  for (const page of ["index", "spend", "hire", "cards", "chat/[slug]", "(tabs)/index", "+not-found"]) {
    fs.mkdirSync(path.dirname(path.join(apiDist, page)), { recursive: true });
    fs.writeFileSync(path.join(apiDist, `${page}.html`), `page:${page}`);
  }
  process.env.INTERNS_APP_DIST = apiDist;

  const apiApp = await startApi({
    db: apiDb,
    registry: apiRegistry,
    bus: apiBus,
    config: apiConfig,
    discord: apiDiscord,
    push: apiPush,
    approvals: apiApprovals,
    capabilities: apiCapabilities,
    github: apiGithub as never,
    orchestrator: apiOrchestrator,
    home: apiHome,
  });
  const addr = apiApp.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : apiConfig.port}`;

  async function apiFetch(
    urlPath: string,
    opts: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${base}${urlPath}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.auth === false ? {} : { Authorization: `Bearer ${apiConfig.api_token}` }),
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }

  try {
    await check("manifest/meta routes are bearer-gated", async () => {
      assert.equal((await apiFetch("/interns/nova/manifest", { auth: false })).status, 401);
      assert.equal((await apiFetch("/meta", { auth: false })).status, 401);
    });

    // ---- attachments: upload → signed download → link to a message → intern reply linking
    apiDb.apiToken = apiConfig.api_token;
    // 1x1 PNG (67 bytes) — a real header so the size sniff has something to read.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    async function upload(slug: string, name: string, bytes: Buffer, type: string, extra = "") {
      const res = await fetch(`${base}/interns/${slug}/attachments?name=${encodeURIComponent(name)}${extra}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiConfig.api_token}`, "Content-Type": type },
        body: bytes,
      });
      return { status: res.status, body: (await res.json()) as any };
    }
    let uploadedId = "";
    await check("attachments: upload sniffs PNG, records size, returns a signed url", async () => {
      const { status, body } = await upload("nova", "../../dot.png", png, "application/octet-stream");
      assert.equal(status, 201);
      assert.equal(body.kind, "image");
      assert.equal(body.mime, "image/png");
      assert.equal(body.name, "dot.png"); // path components stripped
      assert.equal(body.width, 1);
      assert.equal(body.height, 1);
      assert.equal(body.message_id, null);
      assert.ok(body.url.startsWith(`/attachments/${body.id}?sig=`));
      assert.ok(fs.existsSync(body.path));
      uploadedId = body.id;
    });
    await check("attachments: unknown intern → 404, empty body → 400", async () => {
      assert.equal((await upload("ghost", "x.txt", Buffer.from("hi"), "text/plain")).status, 404);
      assert.equal((await upload("nova", "x.txt", Buffer.alloc(0), "text/plain")).status, 400);
    });
    await check("attachments: bytes need bearer OR a valid signature", async () => {
      const sig = signAttachment(apiConfig.api_token, uploadedId);
      const unauth = await fetch(`${base}/attachments/${uploadedId}`);
      assert.equal(unauth.status, 401);
      const badSig = await fetch(`${base}/attachments/${uploadedId}?sig=${"0".repeat(32)}`);
      assert.equal(badSig.status, 401);
      const signed = await fetch(`${base}/attachments/${uploadedId}?sig=${sig}`);
      assert.equal(signed.status, 200);
      assert.equal(signed.headers.get("content-type"), "image/png");
      assert.ok(signed.headers.get("content-disposition")?.startsWith("inline"));
      assert.equal(Buffer.from(await signed.arrayBuffer()).equals(png), true);
      const dl = await fetch(`${base}/attachments/${uploadedId}?sig=${sig}&download=1`);
      assert.ok(dl.headers.get("content-disposition")?.startsWith("attachment"));
      const bearer = await fetch(`${base}/attachments/${uploadedId}/meta`, { headers: { Authorization: `Bearer ${apiConfig.api_token}` } });
      assert.equal(bearer.status, 200);
    });
    await check("attachments: message claims the upload; task payload carries the disk path", async () => {
      const { status, body } = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "look at this", attachment_ids: [uploadedId] } });
      assert.equal(status, 200);
      assert.equal(body.message.attachments.length, 1);
      assert.equal(body.message.attachments[0].id, uploadedId);
      const task = apiDb.getTask(body.task_id)!;
      const files = task.payload.attachments as { path: string; mime: string }[];
      assert.equal(files.length, 1);
      assert.ok(files[0]!.path.endsWith(`${uploadedId}.png`));
      // history hydrates attachments too
      const history = await apiFetch("/interns/nova/messages");
      const stored = history.body.find((m: any) => m.id === body.message.id);
      assert.equal(stored.attachments.length, 1);
      // re-using a claimed attachment is refused
      const again = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "again", attachment_ids: [uploadedId] } });
      assert.equal(again.status, 400);
      // attachment-only messages are fine (no text)
      const second = await upload("nova", "notes.txt", Buffer.from("hello"), "text/plain");
      const only = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "", attachment_ids: [second.body.id] } });
      assert.equal(only.status, 200);
      assert.equal(only.body.message.attachments[0].kind, "file");
      assert.equal((await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "" } })).status, 400);
    });
    await check("attachments: intern uploads during a run are linked to its reply and re-emitted", async () => {
      const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>');
      const since = new Date(Date.now() - 1000).toISOString();
      const up = await upload("nova", "pic.svg", svg, "application/octet-stream", "&author=intern&caption=A%20box");
      assert.equal(up.body.kind, "svg");
      assert.equal(up.body.width, 200);
      assert.equal(up.body.caption, "A box");
      const emitted: string[] = [];
      const off = apiBus.on("message", (m) => emitted.push(`${m.id}:${m.attachments.length}`));
      const reply = apiDb.addMessage({ intern: "nova", author: "intern", text: "here you go [attachment:abcdef12-3456]", surface: "system" });
      const linked = apiDb.linkOrphanInternAttachments("nova", since, reply.id);
      apiDb.emitMessage(reply.id);
      off();
      assert.equal(linked.length, 1);
      assert.equal(linked[0]!.id, up.body.id);
      assert.deepEqual(emitted, [`${reply.id}:0`, `${reply.id}:1`]);
      assert.equal(apiDb.getMessage(reply.id)!.attachments[0]!.id, up.body.id);
      assert.equal((await apiFetch("/interns/nova/attachments")).body.length, 3);
    });
    // ---- rooms + mentions
    let roomId = "";
    await check("mentions: resolve names, slugs, first names and @everyone", () => {
      const dir = [{ slug: "nova", name: "Nova Prime" }, { slug: "code-reviewer", name: "Rhea" }];
      assert.deepEqual(resolveMentions("hey @Nova and @rhea, also @code-reviewer again", dir).slugs, ["nova", "code-reviewer"]);
      assert.deepEqual(resolveMentions("@Nova_Prime please", dir).slugs, ["nova"]);
      assert.deepEqual(resolveMentions("mail me at owner@northwind.example @nobody", dir).slugs, []);
      assert.deepEqual(resolveMentions("@everyone standup", dir), { slugs: ["nova", "code-reviewer"], everyone: true });
      assert.equal(isSilentReply("(nothing)"), true);
      assert.equal(isSilentReply("Nothing."), true);
      assert.equal(isSilentReply("Nothing to report from the mailbox."), false);
    });
    await check("rooms: create, list with last message, patch, unknown member → 400", async () => {
      apiRegistry.save(InternManifestSchema.parse({ ...apiManifest, name: "Orion", icon: "face-03" }), "orion");
      apiDb.upsertIntern({ slug: "orion", name: "Orion", role: "test", icon: "face-03" });
      const bad = await apiFetch("/rooms", { method: "POST", body: { name: "Ops", members: ["nova", "ghost"] } });
      assert.equal(bad.status, 400);
      const created = await apiFetch("/rooms", { method: "POST", body: { name: "Ops", members: ["nova", "orion"], topic: "Keep it short." } });
      assert.equal(created.status, 201);
      roomId = created.body.id;
      assert.ok(roomId.startsWith("room-"));
      const list = await apiFetch("/rooms");
      assert.equal(list.body[0].id, roomId);
      assert.equal(list.body[0].last_message.author, "coordinator");
      const patched = await apiFetch(`/rooms/${roomId}`, { method: "PATCH", body: { name: "Ops room" } });
      assert.equal(patched.body.name, "Ops room");
      assert.deepEqual(patched.body.members, ["nova", "orion"]);
    });
    await check("rooms: mentions → those members; @all / @<room name> → everyone; plain → pre-check; outage → everyone", async () => {
      const mentioned = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "@Orion can you take this?" } });
      assert.equal(mentioned.status, 200);
      assert.deepEqual(mentioned.body.targets, ["orion"]);
      assert.equal(mentioned.body.message.intern, roomId);
      const orionTask = apiDb.currentTask("orion")!;
      assert.equal(orionTask.payload.thread, roomId);
      assert.equal((orionTask.payload.room as any).name, "Ops room");
      assert.equal(orionTask.payload.depth, 0);
      assert.equal(responderCalls.length, 0, "a mention never triggers the pre-check");
      const all = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "@all status please" } });
      assert.deepEqual(all.body.targets.sort(), ["nova", "orion"]);
      const byName = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "@Ops_room status please" } });
      assert.deepEqual(byName.body.targets.sort(), ["nova", "orion"]);
      const firstWord = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "hey @ops, status?" } });
      assert.deepEqual(firstWord.body.targets.sort(), ["nova", "orion"]);
      assert.equal(responderCalls.length, 0, "explicit everyone never triggers the pre-check");
      const routed = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "can someone pull the numbers?" } });
      assert.deepEqual(routed.body.targets, ["orion"]);
      const nobody = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "thanks all, great work" } });
      assert.deepEqual(nobody.body.targets, []);
      const outage = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "thoughts, anyone?" } });
      assert.deepEqual(outage.body.targets.sort(), ["nova", "orion"]);
      assert.equal(responderCalls.length, 3);
      for (const t of apiDb.nextQueuedTasks()) apiDb.markTask(t.id, "cancelled", "test cleanup");
      while (apiDb.nextQueuedTasks().length) for (const t of apiDb.nextQueuedTasks()) apiDb.markTask(t.id, "cancelled", "test cleanup");
    });
    await check("rooms: intern reply lands in the room with a speaker, and its @mention routes one hop further (hop-limited)", async () => {
      const replies = ["Draft ready — @Nova can you sanity-check the numbers?", "Looks right to me, @Orion ship it.", "Shipping. @Nova thanks", "(nothing)"];
      let call = 0;
      const roomOrchestrator = new Orchestrator(apiDb, apiRegistry, {
        runIntern: async () => ({ ok: true, text: replies[Math.min(call++, replies.length - 1)]!, sessionId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      }, { ...apiConfig, idle_advisor: false });
      await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "@Orion draft the plan" } });
      await roomOrchestrator.drain();
      const history = apiDb.listMessages(roomId);
      const fromInterns = history.filter((m) => m.author === "intern");
      assert.equal(fromInterns[0]!.speaker, "orion");
      assert.equal(fromInterns[0]!.intern, roomId);
      assert.equal(fromInterns[1]!.speaker, "nova"); // pulled in by Orion's mention
      assert.equal(fromInterns[2]!.speaker, "orion"); // pulled back by Nova
      // Orion's "Shipping. @Nova thanks" is hop 3 → Nova asked again at hop 4 → replies "(nothing)" (dropped, silent)
      assert.ok(fromInterns.length <= 4, `chain stopped: ${fromInterns.length} intern messages`);
      assert.ok(!history.some((m) => m.text === "(nothing)"), "silent replies are not posted");
      assert.ok(MAX_MENTION_HOPS >= 3);
      const activity = (await apiFetch("/activity")).body.find((t: any) => t.intern === "nova" && /Ops room/.test(t.label));
      assert.ok(activity, "activity label names the room");
    });
    await check("threads in rooms: JP's reply_to is kept, routed replies answer the triggering message, spend is attributed to the room", async () => {
      const replies = ["Numbers: 41k / 32k / 19k.", "(nothing)"];
      let call = 0;
      const threadOrchestrator = new Orchestrator(apiDb, apiRegistry, {
        runIntern: async (slug) => {
          apiDb.recordSpend(slug, 500, 100, 0.01);
          return { ok: true, text: replies[Math.min(call++, replies.length - 1)]!, sessionId: null, inputTokens: 500, outputTokens: 100, costUsd: 0.01 };
        },
      }, { ...apiConfig, idle_advisor: false });
      const history0 = apiDb.listMessages(roomId);
      const anchor = history0[history0.length - 1]!;
      const posted = await apiFetch(`/interns/${roomId}/messages`, { method: "POST", body: { text: "@Orion the numbers please", reply_to: anchor.id } });
      assert.equal(posted.body.message.reply_to, anchor.id);
      const foreign = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "hi", reply_to: anchor.id } });
      assert.equal(foreign.body.message.reply_to, null, "reply_to must point into the same thread");
      for (const t of apiDb.nextQueuedTasks()) if (t.intern === "nova") apiDb.markTask(t.id, "cancelled", "test cleanup");
      await threadOrchestrator.drain();
      const history = apiDb.listMessages(roomId);
      const orion = history.filter((m) => m.speaker === "orion").pop()!;
      assert.equal(orion.reply_to, posted.body.message.id, "routed reply answers the message that triggered it");
      const spend = (await apiFetch("/reports/spend?days=7")).body;
      assert.equal(spend.days.length, 7);
      const room = spend.by_thread.find((t: any) => t.thread === roomId);
      assert.ok(room && room.cost_usd >= 0.01 && room.runs >= 1, "room spend attributed");
      assert.equal(spend.names[roomId], "Ops room");
      assert.ok(spend.by_intern.some((r: any) => r.intern === "orion"));
    });

    await check("suggestions: evidence collects repeated asks + gaps; proposals become cards; decisions are remembered and suppress repeats", async () => {
      for (let i = 0; i < 3; i++) apiDb.addMessage({ intern: "nova", author: "jp", text: "chase the supplier invoices for Hopfield please", surface: "app" });
      apiDb.addMessage({ intern: "nova", author: "intern", text: "I can't open the invoice portal — no access to Xero from here.", surface: "system", speaker: "nova" });
      const evidence = collectEvidence(apiDb, apiRegistry);
      assert.ok(evidence.repeated_asks.some((a) => a.count >= 3 && /supplier invoices/.test(a.phrase)), "repeated ask detected");
      assert.ok(evidence.capability_gaps.some((g) => /Xero/.test(g.snippet)), "capability gap detected");
      assert.ok(evidence.roster.some((r) => r.slug === "nova"));
      let calls = 0;
      const proposeFn = async () => {
        calls += 1;
        return [
          { kind: "hire" as const, key: "hire-invoice-chaser", title: "An invoice chaser", why: "You asked Nova about supplier invoices 3 times.", proposal: "Hire an intern who owns supplier follow-ups.", hire_role: "someone who chases supplier invoices and payment status" },
          { kind: "capability" as const, key: "xero-for-nova", title: "Give Nova Xero access", why: "Nova said it cannot open the invoice portal.", proposal: "Request a Xero read integration.", target_intern: "nova", capability: "xero" },
        ];
      };
      const off = wireSuggestionDecisions(apiBus, apiHome, apiCapabilities);
      const first = await runSuggestions({ db: apiDb, registry: apiRegistry, home: apiHome, proposeFn });
      assert.equal(first.cards.length, 2);
      assert.equal(first.cards[0]!.context.type, "suggestion");
      assert.deepEqual(first.cards[0]!.actions.map((a) => a.id), ["hire", "later", "never"]);
      assert.deepEqual(first.cards[1]!.actions.map((a) => a.id), ["request", "later", "never"]);
      // same proposals again while the cards are open → suppressed
      const again = await runSuggestions({ db: apiDb, registry: apiRegistry, home: apiHome, proposeFn });
      assert.equal(again.cards.length, 0);
      assert.deepEqual(again.skipped, ["hire-invoice-chaser", "xero-for-nova"]);
      // JP decides via the API: never on the hire, request on the capability
      assert.equal((await apiFetch(`/cards/${first.cards[0]!.id}/actions/never`, { method: "POST", body: {} })).status, 200);
      assert.equal((await apiFetch(`/cards/${first.cards[1]!.id}/actions/request`, { method: "POST", body: {} })).status, 200);
      const memory = loadMemory(apiHome);
      assert.equal(memory.records.find((r) => r.key === "hire-invoice-chaser")?.decision, "never");
      assert.equal(memory.records.find((r) => r.key === "xero-for-nova")?.decision, "accepted");
      assert.ok(isSuppressed(memory, "hire-invoice-chaser"));
      assert.ok(apiDb.listCapabilityRequests().some((c) => c.intern === "nova" && c.capability === "xero"), "capability request created");
      // manual run over the API uses the injected proposer and reports the summary
      apiOrchestrator.proposeFn = proposeFn;
      const manual = await apiFetch("/suggest/run", { method: "POST", body: {} });
      assert.equal(manual.status, 202);
      assert.equal(manual.body.running, true);
      let status = manual.body;
      for (let i = 0; i < 100 && status.running; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await apiFetch("/suggest/status")).body;
      }
      assert.equal(status.running, false);
      assert.equal(status.last.created, 0);
      assert.equal(status.last.error, null);
      assert.ok(status.last.evidence_summary.repeated_asks >= 1);
      assert.equal((await apiFetch("/suggest/history")).body.records.length, 2);
      assert.ok(calls >= 3);
      off();
    });

    await check("render: chart / mermaid / svg blocks become PNGs with numbered placeholders", async () => {
      const spec = normalizeChartSpec({ type: "bar", title: "T", labels: ["a", "b"], series: [{ name: "s", data: [1, 2] }] })!;
      assert.ok(chartToSvg(spec).startsWith("<svg"));
      const flow = mermaidToSvg("flowchart LR\n A[Start] -- yes --> B{Ok?}\n B --> C((End))");
      assert.ok(flow && "svg" in flow && /Start/.test(flow.svg) && /yes/.test(flow.svg));
      const seq = mermaidToSvg("sequenceDiagram\n A->>B: hi\n B-->>A: yo");
      assert.ok(seq && "svg" in seq && /marker-end/.test(seq.svg));
      assert.equal(mermaidToSvg("gantt\n title x"), null);
      const text = "Intro\n\n```chart\n{\"type\":\"pie\",\"labels\":[\"x\",\"y\"],\"series\":[{\"name\":\"v\",\"data\":[3,1]}]}\n```\n\nand\n\n```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"red\"/></svg>\n```\n\n```mermaid\ngantt\n```\ndone";
      const rendered = await renderRichBlocks(text);
      assert.equal(rendered.images.length, 2);
      assert.deepEqual(rendered.images.map((i) => i.name), ["chart-1.png", "drawing-2.png"]);
      assert.ok(rendered.images.every((i) => i.png.subarray(1, 4).toString() === "PNG"));
      assert.equal(rendered.text, "Intro\n\n(chart 1 attached)\n\nand\n\n(drawing 2 attached)\n\n(diagram — open the app)\ndone");
    });

    await check("pins + scratchpad: pin a message, list pins, edit/append the room pad with a system note", async () => {
      const posted = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "pin me: https://example.com/login" } });
      for (const t of apiDb.nextQueuedTasks()) apiDb.markTask(t.id, "cancelled", "test cleanup");
      const pinned = await apiFetch(`/messages/${posted.body.message.id}/pin`, { method: "POST", body: { pinned: true } });
      assert.equal(pinned.status, 200);
      assert.equal(pinned.body.pinned, true);
      const pins = await apiFetch("/interns/nova/pins");
      assert.deepEqual(pins.body.map((m: any) => m.id), [posted.body.message.id]);
      await apiFetch(`/messages/${posted.body.message.id}/pin`, { method: "POST", body: { pinned: false } });
      assert.equal((await apiFetch("/interns/nova/pins")).body.length, 0);
      const created = await apiFetch("/rooms", { method: "POST", body: { name: "Pad room", members: ["nova", "orion"] } });
      const rid = created.body.id;
      const set = await apiFetch(`/rooms/${rid}/scratchpad`, { method: "PUT", body: { scratchpad: "# Plan\n- owner: Nova" } });
      assert.equal(set.body.scratchpad, "# Plan\n- owner: Nova");
      const appended = await apiFetch(`/rooms/${rid}/scratchpad`, { method: "PUT", body: { scratchpad: "- decided: ship Friday", append: true, author: "orion" } });
      assert.equal(appended.body.scratchpad, "# Plan\n- owner: Nova\n\n- decided: ship Friday");
      const roomMsgs = apiDb.listMessages(rid);
      assert.ok(roomMsgs.some((m) => m.author === "coordinator" && /Orion updated the scratchpad/.test(m.text)));
      assert.equal((await apiFetch(`/rooms/${rid}`)).body.scratchpad.includes("ship Friday"), true);
      assert.ok(allowedToolsFor(apiManifest).some((t) => t.includes("room-pad")));
      // easter egg: exactly one day per month, deterministic, off when disabled
      const days = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 8, i + 1)));
      const hits = days.filter((d) => easterEggVoice(d, true) !== null);
      assert.equal(hits.length, 1);
      assert.equal(easterEggVoice(hits[0]!, false), null);
    });

    await check("handoff: JP mentioning another intern in a 1:1 thread pulls them into that thread", async () => {
      const res = await apiFetch("/interns/nova/messages", { method: "POST", body: { text: "@Orion what do you think of Nova's plan?" } });
      assert.deepEqual(res.body.targets, ["nova", "orion"]);
      const orionTask = apiDb.currentTask("orion")!;
      assert.equal(orionTask.payload.thread, "nova");
      for (const t of apiDb.nextQueuedTasks()) apiDb.markTask(t.id, "cancelled", "test cleanup");
      while (apiDb.nextQueuedTasks().length) for (const t of apiDb.nextQueuedTasks()) apiDb.markTask(t.id, "cancelled", "test cleanup");
      const archived = await apiFetch(`/rooms/${roomId}/archive`, { method: "POST", body: {} });
      assert.equal(archived.body.archived, true);
      assert.equal((await apiFetch(`/interns/${roomId}/messages`)).status, 404);
    });

    await check("standup: spend chart block + rich-block stripping for Discord/push", () => {
      // a throwaway slug so the manifest contract check below still sees zero spend for nova
      apiDb.recordSpend("ghost-spend", 1200, 300, 0.02);
      const block = spendChartBlock(apiDb, 7);
      assert.ok(block.startsWith("```chart\n") && block.endsWith("\n```"));
      const spec = JSON.parse(block.slice("```chart\n".length, -"\n```".length));
      assert.equal(spec.type, "bar");
      assert.equal(spec.stacked, true);
      assert.equal(spec.labels.length, 7);
      const ghost = spec.series.find((s: any) => s.name === "ghost-spend");
      assert.ok(ghost, "series present, named by slug when no intern row exists");
      assert.equal(ghost.data[6], 1500);
      const stripped = stripRichBlocks(`Digest line\n\n${block}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``);
      assert.equal(stripped, "Digest line\n\n(chart — open the app)\n\n(diagram — open the app)");
      assert.equal(stripRichBlocks("plain"), "plain");
    });

    await check("push text: markdown flattened to lock-screen prose", () => {
      // The notification that started this: a PR report whose first line is a
      // bold link — raw markdown put the URL on JP's lock screen.
      assert.equal(
        plainText("[**webapp #111 — CodeOps**](https://codeops.example.com/PullRequests/Open?repository=northwind%2Fwebapp&number=111) · [GitHub](https://github.com/northwind/webapp/pull/111) — 18 files"),
        "webapp #111 — CodeOps · GitHub — 18 files",
      );
      assert.equal(plainText("## What I noticed\nTessa created 13 cards."), "What I noticed · Tessa created 13 cards.");
      assert.equal(plainText("**What I noticed**\nTessa created 13 cards."), "What I noticed · Tessa created 13 cards.");
      assert.equal(plainText("Still missing:\n\n- **Danny's email**\n- A contact name"), "Still missing: • Danny's email • A contact name");
      assert.equal(plainText("| Step | When |\n|---|---|\n| First contact | Monday |"), "Step · When · First contact · Monday");
      assert.equal(plainText("> Hi Felix\n>\n> Groete"), "Hi Felix · Groete");
      assert.equal(plainText("Fingerprint:\n\n```\nSHA256:04g+T2AaBa2\n```"), "Fingerprint: (code — open the app)");
      assert.equal(plainText("Spend:\n\n```chart\n{}\n```"), "Spend: (chart — open the app)");
      assert.equal(plainText("`ssh.key` sits at the ~~old~~ _root_ of <https://example.com/x>"), "ssh.key sits at the old root of https://example.com/x");
      assert.equal(plainText("plain sentence"), "plain sentence");
      // Same scrub as the app's chat-list previews: no agent plumbing on the lock screen.
      assert.equal(plainText("Failed in /home/sam/repos/webapp/x.ts"), "Failed");
      assert.equal(plainText("Review of https://github.com/northwind/webapp/pull/111 done"), "Review of northwind/webapp #111 done");
      // Truncation lands on a word boundary and never mid-markup.
      const long = notificationText("**CI:** test, typecheck and changes all green. The one red is `Validate title` — the workflow wants a conventional-commit prefix.", 60);
      assert.ok(long.endsWith("…") && long.length <= 60, long);
      assert.ok(!long.includes("*") && !long.includes("`"), long);
      assert.equal(notificationText("short one", 60), "short one");
    });

    await check("attachments: helpers (marker strip, mime resolution, names, sizes)", () => {
      assert.equal(stripAttachmentMarkers("done [attachment:0f3a1b2c-9d8e] thanks"), "done thanks");
      assert.equal(resolveMime("application/octet-stream", "a.csv", Buffer.from("a,b")), "text/csv");
      assert.equal(resolveMime("text/plain", "a.bin", png), "image/png");
      assert.equal(kindFor("image/svg+xml"), "svg");
      assert.equal(kindFor("application/pdf"), "file");
      assert.equal(safeName("/tmp/../we ird:name?.png"), "we ird_name_.png");
      assert.deepEqual(imageSize("image/png", png), { width: 1, height: 1 });
      assert.equal(allowedToolsFor(apiManifest).some((t) => t.includes("intern-attach")), true);
    });

    await check("task-control API pauses, prioritizes and cancels an exact task", async () => {
      const task = apiDb.enqueueTask("nova", "trigger", { kind: "api-control-test" });
      assert.equal((await apiFetch(`/tasks/${task.id}/actions/pause`, { method: "POST", body: {}, auth: false })).status, 401);
      const paused = await apiFetch(`/tasks/${task.id}/actions/pause`, { method: "POST", body: {} });
      assert.equal(paused.status, 200);
      assert.equal(paused.body.status, "paused");
      const prioritized = await apiFetch(`/tasks/${task.id}/actions/prioritize`, { method: "POST", body: {} });
      assert.equal(prioritized.status, 200);
      assert.ok(prioritized.body.priority > 0);
      const cancelled = await apiFetch(`/tasks/${task.id}/actions/cancel`, { method: "POST", body: {} });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, "cancelled");
    });

    await check("GET manifest: unknown slug → 404", async () => {
      assert.equal((await apiFetch("/interns/ghost/manifest")).status, 404);
    });

    await check("GET manifest: coordinator is not a real intern → 404", async () => {
      assert.equal((await apiFetch("/interns/coordinator/manifest")).status, 404);
    });

    await check("GET manifest: full contract shape", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest");
      assert.equal(status, 200);
      assert.equal(body.slug, "nova");
      assert.equal(body.name, "Nova");
      assert.equal(body.role, apiManifest.role);
      assert.equal(body.icon, "face-01");
      assert.equal(body.persona, apiManifest.persona);
      assert.equal(body.system_prompt, apiManifest.system_prompt);
      assert.deepEqual(body.tools, ["fs.read"]);
      assert.deepEqual(body.triggers, { cron: "0 7 * * 1-5", mentions: true, mail_push: false, meeting_brief: false });
      assert.equal(body.mailboxes, null, "no mailbox limit: every connected one");
      assert.deepEqual(body.backlog, ["item one", "item two"]);
      assert.deepEqual(body.guardrails, { drafts_only: true, daily_token_cap: 100_000 });
      assert.deepEqual(body.spend_today, { input_tokens: 0, output_tokens: 0, cost_usd: 0 });
      assert.deepEqual(body.discord, { channel_id: null });
    });

    await check("GET /meta: icons + tools mirror the source-of-truth catalogs", async () => {
      const { status, body } = await apiFetch("/meta");
      assert.equal(status, 200);
      assert.deepEqual(body.icons, ICONS);
      assert.deepEqual(body.tools.sort(), [...INTERN_ASSIGNABLE_TOOL_NAMES].sort());
    });

    await check("hire confirmation withholds capability tools until activation", async () => {
      const result = await apiFetch("/hire/confirm", {
        method: "POST",
        body: {
          draft: {
            name: "Gatekeeper",
            role: "Code reviewer",
            icon: "face-08",
            persona: "Careful and concrete.",
            system_prompt: "Review pull requests only after GitHub access is activated.",
            tools: ["fs.read", "github", "cards"],
            triggers: { mentions: true },
            backlog: [],
            guardrails: { drafts_only: true, daily_token_cap: 100_000 },
          },
          icon: "face-08",
          required_capabilities: [{ id: "github", reason: "Read pull requests and prepare gated reviews." }],
        },
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.manifest.tools, ["fs.read", "cards"]);
      assert.ok(!apiRegistry.get("gatekeeper")!.tools.includes("github"));
      assert.equal(result.body.capability_requests[0].status, "requested");
      assert.deepEqual(provisionedDiscordInterns, ["gatekeeper"]);
    });

    await check("manifest editor cannot bypass managed-tool activation", async () => {
      const result = await apiFetch("/interns/gatekeeper/manifest", {
        method: "PATCH",
        body: { tools: ["fs.read", "cards", "github"] },
      });
      assert.equal(result.status, 403);
      assert.deepEqual(result.body.detail, ["github"]);
      assert.ok(!apiRegistry.get("gatekeeper")!.tools.includes("github"));
    });

    const capabilityIntern = InternManifestSchema.parse({
      name: "Quinn",
      role: "capability test intern",
      icon: "face-03",
      persona: "",
      system_prompt: "Test capability activation.",
      tools: ["fs.read"],
      triggers: {},
      backlog: [],
      guardrails: { drafts_only: true, daily_token_cap: 100_000 },
    });
    apiRegistry.save(capabilityIntern, "quinn");
    apiDb.upsertIntern({ slug: "quinn", name: capabilityIntern.name, role: capabilityIntern.role, icon: capabilityIntern.icon });

    await check("capability pipeline: build approval → ready → activation approval grants the tool", async () => {
      const request = apiCapabilities.request("quinn", {
        id: "github",
        reason: "Review pull requests and prepare human-gated feedback.",
      });
      assert.equal(request.status, "requested");
      assert.ok(request.card_id);

      const approved = await apiFetch(`/cards/${request.card_id}/actions/approve_build`, {
        method: "POST",
        body: {},
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.state, "resolved");
      assert.equal(apiDb.getCapabilityRequest(request.id)!.status, "ready");

      const ready = apiDb.getCapabilityRequest(request.id)!;
      assert.ok(ready.card_id && ready.card_id !== request.card_id, "activation gets a separate approval card");
      const activated = await apiFetch(`/cards/${ready.card_id}/actions/activate`, { method: "POST", body: {} });
      assert.equal(activated.status, 200);
      assert.equal(apiDb.getCapabilityRequest(request.id)!.status, "active");
      assert.ok(apiRegistry.get("quinn")!.tools.includes("github"));

      const again = await apiFetch(`/cards/${ready.card_id}/actions/activate`, { method: "POST", body: {} });
      assert.equal(again.status, 200);
      assert.equal(again.body.id, activated.body.id, "resolved approval is idempotent");
    });

    await check("capability pipeline: unknown integration goes to Forge in an isolated build task", async () => {
      const request = apiCapabilities.request("quinn", {
        id: "linear",
        reason: "Watch assigned issues in Linear.",
      });
      const approved = await apiFetch(`/cards/${request.card_id}/actions/approve_build`, {
        method: "POST",
        body: {},
      });
      assert.equal(approved.status, 200);
      assert.equal(apiDb.getCapabilityRequest(request.id)!.status, "building");
      assert.equal(apiRegistry.get("forge")!.role, "Integration engineer");
      const buildTask = apiDb.nextQueuedTasks().find((t) => t.intern === "forge");
      assert.equal(buildTask?.payload.type, "capability_build");
      assert.equal(buildTask?.payload.request_id, request.id);
    });

    const reviewerManifest = InternManifestSchema.parse({
      name: "Rhea",
      role: "Code reviewer",
      icon: "face-08",
      persona: "Precise and constructive.",
      system_prompt: "Review GitHub pull requests. Propose reviews; never publish without JP's approval.",
      tools: ["github"],
      triggers: { mentions: true },
      backlog: [],
      guardrails: { drafts_only: true, daily_token_cap: 100_000 },
    });
    apiRegistry.save(reviewerManifest, "code-reviewer");
    apiDb.upsertIntern({ slug: "code-reviewer", name: reviewerManifest.name, role: reviewerManifest.role, icon: reviewerManifest.icon });

    await check("GitHub webhook: signature, allowlist, trigger enqueue, and delivery dedupe", async () => {
      const payload = {
        action: "opened",
        repository: { full_name: "acme/widget", owner: { login: "acme" } },
        pull_request: {
          number: 42,
          title: "Make widgets safer",
          user: { login: "octocat" },
          head: { sha: "abc123" },
          base: { sha: "def456" },
          draft: false,
          html_url: "https://github.com/acme/widget/pull/42",
        },
      };
      const raw = JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", apiConfig.github.webhook_secret).update(raw).digest("hex")}`;
      const headers = {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-smoke-1",
        "x-github-event": "pull_request",
      };
      const first = await apiFetch("/webhooks/github", { method: "POST", body: payload, auth: false, headers });
      assert.equal(first.status, 202);
      assert.ok(first.body.task_id);
      const task = apiDb.getTask(first.body.task_id)!;
      assert.equal(task.intern, apiConfig.github.reviewer_slug);
      assert.equal(task.payload.pull_number, 42);

      const duplicate = await apiFetch("/webhooks/github", { method: "POST", body: payload, auth: false, headers });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.duplicate, true);

      const invalid = await apiFetch("/webhooks/github", {
        method: "POST",
        body: payload,
        auth: false,
        headers: { ...headers, "x-github-delivery": "delivery-smoke-2", "x-hub-signature-256": "sha256=bad" },
      });
      assert.equal(invalid.status, 401);
    });

    await check("GitHub polling fallback: queues each PR head exactly once", async () => {
      const pollConfig = { ...apiConfig, github: { ...apiConfig.github, repositories: ["acme/polled"] } };
      let calls = 0;
      const watcher = new GithubWatcher(apiDb, apiRegistry, pollConfig, {
        configured: true,
        listInstallationRepositories: async () => [],
        listPullRequests: async () => {
          calls++;
          return [
            {
              number: 7,
              title: "Polled PR",
              html_url: "https://github.com/acme/polled/pull/7",
              draft: false,
              user: { login: "dev" },
              head: { sha: "poll-sha-1" },
              base: { sha: "main-sha" },
            },
          ];
        },
      });
      await watcher.poll();
      await watcher.poll();
      assert.equal(calls, 2);
      const tasks = apiDb.nextQueuedTasks().filter((t) => t.intern === apiConfig.github.reviewer_slug);
      // nextQueuedTasks intentionally exposes one oldest queued task per intern;
      // inspect SQLite to prove only one polling task exists alongside webhook work.
      const count = apiDb.sqlite
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE intern = ? AND json_extract(payload, '$.repository') = ?")
        .get(apiConfig.github.reviewer_slug, "acme/polled") as { n: number };
      assert.equal(count.n, 1);
      assert.ok(tasks.length <= 1);
    });

    await check("GitHub reviews: proposal creates a card; only Publish executes once", async () => {
      const proposed = await apiFetch("/github/reviews", {
        method: "POST",
        body: {
          intern: "code-reviewer",
          owner: "acme",
          repo: "widget",
          pull_number: 42,
          event: "REQUEST_CHANGES",
          body: "One correctness issue needs attention.",
          comments: [{ path: "src/widget.ts", line: 17, side: "RIGHT", body: "Guard the null case." }],
          head_sha: "abc123",
        },
      });
      assert.equal(proposed.status, 200);
      assert.equal(publishedReviews.length, 0, "proposal must not publish");
      const card = proposed.body.card;
      assert.equal(card.title, "Fix widget edge case");
      assert.equal(card.context.repository, "acme/widget");
      assert.equal(card.context.pull_number, 42);
      assert.equal(card.context.risk, "low");
      assert.deepEqual(card.context.checks, { total: 2, passed: 2, failed: 0, pending: 0 });
      assert.equal(card.actions[0].label, "Request changes");
      const published = await apiFetch(`/cards/${card.id}/actions/publish`, { method: "POST", body: {} });
      assert.equal(published.status, 200);
      assert.equal(published.body.state, "resolved");
      assert.equal(publishedReviews.length, 1);
      assert.equal(publishedReviews[0].pull_number, 42);
      await apiFetch(`/cards/${card.id}/actions/publish`, { method: "POST", body: {} });
      assert.equal(publishedReviews.length, 1, "resolved card must not publish twice");
    });

    await check("PATCH manifest: partial body merges, does not replace the whole manifest", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { backlog: ["only this item"] },
      });
      assert.equal(status, 200);
      assert.deepEqual(body.backlog, ["only this item"]);
      assert.equal(body.name, "Nova"); // untouched fields survive the merge
      assert.equal(body.persona, apiManifest.persona);
      assert.deepEqual(body.tools, ["fs.read"]);
      assert.deepEqual(body.triggers, { cron: "0 7 * * 1-5", mentions: true, mail_push: false, meeting_brief: false });
      assert.deepEqual(apiRegistry.get("nova")!.backlog, ["only this item"]);
      assert.deepEqual(apiRegistry.get("nova")!.tools, ["fs.read"]);
    });

    await check("PATCH manifest: partial triggers update preserves other trigger keys", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { triggers: { mentions: false } },
      });
      assert.equal(status, 200);
      assert.deepEqual(body.triggers, { cron: "0 7 * * 1-5", mentions: false, mail_push: false, meeting_brief: false });
    });

    await check("PATCH manifest: explicit null clears the cron trigger", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { triggers: { cron: null } },
      });
      assert.equal(status, 200);
      assert.deepEqual(body.triggers, { cron: null, mentions: false, mail_push: false, meeting_brief: false });
      assert.equal(apiRegistry.get("nova")!.triggers.cron, undefined);
    });

    await check("PATCH manifest: unknown tool rejected, valid catalog listed, patch not applied", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { tools: ["fs.read", "nonsense.tool"] },
      });
      assert.equal(status, 400);
      assert.deepEqual(body.detail, ["nonsense.tool"]);
      assert.deepEqual(body.valid.sort(), [...INTERN_ASSIGNABLE_TOOL_NAMES].sort());
      assert.deepEqual(apiRegistry.get("nova")!.tools, ["fs.read"]);
    });

    await check("PATCH manifest: unknown icon rejected, patch not applied", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { icon: "not-a-real-icon" },
      });
      assert.equal(status, 400);
      assert.equal(body.detail, "not-a-real-icon");
      assert.ok(body.valid.includes("face-01"));
      assert.equal(apiRegistry.get("nova")!.icon, "face-01");
    });

    await check("PATCH manifest: daily_token_cap below 10000 rejected, patch not applied", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { guardrails: { daily_token_cap: 500 } },
      });
      assert.equal(status, 400);
      assert.match(body.error, /daily_token_cap/);
      assert.equal(apiRegistry.get("nova")!.guardrails.daily_token_cap, 100_000);
    });

    await check("PATCH manifest: non-integer daily_token_cap rejected", async () => {
      const { status } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { guardrails: { daily_token_cap: 15_000.5 } },
      });
      assert.equal(status, 400);
    });

    await check("PATCH manifest: unknown top-level field rejected (slug cannot be smuggled in)", async () => {
      const { status } = await apiFetch("/interns/nova/manifest", {
        method: "PATCH",
        body: { slug: "hacked" },
      });
      assert.equal(status, 400);
    });

    await check("PATCH manifest: unknown slug → 404", async () => {
      const { status } = await apiFetch("/interns/ghost/manifest", { method: "PATCH", body: { name: "x" } });
      assert.equal(status, 404);
    });

    await check("PATCH manifest: name change keeps slug stable, updates the db row, syncs Discord identity (dry_run)", async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
        origLog(...args);
      };
      let status: number, body: any;
      try {
        ({ status, body } = await apiFetch("/interns/nova/manifest", { method: "PATCH", body: { name: "Nova Prime" } }));
      } finally {
        console.log = origLog;
      }
      assert.equal(status, 200);
      assert.equal(body.slug, "nova"); // slug is stable identity — never derived from name post-hire
      assert.equal(body.name, "Nova Prime");
      assert.equal(apiRegistry.get("nova")!.name, "Nova Prime");
      assert.ok(!apiRegistry.get("nova-prime"), "must not create a re-slugified duplicate");
      const row = apiDb.getIntern("nova")!;
      assert.equal(row.slug, "nova");
      assert.equal(row.name, "Nova Prime");
      assert.equal(row.session_id, null); // PATCH never touches session identity
      assert.ok(logs.some((l) => l.includes("would update webhook identity for nova")), "name change should trigger the dry_run identity-update log");
    });

    await check("PATCH manifest: icon change also syncs Discord identity, stays best-effort under dry_run", async () => {
      const { status, body } = await apiFetch("/interns/nova/manifest", { method: "PATCH", body: { icon: "face-02" } });
      assert.equal(status, 200);
      assert.equal(body.icon, "face-02");
      assert.equal(apiDb.getIntern("nova")!.icon, "face-02");
    });

    // -------------------------------------------------------------------
    // POST /interns/:slug/archive ("fire" an intern)
    // -------------------------------------------------------------------
    const orinManifest = InternManifestSchema.parse({
      name: "Orin",
      role: "test intern for archive",
      icon: "face-01",
      persona: "",
      system_prompt: "You are Orin, a test intern.",
      tools: [],
      triggers: {},
      backlog: [],
      guardrails: { drafts_only: true, daily_token_cap: 100_000 },
    });
    apiRegistry.save(orinManifest, "orin");
    apiDb.upsertIntern({ slug: "orin", name: orinManifest.name, role: orinManifest.role, icon: orinManifest.icon });
    const orinQueuedTask = apiDb.enqueueTask("orin", "message", { text: "should never run" });

    await check("POST archive: unknown slug → 404", async () => {
      const { status } = await apiFetch("/interns/ghost/archive", { method: "POST", body: {} });
      assert.equal(status, 404);
    });

    await check("POST archive: coordinator → 404", async () => {
      const { status } = await apiFetch("/interns/coordinator/archive", { method: "POST", body: {} });
      assert.equal(status, 404);
    });

    await check("POST archive: fires the intern — exact response shape, dir moved, db archived, queued tasks cancelled", async () => {
      const { status, body } = await apiFetch("/interns/orin/archive", { method: "POST", body: {} });
      assert.equal(status, 200);
      assert.deepEqual(body, { slug: "orin", archived: true, name: "Orin" });

      assert.ok(!fs.existsSync(path.join(apiHome, "orin")), "intern dir should be moved out of the live tree");
      assert.ok(fs.existsSync(path.join(apiHome, "_fired", "orin", "intern.yaml")), "intern dir should land under _fired/");
      assert.ok(!apiRegistry.get("orin"), "registry.get should no longer see the fired intern");

      const row = apiDb.getIntern("orin")!;
      assert.ok(row.archived_at, "db row should be marked archived");

      const task = apiDb.getTask(orinQueuedTask.id)!;
      assert.equal(task.status, "failed");
      assert.equal(task.error, "intern archived");
    });

    await check("POST archive: firing the same slug again → 404 (already gone)", async () => {
      const { status } = await apiFetch("/interns/orin/archive", { method: "POST", body: {} });
      assert.equal(status, 404);
    });

    // Names are unique across the active crew; slugs never collide with archived interns
    const hireAs = (name: string) =>
      apiFetch("/hire/confirm", {
        method: "POST",
        body: { draft: { ...apiManifest, name, role: "namesake test" }, icon: "face-04" },
      });

    await check("hire confirm: an active intern's name (any case) → 409, nothing written", async () => {
      const before = apiRegistry.list().length;
      const { status, body } = await hireAs("nova prime");
      assert.equal(status, 409);
      assert.match(body.error, /Nova Prime is already on the crew/);
      assert.equal(apiRegistry.list().length, before);
      assert.equal(apiRegistry.get("nova")!.name, "Nova Prime", "existing intern must be untouched");
    });

    await check("hire confirm: the Coordinator's name is reserved → 409", async () => {
      const { status, body } = await hireAs("Coordinator");
      assert.equal(status, 409);
      assert.match(body.error, /reserved/);
    });

    await check("hire confirm: an archived intern's name is free, but gets a fresh slug", async () => {
      const { status, body } = await hireAs("Orin");
      assert.equal(status, 200);
      assert.equal(body.slug, "orin-2");
      assert.ok(apiDb.getIntern("orin")!.archived_at, "the archived Orin must stay archived");
      assert.equal(apiRegistry.get("orin-2")!.name, "Orin");
    });

    await check("PATCH manifest: renaming onto another active intern's name → 409; own name is fine", async () => {
      const clash = await apiFetch("/interns/orion/manifest", { method: "PATCH", body: { name: "Nova Prime" } });
      assert.equal(clash.status, 409);
      assert.equal(apiRegistry.get("orion")!.name, "Orion");
      const same = await apiFetch("/interns/nova/manifest", { method: "PATCH", body: { name: "NOVA PRIME" } });
      assert.equal(same.status, 200);
    });

    await check("hire prompt: lists the active crew's names as taken, and never offers a taken example", async () => {
      const { hirePrompt, takenNames } = await import("../src/hire.js");
      const taken = takenNames({ db: apiDb, registry: apiRegistry });
      assert.ok(taken.includes("NOVA PRIME") && taken.includes("Orin") && taken.includes("Coordinator"));
      assert.equal(new Set(taken.map((n) => n.toLowerCase())).size, taken.length, "no duplicates");
      const prompt = hirePrompt("someone to chase invoices", ["Milo", ...taken]);
      assert.ok(prompt.includes(JSON.stringify(["Milo", ...taken])));
      assert.ok(!/e\.g\.[^)]*"Milo"/.test(prompt), "a taken name must not be offered as an example");
      assert.ok(!hirePrompt("x").includes("already taken"));
    });

    // Deep links get their own pre-rendered page; hydrating another route's HTML is React #418
    const load = async (urlPath: string, headers: Record<string, string> = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" }) => {
      const res = await fetch(`${base}${urlPath}`, { headers });
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    };

    await check("app shell: each deep link is served its own route's page, dynamic segments included", async () => {
      assert.equal((await load("/")).body, "page:index");
      assert.equal((await load("/spend")).body, "page:spend");
      assert.equal((await load("/chat/milo?q=1")).body, "page:chat/[slug]");
      const missing = await load("/no/such/route");
      assert.equal(missing.status, 404);
      assert.equal(missing.body, "page:+not-found");
    });

    await check("app shell: reloading a screen that shares an API prefix gets the screen; API fetches still get data", async () => {
      const hirePage = await load("/hire?role=someone");
      assert.equal(hirePage.status, 200);
      assert.equal(hirePage.body, "page:hire");
      assert.equal((await load("/cards")).body, "page:cards");
      const cards = await apiFetch("/cards");
      assert.equal(cards.status, 200);
      assert.ok(Array.isArray(cards.body), "a fetch of /cards is still the API");
      assert.equal((await load("/cards", {})).status, 401, "a non-navigation without a token is still gated");
      assert.equal((await load("/attachments/nope")).status, 401, "API paths with no page stay token-gated");
    });
  } finally {
    await apiApp.close();
    apiDb.close();
    fs.rmSync(apiHome, { recursive: true, force: true });
  }
}

db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) FAILED`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
