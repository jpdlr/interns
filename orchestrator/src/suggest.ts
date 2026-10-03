/**
 * The coordinator's suggestions: "looks like you need an intern for X",
 * "Rhea keeps hitting a wall without Y", "Milo's spend doubled". Runs on a
 * weekly cron and on demand (POST /suggest/run).
 *
 * Deterministic first, LLM last — the same split as standup.ts: code
 * collects the evidence (repeated asks, capability gaps interns complained
 * about, failures, cap hits, dismissed-card ratios, spend, mention graph),
 * one cheap Haiku call turns it into at most two concrete proposals, and
 * every proposal becomes a coordinator card whose accept button leads into
 * an existing flow (the hire screen, a capability request). Fails closed:
 * any SDK or parse error means no cards this pass.
 *
 * Memory (~/.interns/coordinator/suggestions.json) keeps every proposal and
 * JP's decision so the same idea is not pitched again: "never" is
 * permanent, "later" snoozes for 30 days, an accepted one rests for 60.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { CAPABILITY_CATALOG } from "./capabilities.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { openIdeas } from "./ideas.js";
import type { EventBus } from "./events.js";
import { extractMentionTokens } from "./mentions.js";
import type { Registry } from "./registry.js";
import type { Card, CapabilityRequirement } from "./types.js";
import { ownerName } from "./profile.js";

const SUGGEST_MODEL = "claude-haiku-4-5";
const WINDOW_DAYS = 14;
const MAX_SUGGESTIONS = 2;
const LATER_DAYS = 30;
const ACCEPTED_REST_DAYS = 60;

export type SuggestionKind = "hire" | "capability" | "trigger" | "backlog" | "spend" | "merge" | "other";

export interface Suggestion {
  kind: SuggestionKind;
  /** stable dedupe key, kebab-case, e.g. "hire-invoice-chaser" */
  key: string;
  title: string;
  /** the evidence, in plain words */
  why: string;
  /** what to do about it */
  proposal: string;
  /** hire: the rough role to feed the hire flow */
  hire_role?: string;
  /** capability: which intern lacks what (catalog id or free text) */
  target_intern?: string;
  capability?: string;
}

export interface SuggestionRecord extends Suggestion {
  card_id: string | null;
  proposed_at: string;
  decision: "open" | "accepted" | "later" | "never" | "noted" | null;
  decided_at: string | null;
}

export interface SuggestionMemory {
  records: SuggestionRecord[];
  last_run_at: string | null;
}

export interface Evidence {
  window_days: number;
  roster: { slug: string; name: string; role: string; tools: string[]; cron: string | null; backlog: number }[];
  repeated_asks: { phrase: string; count: number; example: string; thread: string }[];
  capability_gaps: { intern: string; snippet: string }[];
  failures: { intern: string; failed: number; cap_hits: number }[];
  dismissals: { intern: string; created: number; dismissed: number }[];
  spend_7d: { intern: string; tokens: number; cost_usd: number }[];
  mentions: { from: string; to: string; count: number }[];
  rooms: { name: string; members: string[] }[];
  capability_catalog: string[];
  pending_capabilities: { intern: string; capability: string; status: string }[];
  message_count_jp: number;
  /** JP's open ideas from the Ideas page — recurring themes can become suggestions */
  ideas: { text: string; tags: string[]; ts: string }[];
}

export type ProposeFn = (evidence: Evidence, memory: SuggestionMemory, db: Db) => Promise<Suggestion[]>;

// ------------------------------------------------------------------ memory

export function memoryPath(home: string): string {
  return path.join(home, "coordinator", "suggestions.json");
}

export function loadMemory(home: string): SuggestionMemory {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryPath(home), "utf8")) as SuggestionMemory;
    return { records: Array.isArray(raw.records) ? raw.records : [], last_run_at: raw.last_run_at ?? null };
  } catch {
    return { records: [], last_run_at: null };
  }
}

export function saveMemory(home: string, memory: SuggestionMemory): void {
  const file = memoryPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(memory, null, 2) + "\n");
}

