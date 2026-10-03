/**
 * The deterministic heart. No LLM calls happen directly here — judgment calls
 * are delegated to advisor.ts (idle-priority) and standup.ts (morning
 * digest), both injectable for tests, same as engine.ts is for intern runs.
 *
 * Invariants:
 *  - at most one running task per intern; different interns run concurrently
 *  - every task transition goes through Db.markTask
 *  - heartbeat is idempotent: re-running it never double-enqueues
 */
import { randomUUID } from "node:crypto";
import { adviseIdlePriority, type AdvisorVerdict } from "./advisor.js";
import { localDate } from "./agenda.js";
import { cronMatches } from "./schedules.js";
import { coordinatorName, ownerName } from "./profile.js";
import { quickRepliesFence } from "./fences.js";
import type { Config } from "./config.js";
import { OVER_BUDGET, type Db } from "./db.js";
import type { Engine } from "./engine.js";
import { CapExceededError } from "./engine.js";
import type { Registry } from "./registry.js";
import { groupAliases, isRoomKey, MAX_MENTION_HOPS, resolveMentions, type DirectoryEntry } from "./mentions.js";
import { chooseResponders, type ChooseRespondersFn } from "./responders.js";
import { applyHardRules } from "./rules.js";
import { standup, stripRichBlocks } from "./standup.js";
import { runSuggestions, type ProposeFn } from "./suggest.js";
import { todayUtc, type InternManifest, type Message, type Room, type Task } from "./types.js";

/** Narrow slice of MailWatcher the orchestrator needs — avoids a hard dependency. */
export interface HeldMailDrainer {
  drainHeld(slug: string): string[];
}

/** Narrow slice of DiscordAdapter the orchestrator needs for standup delivery — avoids a hard dependency. */
export interface OfficePoster {
  postToOffice(text: string): Promise<void>;
}

/** Narrow slice of PushService the orchestrator needs for standup delivery — avoids a hard dependency. */
export interface PushNotifier {
  notify(payload: { title: string; body: string; url: string; tag: string }): Promise<unknown>;
}

/** Idle-priority judgment call — see advisor.ts. Injectable so tests never make a real LLM call. */
export type AdviseFn = (
  intern: { name: string; role: string },
  backlog: string[],
  recentMessages: Message[],
  openCardCount: number,
  now: Date,
  db: Db,
) => Promise<AdvisorVerdict>;

/** Morning-standup digest builder — see standup.ts. Injectable so tests never make a real LLM call. */
export type StandupFn = (db: Db) => Promise<string>;

interface TaskAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  path: string;
  caption: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The coordinator's own chat: JP's front desk (docs/features/06-coordinator-chat-ideas.md). */
export const FRONT_DESK = "coordinator";

/** An intern may decline to speak ("(nothing)"); these replies are dropped rather than posted, in any thread. */
export function isSilentReply(text: string, strict = false): boolean {
  const t = text.trim();
  if (t === "") return true;
  // In the owner's own 1:1 thread "Nothing." can be a real answer ("anything from Kettle Labs?"):
  // there only the bracketed marker the prompt asks for counts as silence.
  if (strict) return /^\(\s*(nothing|no reply|nothing to add|pass)\s*\.?\)\.?$/i.test(t);
  return /^\(?\s*(nothing|no reply|nothing to add|pass)\s*\.?\)?\.?$/i.test(t);
}

/** intern-attach prints `[attachment:<id>]`; an intern that echoes it into prose gets it cleaned. */
export function stripAttachmentMarkers(text: string): string {
  return text.replace(/\s*\[attachment:[0-9a-f-]{8,}\]\s*/gi, " ").replace(/[ \t]+\n/g, "\n").trim();
}

/** Whether other interns' @mentions wake this intern (triggers.mentions, on unless set false; never while paused). */
export function takesMentions(manifest: InternManifest | undefined): boolean {
  return Boolean(manifest) && !manifest!.paused && manifest!.triggers.mentions !== false;
}

/** JP wrote to this intern himself (their 1:1, or named them) — the only work a paused intern takes. */
export function fromJpDirectly(task: Task): boolean {
  return task.kind === "message" && (task.payload.from === undefined || task.payload.from === "jp");
}

/** 41230 → "41k", 1500000 → "1.5M" (the app's shortTokens). */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** What a task held at the token limit was going to do, in JP's words. */
export function heldWorkLabel(task: Task): string {
  const p = task.payload;
  if (task.kind === "message") return typeof p.thread === "string" && p.thread !== task.intern ? "a message in a group" : "your message";
  if (task.kind === "scheduled") return "my scheduled run";
  if (task.kind === "backlog") return typeof p.item === "string" ? `“${p.item.slice(0, 80)}”` : "my standing work";
  if (p.kind === "new_mail") return "new mail";
  if (p.kind === "meeting_brief") return "a meeting brief";
  if (p.type === "github_pull_request") return "a pull request review";
  return "a task";
}

