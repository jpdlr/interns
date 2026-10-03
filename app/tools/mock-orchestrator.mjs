/**
 * Mock of the Interns orchestrator API: same routes, same shapes, plus CORS.
 *
 * It also serves ../dist at the same origin, exactly like the real
 * orchestrator does now, so the app's same-origin API default, the service
 * worker and the SSE stream can all be exercised the way they actually run.
 * Set DIST=0 to go back to a bare API.
 */
import http from "node:http";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { installFeatures } from "./mock-features.mjs";
import { isNavigation, notFoundPage, resolvePage } from "./page-route.mjs";

const TOKEN = "test-token-abc";
const PORT = Number(process.env.PORT ?? 7811);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** MOCK_FRESH=1 behaves like a brand-new install: setup not done, nobody hired. */
const owner = {
  owner_name: process.env.MOCK_FRESH ? "Boss" : "Sam",
  timezone: "Europe/London",
  timezone_configured: !process.env.MOCK_FRESH,
  own_domains: process.env.MOCK_FRESH ? [] : ["northwind.example"],
  setup_complete: !process.env.MOCK_FRESH,
  hired: process.env.MOCK_FRESH ? 0 : 3,
  connected: { outlook: process.env.MOCK_FRESH ? [] : ["work"], github: false, discord: false, push: true },
};

/** The real starter templates (orchestrator/templates), read with the orchestrator's yaml package when it's installed. */
const templates = (() => {
  try {
    const dir = join(ROOT, "..", "orchestrator", "templates");
    const YAML = createRequire(join(ROOT, "..", "orchestrator", "package.json"))("yaml");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort()
      .map((file) => {
        const { summary, order = 100, required_capabilities = [], ...draft } = YAML.parse(readFileSync(join(dir, file), "utf8"));
        const defaults = { persona: "", tools: [], triggers: {}, backlog: [], guardrails: { drafts_only: true, daily_token_cap: 200000 } };
        const full = { ...defaults, ...draft };
        const needs = [
          ...(full.tools.some((t) => t === "mail" || t === "calendar") || full.triggers.mail_push || full.triggers.meeting_brief ? ["outlook"] : []),
          ...(required_capabilities.some((r) => r.id === "github") ? ["github"] : []),
        ];
        const ready = needs.every((n) => (n === "outlook" ? owner.connected.outlook.length > 0 : owner.connected.github));
        return { id: file.replace(/\.yaml$/, ""), summary, order, draft: full, required_capabilities, needs, ready };
      })
      .sort((a, b) => a.order - b.order);
  } catch (err) {
    console.warn(`[mock] no templates (${err.message}) — run npm ci in orchestrator/ to load them`);
    return [];
  }
})();
const DIST = process.env.DIST === "0" ? null : join(ROOT, process.env.DIST || "dist");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".css": "text/css", ".map": "application/json", ".webmanifest": "application/manifest+json",
};

/** Routes the API owns. Note /cards is both an API route and an app route. */
const API_PATHS = /^\/(owner|templates|notify|interns|tasks|cards|activity|hire|events|meta|push|github|attachments|rooms|reports|suggest|messages|pages|rules|agenda|ideas)(\/|$)/;
const isApiPath = (path) => API_PATHS.test(path);

/** An asset as-is, else the route's own page (as the orchestrator does), else Expo's not-found page. */
function resolveStatic(path) {
  const clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  const asset = join(DIST, clean);
  if (existsSync(asset) && statSync(asset).isFile()) return { file: asset, status: 200 };
  const page = resolvePage(DIST, path);
  return page ? { file: join(DIST, page), status: 200 } : { file: join(DIST, notFoundPage(DIST)), status: 404 };
}

const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

const interns = [
  { slug: "milo", name: "Milo", role: "Personal assistant · mail + follow-ups", icon: "face-05",
    session_id: "s1", queued: 0, running: 0, paused: 0, spend_today: 41230, cost_today_usd: 0.42 },
  { slug: "nia", name: "Nia", role: "Research & briefings", icon: "face-11",
    session_id: null, queued: 1, running: 1, paused: 0,
    activity: { id: "ta-live", intern: "nia", kind: "trigger", status: "running", priority: 0, label: "Reviewing northwind/iot-starter #277", repository: "northwind/iot-starter", pull_number: 277, created_at: iso(240e3), started_at: iso(220e3), finished_at: null, error: null },
    spend_today: 8100, cost_today_usd: 0.09 },
  { slug: "zara", name: "Zara", role: "Ops watchdog", icon: "default",
    session_id: null, queued: 0, running: 0, paused: 0, spend_today: 0, cost_today_usd: 0 },
];