/** True when a key must not be pitched again right now. */
export function isSuppressed(memory: SuggestionMemory, key: string, now = Date.now()): boolean {
  const hits = memory.records.filter((r) => r.key === key);
  for (const r of hits) {
    if (r.decision === "never") return true;
    if (r.decision === "open") return true;
    const at = Date.parse(r.decided_at ?? r.proposed_at);
    if (r.decision === "later" && now - at < LATER_DAYS * 86_400_000) return true;
    if ((r.decision === "accepted" || r.decision === "noted") && now - at < ACCEPTED_REST_DAYS * 86_400_000) return true;
  }
  return false;
}

// ---------------------------------------------------------------- evidence

const GAP_RE = /\b(can'?t|cannot|unable|not able|no access|don'?t have (?:access|a way|the tool)|need(?:s)? access|not permitted|no permission|missing (?:tool|credential|integration)|without (?:access|a tool))\b/i;
// "seen" (information cards) is acknowledgement, not a dismissal — deliberately absent.
const DISMISS_ACTIONS = new Set(["ignore", "dismiss", "drop", "reject", "skip", "no"]);

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9@\s]/g, " ")
    .replace(/\b(please|pls|can you|could you|hey|hi|thanks|thank you|ok|okay|the|a|an|to|me|my|for|of|and|now|today|again)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
}

export function collectEvidence(db: Db, registry: Registry, days = WINDOW_DAYS): Evidence {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const roster = registry.list().map(({ slug, manifest }) => ({
    slug,
    name: manifest.name,
    role: manifest.role,
    tools: manifest.tools,
    cron: manifest.triggers.cron ?? null,
    backlog: manifest.backlog.length,
  }));
  const threads = [...roster.map((r) => r.slug), ...db.listRooms().map((r) => r.id)];
  const roomNames = new Map(db.listRooms().map((r) => [r.id, r.name]));
  const asks = new Map<string, { count: number; example: string; thread: string }>();
  const gaps: Evidence["capability_gaps"] = [];
  const mentionCounts = new Map<string, number>();
  let jpCount = 0;
  const names = new Map(roster.map((r) => [r.slug, r.name]));
  const resolveName = (token: string) => {
    const key = token.toLowerCase();
    return roster.find((r) => r.slug.toLowerCase() === key || r.name.toLowerCase() === key || r.name.toLowerCase().split(/\s+/)[0] === key)?.slug;
  };
  for (const thread of threads) {
    for (const m of db.listMessages(thread, 400)) {
      if (m.ts < since) continue;
      if (m.author === "jp") {
        jpCount += 1;
        const phrase = normalizePhrase(m.text);
        if (phrase.split(" ").length >= 3) {
          const hit = asks.get(phrase) ?? { count: 0, example: m.text.slice(0, 160), thread: roomNames.get(thread) ?? names.get(thread) ?? thread };
          hit.count += 1;
          asks.set(phrase, hit);
        }
      } else if (m.author === "intern") {
        const speaker = m.speaker ?? m.intern;
        const match = GAP_RE.exec(m.text);
        if (match) {
          const at = Math.max(0, (match.index ?? 0) - 80);
          gaps.push({ intern: names.get(speaker) ?? speaker, snippet: m.text.slice(at, at + 200).replace(/\s+/g, " ") });
        }
        for (const token of extractMentionTokens(m.text)) {
          const to = resolveName(token);
          if (to && to !== speaker) {
            const k = `${speaker}>${to}`;
            mentionCounts.set(k, (mentionCounts.get(k) ?? 0) + 1);
          }
        }
      }
    }
  }
  const repeated_asks = [...asks.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([phrase, v]) => ({ phrase, ...v }));
  const tasks = db.listRecentTasks(500).filter((t) => t.created_at >= since);
  const capCards = db.listCards().filter((c) => c.created_at >= since && /daily token cap/i.test(c.title));
  const failures = roster
    .map((r) => ({
      intern: r.name,
      failed: tasks.filter((t) => t.intern === r.slug && t.status === "failed").length,
      cap_hits: capCards.filter((c) => c.body.includes(`\`${r.slug}\``)).length,
    }))
    .filter((f) => f.failed > 0 || f.cap_hits > 0);
  const cards = db.listCards().filter((c) => c.created_at >= since && c.intern !== "coordinator");
  const dismissals = roster
    .map((r) => {
      const mine = cards.filter((c) => c.intern === r.slug);
      return { intern: r.name, created: mine.length, dismissed: mine.filter((c) => c.resolution && DISMISS_ACTIONS.has(c.resolution.action)).length };
    })
    .filter((d) => d.created >= 3);
  const spendRows = db.spendLastDays(7);
  const spend_7d = roster
    .map((r) => {
      const rows = spendRows.filter((s) => s.intern === r.slug);
      return { intern: r.name, tokens: rows.reduce((a, s) => a + s.input_tokens + s.output_tokens, 0), cost_usd: Math.round(rows.reduce((a, s) => a + s.cost_usd, 0) * 100) / 100 };
    })
    .filter((s) => s.tokens > 0);
  const mentions = [...mentionCounts.entries()].map(([k, count]) => {
    const [from, to] = k.split(">") as [string, string];
    return { from: names.get(from) ?? from, to: names.get(to) ?? to, count };
  });
  return {
    window_days: days,
    roster,
    repeated_asks,
    capability_gaps: gaps.slice(-5).map((g) => ({ ...g, snippet: g.snippet.slice(0, 140) })),
    failures,
    dismissals,
    spend_7d,
    mentions,
    rooms: db.listRooms().map((r) => ({ name: r.name, members: r.members.map((m) => names.get(m) ?? m) })),
    capability_catalog: Object.keys(CAPABILITY_CATALOG),
    pending_capabilities: db.listCapabilityRequests().filter((c) => !["active", "rejected", "failed"].includes(c.status)).map((c) => ({ intern: c.intern, capability: c.capability, status: c.status })),
    message_count_jp: jpCount,
    ideas: openIdeas(db).map((i) => ({ ...i, text: i.text.slice(0, 200) })),
  };
}

