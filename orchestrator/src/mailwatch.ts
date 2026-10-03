/**
 * Mail watcher — near-real-time mail triggering by polling, with layered
 * triage so the (expensive, Opus-class) intern session only wakes for mail
 * that matters.
 *
 * Deliberately NOT Graph change notifications (webhooks): those need a public
 * HTTPS endpoint + subscription renewal. This box is localhost-only, so we
 * poll the read-only `tools/graph-mail` CLI every config.mail_poll_minutes.
 *
 * Three layers sit between "new mail arrived" and "wake the intern":
 *  - Layer 1 (free, deterministic): config.mail_triage regexes drop obvious
 *    junk (newsletters, no-reply, etc.) before it ever reaches the batch.
 *    Filtered mail still advances the watermark — it never re-surfaces.
 *  - Layer 2 (free, deterministic): survivors accumulate in a per-mailbox
 *    pending batch, persisted in the watermark file. A batch is only *ready*
 *    to enqueue once a VIP sender appears (immediate), the cooldown since the
 *    mailbox's last trigger has passed, or the oldest pending message has
 *    waited past mail_batch_max_wait_minutes.
 *  - Layer 3 (small LLM cost): a ready batch (unless VIP) goes through
 *    triage.classifyBatch — a cheap Haiku-class call — before the trigger
 *    task is actually enqueued. "hold" verdicts move the batch into a `held`
 *    digest that rides along on the next wake or scheduled task instead.
 *
 * Invariants:
 *  - one trigger task per tick per intern+mailbox, never one per message
 *  - a Graph hiccup logs and skips the tick; it never throws into the service
 *  - the watermark only advances after any Layer-2/3 outcome is durably
 *    persisted (batched, held, or enqueued) — a crash re-delivers, never drops
 *  - watermarks (+ pending/held state) live in ~/.interns/<slug>/mailwatch.json
 *    (db.ts is another lane)
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { internsHome } from "./config.js";
import type { Db } from "./db.js";
import { mailboxesFor } from "./mailboxes.js";
import type { Registry } from "./registry.js";
import { classifyBatch } from "./triage.js";
import { nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------ tuning

/** How long a single graph-mail invocation may take before we kill it. */
const CLI_TIMEOUT_MS = 60_000;
/** graph-mail prints a JSON array; 25 messages of previews is ~50 KB. */
const CLI_MAX_BUFFER = 8 * 1024 * 1024;
/** Consecutive CLI failures before we shout once and back off. */
const FAILURES_BEFORE_BACKOFF = 3;
/** Slow tick used while the CLI is unhealthy. */
const BACKOFF_MINUTES = 15;
/** Ids remembered per mailbox — dedupe window across restarts/clock skew. */
const SEEN_IDS_CAP = 200;
/** Messages embedded in one trigger payload (the prompt has to stay sane). */
const MAX_MESSAGES_PER_TASK = 25;
/** Preview text kept per message in the payload. */
const PREVIEW_CHARS = 240;

/**
 * Mailboxes come from `config.mailboxes`: each id is a directory under
 * ~/.interns/mailboxes/ that graph-mail selects with `--mailbox <id>`.
 * Everything downstream — watermark files, dedupe, task payloads — is keyed
 * by mailbox id, so adding a mailbox needs no code change.
 */
interface MailboxSpec {
  /** stable key used in the watermark file and the task payload */
  id: string;
  /** extra argv prepended to the base inbox command */
  args: string[];
}

/** Base command; --days 1 --top 25 is a comfortable superset of a 2-min tick. */
const INBOX_ARGS = ["inbox", "--days", "1", "--top", "25"];

// ------------------------------------------------------------------- types

/** Trimmed shape of one graph-mail inbox row (see tools/graph-mail msg_fields). */
export interface MailMessage {
  id: string;
  conversationId: string | null;
  from: string | null;
  subject: string | null;
  received: string | null;
  preview: string | null;
}