// In-memory attachment store: id → { meta, bytes }. Signed URLs are mocked
// as ?sig=mock so <img src> works without an Authorization header.
const attachments = new Map();
const attachmentMeta = (intern, author, name, mime, bytes, extra = {}) => {
  const id = `att-${Math.random().toString(36).slice(2, 10)}`;
  const kind = mime === "image/svg+xml" ? "svg" : mime.startsWith("image/") ? "image" : "file";
  const meta = { id, intern, message_id: null, author, name, mime, size: bytes.length, kind, sha256: "mock", ext: name.split(".").pop(),
    caption: null, width: null, height: null, created_at: new Date().toISOString(), url: `/attachments/${id}?sig=mock`, ...extra };
  attachments.set(id, { meta, bytes });
  return meta;
};
const demoSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" rx="16" fill="#18181b"/><circle cx="90" cy="90" r="46" fill="#2a78d6"/><rect x="160" y="44" width="110" height="92" rx="10" fill="#eb6834"/><text x="160" y="164" font-family="sans-serif" font-size="14" fill="#fafafa" text-anchor="middle">office floor plan v2</text></svg>`);
const demoCsv = Buffer.from("week,tokens,cost_usd\n1,41230,0.42\n2,38800,0.39\n3,52100,0.55\n4,47700,0.48\n");
const svgAtt = attachmentMeta("milo", "intern", "floor-plan.svg", "image/svg+xml", demoSvg, { message_id: "m3", width: 320, height: 180, caption: "Rough floor plan for the new office" });
const csvAtt = attachmentMeta("milo", "intern", "token-spend.csv", "text/csv", demoCsv, { message_id: "m3" });

let suggestStatus = { running: false, started_at: null, finished_at: null, last: null };

const rooms = [
  { id: "room-launch", name: "Launch week", members: ["milo", "nia", "zara"], topic: "Keep replies short.", scratchpad: "# Launch week\n- **Owner:** Milo (announcement), Nia (numbers)\n- Decided: ship Friday 10:00\n- Open: press list still missing", created_at: iso(7200e3), updated_at: iso(600e3), archived_at: null },
];

const messages = {
  "room-launch": [
    { id: "r1", intern: "room-launch", author: "coordinator", speaker: null, text: "Group created: **Launch week** with Milo, Nia, Zara.", ts: iso(7200e3), surface: "system" },
    { id: "r2", intern: "room-launch", author: "jp", speaker: null, text: "@Nia can you pull the numbers, and @Milo draft the announcement?", ts: iso(3000e3), surface: "app" },
    { id: "r3", intern: "room-launch", author: "intern", speaker: "nia", text: "On it. Numbers by noon. @Zara — anything in ops I should flag?", ts: iso(2900e3), surface: "system" },
    { id: "r4", intern: "room-launch", author: "intern", speaker: "zara", text: "Two alerts overnight, both resolved. Nothing blocking.", ts: iso(2800e3), surface: "system" },
    { id: "r5", intern: "room-launch", author: "intern", speaker: "milo", text: "Draft's in your inbox as a card. I'll fold @Nia's numbers in once they land.", ts: iso(600e3), surface: "system" },
  ],
  milo: [
    { id: "m1", intern: "milo", author: "jp", text: "Morning — anything owed today?", ts: iso(3600e3), surface: "app" },
    { id: "m3", intern: "milo", author: "intern", ts: iso(3400e3), surface: "system", attachments: [svgAtt, csvAtt],
      text: "Here's the spend picture for the month, plus the files you asked for:\n\n```chart\n{\"type\":\"bar\",\"title\":\"Token spend by week\",\"labels\":[\"W1\",\"W2\",\"W3\",\"W4\"],\"series\":[{\"name\":\"Input\",\"data\":[41230,38800,52100,47700]},{\"name\":\"Output\",\"data\":[9000,8100,12400,10200]}],\"format\":\"number\"}\n```\n\nAnd a quick sketch:\n\n```svg\n<svg viewBox=\"0 0 240 120\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"10\" y=\"10\" width=\"100\" height=\"100\" rx=\"12\" fill=\"#2a78d6\"/><circle cx=\"180\" cy=\"60\" r=\"48\" fill=\"#eb6834\"/></svg>\n```" },
    { id: "m2", intern: "milo", author: "intern", text: "Two threads are waiting on you. I drafted replies for both — cards are in your inbox. Nothing outbound has been sent at /tmp/milo/draft.md.", ts: iso(3500e3), surface: "system" },
  ],
  nia: [
    { id: "m3", intern: "nia", author: "intern", text: "Briefing on the city tender is ready. **Short version:** the deadline moved to the 9th.", ts: iso(7200e3), surface: "discord" },
  ],
  zara: [],
};

// A deliberately long thread so the app's "open pre-scrolled to the newest
// message" behaviour has something to actually scroll.
messages.nia = [
  ...messages.nia,
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `nia-${i}`,
    intern: "nia",
    author: i % 3 === 0 ? "jp" : "intern",
    text:
      i % 3 === 0
        ? `Follow-up question number ${i + 1} about the tender.`
        : `Answer ${i + 1}: I checked the portal and the annexures are unchanged.`,
    ts: new Date(now - (30 - i) * 60_000).toISOString(),
    surface: "app",
  })),
  { id: "nia-resources", intern: "nia", author: "intern",
    text: "Useful links: [staging deployment](https://codeops.example.com/Deployments/staging/842) · [ClickUp follow-up](https://app.clickup.com/t/example123) · [review brief](https://docs.google.com/document/d/brief-277) · [tomorrow's review](https://calendar.google.com/calendar/event?eid=review277) · [Priya's email](https://outlook.office.com/mail/deeplink/read/example)",
    ts: new Date(now - 45_000).toISOString(), surface: "app" },
  { id: "nia-last", intern: "nia", author: "intern",
    text: "#277 review prepared at /tmp/review/PR277.md. [Open iot-starter #277 in CodeOps](https://codeops.example.com/PullRequests/Open?repository=northwind%2Fiot-starter&number=277) · https://github.com/northwind/iot-starter/pull/277",
    ts: new Date(now - 30_000).toISOString(), surface: "app" },
];