// Crons are matched on the owner's wall clock (schedules.ts).
export { cronMatches } from "./schedules.js";

// ------------------------------------------------------------ orchestrator

export class Orchestrator {
  private running = new Set<string>(); // intern slugs with an in-flight task
  private abortControllers = new Map<string, AbortController>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private lastCronMinute = ""; // guard against double-firing within a minute
  private stopped = false;
  /** room responder pre-check — replaceable so tests never make a real LLM call */
  chooseRespondersFn: ChooseRespondersFn = chooseResponders;
  /** weekly suggestions: proposal call, replaceable for tests; `home` for the memory file */
  proposeFn: ProposeFn | undefined = undefined;
  suggestHome: string | undefined = undefined;

  constructor(
    private db: Db,
    private registry: Registry,
    private engine: Engine,
    private config: Config,
    /** optional: lets scheduled (cron) tasks for mail_push interns carry a "Held since last run" digest */
    private mailwatch?: HeldMailDrainer,
    /** optional: standup_cron delivery surface #1 (#office channel) */
    private discord?: OfficePoster,
    /** optional: standup_cron delivery surface #2 (web push) */
    private push?: PushNotifier,
    /** optional override for tests — defaults to the real advisor.ts LLM call */
    private adviseFn: AdviseFn = adviseIdlePriority,
    /** optional override for tests — defaults to the real standup.ts LLM call */
    private standupFn: StandupFn = (db) => standup(db, { easterEggs: config.standup_easter_eggs }),
  ) {}

  start(): void {
    this.stopped = false;
    // Recover: tasks left 'running' by a previous crash are re-queued once.
    for (const task of this.db.staleRunningTasks(0)) {
      this.db.markTask(task.id, "failed", "orphaned by restart");
      this.db.enqueueTask(task.intern, task.kind, task.payload);
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.config.heartbeat_minutes * 60_000);
    this.pumpTimer = setInterval(() => void this.pump(), 2_000);
    void this.heartbeat();
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    // in-flight engine runs finish on their own; nothing new starts
  }

  // ------------------------------------------------------------- worker

  /** Start the oldest queued task for every idle intern. Concurrent across interns. */
  async pump(): Promise<void> {
    if (this.stopped) return;
    for (const task of this.db.nextQueuedTasks()) {
      if (this.running.has(task.intern)) continue; // one task per intern at a time
      this.running.add(task.intern);
      void this.runTask(task).finally(() => this.running.delete(task.intern));
    }
  }