/** Per-mailbox high-water mark, plus layer-2/3 triage state. */
export interface MailboxWatermark {
  /** ISO receivedDateTime of the newest message we have accounted for */
  last_received: string | null;
  /** recently accounted-for message ids, newest first, capped */
  seen_ids: string[];
  updated_at: string;
  /** Layer-2: messages past Layer-1 filtering, waiting on cooldown/max-wait/VIP. */
  pending?: MailMessage[];
  /** ISO timestamp the oldest currently-pending message was added (drives max-wait). */
  pending_since?: string | null;
  /** ISO timestamp of this mailbox's last enqueued mail trigger (cooldown anchor). */
  last_trigger_at?: string | null;
  /** Layer-3 "hold" verdicts, waiting to ride along on the next wake/scheduled task. */
  held?: MailMessage[];
}

/** Matches a message against a set of case-insensitive regex fragments. */
function anyMatch(patterns: string[], value: string | null): boolean {
  if (!value) return false;
  return patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(value);
    } catch {
      return false; // a bad regex in config must not wedge the poller
    }
  });
}

/** Layer 1: deterministic, free — obvious junk never reaches the batch. */
export function isIgnoredMessage(m: MailMessage, triage: Config["mail_triage"]): boolean {
  return anyMatch(triage.ignore_from, m.from) || anyMatch(triage.ignore_subject, m.subject);
}

/** VIP senders bypass cooldown (Layer 2) and the LLM gate (Layer 3) entirely. */
export function isVipMessage(m: MailMessage, triage: Config["mail_triage"]): boolean {
  return anyMatch(triage.vip_from, m.from);
}

/** One compact line per held message, used in "Held since last run" digests. */
export function formatHeldLine(m: MailMessage, mailboxId: string): string {
  const when = m.received ? ` (${m.received})` : "";
  return `- [${mailboxId}] from ${m.from ?? "unknown"} — "${m.subject ?? "(no subject)"}"${when}`;
}

export interface WatermarkFile {
  version: 1;
  mailboxes: Record<string, MailboxWatermark>;
}

export function emptyWatermarkFile(): WatermarkFile {
  return { version: 1, mailboxes: {} };
}

// -------------------------------------------------------- watermark logic
// Pure functions, unit-testable without Graph, a db, or a filesystem.

/**
 * Messages that are genuinely new relative to `mark`.
 *
 * Rules:
 *  - no watermark yet (first ever tick for this intern+mailbox) → nothing is
 *    new. We adopt the current inbox as the baseline instead of spamming the
 *    intern with a day of backlog on first boot.
 *  - an id we have already accounted for is never new (survives restarts and
 *    Graph returning the same message with a jittered timestamp)
 *  - otherwise new means received >= last_received. Ties are safe because the
 *    already-seen ids at that exact timestamp are in seen_ids.
 *  - a message with no usable timestamp is new iff its id is unseen.
 */
export function selectNewMessages(messages: MailMessage[], mark: MailboxWatermark | undefined): MailMessage[] {
  if (!mark) return [];
  const seen = new Set(mark.seen_ids);
  return messages.filter((m) => {
    if (!m.id || seen.has(m.id)) return false;
    if (!m.received || !mark.last_received) return true;
    return m.received >= mark.last_received;
  });
}

/**
 * Fold a polled batch into the watermark. Advances last_received monotonically
 * (never backwards, so a late-arriving old mail cannot re-open the window) and
 * remembers every id in the batch, newest first, capped.
 */
export function advanceWatermark(messages: MailMessage[], mark: MailboxWatermark | undefined): MailboxWatermark {
  const previous = mark ?? { last_received: null, seen_ids: [], updated_at: nowIso() };
  let last = previous.last_received;
  for (const m of messages) {
    if (m.received && (!last || m.received > last)) last = m.received;
  }
  // newest first: the batch is already ordered desc by graph-mail, but sort
  // defensively so the cap always evicts the oldest ids.
  const batchIds = [...messages]
    .sort((a, b) => (b.received ?? "").localeCompare(a.received ?? ""))
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));
  const seen_ids: string[] = [];
  for (const id of [...batchIds, ...previous.seen_ids]) {
    if (!seen_ids.includes(id)) seen_ids.push(id);
    if (seen_ids.length >= SEEN_IDS_CAP) break;
  }
  return { last_received: last, seen_ids, updated_at: nowIso() };
}