// ------------------------------------------------------------------- propose

const systemPrompt = (owner = ownerName()) =>
  "You are the Chaos Coordinator, who runs " + owner + "'s crew of AI interns. Once a week you look at what actually " +
  "happened and, only if the evidence is strong, propose at most two concrete improvements. Kinds: " +
  '"hire" (a new intern for a recurring need ' + owner + ' keeps handling by hand or keeps asking the wrong intern for), ' +
  '"capability" (an intern repeatedly lacked a tool/integration — name the intern and the capability), ' +
  '"trigger" (a routine ' + owner + ' asks for by hand that should run on a schedule), "backlog" (standing work an intern should own), ' +
  '"spend" (an intern whose cost is out of line with its usefulness), "merge" (two interns doing the same job), "other". ' +
  "Rules: never propose something on the suppressed list; be specific and cite the evidence in plain words " +
  "(counts, names, phrases); say what will change for " + owner + "; prefer zero suggestions to weak ones. " +
  owner + "'s open ideas (evidence.ideas) count as evidence too: several ideas on one theme, or an idea an intern could act on, can be a suggestion. " +
  'Respond with ONLY strict JSON: {"suggestions":[{"kind":"…","key":"kebab-case-stable-id","title":"≤60 chars","why":"evidence, 1-2 sentences","proposal":"what to do, 1-2 sentences","hire_role":"only for hire: rough role in one line","target_intern":"only for capability: slug","capability":"only for capability: catalog id or short name"}]}';

function parseSuggestions(text: string): Suggestion[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in suggestion response");
  const parsed = JSON.parse(match[0]) as { suggestions?: unknown };
  if (!Array.isArray(parsed.suggestions)) throw new Error("suggestions is not an array");
  const kinds: SuggestionKind[] = ["hire", "capability", "trigger", "backlog", "spend", "merge", "other"];
  return parsed.suggestions
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      kind: kinds.includes(s.kind as SuggestionKind) ? (s.kind as SuggestionKind) : "other",
      key: String(s.key ?? s.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60),
      title: String(s.title ?? "").slice(0, 80),
      why: String(s.why ?? ""),
      proposal: String(s.proposal ?? ""),
      ...(typeof s.hire_role === "string" && s.hire_role ? { hire_role: s.hire_role } : {}),
      ...(typeof s.target_intern === "string" && s.target_intern ? { target_intern: s.target_intern } : {}),
      ...(typeof s.capability === "string" && s.capability ? { capability: s.capability } : {}),
    }))
    .filter((s) => s.key && s.title && s.proposal)
    .slice(0, MAX_SUGGESTIONS);
}