  /** Drain the queue synchronously (used by tests): pump until nothing is queued or running. */
  async drain(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queued = this.db.nextQueuedTasks().filter((t) => !this.running.has(t.intern));
      if (queued.length === 0 && this.running.size === 0) return;
      await this.pump();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  pauseTask(id: string): Task {
    const task = this.db.getTask(id);
    if (!task || (task.status !== "running" && task.status !== "queued")) throw new Error("task is no longer active");
    this.db.markTask(id, "paused");
    this.abortControllers.get(id)?.abort();
    return this.db.getTask(id)!;
  }

  resumeTask(id: string): Task {
    const task = this.db.getTask(id);
    if (!task || task.status !== "paused") throw new Error("task is not paused");
    this.db.markTask(id, "queued");
    void this.pump();
    return this.db.getTask(id)!;
  }

  cancelTask(id: string): Task {
    const task = this.db.getTask(id);
    if (!task || !["running", "queued", "paused"].includes(task.status)) throw new Error("task is no longer active");
    this.db.markTask(id, "cancelled", `cancelled by ${ownerName()}`);
    this.abortControllers.get(id)?.abort();
    return this.db.getTask(id)!;
  }

  prioritizeTask(id: string): Task {
    const task = this.db.prioritizeTask(id);
    if (!task) throw new Error("only active tasks can be prioritized");
    void this.pump();
    return task;
  }

  private async runTask(task: Task): Promise<void> {
    // A paused intern only answers JP himself; everything automatic is dropped.
    if (this.registry.get(task.intern)?.paused && !fromJpDirectly(task)) {
      this.db.markTask(task.id, "cancelled", "intern paused");
      console.log(`[pause] ${task.intern}: dropped ${task.kind} task ${task.id}`);
      return;
    }
    // Standing orders: muted work never reaches the intern (rules.ts). A
    // dropped task leaves no message — the rule's hit counter is the trace.
    const verdict = applyHardRules(this.db, task);
    for (const hold of verdict.holds ?? []) this.db.addHold({ intern: task.intern, ...hold });
    if (verdict.drop) {
      this.db.markTask(task.id, "cancelled", verdict.reason ?? "standing order");
      console.log(`[rules] ${task.intern}: dropped ${task.kind} task ${task.id} — ${verdict.reason}`);
      return;
    }
    const effective: Task = verdict.payload ? { ...task, payload: verdict.payload } : task;
    this.db.markTask(task.id, "running");
    if (effective.payload.kind === "meeting_brief") this.recordBrief(effective);
    const abort = new AbortController();
    this.abortControllers.set(task.id, abort);
    try {
      const input = this.taskPrompt(effective);
      const result = await this.engine.runIntern(task.intern, input, { abort });
      this.db.recordRunSpend({
        intern: task.intern,
        thread: typeof task.payload.thread === "string" ? task.payload.thread : task.kind === "message" ? task.intern : null,
        taskId: task.id,
        kind: "run",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });
      if (this.db.getTask(task.id)?.status !== "running") return;
      if (!result.ok) {
        this.db.markTask(task.id, "failed", result.error ?? "unknown engine error");
        return;
      }
      const startedAt = this.db.getTask(task.id)?.started_at ?? task.created_at;
      const text = stripAttachmentMarkers(result.text);
      const thread = typeof task.payload.thread === "string" ? task.payload.thread : task.intern;
      const shared = thread !== task.intern; // a room, a handoff into another intern's thread, or the front desk
      const hasOrphans = this.db
        .listAttachments(task.intern, 50)
        .some((a) => a.author === "intern" && !a.message_id && a.created_at >= startedAt);
      // Pages/rules the intern created or showed during this run ride on its reply as fences.
      const announced = this.db.hasPendingAnnouncements(task.intern, startedAt);
      // "(nothing)" is never shown, in any thread — Rhea's 1:1 used to get it verbatim.
      const silent = isSilentReply(text, !shared);
      if (!silent || hasOrphans || announced) {
        // A routed reply answers the message that triggered it — the thread structure inside a room.
        const replyTo = shared && typeof task.payload.reply_to === "string" ? task.payload.reply_to : null;
        const id = randomUUID();
        const fences = this.db.claimAnnouncements(task.intern, startedAt, id);
        const body = [silent ? "" : text, ...fences.map((f) => f.fence)].filter(Boolean).join("\n\n");
        // Why they spoke decides whether it buzzes now or waits for JP's summary (notify.ts).
        const cause = /```quick-replies\b/.test(body) ? "ask" : fromJpDirectly(task) ? "reply" : "work";
        const message = this.db.addMessage({ id, intern: thread, author: "intern", speaker: task.intern, reply_to: replyTo, text: body, surface: "system", cause });
        if (isRoomKey(thread)) this.db.touchRoom(thread);
        for (const f of fences) {
          // A page first shown somewhere other than its owner's thread is listed with that thread too.
          const page = f.page_id ? this.db.getPage(f.page_id) : undefined;
          if (page && page.thread_key === page.intern && thread !== page.intern) this.db.setPageThread(page.id, thread);
        }
        // Files the intern uploaded (intern-attach) during this run belong to this reply.
        const linked = this.db.linkOrphanInternAttachments(task.intern, startedAt, message.id);
        if (linked.length) this.db.emitMessage(message.id);
        // A pre-meeting brief is filed under its meeting on JP's Today schedule.
        if (effective.payload.kind === "meeting_brief" && !silent) {
          const brief = this.db.linkMeetingBriefMessage(task.id, message.id);
          if (brief) this.db.notifyAgenda(localDate(new Date(brief.start_at)));
        }
        // @mentions in the reply pull other interns into the same thread, hop-limited.
        const depth = Number(task.payload.depth ?? 0) + 1;
        if (!silent) this.routeMentions(thread, task.intern, text, depth, message.id);
      }
      this.db.markTask(task.id, "done");
    } catch (err) {
      if (this.db.getTask(task.id)?.status !== "running") return;
      if (err instanceof CapExceededError) {
        // Out of tokens for today: set the work aside and ask JP for more.
        this.db.markTask(task.id, "paused", OVER_BUDGET);
        this.askForBudget(task.intern, err.used);
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.db.markTask(task.id, "failed", reason);
      this.db.createCard({
        intern: "coordinator",
        title: `Task failed for ${task.intern}`,
        body: `\`${task.kind}\` task \`${task.id}\` failed:\n> ${reason}`,
        severity: "action",
        actions: [
          { id: "retry", label: "Retry", style: "primary", kind: "button" },
          { id: "drop", label: "Drop", style: "neutral", kind: "button" },
        ],
      });
    } finally {
      if (this.abortControllers.get(task.id) === abort) this.abortControllers.delete(task.id);
    }
  }