// ------------------------------------------------------------- formatting

function trim(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** Defensive parse of graph-mail's JSON — never trust the shape blindly. */
export function parseInboxOutput(stdout: string): MailMessage[] {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
    throw new Error(`graph-mail error: ${String((parsed as { error: unknown }).error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("graph-mail inbox did not return a JSON array");
  return parsed.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) return [];
    return [
      {
        id: r.id,
        conversationId: typeof r.conversationId === "string" ? r.conversationId : null,
        from: trim(r.from, 200),
        subject: trim(r.subject, 300),
        received: typeof r.received === "string" ? r.received : null,
        preview: trim(r.preview, PREVIEW_CHARS),
      },
    ];
  });
}

/** Human-readable digest that rides along in the payload (see reachesEngine note). */
export function summarize(messages: MailMessage[], mailboxId: string): string {
  const label = mailboxId === "default" ? "" : ` (${mailboxId})`;
  const head = `New mail arrived${label}: ${messages.length} message${messages.length === 1 ? "" : "s"}.`;
  const lines = messages.map((m, i) => {
    const parts = [
      `${i + 1}. from ${m.from ?? "unknown"}`,
      `subject "${m.subject ?? "(no subject)"}"`,
      m.received ? `received ${m.received}` : null,
    ].filter(Boolean);
    return `${parts.join(", ")}${m.preview ? ` — ${m.preview}` : ""}`;
  });
  return [head, ...lines].join("\n");
}

// ----------------------------------------------------------------- runner

export type MailCliRunner = (args: string[]) => Promise<string>;

/** Layer 3 gate. Returns a verdict; never throws — callers still wrap it defensively. */
export type TriageFn = (messages: MailMessage[]) => Promise<"wake" | "hold">;

function resolveCliPath(): string {
  const override = process.env.INTERNS_GRAPH_MAIL;
  if (override) return override;
  // dev runs from src/, built code runs from dist/src/ — try both, then fall
  // back to the repo path so a stack trace names something meaningful.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../tools/graph-mail"),
    path.resolve(here, "../../tools/graph-mail"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[1]!;
}

function defaultRunner(args: string[]): Promise<string> {
  const cli = resolveCliPath();
  return execFileAsync(cli, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER }).then((r) => r.stdout);
}

// ------------------------------------------------------------ MailWatcher

export interface MailWatcherOptions {
  /** base dir for watermark files; defaults to INTERNS_HOME */
  home?: string;
  /** injectable CLI for tests */
  runCli?: MailCliRunner;
  /** injectable Layer-3 gate for tests; defaults to triage.classifyBatch */
  classify?: TriageFn;
}

export class MailWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  /** Per-mailbox consecutive-failure counts — one healthy mailbox must not reset another's. */
  private consecutiveFailures = new Map<string, number>();
  private lastOkAt = new Map<string, string>();
  private lastError = new Map<string, string>();
  private backingOff = false;
  private readonly home: string;
  private readonly runCli: MailCliRunner;
  private readonly classify: TriageFn;

  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
    options: MailWatcherOptions = {},
  ) {
    this.home = options.home ?? internsHome();
    this.runCli = options.runCli ?? defaultRunner;
    this.classify = options.classify ?? ((messages) => classifyBatch(messages, this.db));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // let an in-flight tick finish so a watermark is never half-written
    while (this.ticking) await new Promise((r) => setTimeout(r, 25));
  }

  /** Minutes between ticks right now (backoff-aware). */
  intervalMinutes(): number {
    return this.backingOff ? BACKOFF_MINUTES : this.config.mail_poll_minutes;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, this.intervalMinutes() * 60_000);
    this.timer.unref?.();
  }

  /**
   * One poll cycle. Always resolves: any failure is logged and the tick is
   * skipped. Exported behaviour (not private) so it can be driven from tests.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    let tickFiltered = 0;
    let tickKept = 0;
    try {
      const watchers = this.watchingInterns();
      if (watchers.length === 0) return;
      const mailboxes: MailboxSpec[] = this.config.mailboxes.map((id) => ({ id, args: ["--mailbox", id] }));

      for (const mailbox of mailboxes) {
        let messages: MailMessage[];
        try {
          // --mailbox is a main-parser flag on graph-mail: it must PRECEDE the subcommand.
          messages = parseInboxOutput(await this.runCli([...mailbox.args, ...INBOX_ARGS]));
        } catch (err) {
          this.noteFailure(mailbox.id, err);
          continue;
        }
        this.noteSuccess(mailbox.id);
        for (const slug of watchers) {
          // an intern limited to some mailboxes is only woken by those
          const manifest = this.registry.get(slug);
          if (!manifest || !mailboxesFor(manifest, this.config).includes(mailbox.id)) continue;
          try {
            const { filtered, kept } = await this.applyToIntern(slug, mailbox.id, messages);
            tickFiltered += filtered;
            tickKept += kept;
          } catch (err) {
            // one bad intern must not stop the others
            console.error(`[mailwatch] ${slug}/${mailbox.id}: ${describe(err)}`);
          }
        }
      }
    } catch (err) {
      console.error(`[mailwatch] tick failed: ${describe(err)}`);
    } finally {
      if (tickFiltered || tickKept) {
        console.log(`[mailwatch] tick: layer1 filtered ${tickFiltered}, kept ${tickKept}`);
      }
      this.ticking = false;
    }
  }

  /** Interns whose manifest opts into mail triggering. */
  private watchingInterns(): string[] {
    return this.registry
      .list()
      // a paused intern's mail stays unread here, so it is picked up on resume
      .filter(({ manifest }) => manifest.triggers.mail_push === true && !manifest.paused)
      .map(({ slug }) => slug);
  }

  /**
   * Diff against the intern's watermark, run it through layers 1-3, enqueue
   * at most one task, persist. Returns Layer-1 counts for the tick's summary
   * log.
   */
  private async applyToIntern(
    slug: string,
    mailboxId: string,
    messages: MailMessage[],
  ): Promise<{ filtered: number; kept: number }> {
    const file = this.readWatermarkFile(slug);
    const mark = file.mailboxes[mailboxId];
    const fresh = selectNewMessages(messages, mark);

    if (!mark) {
      // First sighting: adopt the current inbox as the baseline, stay quiet.
      file.mailboxes[mailboxId] = advanceWatermark(messages, undefined);
      this.writeWatermarkFile(slug, file);
      console.log(`[mailwatch] ${slug}/${mailboxId}: baseline set (${messages.length} existing messages, no trigger)`);
      return { filtered: 0, kept: 0 };
    }

    // The watermark always advances over the WHOLE polled batch — filtered or
    // not — so nothing can ever re-surface. Everything below only decides
    // whether/when to enqueue, never whether mail is "accounted for".
    file.mailboxes[mailboxId] = advanceWatermark(messages, mark);
    const updated = file.mailboxes[mailboxId]!;
    // advanceWatermark only touches last_received/seen_ids/updated_at — carry
    // the layer-2/3 state on the old mark forward onto the new one.
    updated.pending = mark.pending ?? [];
    updated.pending_since = mark.pending_since ?? null;
    updated.last_trigger_at = mark.last_trigger_at ?? null;
    updated.held = mark.held ?? [];

    // ---------------------------------------------------------- Layer 1
    const triage = this.config.mail_triage;
    let filtered = 0;
    const kept: MailMessage[] = [];
    for (const m of fresh) {
      if (isIgnoredMessage(m, triage)) filtered++;
      else kept.push(m);
    }
    if (kept.length > 0) {
      updated.pending.push(...kept);
      if (!updated.pending_since) updated.pending_since = nowIso();
    }

    if (updated.pending.length === 0) {
      this.writeWatermarkFile(slug, file);
      return { filtered, kept: 0 };
    }

    // ---------------------------------------------------------- Layer 2
    const vip = updated.pending.some((m) => isVipMessage(m, triage));
    const cooldownOk =
      !updated.last_trigger_at ||
      Date.now() - Date.parse(updated.last_trigger_at) >= this.config.mail_trigger_cooldown_minutes * 60_000;
    const maxWaitExceeded =
      !!updated.pending_since &&
      Date.now() - Date.parse(updated.pending_since) >= this.config.mail_batch_max_wait_minutes * 60_000;

    if (!vip && !cooldownOk && !maxWaitExceeded) {
      this.writeWatermarkFile(slug, file);
      if (kept.length > 0) {
        console.log(`[mailwatch] ${slug}/${mailboxId}: batched ${kept.length} (pending ${updated.pending.length}, waiting on cooldown)`);
      }
      return { filtered, kept: kept.length };
    }

    // ---------------------------------------------------------- Layer 3
    // VIP mail skips the LLM gate entirely — it always wakes immediately.
    let verdict: "wake" | "hold" = "wake";
    if (!vip) {
      try {
        verdict = await this.classify(updated.pending);
      } catch (err) {
        console.error(`[mailwatch] ${slug}/${mailboxId}: triage failed, failing open to wake — ${describe(err)}`);
        verdict = "wake";
      }
    }

    if (verdict === "hold") {
      updated.held.push(...updated.pending);
      updated.pending = [];
      updated.pending_since = null;
      this.writeWatermarkFile(slug, file);
      console.log(`[mailwatch] ${slug}/${mailboxId}: held ${kept.length} — batch (triage: hold), ${updated.held.length} awaiting next wake`);
      return { filtered, kept: kept.length };
    }

    // wake: enqueue exactly one trigger task carrying the whole batch. If
    // items were previously held, this run IS "the next wake-trigger" they
    // were waiting for — drain them in as a digest.
    const heldDigest = updated.held.map((m) => formatHeldLine(m, mailboxId));
    const batch = updated.pending;
    const ordered = [...batch].sort((a, b) => (a.received ?? "").localeCompare(b.received ?? ""));
    const payloadMessages = ordered.slice(-MAX_MESSAGES_PER_TASK);
    const payload: Record<string, unknown> = {
      kind: "new_mail",
      mailbox: mailboxId,
      count: batch.length,
      // One short line only — `messages` below already carries the detail, and
      // orchestrator.taskPrompt stringifies the whole payload into the prompt,
      // so duplicating content here would just burn the intern's token cap.
      summary:
        `New mail in ${mailboxId}: ${batch.length} message(s).` +
        (heldDigest.length > 0
          ? `\n\nHeld since last run (${heldDigest.length}, quiet mail — skim only):\n${heldDigest.join("\n")}`
          : ""),
      messages: payloadMessages,
    };
    if (heldDigest.length > 0) payload.held = heldDigest;

    const task = this.db.enqueueTask(slug, "trigger", payload);

    updated.pending = [];
    updated.pending_since = null;
    updated.held = [];
    updated.last_trigger_at = nowIso();
    this.writeWatermarkFile(slug, file);
    console.log(`[mailwatch] ${slug}/${mailboxId}: ${batch.length} new → task ${task.id}${vip ? " (VIP)" : ""}`);
    return { filtered, kept: kept.length };
  }

  /**
   * Pull and clear every mailbox's held digest for one intern. Mail-trigger
   * wake payloads already drain their own held items inline (see above); this
   * is for the OTHER place held mail can surface — the orchestrator calls it
   * when enqueueing a `scheduled` (cron) task for a mail_push intern, so a
   * quiet inbox still eventually reaches JP via the morning digest etc.
   */
  drainHeld(slug: string): string[] {
    const file = this.readWatermarkFile(slug);
    const lines: string[] = [];
    let changed = false;
    for (const [mailboxId, mark] of Object.entries(file.mailboxes)) {
      const held = mark.held ?? [];
      if (held.length === 0) continue;
      changed = true;
      for (const m of held) lines.push(formatHeldLine(m, mailboxId));
      mark.held = [];
    }
    if (changed) this.writeWatermarkFile(slug, file);
    return lines;
  }

  // ------------------------------------------------------- health/backoff

  /** What the Connectors screen shows per mailbox: last good poll, last error, failures in a row. */
  health(mailboxId: string): { last_ok_at: string | null; last_error: string | null; failures: number } {
    return {
      last_ok_at: this.lastOkAt.get(mailboxId) ?? null,
      last_error: (this.consecutiveFailures.get(mailboxId) ?? 0) > 0 ? (this.lastError.get(mailboxId) ?? null) : null,
      failures: this.consecutiveFailures.get(mailboxId) ?? 0,
    };
  }

  private noteFailure(mailboxId: string, err: unknown): void {
    this.lastError.set(mailboxId, describe(err));
    const n = (this.consecutiveFailures.get(mailboxId) ?? 0) + 1;
    this.consecutiveFailures.set(mailboxId, n);
    if (n === FAILURES_BEFORE_BACKOFF) {
      console.error(
        `[mailwatch] !! graph-mail (${mailboxId}) has failed ${n} times in a row — ` +
          `Last error: ${describe(err)}. Check that mailbox's token cache — its mail triggers are NOT firing.`,
      );
      // back off the shared cadence only when EVERY mailbox is failing
      if (!this.backingOff && this.config.mailboxes.every((id) => (this.consecutiveFailures.get(id) ?? 0) >= FAILURES_BEFORE_BACKOFF)) {
        this.backingOff = true;
        console.error(`[mailwatch] all mailboxes failing — backing off to ${BACKOFF_MINUTES}m ticks until one recovers.`);
        this.scheduleNext();
      }
    } else if (n < FAILURES_BEFORE_BACKOFF) {
      console.error(`[mailwatch] graph-mail (${mailboxId}) failed: ${describe(err)} — skipping tick`);
    }
    // beyond the threshold we stay quiet; the loud line above already said it
  }

  private noteSuccess(mailboxId: string): void {
    this.consecutiveFailures.set(mailboxId, 0);
    this.lastOkAt.set(mailboxId, new Date().toISOString());
    if (this.backingOff) {
      console.log(`[mailwatch] graph-mail (${mailboxId}) recovered — back to ${this.config.mail_poll_minutes}m ticks`);
      this.backingOff = false;
      this.scheduleNext();
    }
  }

  // ------------------------------------------------------------ storage

  private watermarkPath(slug: string): string {
    return path.join(this.home, slug, "mailwatch.json");
  }

  readWatermarkFile(slug: string): WatermarkFile {
    const file = this.watermarkPath(slug);
    try {
      if (!fs.existsSync(file)) return emptyWatermarkFile();
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WatermarkFile>;
      if (!parsed || typeof parsed !== "object" || !parsed.mailboxes) return emptyWatermarkFile();
      return { version: 1, mailboxes: parsed.mailboxes };
    } catch (err) {
      // A corrupt watermark must not wedge the poller: start a fresh baseline.
      console.error(`[mailwatch] unreadable watermark for ${slug}, resetting: ${describe(err)}`);
      return emptyWatermarkFile();
    }
  }

  writeWatermarkFile(slug: string, data: WatermarkFile): void {
    const file = this.watermarkPath(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string; code?: number | string };
    const stderr = typeof withStderr.stderr === "string" ? withStderr.stderr.trim().slice(0, 300) : "";
    return stderr ? `${err.message} | ${stderr}` : err.message;
  }
  return String(err);
}
