/**
 * Learning from the owner's draft edits.
 *
 * Interns write Outlook drafts; the owner edits and sends them. Every half
 * hour this asks graph-mail which of its drafts have been sent
 * (`sent-drafts`, read-only) and gets back the intern's text next to what
 * actually went out. A real edit — not just a signature Outlook added — is
 * kept (db draft_edits). Once an intern has two or more unread edits, one
 * cheap model call looks for a pattern ("you always cut the sign-off",
 * "you never use em dashes"); if there is one, the intern asks in its own
 * chat whether to make it a standing order: Save it / Not now / Never.
 *
 * Deterministic except that one judgment call, which fails closed: an error
 * leaves the edits unlearned to try again later.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { Db, DraftEdit } from "./db.js";
import { TOOLS_DIR } from "./engine.js";
import { ruleFence } from "./fences.js";
import { ownerName } from "./profile.js";
import type { Registry } from "./registry.js";
import type { Card } from "./types.js";
import { SMALL_MODEL } from "./models.js";

const LEARN_MODEL = SMALL_MODEL;
/** Edits needed before looking for a pattern. */
export const EDITS_TO_LEARN = 2;
const SNOOZE_DAYS = 7;

export interface SentDraft {
  draft_id: string;
  intern: string | null;
  mailbox: string;
  subject: string;
  intern_body: string;
  sent_body: string;
  sent_at: string | null;
}