  /**
   * The intern hit today's token limit: one card from them (per day) asking
   * to go over it. "Double it" adds their normal limit again for today and
   * resumes the held work (approvals.ts); "Not today" leaves it for the
   * next UTC day, when the heartbeat releases it.
   */
  private askForBudget(slug: string, used: number): void {
    const manifest = this.registry.get(slug);
    if (!manifest) return;
    const day = todayUtc();
    // Ask once at a time, and not again today after "Not today".
    const asked = this.db
      .listCards()
      .some((c) => c.intern === slug && c.context.kind === "budget" && c.context.day === day && (c.state === "open" || c.resolution?.action === "not_today"));
    if (asked) return;
    const base = manifest.guardrails.daily_token_cap;
    const extended = this.db.budgetExtra(slug, day) > 0;
    const held = this.db.budgetHeldTasks(slug);
    const waiting = [...new Set(held.map(heldWorkLabel))];
    const list = waiting.length === 1 ? waiting[0] : `${waiting.slice(0, -1).join(", ")} and ${waiting[waiting.length - 1]}`;
    this.db.createCard({
      intern: slug,
      title: extended ? "Can I go over my limit again today?" : "Can I go over my limit today?",
      body:
        `I've used ${shortTokens(used)} tokens today, which is my limit${extended ? " including what you added" : ""}, so I've stopped. ` +
        `Still waiting: ${list}.

` +
        `${extended ? `Another ${shortTokens(base)}` : `Doubling it (+${shortTokens(base)})`} gets me through today and I'll carry on where I stopped. ` +
        `Otherwise I'll pick it up after midnight UTC (02:00 your time).`,
      severity: "action",
      actions: [
        { id: "extend", label: extended ? `Another ${shortTokens(base)} today` : "Double it for today", style: "primary", kind: "button" },
        { id: "not_today", label: "Not today", style: "neutral", kind: "button" },
      ],
      // approvals.ts applies "extend": +tokens for `day`, then resumes the held work
      context: { kind: "budget", day, tokens: base },
    });
  }

  /**
   * Budget-held work goes back in the queue once there is room again (a new
   * UTC day, or JP raised the limit on the profile); yesterday's open
   * "go over my limit?" cards expire.
   */
  private releaseBudgetHolds(): void {
    const day = todayUtc();
    for (const slug of new Set(this.db.budgetHeldTasks().map((t) => t.intern))) {
      const manifest = this.registry.get(slug);
      if (!manifest) continue;
      const spend = this.db.spendToday(slug);
      if (spend.input_tokens + spend.output_tokens >= manifest.guardrails.daily_token_cap + this.db.budgetExtra(slug, day)) continue;
      console.log(`[budget] ${slug}: room again, resumed ${this.db.releaseBudgetHeld(slug)} task(s)`);
    }
    // The question is moot once nothing waits on it, or the day it was about is over.
    for (const card of this.db.listCards("open")) {
      if (card.context.kind !== "budget") continue;
      if (card.context.day !== day || this.db.budgetHeldTasks(card.intern).length === 0) {
        this.db.resolveCard(card.id, { via: "app", action: "expired" }, "expired");
      }
    }
  }

  /** Remember which meeting a brief task is for, so its reply can be filed under the meeting. */
  private recordBrief(task: Task): void {
    const event = task.payload.event as { id?: string; start?: { iso?: string | null }; end?: { iso?: string | null } } | undefined;
    if (!event?.id || !event.start?.iso) return;
    this.db.recordMeetingBrief({
      event_id: event.id,
      intern: task.intern,
      event: event as Record<string, unknown>,
      start_at: event.start.iso,
      end_at: event.end?.iso ?? event.start.iso,
      task_id: task.id,
    });
  }

  /** Names for prompts and mention resolution: every active intern. */
  private directory(): DirectoryEntry[] {
    return this.registry.list().map(({ slug, manifest }) => ({ slug, name: manifest.name }));
  }

  private displayName(slug: string): string {
    if (slug === "jp") return ownerName();
    if (slug === "coordinator") return coordinatorName();
    return this.registry.get(slug)?.name ?? slug;
  }

  /**
   * Turn @mentions in a message into tasks for the mentioned interns, each
   * carrying the thread so the reply lands where the conversation is. In a
   * room only members can be pulled in; in a 1:1 thread any intern can be
   * handed a question. `depth` counts intern→intern hops since JP last
   * spoke; past MAX_MENTION_HOPS the chain stops and nothing is enqueued.
   */
  routeMentions(thread: string, from: string, text: string, depth: number, replyTo: string | null = null): string[] {
    if (depth > MAX_MENTION_HOPS) {
      console.log(`[mentions] hop limit reached in ${thread} (from ${from}); not routing further`);
      return [];
    }
    const room = isRoomKey(thread) ? this.db.getRoom(thread) : undefined;
    const directory = this.directory().filter((e) => !room || room.members.includes(e.slug));
    const { slugs } = resolveMentions(text, directory);
    // JP's own @mentions always reach them; another intern's only if they take mentions and aren't paused.
    const targets = slugs.filter((slug) => slug !== from && slug !== thread && (from === "jp" || takesMentions(this.registry.get(slug))));
    for (const slug of targets) {
      this.db.enqueueTask(slug, "message", {
        text,
        thread,
        from,
        depth,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(room ? { room: { id: room.id, name: room.name, members: room.members } } : {}),
      });
    }
    return targets;
  }