export const proposeSuggestions: ProposeFn = async (evidence, memory, db) => {
  const suppressed = memory.records.filter((r) => isSuppressed(memory, r.key)).map((r) => `${r.key} (${r.decision})`);
  const prompt =
    `Evidence from the last ${evidence.window_days} days (JSON):\n${JSON.stringify(evidence, null, 1)}\n\n` +
    `Suppressed keys (already decided, do not repeat): ${suppressed.length ? suppressed.join(", ") : "(none)"}\n` +
    `Previously accepted: ${memory.records.filter((r) => r.decision === "accepted").map((r) => r.title).join("; ") || "(none)"}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let resultText = "";
  let sdkError: string | undefined;
  try {
    for await (const message of query({
      prompt,
      options: { systemPrompt: systemPrompt(), model: SUGGEST_MODEL, tools: [], maxTurns: 1, settingSources: [], permissionMode: "bypassPermissions" },
    })) {
      if (message.type === "result") {
        for (const usage of Object.values(message.modelUsage ?? {})) {
          inputTokens += usage.inputTokens + usage.cacheCreationInputTokens;
          outputTokens += usage.outputTokens;
          costUsd += usage.costUSD;
        }
        if (message.subtype === "success") resultText = message.result;
        else sdkError = `suggestion run ended with ${message.subtype}`;
      }
    }
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err);
  }
  if (inputTokens || outputTokens || costUsd) {
    db.recordSpend("coordinator", inputTokens, outputTokens, costUsd);
    db.recordRunSpend({ intern: "coordinator", kind: "suggest", inputTokens, outputTokens, costUsd });
  }
  if (sdkError) throw new Error(sdkError);
  return parseSuggestions(resultText);
};

// --------------------------------------------------------------------- run

function actionsFor(s: Suggestion): Card["actions"] {
  const tail: Card["actions"] = [
    { id: "later", label: "Not now", style: "neutral", kind: "button" },
    { id: "never", label: "Never", style: "neutral", kind: "button" },
  ];
  if (s.kind === "hire") return [{ id: "hire", label: "Draft this hire", style: "primary", kind: "button" }, ...tail];
  if (s.kind === "capability" && s.target_intern && s.capability) return [{ id: "request", label: "Request the build", style: "primary", kind: "button" }, ...tail];
  return [{ id: "noted", label: "Good idea, noted", style: "success", kind: "button" }, ...tail];
}

const KIND_LABEL: Record<SuggestionKind, string> = {
  hire: "Hire",
  capability: "Integration",
  trigger: "Schedule",
  backlog: "Standing work",
  spend: "Spend",
  merge: "Merge",
  other: "Idea",
};

/**
 * In-process tracker so the API can start a pass and return at once — the
 * model call takes long enough that proxies in front of the orchestrator
 * (Tailscale serve) time out a synchronous request. One pass at a time.
 */
export interface SuggestStatus {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  last: { created: number; proposed: number; skipped: string[]; titles: string[]; error: string | null; evidence_summary: Record<string, number> } | null;
}

const tracker: { running: Promise<SuggestRunResult> | null; status: SuggestStatus } = {
  running: null,
  status: { running: false, started_at: null, finished_at: null, last: null },
};

export function suggestStatus(): SuggestStatus {
  return { ...tracker.status, last: tracker.status.last ? { ...tracker.status.last } : null };
}

export function summarizeEvidence(evidence: Evidence): Record<string, number> {
  return {
    window_days: evidence.window_days,
    jp_messages: evidence.message_count_jp,
    repeated_asks: evidence.repeated_asks.length,
    capability_gaps: evidence.capability_gaps.length,
    interns: evidence.roster.length,
    ideas: evidence.ideas?.length ?? 0,
  };
}

/** Start a pass unless one is already running; resolves immediately with the status. */
export function startSuggestions(deps: Parameters<typeof runSuggestions>[0]): SuggestStatus {
  if (tracker.running) return suggestStatus();
  tracker.status = { running: true, started_at: new Date().toISOString(), finished_at: null, last: tracker.status.last };
  tracker.running = runSuggestions(deps)
    .then((result) => {
      tracker.status.last = {
        created: result.cards.length,
        proposed: result.proposed,
        skipped: result.skipped,
        titles: result.cards.map((c) => c.title),
        error: null,
        evidence_summary: summarizeEvidence(result.evidence),
      };
      return result;
    })
    .catch((err) => {
      tracker.status.last = { created: 0, proposed: 0, skipped: [], titles: [], error: err instanceof Error ? err.message : String(err), evidence_summary: {} };
      throw err;
    })
    .finally(() => {
      tracker.status.running = false;
      tracker.status.finished_at = new Date().toISOString();
      tracker.running = null;
    });
  tracker.running.catch(() => {});
  return suggestStatus();
}

export interface SuggestRunResult {
  cards: Card[];
  evidence: Evidence;
  proposed: number;
  skipped: string[];
}

/**
 * One pass: evidence → proposals → cards. `proposeFn` is injectable so the
 * smoke test never calls the model. Returns what was created and why
 * anything was skipped (suppressed by memory).
 */
export async function runSuggestions(
  deps: { db: Db; registry: Registry; home: string; proposeFn?: ProposeFn },
): Promise<SuggestRunResult> {
  const { db, registry, home } = deps;
  const propose = deps.proposeFn ?? proposeSuggestions;
  const memory = loadMemory(home);
  const evidence = collectEvidence(db, registry);
  const cards: Card[] = [];
  const skipped: string[] = [];
  let proposals: Suggestion[] = [];
  if (evidence.roster.length === 0 && evidence.message_count_jp === 0) {
    memory.last_run_at = new Date().toISOString();
    saveMemory(home, memory);
    return { cards, evidence, proposed: 0, skipped };
  }
  try {
    proposals = await propose(evidence, memory, db);
  } catch (err) {
    console.error("[suggest] proposal call failed; no cards this pass:", err);
    memory.last_run_at = new Date().toISOString();
    saveMemory(home, memory);
    return { cards, evidence, proposed: 0, skipped };
  }
  for (const s of proposals) {
    if (isSuppressed(memory, s.key)) {
      skipped.push(s.key);
      continue;
    }
    const card = db.createCard({
      intern: "coordinator",
      title: `${KIND_LABEL[s.kind]}: ${s.title}`,
      body: `**What I noticed**\n${s.why}\n\n**Suggestion**\n${s.proposal}${s.hire_role ? `\n\n_Role to draft:_ ${s.hire_role}` : ""}${s.capability ? `\n\n_Capability:_ \`${s.capability}\` for **${registry.get(s.target_intern ?? "")?.name ?? s.target_intern}**` : ""}`,
      severity: "info",
      actions: actionsFor(s),
      context: { type: "suggestion", kind: s.kind, key: s.key, hire_role: s.hire_role ?? null, target_intern: s.target_intern ?? null, capability: s.capability ?? null },
    });
    memory.records.push({ ...s, card_id: card.id, proposed_at: card.created_at, decision: "open", decided_at: null });
    cards.push(card);
  }
  memory.last_run_at = new Date().toISOString();
  saveMemory(home, memory);
  console.log(`[suggest] proposed=${proposals.length} created=${cards.length} skipped=${skipped.length}`);
  return { cards, evidence, proposed: proposals.length, skipped };
}

/**
 * Record JP's decision when a suggestion card is resolved (app or Discord)
 * and carry out the one side effect a card can have: a capability request
 * for "Request the build". The hire flow is opened by the app itself.
 */
export function wireSuggestionDecisions(
  bus: EventBus,
  home: string,
  capabilities: { request: (intern: string, requirement: CapabilityRequirement) => unknown },
): () => void {
  return bus.on("card_state", (card) => {
    if (card.context?.type !== "suggestion" || card.state === "open" || !card.resolution) return;
    const memory = loadMemory(home);
    const record = memory.records.find((r) => r.card_id === card.id);
    if (!record) return;
    const action = card.resolution.action;
    record.decision = action === "later" ? "later" : action === "never" ? "never" : action === "noted" ? "noted" : "accepted";
    record.decided_at = card.resolved_at ?? new Date().toISOString();
    saveMemory(home, memory);
    if (action === "request" && typeof card.context.target_intern === "string" && typeof card.context.capability === "string") {
      try {
        capabilities.request(card.context.target_intern, {
          id: String(card.context.capability).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "integration",
          reason: `Coordinator suggestion: ${card.title}`,
        });
      } catch (err) {
        console.error("[suggest] capability request failed:", err);
      }
    }
  });
}
