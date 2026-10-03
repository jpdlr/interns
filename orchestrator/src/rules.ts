/**
 * Standing orders (docs/features/04-standing-orders.md).
 *
 * Hard rules are enforced here, deterministically, before work reaches an
 * intern: the orchestrator calls applyHardRules() on every automatic task
 * (mail, PR, scheduled, backlog) right before running it. Work JP asked for
 * directly — a `message` task — is never filtered: a rule must not swallow a
 * direct question. A muted item produces nothing at all, not even a
 * "skipped" note; the rule's hit counter is the only trace.
 *
 * A hold_until rule *holds* matching mail and PR reviews: they are parked
 * (Db holds) and released as a fresh trigger once the date has passed — never
 * thrown away. A pre-meeting brief is the exception: one that arrives after
 * the meeting is useless, so a held meeting is simply not briefed.
 *
 * Soft rules (type `guidance`) are not enforced here — engine.ts adds them
 * to the system prompt as a "Standing orders" block.
 */
import type { Db } from "./db.js";
import { RULE_PARAMS_SCHEMAS, type Rule, type RuleType, type Task } from "./types.js";
import { localZone, ownerName } from "./profile.js";

export const HARD_RULE_TYPES: RuleType[] = ["mute_repo", "mute_sender", "quiet_hours", "hold_until"];

export function ruleKind(type: RuleType): "hard" | "soft" {
  return type === "guidance" ? "soft" : "hard";
}