  /**
   * JP posted in a room. Who replies:
   *  - `@Name` → exactly those members;
   *  - `@all` / `@everyone` / `@<room name>` → every member;
   *  - no mention → a cheap responder pre-check (responders.ts) picks the
   *    fewest members who can answer; if that call fails, everyone is asked
   *    (and may stay silent), so a message never goes unanswered.
   * Also used for 1:1 threads, where a mention of another intern hands them
   * the question in place.
   */
  async fanOutFromJp(thread: string, text: string, extra: Record<string, unknown> = {}): Promise<string[]> {
    if (thread === FRONT_DESK) return this.routeFrontDesk(text, extra);
    const room = isRoomKey(thread) ? this.db.getRoom(thread) : undefined;
    if (room) {
      const live = room.members.filter((m) => this.registry.get(m));
      // Paused members answer only when JP @mentions them by name.
      const awake = live.filter((m) => !this.registry.get(m)?.paused);
      const directory = this.directory().filter((e) => live.includes(e.slug));
      const awakeDirectory = directory.filter((e) => awake.includes(e.slug));
      const { slugs, everyone } = resolveMentions(text, directory, groupAliases(room.name));
      let targets: string[];
      let how: string;
      if (everyone) {
        targets = awake;
        how = "everyone (explicit)";
      } else if (slugs.length) {
        targets = slugs;
        how = "mentioned";
      } else if (this.config.room_responder_precheck && awake.length > 1) {
        try {
          const verdict = await this.chooseRespondersFn(
            { id: room.id, name: room.name, topic: room.topic, members: awakeDirectory.map((e) => ({ ...e, role: this.registry.get(e.slug)?.role ?? "" })) },
            text,
            this.db.listMessages(thread, 10),
            (slug) => this.displayName(slug),
            this.db,
          );
          targets = verdict.responders.filter((s) => awake.includes(s));
          how = `pre-check: ${verdict.reason || "no reason"}`;
        } catch (err) {
          console.error(`[responders] pre-check failed for ${room.name}, asking everyone:`, err);
          targets = awake;
          how = "everyone (pre-check failed)";
        }
      } else {
        targets = awake;
        how = "everyone";
      }
      console.log(`[room] ${room.name}: ${targets.length ? targets.join(", ") : "nobody"} — ${how}`);
      for (const slug of targets) {
        this.db.enqueueTask(slug, "message", { text, thread, from: "jp", depth: 0, room: { id: room.id, name: room.name, members: room.members }, ...extra });
      }
      this.db.touchRoom(room.id);
      return targets;
    }
    // 1:1 thread: the owner always gets it; anyone else JP mentions is pulled in too.
    const { slugs } = resolveMentions(text, this.directory());
    const others = slugs.filter((slug) => slug !== thread);
    this.db.enqueueTask(thread, "message", { text, ...extra });
    for (const slug of others) this.db.enqueueTask(slug, "message", { text, thread, from: "jp", depth: 0, ...extra });
    return [thread, ...others];
  }