const cards = [
  { id: "c1", intern: "milo", title: "Reply owed: Marco (Hopfield)",
    body: "Marco asked about the **portal deploy** 3 days ago and is still waiting.\n\n- Thread: `Re: portal.hopfield.example`\n- Draft is ready in your Drafts folder\n\n> Nothing has been sent. Approve to keep the draft, or snooze.",
    severity: "action", state: "open",
    actions: [ { id: "approve", label: "Looks good", style: "success", kind: "button" },
               { id: "snooze", label: "Snooze", style: "neutral", kind: "date" },
               { id: "note", label: "Add note", style: "neutral", kind: "text" } ],
    created_at: iso(300e3), updated_at: iso(300e3), resolved_at: null, snoozed_until: null,
    resolution: null, discord_message_id: null, context: {} },
  { id: "c2", intern: "coordinator", title: "Daily token cap: Milo at 82%",
    body: "Milo has used 41,230 of a 50,000 token cap today.", severity: "urgent", state: "open",
    actions: [{ id: "ack", label: "Acknowledge", style: "primary", kind: "button" }],
    created_at: iso(60e3), updated_at: iso(60e3), resolved_at: null, snoozed_until: null,
    resolution: null, discord_message_id: null, context: {} },
  { id: "c3", intern: "nia", title: "Prevent duplicate device registration", body: "**Recommended action:** APPROVE\n\nThe deduplication key is now stable across retries and the migration preserves existing devices.\n\n2 inline comments. Nothing has been posted to GitHub.",
    severity: "info", state: "open", actions: [{ id: "publish", label: "Approve PR", style: "success", kind: "button" }, { id: "ignore", label: "Dismiss", style: "neutral", kind: "button" }],
    created_at: iso(9000e3), updated_at: iso(9000e3), resolved_at: null, snoozed_until: null,
    resolution: null, discord_message_id: null,
    context: { type: "github_review", repository: "northwind/iot-starter", pull_number: 277,
      url: "https://codeops.example.com/PullRequests/Open?repository=northwind%2Fiot-starter&number=277",
      primary_url: "https://codeops.example.com/PullRequests/Open?repository=northwind%2Fiot-starter&number=277",
      primary_label: "CodeOps", codeops_url: "https://codeops.example.com/PullRequests/Open?repository=northwind%2Fiot-starter&number=277",
      github_url: "https://github.com/northwind/iot-starter/pull/277", recommendation: "APPROVE", risk: "medium", changed_files: 12, additions: 184, deletions: 43, checks: { total: 8, passed: 7, failed: 0, pending: 1 }, inline_comments: 2 } },
  { id: "c-old", intern: "milo", title: "Reply approved: Marco", body: "Draft kept for sending.",
    severity: "info", state: "resolved", actions: [{ id: "approve", label: "Looks good", style: "success", kind: "button" }],
    created_at: iso(86400e3), updated_at: iso(80000e3), resolved_at: iso(80000e3), snoozed_until: null,
    resolution: { via: "app", action: "approve" }, discord_message_id: null, context: {} },
];

const activity = [
  { id: "ta1", intern: "nia", kind: "trigger", status: "done", label: "Reviewed northwind/iot-starter #271", repository: "northwind/iot-starter", pull_number: 271, created_at: iso(7200e3), started_at: iso(7100e3), finished_at: iso(6800e3), error: null },
  { id: "ta2", intern: "zara", kind: "capability", status: "failed", label: "Build failed: GitHub checks integration", repository: null, pull_number: null, created_at: iso(10000e3), started_at: iso(9900e3), finished_at: iso(9600e3), error: "Integration smoke test failed on the callback route." },
];

// The intern "employee file" — GET/PATCH /interns/:slug/manifest — keyed by
// slug. spend_today mirrors the interns[] summary fields (split input/output
// so the app has something to add up), and stays server-computed: it is never
// accepted on PATCH.
const manifests = {
  milo: {
    slug: "milo", name: "Milo", role: "Personal assistant · mail + follow-ups", icon: "face-05",
    persona: "Milo is unflappable and terse. Reports what's owed, what's drafted, what needs Sam — nothing padded.",
    system_prompt: "You are Milo, Sam's personal assistant for mail and follow-ups. Watch the inbox, detect threads Sam owes a reply, draft replies for approval. Anything outbound is a DRAFT ONLY — never send. Report back with what you found, what you drafted, and what you need from Sam.",
    tools: ["mail", "cards", "fs.read"],
    triggers: { cron: "0 7 * * 1-5", mentions: true, mail_push: true },
    backlog: [
      "Sweep the inbox for threads older than 48h with no reply",
      "Chase the Side Project invoice thread once a week",
    ],
    guardrails: { drafts_only: true, daily_token_cap: 50000 },
    paused: false,
    budget: { extra_today: 0, held: 0 },
    notify: "all",
    notify_stats: { now: 23, opened: 3, summary: 0, off: 0 },
    spend_today: { input_tokens: 31230, output_tokens: 10000, cost_usd: 0.42 },
    discord: { channel_id: "1187654321098765432" },
  },
  nia: {
    slug: "nia", name: "Nia", role: "Research & briefings", icon: "face-11",
    persona: "Nia is curious and precise. Leads with the short version, cites where a claim came from, flags what's still uncertain.",
    system_prompt: "You are Nia, Sam's research and briefing intern. When asked, or ahead of a known meeting, research the topic and produce a short briefing: headline finding first, sources, open questions.",
    tools: ["web", "fs.read", "cards"],
    triggers: { cron: null, mentions: true, mail_push: false },
    backlog: [
      "Watch the city tender portal for changes",
      "Weekly roundup of anything relevant in Sam's watched topics",
    ],
    guardrails: { drafts_only: true, daily_token_cap: 100000 },
    paused: false,
    budget: { extra_today: 0, held: 0 },
    notify: "needs_you",
    notify_stats: { now: 4, opened: 3, summary: 9, off: 0 },
    spend_today: { input_tokens: 6100, output_tokens: 2000, cost_usd: 0.09 },
    discord: { channel_id: "1187654321098765433" },
  },
  zara: {
    slug: "zara", name: "Zara", role: "Ops watchdog", icon: "default",
    persona: "Zara is calm under pressure and allergic to false alarms. Only escalates what actually needs eyes.",
    system_prompt: "You are Zara, ops watchdog for the servers. Check health signals on schedule; open a card only for things that need Sam's attention.",
    tools: ["shell", "cards"],
    triggers: { cron: "*/30 * * * *", mentions: false, mail_push: false },
    backlog: ["Baseline the current disk/CPU/mem levels for anomaly comparison"],
    guardrails: { drafts_only: true, daily_token_cap: 30000 },
    paused: true,
    budget: { extra_today: 0, held: 0 },
    notify: "summary",
    notify_stats: { now: 0, opened: 0, summary: 2, off: 0 },
    spend_today: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    discord: { channel_id: null },
  },
};