/** Validate and normalize params for a rule type; throws a readable message. */
export function parseRuleParams(type: RuleType, params: unknown): Record<string, unknown> {
  const parsed = RULE_PARAMS_SCHEMAS[type].safeParse(params ?? {});
  if (!parsed.success) throw new Error(`invalid ${type} params: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data as Record<string, unknown>;
}

// ---------------------------------------------------------------- matchers

/**
 * "acme/webapp", "webapp" (any owner) or "acme/*" (every repo of an owner),
 * case-insensitive.
 */
export function repoMatches(pattern: string, repository: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  const r = repository.trim().toLowerCase();
  if (!p || !r) return false;
  if (p.endsWith("/*")) return r.startsWith(p.slice(0, -1));
  if (p.includes("/")) return r === p;
  return r.split("/")[1] === p || r === p;
}

/** Address match is exact; domain match covers subdomains ("example.com" mutes "a@mail.example.com"). */
export function senderMatches(params: { address?: string; domain?: string }, from: string | null | undefined): boolean {
  const addr = (from ?? "").trim().toLowerCase();
  if (!addr) return false;
  if (params.address && addr === params.address.trim().toLowerCase()) return true;
  if (params.domain) {
    const d = params.domain.trim().toLowerCase().replace(/^@/, "");
    const host = addr.split("@")[1] ?? "";
    return host === d || host.endsWith(`.${d}`);
  }
  return false;
}

/** Local wall-clock minutes for a time zone (Intl, no dependency). */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** True inside [from, to) local time; a window that wraps midnight (21:00–07:00) works. */
export function inQuietHours(params: { from: string; to: string; tz?: string }, now: Date = new Date()): boolean {
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const from = toMin(params.from);
  const to = toMin(params.to);
  let cur: number;
  try {
    cur = localMinutes(now, params.tz || localZone());
  } catch {
    cur = localMinutes(now, localZone());
  }
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** hold_until: holds while today's local date is before `until`. */
export function holdActive(params: { until: string }, now: Date = new Date()): boolean {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: localZone() }).format(now); // YYYY-MM-DD
  return today < params.until.slice(0, 10);
}

function textMatches(needle: string, haystack: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

// ------------------------------------------------------------- enforcement

interface MailRow {
  from?: string | null;
  subject?: string | null;
  preview?: string | null;
}

export interface RuleVerdict {
  /** drop the task entirely */
  drop: boolean;
  /** a filtered payload to run with instead (mail batches lose muted messages) */
  payload?: Record<string, unknown>;
  /** human-readable reason, recorded as the task's error when dropped */
  reason?: string;
  /** work parked by hold_until rules, to be re-enqueued on `until` (orchestrator) */
  holds?: { until: string; rule: string; payload: Record<string, unknown> }[];
}

/**
 * Apply an intern's enabled hard rules to one task. Records hits as a side
 * effect. Returns `{drop:false}` untouched when nothing matched.
 */
export function applyHardRules(db: Db, task: Task, now: Date = new Date()): RuleVerdict {
  if (task.kind === "message") return { drop: false };
  const rules = db.listRules(task.intern, { enabledOnly: true }).filter((r) => r.kind === "hard");
  if (rules.length === 0) return { drop: false };
  const p = task.payload;

  // GitHub PRs: a muted repo drops the review.
  if (p.type === "github_pull_request" && typeof p.repository === "string") {
    for (const rule of rules) {
      const repo = String(rule.params.repo ?? "");
      if (rule.type === "mute_repo" && repoMatches(repo, p.repository)) {
        db.recordRuleHit(rule.id, `${p.repository}#${String(p.pull_number ?? "?")}`);
        return { drop: true, reason: `standing order: ${rule.text}` };
      }
      if (rule.type === "hold_until" && holdActive(rule.params as { until: string }, now) && textMatches(String(rule.params.match), `${p.repository} ${String(p.title ?? "")}`)) {
        db.recordRuleHit(rule.id, `${p.repository}#${String(p.pull_number ?? "?")}`);
        const until = String(rule.params.until).slice(0, 10);
        return { drop: true, reason: `held by standing order until ${until}: ${rule.text}`, holds: [{ until, rule: rule.text, payload: p }] };
      }
    }
    return { drop: false };
  }

  // Mail batches: muted/held messages leave the batch; an emptied batch is dropped.
  if (p.kind === "new_mail" && Array.isArray(p.messages)) {
    const messages = p.messages as MailRow[];
    const keep: MailRow[] = [];
    const hits = new Map<Rule, number>();
    const held = new Map<Rule, MailRow[]>();
    for (const m of messages) {
      const muted = rules.find((r) => r.type === "mute_sender" && senderMatches(r.params as { address?: string; domain?: string }, m.from));
      const holding = muted
        ? undefined
        : rules.find(
            (r) =>
              r.type === "hold_until" &&
              holdActive(r.params as { until: string }, now) &&
              textMatches(String(r.params.match), `${m.from ?? ""} ${m.subject ?? ""}`),
          );
      const rule = muted ?? holding;
      if (rule) hits.set(rule, (hits.get(rule) ?? 0) + 1);
      if (holding) held.set(holding, [...(held.get(holding) ?? []), m]);
      if (!rule) keep.push(m);
    }
    for (const [rule, n] of hits) db.recordRuleHit(rule.id, `${n} mail(s)`, n);
    if (hits.size === 0) return { drop: false };
    const holds = [...held.entries()].map(([rule, rows]) => ({
      until: String(rule.params.until).slice(0, 10),
      rule: rule.text,
      payload: { kind: "new_mail", mailbox: p.mailbox, count: rows.length, summary: `Held mail released (${rows.length})`, messages: rows },
    }));
    if (keep.length === 0 && !(Array.isArray(p.held) && p.held.length)) {
      const reason = holds.length && holds.length === hits.size
        ? `held by standing order until ${holds.map((h) => h.until).join(", ")}`
        : `standing order: ${[...hits.keys()].map((r) => r.text).join("; ")}`;
      return { drop: true, reason, ...(holds.length ? { holds } : {}) };
    }
    return { drop: false, payload: { ...p, messages: keep, count: keep.length }, ...(holds.length ? { holds } : {}) };
  }

  // Meeting briefs: a held meeting is not briefed (a late brief is useless).
  // No other trigger kind is matched — a hold must never stall builds or routines.
  if (p.kind === "meeting_brief") {
    const event = (p.event ?? {}) as { subject?: string; attendees?: { name?: string | null; email?: string | null }[] };
    const subject = [event.subject ?? "", ...(event.attendees ?? []).flatMap((a) => [a.name ?? "", a.email ?? ""])].join(" ");
    for (const rule of rules) {
      if (rule.type === "hold_until" && holdActive(rule.params as { until: string }, now) && textMatches(String(rule.params.match), subject)) {
        db.recordRuleHit(rule.id, event.subject ?? "meeting brief");
        return { drop: true, reason: `standing order: ${rule.text}` };
      }
    }
  }
  return { drop: false };
}

/** Push gate: is this intern inside one of its quiet-hours rules right now? Records a hit when it is. */
export function quietNow(db: Pick<Db, "listRules" | "recordRuleHit">, intern: string, now: Date = new Date()): boolean {
  for (const rule of db.listRules(intern, { enabledOnly: true })) {
    if (rule.type === "quiet_hours" && inQuietHours(rule.params as { from: string; to: string; tz?: string }, now)) {
      db.recordRuleHit(rule.id, "push held");
      return true;
    }
  }
  return false;
}

/** The system-prompt block for an intern's soft rules ("" when none). */
export function standingOrdersPrompt(rules: Rule[]): string {
  const soft = rules.filter((r) => r.enabled && !r.removed_at && r.kind === "soft");
  const hard = rules.filter((r) => r.enabled && !r.removed_at && r.kind === "hard");
  if (soft.length === 0 && hard.length === 0) return "";
  return [
    `\n## Standing orders from ${ownerName()}`,
    ...soft.map((r) => `- ${r.text}`),
    ...(hard.length
      ? [
          "Already enforced before work reaches you (never mention skipping these):",
          ...hard.map((r) => `- ${r.text}`),
        ]
      : []),
  ].join("\n");
}