  /**
   * JP wrote in the coordinator's chat — the front desk. The coordinator
   * never does the work; it picks ONE intern to answer in this thread:
   *  - replying to an intern's message keeps that intern;
   *  - answering "who should take this?" routes the original question;
   *  - an @mention picks those interns;
   *  - otherwise the room responder pre-check chooses, with the whole crew
   *    as members. If it cannot decide (or fails), the coordinator asks one
   *    short question with the interns as quick replies.
   */
  async routeFrontDesk(text: string, extra: Record<string, unknown> = {}): Promise<string[]> {
    // Routing only picks interns who aren't paused; naming one still reaches them.
    const crew = this.registry.list().filter((c) => !c.manifest.paused);
    const live = new Set(this.registry.list().map((c) => c.slug));
    const directory = this.directory();
    const quoted = extra.quoted as { id?: string; author?: string; speaker?: string | null } | undefined;
    const enqueue = (slug: string, question: string) => {
      this.db.enqueueTask(slug, "message", { text: question, thread: FRONT_DESK, from: "jp", depth: 0, ...extra });
      return [slug];
    };

    if (quoted?.id) {
      const pending = this.db.getKv(`clarify:${quoted.id}`);
      if (pending) {
        const picked = resolveMentions(`@${text.trim().replace(/^@/, "").split(/\s+/)[0]}`, directory).slugs[0];
        if (picked) {
          this.db.setKv(`clarify:${quoted.id}`, "");
          const original = (JSON.parse(pending) as { text?: string }).text ?? text;
          return enqueue(picked, original);
        }
      }
      if (quoted.author === "intern" && quoted.speaker && live.has(quoted.speaker)) return enqueue(quoted.speaker, text);
    }

    const { slugs } = resolveMentions(text, directory);
    if (slugs.length) {
      for (const slug of slugs) enqueue(slug, text);
      return slugs;
    }

    let choice: string | undefined;
    let how = "";
    if (crew.length === 1) {
      choice = crew[0]!.slug;
      how = "only intern";
    } else if (crew.length > 1) {
      try {
        const verdict = await this.chooseRespondersFn(
          {
            id: FRONT_DESK,
            name: "Front desk",
            topic: `${ownerName()}'s front desk. Route each message to the ONE colleague best placed to answer it; pick nobody only if it is genuinely unclear.`,
            members: directory.filter((e) => crew.some((c) => c.slug === e.slug)).map((e) => ({ ...e, role: this.registry.get(e.slug)?.role ?? "" })),
          },
          text,
          this.db.listMessages(FRONT_DESK, 10),
          (slug) => this.displayName(slug),
          this.db,
        );
        choice = verdict.responders.find((s) => crew.some((c) => c.slug === s));
        how = `pre-check: ${verdict.reason || "no reason"}`;
      } catch (err) {
        console.error("[front desk] pre-check failed:", err);
        how = "pre-check failed";
      }
    }
    console.log(`[front desk] ${choice ?? "nobody"} — ${how}`);
    if (choice) return enqueue(choice, text);

    const ask = this.db.addMessage({
      intern: FRONT_DESK,
      author: "coordinator",
      text: `Who should take this one?\n\n${quickRepliesFence(crew.slice(0, 6).map((c) => c.manifest.name))}`,
      surface: "system",
      reply_to: typeof extra.reply_to === "string" ? extra.reply_to : null,
    });
    this.db.setKv(`clarify:${ask.id}`, JSON.stringify({ text }));
    return [];
  }

  private transcript(thread: string, limit = 14): string {
    return this.db
      .listMessages(thread, limit)
      .map((m) => {
        const who = m.author === "jp" ? ownerName() : m.author === "coordinator" ? coordinatorName() : this.displayName(m.speaker ?? m.intern);
        const files = m.attachments.length ? ` [${m.attachments.length} file${m.attachments.length === 1 ? "" : "s"} attached]` : "";
        return `[${who}]: ${m.text.replace(/\s+/g, " ").slice(0, 600)}${files}`;
      })
      .join("\n");
  }

  private taskPrompt(task: Task): string {
    switch (task.kind) {
      case "message": {
        const text = String(task.payload.text ?? "");
        const files = Array.isArray(task.payload.attachments) ? (task.payload.attachments as TaskAttachment[]) : [];
        const filesBlock = files.length
          ? `\n\nAttached ${files.length} file${files.length === 1 ? "" : "s"} — read them from disk:\n` +
            files.map((f) => `- ${f.path} (${f.mime}, ${formatBytes(f.size)}${f.caption ? `, caption: ${f.caption}` : ""})`).join("\n")
          : "";
        const context = this.messageContext(task);
        const thread = typeof task.payload.thread === "string" ? task.payload.thread : task.intern;
        if (thread === task.intern) return `${context}${text || "(no text)"}${filesBlock}`;
        if (thread === FRONT_DESK) {
          const from = String(task.payload.from ?? "jp");
          return [
            from === "jp"
              ? `${ownerName()} wrote in the front desk (the ${coordinatorName()}'s chat), and it was routed to you (${this.displayName(task.intern)}). Answer ${ownerName()} there directly.`
              : `You (${this.displayName(task.intern)}) are in the front desk (the ${coordinatorName()}'s chat with ${ownerName()}); ${this.displayName(from)} mentioned you there.`,
            `Recent conversation:`,
            this.transcript(thread),
            ``,
            from === "jp"
              ? `${context}${ownerName()} just said: ${text || "(no text)"}${filesBlock}`
              : `${this.displayName(from)} just said, mentioning you: ${text || "(no text)"}${filesBlock}\n\nReply in your own voice; if you have nothing useful to add, reply with exactly: (nothing)`,
          ].join("\n");
        }
        // Shared thread: a room, or a handoff into another intern's 1:1 thread with JP.
        const from = String(task.payload.from ?? "jp");
        const me = this.displayName(task.intern);
        const roomInfo = task.payload.room as Room | undefined;
        const others = roomInfo
          ? roomInfo.members.filter((m) => m !== task.intern).map((m) => this.displayName(m))
          : [this.displayName(thread)];
        const where = roomInfo
          ? `the group chat "${roomInfo.name}" with ${ownerName()} and ${others.join(", ") || "nobody else"}`
          : `${ownerName()}'s 1:1 thread with ${this.displayName(thread)}`;
        const liveRoom = roomInfo ? this.db.getRoom(roomInfo.id) : undefined;
        const topic = liveRoom?.topic ?? "";
        const pad = liveRoom?.scratchpad?.trim() ?? "";
        return [
          `You (${me}) are in ${where}.${topic ? ` Standing brief: ${topic}` : ""}${roomInfo ? ` Room id: ${roomInfo.id}` : ""}`,
          ...(pad ? [`Shared scratchpad (room-pad --room ${roomInfo!.id} append/set to change it):\n${pad.slice(0, 3000)}`, ``] : []),
          `Recent conversation:`,
          this.transcript(thread),
          ``,
          `${from === "jp" ? context : ""}${this.displayName(from)} just said${from === "jp" ? "" : ", mentioning you"}: ${text || "(no text)"}${filesBlock}`,
          ``,
          `Reply as ${me}, in your own voice, to the group — do not repeat what others already said. ` +
            `Address a colleague with @Name to bring them in (only when you actually need them). ` +
            `If you have nothing useful to add, reply with exactly: (nothing)`,
        ].join("\n");
      }
      case "backlog":
        return `Work on this standing backlog item now and report what you did:\n${String(task.payload.item ?? "")}`;
      case "scheduled": {
        const held = Array.isArray(task.payload.held) ? (task.payload.held as unknown[]).map(String) : [];
        const heldBlock =
          held.length > 0 ? `\n\nHeld since last run (${held.length}, quiet mail — skim only):\n${held.join("\n")}` : "";
        return `Your scheduled trigger fired (${String(task.payload.cron ?? "")}). Do your routine work and report.${heldBlock}`;
      }
      case "trigger": {
        const base = `An external trigger fired: ${JSON.stringify(task.payload)}. Handle it.`;
        if (task.payload.kind !== "meeting_brief") return base;
        return (
          `${base}\n\nThis is a pre-meeting brief. Your reply IS the brief: it is filed under this meeting on ${ownerName()}'s Today ` +
          `schedule, where ${ownerName()} expands it at a glance — lead with what matters, keep it short. Do not raise a card for the ` +
          `brief itself; raise one only if ${ownerName()} must decide or do something before the meeting starts.`
        );
      }
    }
  }