export type SentDraftsRunner = (mailbox: string) => Promise<SentDraft[]>;
export type LearnFn = (input: { intern: string; edits: DraftEdit[]; rules: string[]; rejected: string[] }) => Promise<{ rule: string | null; why: string }>;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Did the owner really change it? Unchanged, or only something added at the
 * end (Outlook's signature), doesn't count; nor does a tweak of a few
 * characters.
 */
export function wasEdited(original: string, sent: string): boolean {
  const a = norm(original);
  const b = norm(sent);
  if (!b || a === b) return false;
  if (b.startsWith(a)) return false; // only appended: a signature
  const wa = a.toLowerCase().split(" ");
  const wb = b.toLowerCase().split(" ");
  // word-level LCS: how much of the intern's text survived, in order
  const prev = new Array(wb.length + 1).fill(0);
  for (const x of wa) {
    let diag = 0;
    for (let j = 1; j <= wb.length; j++) {
      const up = prev[j];
      prev[j] = x === wb[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = up;
    }
  }
  const kept = prev[wb.length] / Math.max(wa.length, wb.length);
  return kept < 0.97;
}

function defaultRunner(config: Config, home: string): SentDraftsRunner {
  const run = promisify(execFile);
  return async (mailbox) => {
    const { stdout } = await run(path.join(TOOLS_DIR, "graph-mail"), ["--mailbox", mailbox, "sent-drafts"], {
      env: { ...process.env, INTERNS_HOME: home },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { sent?: SentDraft[]; error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed.sent ?? [];
  };
}

/** The pattern call: at most one standing order, or none. */
export const learnFromEdits: LearnFn = async ({ intern, edits, rules, rejected }) => {
  const owner = ownerName();
  const pairs = edits
    .slice(-5)
    .map((e, i) => `### Draft ${i + 1}${e.subject ? ` (${e.subject})` : ""}\nWhat ${intern} wrote:\n${e.original.slice(0, 1500)}\n\nWhat ${owner} sent:\n${e.sent.slice(0, 1500)}`)
    .join("\n\n");
  const prompt =
    `${intern} is an AI assistant that drafts emails for ${owner}. ${owner} edited these drafts before sending.\n\n${pairs}\n\n` +
    `Standing orders ${intern} already has:\n${rules.length ? rules.map((r) => `- ${r}`).join("\n") : "(none)"}\n` +
    `Already declined by ${owner}, never suggest again:\n${rejected.length ? rejected.map((r) => `- ${r}`).join("\n") : "(none)"}\n\n` +
    `Is there ONE consistent change ${owner} makes across these drafts that ${intern} should adopt as a standing order ` +
    `(length, tone, greetings, sign-offs, phrases to avoid, punctuation, formatting)? Ignore one-off factual corrections, ` +
    `signatures and quoted text. Only suggest something seen in at least two drafts and not already covered above.\n` +
    `Respond with ONLY strict JSON: {"rule": "<one short instruction to ${intern}, in second person, e.g. 'Keep emails under five lines'>" or null, ` +
    `"why": "<what ${owner} kept changing, in one short sentence addressed to ${owner}, e.g. 'you cut every sign-off down to just your name'>"}`;
  let text = "";
  for await (const message of query({
    prompt,
    options: { systemPrompt: "You spot editing patterns. You output only strict JSON.", model: LEARN_MODEL, tools: [], maxTurns: 1, settingSources: [], strictMcpConfig: true },
  })) {
    if (message.type === "result" && message.subtype === "success") text = message.result;
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in the edit-learning answer");
  const parsed = JSON.parse(match[0]) as { rule?: unknown; why?: unknown };
  const rule = typeof parsed.rule === "string" && parsed.rule.trim() ? parsed.rule.trim().slice(0, 280) : null;
  return { rule, why: typeof parsed.why === "string" ? parsed.why.trim() : "" };
};

export class DraftLearner {
  private running = false;
  private readonly runner: SentDraftsRunner;
  private readonly learn: LearnFn;

  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
    opts: { home: string; runner?: SentDraftsRunner; learn?: LearnFn },
  ) {
    this.runner = opts.runner ?? defaultRunner(config, opts.home);
    this.learn = opts.learn ?? learnFromEdits;
  }

  /** Collect sent drafts from every mailbox, keep real edits, then look for patterns. Never throws. */
  async tick(now: Date = new Date()): Promise<Card[]> {
    if (this.running) return [];
    this.running = true;
    try {
      for (const mailbox of this.config.mailboxes) {
        let sent: SentDraft[];
        try {
          sent = await this.runner(mailbox);
        } catch (err) {
          console.error(`[draftlearn] ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        for (const s of sent) {
          if (!s.intern || !this.registry.get(s.intern) || !wasEdited(s.intern_body, s.sent_body)) continue;
          this.db.addDraftEdit({ intern: s.intern, mailbox, draft_id: s.draft_id, subject: s.subject, original: s.intern_body, sent: s.sent_body, sent_at: s.sent_at });
        }
      }
      const cards: Card[] = [];
      for (const intern of this.db.internsWithUnlearnedEdits()) {
        const card = await this.consider(intern, now);
        if (card) cards.push(card);
      }
      return cards;
    } finally {
      this.running = false;
    }
  }

  private async consider(slug: string, now: Date): Promise<Card | null> {
    const manifest = this.registry.get(slug);
    if (!manifest) return null;
    const snooze = this.db.getKv(`draft_learn_snooze:${slug}`);
    if (snooze && snooze > now.toISOString()) return null;
    if (this.db.listCards("open").some((c) => c.intern === slug && c.context.kind === "draft_learn")) return null;
    const edits = this.db.unlearnedDraftEdits(slug);
    if (edits.length < EDITS_TO_LEARN) return null;
    const rules = this.db.listRules(slug).filter((r) => r.enabled && !r.removed_at).map((r) => r.text);
    const rejected = neverList(this.db, slug);
    let verdict: { rule: string | null; why: string };
    try {
      verdict = await this.learn({ intern: manifest.name, edits, rules, rejected });
    } catch (err) {
      console.error(`[draftlearn] ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      return null; // fail closed: try again next tick
    }
    this.db.markDraftEditsLearned(edits.map((e) => e.id));
    const rule = verdict.rule;
    if (!rule || rules.some((r) => r.toLowerCase() === rule.toLowerCase()) || rejected.some((r) => r.toLowerCase() === rule.toLowerCase())) return null;
    return this.db.createCard({
      intern: slug,
      title: "Learned from your edits",
      body:
        `I looked at how you changed my last ${edits.length} drafts before sending${verdict.why ? `: ${verdict.why.replace(/\.$/, "")}` : ""}. ` +
        `Shall I make this a standing order?\n\n> ${rule}`,
      severity: "info",
      actions: [
        { id: "save", label: "Save it", style: "primary", kind: "button" },
        { id: "not_now", label: "Not now", style: "neutral", kind: "button" },
        { id: "never", label: "Never", style: "neutral", kind: "button" },
      ],
      context: { kind: "draft_learn", rule, edits: edits.length },
    });
  }
}

function neverList(db: Db, slug: string): string[] {
  try {
    const list: unknown = JSON.parse(db.getKv(`draft_learn_never:${slug}`) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The owner answered a "Learned from your edits" card (approvals.ts). */
export function applyDraftLearnAnswer(db: Db, card: Card, actionId: string, now: Date = new Date()): void {
  const slug = card.intern;
  const rule = String(card.context.rule ?? "");
  if (!rule) return;
  if (actionId === "save") {
    if (db.listRules(slug).some((r) => r.text === rule && !r.removed_at)) return;
    const created = db.createRule({ intern: slug, kind: "soft", type: "guidance", params: {}, text: rule });
    db.announce(slug, ruleFence(created));
  } else if (actionId === "not_now") {
    db.setKv(`draft_learn_snooze:${slug}`, new Date(now.getTime() + SNOOZE_DAYS * 86_400_000).toISOString());
  } else if (actionId === "never") {
    db.setKv(`draft_learn_never:${slug}`, JSON.stringify([...neverList(db, slug), rule].slice(-50)));
  }
}