const notifySettings = { summary_times: ["12:30", "17:30"], quiet: { enabled: true, from: "22:00", to: "07:00" } };

const ICON_CATALOG = Array.from({ length: 20 }, (_, i) => {
  const id = `face-${String(i + 1).padStart(2, "0")}`;
  return { id, label: `Face ${i + 1}` };
});
const TOOL_CATALOG = ["fs.read", "fs.write", "shell", "web", "notebook", "todo", "mail", "cards"];

const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

const streams = new Set();
const emit = (event, data) => {
  for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// Pages, standing orders, Today, ideas, the front desk (docs/features) — see mock-features.mjs.
const features = installFeatures({ messages, cards, interns, emit, iso });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  // The real orchestrator now serves dist/ from the same origin as the API, so
  // the mock does too — otherwise the app's same-origin default, the service
  // worker and the SSE stream would all be exercised under conditions that no
  // longer exist. API routes win; everything else gets its route's page.
  // Reloading a screen that shares an API prefix (/hire, /cards) gets the screen.
  const navigationPage = DIST && isApiPath(url.pathname) && isNavigation(req) ? resolvePage(DIST, req.url) : null;
  if (DIST && (!isApiPath(url.pathname) || navigationPage)) {
    const { file, status } = navigationPage ? { file: join(DIST, navigationPage), status: 200 } : resolveStatic(url.pathname);
    if (existsSync(file)) {
      res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      return createReadStream(file).pipe(res);
    }
  }
  const path = url.pathname;
  // Attachment bytes: signed URL (any sig here) or bearer.
  let attMatch = /^\/attachments\/([^/]+)$/.exec(path);
  if (attMatch && req.method === "GET" && (url.searchParams.get("sig") || req.headers.authorization === `Bearer ${TOKEN}`)) {
    const hit = attachments.get(attMatch[1]);
    if (!hit) { res.writeHead(404, cors); return res.end(); }
    const download = url.searchParams.get("download") === "1";
    res.writeHead(200, { ...cors, "content-type": hit.meta.mime, "content-length": hit.bytes.length,
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(hit.meta.name)}` });
    return res.end(hit.bytes);
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { ...cors, "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  const json = (code, body) => {
    res.writeHead(code, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (features.handle(req, res, path, url, json)) return;

  attMatch = /^\/interns\/([^/]+)\/attachments$/.exec(path);
  if (attMatch) {
    const slug = attMatch[1];
    if (!messages[slug]) return json(404, { error: "no such intern" });
    if (req.method === "GET") return json(200, [...attachments.values()].map((a) => a.meta).filter((a) => a.intern === slug));
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    return req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) return json(400, { error: "empty body" });
      const name = url.searchParams.get("name") || "upload";
      const mime = (req.headers["content-type"] || "application/octet-stream").split(";")[0];
      // slow it down a little so the progress strip is visible
      setTimeout(() => json(201, attachmentMeta(slug, url.searchParams.get("author") || "jp", name, mime, bytes, { caption: url.searchParams.get("caption") })), 600);
    });
  }

  if (path === "/interns" && req.method === "GET") return json(200, interns.map((i) => ({ ...i, on_pause: manifests[i.slug]?.paused === true, notify: manifests[i.slug]?.notify ?? "needs_you" })));
  if (path === "/suggest/run" && req.method === "POST") {
    const card = { id: `c-sugg-${Date.now()}`, intern: "coordinator", title: "Hire: An invoice chaser", severity: "info", state: "open",
      body: "**What I noticed**\nYou asked Milo about supplier invoices 6 times in two weeks, and twice he had to hand it back.\n\n**Suggestion**\nHire an intern who owns supplier follow-ups end to end and reports weekly.\n\n_Role to draft:_ someone who chases supplier invoices and payment status",
      actions: [{ id: "hire", label: "Draft this hire", style: "primary", kind: "button" }, { id: "later", label: "Not now", style: "neutral", kind: "button" }, { id: "never", label: "Never", style: "neutral", kind: "button" }],
      context: { type: "suggestion", kind: "hire", key: "hire-invoice-chaser", hire_role: "someone who chases supplier invoices and payment status", target_intern: null, capability: null },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), resolved_at: null, snoozed_until: null, resolution: null, discord_message_id: null };
    cards.unshift(card);
    emit("card", card);
    suggestStatus = { running: true, started_at: new Date().toISOString(), finished_at: null, last: suggestStatus.last };
    setTimeout(() => { suggestStatus = { running: false, started_at: suggestStatus.started_at, finished_at: new Date().toISOString(), last: { created: 1, proposed: 1, skipped: [], titles: [card.title], error: null, evidence_summary: { window_days: 14, jp_messages: 38, repeated_asks: 3, capability_gaps: 1, interns: 3 } } }; }, 2500);
    return json(202, suggestStatus);
  }
  if (path === "/suggest/status" && req.method === "GET") return json(200, suggestStatus);
  if (path === "/reports/spend" && req.method === "GET") {
    const days = Number(url.searchParams.get("days") ?? 30);
    const list = Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * 86400e3).toISOString().slice(0, 10));
    const by_intern = list.flatMap((day, i) => interns.map((it, j) => ({ intern: it.slug, day, tokens: 8000 + ((i * 7 + j * 13) % 11) * 1500, cost_usd: 0.08 + ((i * 7 + j * 13) % 11) * 0.015 })));
    const by_thread = [
      { thread: "room-launch", tokens: 182000, cost_usd: 1.94, runs: 23, last_ts: iso(600e3) },
      { thread: "milo", tokens: 140000, cost_usd: 1.41, runs: 31, last_ts: iso(3500e3) },
      { thread: "nia", tokens: 96000, cost_usd: 0.97, runs: 12, last_ts: iso(240e3) },
      { thread: "zara", tokens: 12000, cost_usd: 0.12, runs: 4, last_ts: iso(86400e3) },
    ];
    return json(200, { days: list, by_intern, by_thread, by_thread_day: [], names: { "room-launch": "Launch week", milo: "Milo", nia: "Nia", zara: "Zara", coordinator: "Chaos Coordinator" } });
  }
  if (path === "/rooms" && req.method === "GET") return json(200, rooms.filter((r) => !r.archived_at).map((r) => ({ ...r, last_message: (messages[r.id] ?? []).slice(-1)[0] ?? null })));
  if (path === "/rooms" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { name, members, topic = "" } = JSON.parse(body || "{}");
      const room = { id: `room-${Date.now()}`, name, members, topic, scratchpad: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived_at: null };
      rooms.push(room);
      messages[room.id] = [{ id: `r${Date.now()}`, intern: room.id, author: "coordinator", speaker: null, text: `Group created: **${name}**.`, ts: room.created_at, surface: "system" }];
      json(201, room);
    });
  }
  let pinMatch = /^\/messages\/([^/]+)\/pin$/.exec(path);
  if (pinMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { pinned = true } = JSON.parse(body || "{}");
      for (const list of Object.values(messages)) for (const m of list) if (m.id === pinMatch[1]) { m.pinned = pinned; emit("message", m); return json(200, m); }
      json(404, { error: "no such message" });
    });
  }
  let pinsMatch = /^\/interns\/([^/]+)\/pins$/.exec(path);
  if (pinsMatch && req.method === "GET") return json(200, (messages[pinsMatch[1]] ?? []).filter((m) => m.pinned));
  let padMatch = /^\/rooms\/([^/]+)\/scratchpad$/.exec(path);
  if (padMatch) {
    const room = rooms.find((r) => r.id === padMatch[1]);
    if (!room) return json(404, { error: "no such room" });
    if (req.method === "GET") return json(200, { id: room.id, name: room.name, scratchpad: room.scratchpad, updated_at: room.updated_at });
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { scratchpad, append } = JSON.parse(body || "{}");
      room.scratchpad = append ? `${room.scratchpad}\n\n${scratchpad}` : scratchpad;
      room.updated_at = new Date().toISOString();
      emit("room", room);
      json(200, { id: room.id, name: room.name, scratchpad: room.scratchpad, updated_at: room.updated_at });
    });
  }
  let roomMatch = /^\/rooms\/([^/]+)(\/archive)?$/.exec(path);
  if (roomMatch) {
    const room = rooms.find((r) => r.id === roomMatch[1]);
    if (!room) return json(404, { error: "no such room" });
    if (roomMatch[2]) { room.archived_at = new Date().toISOString(); return json(200, { id: room.id, archived: true }); }
    if (req.method === "GET") return json(200, room);
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => { Object.assign(room, JSON.parse(body || "{}"), { updated_at: new Date().toISOString() }); emit("room", room); json(200, room); });
  }
  if (path === "/activity" && req.method === "GET") return json(200, activity);
  if (path === "/github/repositories" && req.method === "GET") return json(200, { repositories: ["northwind/iot-starter", "jpdlr/interns", "side-project/platform"] });
  if (path === "/github/pr-preview" && req.method === "GET") {
    const repository = url.searchParams.get("repository");
    const number = Number(url.searchParams.get("number"));
    if (!repository || !number) return json(400, { error: "repository and pull request number required" });
    return json(200, {
      repository, pull_number: number, title: "Prevent duplicate device registration", state: "open", draft: false,
      author: "jpdlr", updated_at: new Date().toISOString(), changed_files: 12, additions: 184, deletions: 43,
      checks: { total: 8, passed: 7, failed: 0, pending: 1 }, risk: "medium",
      github_url: `https://github.com/${repository}/pull/${number}`,
      codeops_url: `https://codeops.example.com/PullRequests/Open?repository=${encodeURIComponent(repository)}&number=${number}`,
      primary_url: `https://codeops.example.com/PullRequests/Open?repository=${encodeURIComponent(repository)}&number=${number}`,
      primary_label: "CodeOps",
    });
  }
  if (path === "/push/status" && req.method === "GET") return json(200, { configured: true, subscriptions: 2, last_delivery: null });
  if (path === "/push/test" && req.method === "POST") return json(200, { attempted_at: new Date().toISOString(), subscriptions: 2, sent: 2, failed: 0, removed: 0, errors: [] });

  let taskMatch = /^\/tasks\/([^/]+)\/actions\/(pause|resume|cancel|prioritize)$/.exec(path);
  if (taskMatch && req.method === "POST") {
    const [, taskId, action] = taskMatch;
    const owner = interns.find((intern) => intern.activity?.id === taskId);
    if (!owner?.activity) return json(404, { error: "no such task" });
    if (action === "pause") {
      owner.activity.status = "paused";
      owner.activity.label = owner.activity.label.replace(/^Reviewing /, "Paused: Reviewing ");
      owner.running = 0; owner.queued = 0; owner.paused = 1;
    } else if (action === "resume") {
      owner.activity.status = "queued";
      owner.activity.label = owner.activity.label.replace(/^Paused: /, "Queued: ");
      owner.running = 0; owner.queued = 1; owner.paused = 0;
    } else if (action === "prioritize") {
      owner.activity.priority = 1;
      owner.activity.label = owner.activity.label.replace(/^Queued: /, "Priority: ");
    } else {
      owner.activity.status = "cancelled";
      owner.activity.finished_at = new Date().toISOString();
      owner.activity.error = "cancelled by Sam";
      owner.running = 0; owner.queued = 0; owner.paused = 0;
    }
    emit("task_state", owner.activity);
    const result = owner.activity;
    if (action === "cancel") owner.activity = null;
    return json(200, result);
  }

  let match = /^\/interns\/([^/]+)\/messages$/.exec(path);
  if (match) {
    const slug = match[1];
    if (!messages[slug]) return json(404, { error: "no such intern" });
    if (req.method === "GET") return json(200, messages[slug]);
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { text = "", attachment_ids = [], reply_to = null } = JSON.parse(body || "{}");
      const attached = attachment_ids.map((id) => attachments.get(id)?.meta).filter(Boolean);
      if (!text.trim() && attached.length === 0) return json(400, { error: "text or attachment_ids required" });
      const message = { id: `m${Date.now()}`, intern: slug, author: "jp", speaker: null, reply_to, text, ts: new Date().toISOString(), surface: "app", attachments: attached };
      const room = rooms.find((r) => r.id === slug);
      const mentioned = [...text.matchAll(/(^|[^\w@])@(\w+)/g)].map((m) => m[2].toLowerCase());
      const everyone = mentioned.some((m) => ["all", "everyone"].includes(m) || (room && room.name.toLowerCase().split(" ")[0] === m));
      const speakers = room ? (everyone ? room.members : mentioned.length ? room.members.filter((m) => mentioned.includes(m)) : [room.members[0]]) : [slug];
      const speaker = speakers[0] ?? slug;
      if (features.intercept(slug, { text, reply_to }, message, json)) return;
      for (const a of attached) a.message_id = message.id;
      messages[slug].push(message);
      emit("message", message);
      // Mirror the real backend: the task goes running, then finishes.
      const who = interns.find((i) => i.slug === slug);
      const taskId = `t${Date.now()}`;
      if (who) {
        who.running = 1;
        who.activity = {
          id: taskId, intern: slug, kind: "message", status: "running", priority: 0,
          label: "Replying to you", repository: null, pull_number: null,
          created_at: message.ts, started_at: message.ts, finished_at: null, error: null,
        };
        emit("task_state", who.activity);
      }
      json(200, { message, task_id: taskId });
      // The intern "replies" over the live stream a moment later.
      setTimeout(() => {
        const wantsDiagram = /diagram|flow|sequence|mermaid/i.test(text);
        const wantsChart = !wantsDiagram && /chart|graph|plot/i.test(text);
        const wantsSvg = /svg|draw|diagram|logo|image/i.test(text) && !wantsChart;
        const replyText = wantsDiagram
          ? "Here's how the approval flow works:\n\n```mermaid\nflowchart TD\n  A[Intern proposes] --> B{Sam approves?}\n  B -- yes --> C[Publish review]\n  B -- no --> D[Dismiss card]\n  C --> E((Done))\n  D --> E\n```\n\nAnd the handshake:\n\n```mermaid\nsequenceDiagram\n  participant A as App\n  participant O as Orchestrator\n  participant I as Intern\n  A->>O: POST /messages\n  O->>I: run task\n  I-->>O: reply + files\n  Note over O,A: SSE message event\n  O-->>A: message\n```"
          : wantsChart
          ? "Here you go:\n\n```chart\n{\"type\":\"donut\",\"title\":\"Where the tokens went\",\"labels\":[\"Mail triage\",\"Reviews\",\"Briefs\",\"Idle chatter\"],\"series\":[{\"name\":\"Tokens\",\"data\":[41,32,19,8]}],\"format\":\"percent\"}\n```\n\nReviews are the second biggest bucket — worth a look."
          : wantsSvg
            ? "A first pass:\n\n```svg\n<svg viewBox=\"0 0 200 200\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"g\" x1=\"0\" x2=\"1\"><stop offset=\"0\" stop-color=\"#2a78d6\"/><stop offset=\"1\" stop-color=\"#1baf7a\"/></linearGradient></defs><circle cx=\"100\" cy=\"100\" r=\"88\" fill=\"url(#g)\"/><path d=\"M60 110 l30 30 l50 -60\" stroke=\"#fff\" stroke-width=\"14\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n```\n\nWant it in a different palette?"
            : attached.length
              ? `Got ${attached.length} file${attached.length === 1 ? "" : "s"} — ${attached.map((a) => a.name).join(", ")}. I'll come back with a card.\n\n— ${speaker}, filing it now`
              : "On it — I'll come back with a card.\n\n— " + speaker + ", on the case";
        const reply = { id: `m${Date.now()}r`, intern: slug, author: "intern", speaker, reply_to: message.id,
          text: room ? `${replyText} — @${(speakers[1] ?? room.members.find((m) => m !== speaker))} anything to add?` : replyText, ts: new Date().toISOString(), surface: "system", attachments: [] };
        messages[slug].push(reply);
        if (who) {
          who.running = 0;
          who.activity = null;
        }
        emit("message", reply);
      }, Number(process.env.REPLY_DELAY_MS ?? 1200));
    });
  }

  // Lock-screen settings: summary times and quiet hours.
  if (path === "/notify/settings") {
    if (req.method === "GET") return json(200, notifySettings);
    if (req.method === "PATCH") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const patch = JSON.parse(raw || "{}");
        if (patch.summary_times) notifySettings.summary_times = [...patch.summary_times].sort();
        if (patch.quiet) notifySettings.quiet = { ...notifySettings.quiet, ...patch.quiet };
        json(200, notifySettings);
      });
      return;
    }
  }

  // An intern's last seven days (the profile's "This week").
  match = /^\/interns\/([^/]+)\/week$/.exec(path);
  if (match && req.method === "GET") {
    const slug = match[1];
    if (!manifests[slug]) return json(404, { error: "no such intern" });
    const busy = slug === "milo";
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(Date.now() - (6 - i) * 86400e3).toISOString().slice(0, 10);
      const tokens = busy ? [18000, 32000, 0, 41000, 27000, 50000, 41230][i] : 0;
      return { day, tokens, cost_usd: tokens / 100000 };
    });
    return json(200, {
      since: new Date(Date.now() - 6 * 86400e3).toISOString(),
      summary: busy ? "Triaged 46 emails, answered 9 messages, ran 5 routines, muted 9 by standing order" : "",
      done: busy ? 23 : 0, failed: busy ? 1 : 0, muted: busy ? 9 : 0,
      messages: busy ? 14 : 0,
      drafts: busy ? [
        { id: "pg_draft_clinicflow", title: "RE: ClinicFlow for Willowbrook Vet", updated_at: iso(24 * 60e3) },
        { id: "pg_draft_side", title: "RE: Side Project invoice", updated_at: iso(26 * 3600e3) },
      ] : [],
      draft_count: busy ? 3 : 0,
      pages_created: busy ? 1 : 0, pages_updated: busy ? 2 : 0,
      cards_raised: busy ? 4 : 0, cards_decided: busy ? 3 : 0,
      days, tokens: days.reduce((n, d) => n + d.tokens, 0), cost_usd: days.reduce((n, d) => n + d.cost_usd, 0),
    });
  }

  match = /^\/interns\/([^/]+)\/manifest$/.exec(path);
  if (match) {
    const slug = match[1];
    const manifest = manifests[slug];
    if (!manifest) return json(404, { error: "no such intern" });
    if (req.method === "GET") return json(200, manifest);
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        let patch;
        try {
          patch = JSON.parse(body || "{}");
        } catch {
          return json(400, { error: "invalid JSON body" });
        }
        // Minimal zod-shaped validation, echoed back the way the real
        // orchestrator's zod .safeParse would: {error, detail: [{path, message}]}.
        const issues = [];
        if (patch.guardrails && "daily_token_cap" in patch.guardrails) {
          const cap = patch.guardrails.daily_token_cap;
          if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 10000) {
            issues.push({
              path: ["guardrails", "daily_token_cap"],
              message: "Number must be greater than or equal to 10000",
            });
          }
        }
        if (patch.triggers && "cron" in patch.triggers) {
          const cron = patch.triggers.cron;
          if (cron != null && cron !== "" && !CRON_RE.test(cron)) {
            issues.push({ path: ["triggers", "cron"], message: "Expected a 5-field cron expression" });
          }
        }
        if ("name" in patch && !String(patch.name ?? "").trim()) {
          issues.push({ path: ["name"], message: "String must contain at least 1 character(s)" });
        }
        if (issues.length) return json(400, { error: "invalid manifest patch", detail: issues });

        // Merge + echo, exactly like the contract describes. spend_today,
        // slug and discord are server-owned and never taken from the body.
        const { spend_today, discord, slug: _s, ...editable } = patch;
        const { triggers: prevTriggers, guardrails: prevGuardrails } = manifest;
        Object.assign(manifest, editable);
        if (patch.triggers) manifest.triggers = { ...prevTriggers, ...patch.triggers };
        if (patch.guardrails) manifest.guardrails = { ...prevGuardrails, ...patch.guardrails };
        // Keep the crew list's summary card in sync so the thread header
        // reflects an edited name/role/icon immediately.
        const summary = interns.find((i) => i.slug === slug);
        if (summary) {
          if (patch.name) summary.name = patch.name;
          if (patch.role) summary.role = patch.role;
          if (patch.icon) summary.icon = patch.icon;
        }
        return json(200, manifest);
      });
    }
    return json(405, { error: "method not allowed" });
  }

  if (path === "/meta" && req.method === "GET") {
    return json(200, { icons: ICON_CATALOG, tools: TOOL_CATALOG });
  }

  // Fire an intern. Mirrors the real contract's shape (200 {slug, archived,
  // name}; 404 for "coordinator" or an unknown slug) but only removes the
  // intern from the in-memory crew list — manifests/messages stay put, so
  // a second archive attempt on the same slug naturally 404s ("no such
  // intern") once it is gone from `interns`, which is a handy way to
  // exercise the app's inline-error path without a special test hook.
  match = /^\/interns\/([^/]+)\/archive$/.exec(path);
  if (match && req.method === "POST") {
    const slug = match[1];
    if (slug === "coordinator") return json(404, { error: "no such intern" });
    const idx = interns.findIndex((i) => i.slug === slug);
    if (idx === -1) return json(404, { error: "no such intern" });
    const [removed] = interns.splice(idx, 1);
    return json(200, { slug, archived: true, name: removed.name });
  }

  if (path === "/cards" && req.method === "GET") {
    const state = url.searchParams.get("state");
    return json(200, state ? cards.filter((c) => c.state === state) : cards);
  }

  match = /^\/cards\/([^/]+)\/actions\/([^/]+)$/.exec(path);
  if (match && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const [, id, actionId] = match;
      const card = cards.find((c) => c.id === id);
      if (!card) return json(404, { error: "no such card" });
      const note = (JSON.parse(body || "{}") || {}).note;
      card.state = "resolved";
      card.resolved_at = new Date().toISOString();
      card.resolution = { via: "app", action: actionId, ...(note ? { note } : {}) };
      emit("card_state", card);
      json(200, card);
    });
  }

  if (path === "/owner" && req.method === "GET") return json(200, owner);
  if (path === "/owner" && req.method === "PATCH") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const patch = JSON.parse(body || "{}");
      if (patch.timezone && !/^[A-Za-z_]+\/[A-Za-z_\/]+$|^UTC$/.test(patch.timezone)) return json(400, { error: "unknown time zone" });
      const { setup_complete, ...rest } = patch;
      Object.assign(owner, rest, setup_complete ? { setup_complete: true } : {});
      if (rest.timezone) owner.timezone_configured = true;
      json(200, owner);
    });
  }
  if (path === "/templates" && req.method === "GET") {
    return json(200, templates.map(({ draft, ...t }) => ({ ...t, name: draft.name, role: draft.role, icon: draft.icon, tools: draft.tools, triggers: draft.triggers })));
  }
  if (path === "/hire/template" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const template = templates.find((t) => t.id === JSON.parse(body || "{}").id);
      if (!template) return json(404, { error: "no such template" });
      json(200, { draft: template.draft, required_capabilities: template.required_capabilities });
    });
  }

  if (path === "/hire" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const role = (JSON.parse(body || "{}").role || "").trim();
      if (role.length < 3) return json(400, { error: "role required" });
      const names = ["Rowan", "Pia", "Otis", "Sable", "Wren"];
      const name = names[Math.floor(Math.random() * names.length)];
      const draft = {
        name,
        role: role.charAt(0).toUpperCase() + role.slice(1),
        icon: "default",
        persona: `${name} is dry, unflappable and allergic to filler. Reports in short paragraphs, flags what is uncertain, never pads a summary to look busy.`,
        system_prompt: `You are ${name}, ${role}. Work in short sessions. Anything outbound to another human is a draft for Sam to approve — never send. Report back with what you did, what you found and what you need from Sam, in that order.`,
        tools: ["read_files", "search_web"],
        triggers: { cron: "0 7 * * 1-5", mentions: true },
        backlog: [
          "Do a first pass and write up what you found",
          "List the recurring questions worth automating",
          "Flag anything that looks stale or abandoned",
        ],
        guardrails: { drafts_only: true, daily_token_cap: 200000 },
      };
      // The real endpoint is an LLM call; make the wait visible.
      setTimeout(() => json(200, { draft, required_capabilities: [] }), 1800);
    });
  }

  if (path === "/hire/confirm" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const manifest = parsed.draft;
      if (!manifest?.name) return json(400, { error: "invalid draft" });
      const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const icon = parsed.icon ?? manifest.icon ?? "default";
      interns.push({
        slug, name: manifest.name, role: manifest.role, icon,
        session_id: null, queued: 0, running: 0, paused: 0, spend_today: 0, cost_today_usd: 0,
      });
      messages[slug] = [];
      json(200, { slug, manifest: { ...manifest, icon } });
    });
  }

  if (path === "/events") {
    res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  json(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`mock orchestrator on ${PORT}${DIST ? ` (serving ${DIST})` : ""}`),
);