  /**
   * What JP's message is answering, spelled out for the intern: a swipe-reply
   * quote, or the answer to a debrief question (with the meeting attached and
   * a request for a next-steps checklist).
   */
  private messageContext(task: Task): string {
    const debrief = task.payload.debrief as { subject?: string; start?: { local?: string | null }; attendees?: { name?: string | null; email?: string | null }[] } | undefined;
    if (debrief) {
      const who = (debrief.attendees ?? []).map((a) => a.name || a.email).filter(Boolean).slice(0, 6).join(", ");
      return (
        `${ownerName()} is answering your debrief question about the meeting "${debrief.subject ?? "?"}"` +
        `${debrief.start?.local ? ` (${debrief.start.local.slice(0, 16).replace("T", " ")})` : ""}${who ? ` with ${who}` : ""}.\n` +
        `Update what you track (people pages, follow-ups, memory) from the answer, then propose next steps as a checklist ` +
        `block ${ownerName()} can tick and submit — see "Checklists" in your instructions. Keep it to what is genuinely useful.\n\n${ownerName()}: `
      );
    }
    const quoted = task.payload.quoted as { author?: string; speaker?: string | null; text?: string } | undefined;
    if (quoted?.text) {
      const who = quoted.author === "jp" ? "their own earlier message" : quoted.speaker === task.intern ? "your earlier message" : `${this.displayName(quoted.speaker ?? "coordinator")}'s message`;
      return `(${ownerName()} is replying to ${who}: "${quoted.text.replace(/\s+/g, " ").slice(0, 400)}")\n`;
    }
    return "";
  }

  // ---------------------------------------------------------- heartbeat

  async heartbeat(): Promise<void> {
    if (this.stopped) return;
    const now = new Date();

    // 1. cron triggers — fire at most once per matching minute
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey !== this.lastCronMinute) {
      this.lastCronMinute = minuteKey;
      for (const { slug, manifest } of this.registry.list()) {
        const cron = manifest.triggers.cron;
        if (cron && !manifest.paused && cronMatches(cron, now) && !this.hasPending(slug)) {
          const payload: Record<string, unknown> = { cron };
          if (manifest.triggers.mail_push && this.mailwatch) {
            const held = this.mailwatch.drainHeld(slug);
            if (held.length > 0) payload.held = held;
          }
          this.db.enqueueTask(slug, "scheduled", payload);
        }
      }
      if (cronMatches(this.config.standup_cron, now)) {
        await this.runStandup();
      }
      if (this.config.suggest_enabled && this.suggestHome && cronMatches(this.config.suggest_cron, now)) {
        try {
          const result = await runSuggestions({ db: this.db, registry: this.registry, home: this.suggestHome, proposeFn: this.proposeFn });
          if (this.push && result.cards.length) {
            await this.push.notify({
              title: `${coordinatorName()} has a suggestion`,
              body: result.cards.map((c) => c.title).join(" · "),
              url: "/inbox",
              tag: "suggestions",
            });
          }
        } catch (err) {
          console.error("[suggest] weekly pass failed:", err);
        }
      }
    }

    // 1b. held work (hold_until standing orders) whose date has come → back to its intern
    for (const hold of this.db.takeDueHolds(localDate(now), (intern) => this.registry.get(intern)?.paused === true)) {
      if (!this.registry.get(hold.intern)) continue;
      this.db.enqueueTask(hold.intern, "trigger", { ...hold.payload, released_hold: `held until ${hold.until} by your standing order: ${hold.rule}` });
    }

    // 1c. work held at the daily limit → back in the queue once there is room
    this.releaseBudgetHolds();

    // 2. stale running tasks → fail them and tell JP
    for (const task of this.db.staleRunningTasks(this.config.stale_task_minutes)) {
      this.db.markTask(task.id, "failed", `stale: running > ${this.config.stale_task_minutes}m`);
      this.running.delete(task.intern);
      this.db.createCard({
        intern: "coordinator",
        title: `Stale task killed (${task.intern})`,
        body: `A \`${task.kind}\` task ran past ${this.config.stale_task_minutes} minutes and was marked failed.`,
        severity: "action",
        actions: [{ id: "ack", label: "OK", style: "neutral", kind: "button" }],
      });
    }

    // 3. idle interns with a backlog → enqueue the advised item (cooldown-gated)
    for (const { slug, manifest } of this.registry.list()) {
      if (manifest.paused || manifest.backlog.length === 0 || this.hasPending(slug)) continue;
      const last = this.db.lastFinishedAt(slug, "backlog");
      if (last && Date.now() - Date.parse(last) < this.config.backlog_cooldown_minutes * 60_000) continue;
      const item = await this.advise(slug, manifest);
      if (item) this.db.enqueueTask(slug, "backlog", { item });
    }

    await this.pump();
  }

  private hasPending(slug: string): boolean {
    return (
      this.running.has(slug) ||
      this.db.countTasks(slug, "queued") > 0 ||
      this.db.countTasks(slug, "running") > 0 ||
      this.db.budgetHeldTasks(slug).length > 0
    );
  }

  /**
   * Idle-priority hook: a cheap LLM judgment call (advisor.ts) picks the
   * single best backlog item for an idle intern right now, or null ("stay
   * idle"). Side-effect free besides the advisor's own spend recording — the
   * orchestrator remains the only thing that enqueues. Fails closed to the
   * old FIFO behaviour (backlog[0]) on any advisor error, or when
   * config.idle_advisor is off.
   */
  protected async advise(slug: string, manifest: InternManifest): Promise<string | null> {
    if (!this.config.idle_advisor) return manifest.backlog[0] ?? null;
    try {
      const recentMessages = this.db.listMessages(slug, 5);
      const openCardCount = this.db.listCards("open").filter((c) => c.intern === slug).length;
      const verdict = await this.adviseFn(
        { name: manifest.name, role: manifest.role },
        manifest.backlog,
        recentMessages,
        openCardCount,
        new Date(),
        this.db,
      );
      const item = verdict.choice !== null ? (manifest.backlog[verdict.choice - 1] ?? null) : null;
      console.log(
        `[advisor] ${slug}: choice=${verdict.choice ?? "none"} reason="${verdict.reason}"` +
          (item ? ` item="${item.slice(0, 60)}"` : ""),
      );
      return item;
    } catch (err) {
      console.error(`[advisor] failed for ${slug}, falling back to FIFO:`, err);
      return manifest.backlog[0] ?? null;
    }
  }

  /**
   * standup_cron fired: build the digest (standupFn), record it as a
   * coordinator message (so the app's Coordinator thread shows it), and
   * deliver best-effort to both #office (Discord) and web push. Every step
   * is independently non-fatal — a standup must never crash the heartbeat.
   */
  private async runStandup(): Promise<void> {
    let digest: string;
    try {
      digest = await this.standupFn(this.db);
    } catch (err) {
      console.error("[standup] failed to build digest:", err);
      return;
    }
    const message = this.db.addMessage({ intern: FRONT_DESK, author: "coordinator", text: digest, surface: "system" });
    // Today shows the day's standup (chart included); it is no longer a card
    // JP has to dismiss (docs/features/03-today.md).
    const today = localDate();
    this.db.setKv(`standup:${today}`, message.id);
    this.db.notifyAgenda(today);
    if (this.discord) {
      try {
        await this.discord.postToOffice(stripRichBlocks(digest));
      } catch (err) {
        console.error("[standup] discord delivery failed:", err);
      }
    }
    if (this.push) {
      try {
        await this.push.notify({ title: "Morning standup", body: digest, url: "/today", tag: "standup" });
      } catch (err) {
        console.error("[standup] push delivery failed:", err);
      }
    }
  }
}
