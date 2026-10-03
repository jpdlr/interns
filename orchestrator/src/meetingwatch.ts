/**
 * Meeting watcher — polls the read-only `tools/graph-cal` CLI so an intern
 * can raise a short pre-meeting brief shortly before a real meeting starts.
 *
 * Same shape as mailwatch.ts (self-rescheduling timer, per-intern JSON state
 * file, never throws into the service, graceful stop) but simpler: there is
 * exactly one calendar to poll (`calendar_mailbox`, else the first of
 * `mailboxes`; none configured = nothing to poll), and no
 * batching/triage layers — each qualifying event gets its own trigger task
 * so the intern can brief one meeting at a time.
 *
 * Invariants:
 *  - a Graph/CLI hiccup logs and skips the tick; it never throws into the service
 *  - an event is briefed at most once, ever (tracked in the state file, capped
 *    ring like mailwatch's seen_ids)
 *  - only events that (a) haven't started, (b) aren't all-day, and (c) have at
 *    least one other attendee are ever briefed — see selectMeetingsToBrief
 *  - one trigger task per qualifying event (not batched — mailwatch batches
 *    because mail volume is bursty; meetings are naturally sparse and each
 *    deserves its own focused brief)
 *  - state (briefed ids) lives in ~/.interns/<slug>/meetingwatch.json
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { calendarMailbox, internsHome } from "./config.js";
import { mailboxesFor } from "./mailboxes.js";
import type { Db } from "./db.js";
import { hasExternalAttendee, isExternal, localDate } from "./agenda.js";
import { quickRepliesFence } from "./fences.js";
import type { Registry } from "./registry.js";
import { nowIso } from "./types.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------ tuning

/** How long a single graph-cal invocation may take before we kill it. */
const CLI_TIMEOUT_MS = 60_000;
/** graph-cal prints a JSON array of events; plenty of headroom. */
const CLI_MAX_BUFFER = 4 * 1024 * 1024;
/** Consecutive CLI failures before we shout once and back off. */
const FAILURES_BEFORE_BACKOFF = 3;
/** Slow tick used while the CLI is unhealthy. */
const BACKOFF_MINUTES = 15;
/** Event ids remembered per intern — dedupe window across restarts/clock skew. */
const BRIEFED_IDS_CAP = 200;
/** Extra minutes past the lead time the CLI window asks for, so an event that
 *  crosses the lead threshold mid-tick is already visible on the NEXT tick
 *  rather than only right at the edge. */
const WINDOW_SLACK_MINUTES = 5;
/** A meeting that ended longer ago than this is never debriefed (stale after an outage). */
const DEBRIEF_WINDOW_HOURS = 4;
/** Quick replies on the debrief question; "Skip" closes it without waking the intern. */
export const DEBRIEF_OPTIONS = ["Went well", "Needs follow-up", "Didn't happen", "Skip"];

// ------------------------------------------------------------------- types

/** One event field's {iso, local, timezone} shape — see tools/graph-cal event_fields. */
export interface CalDateTime {
  iso: string | null;
  local: string | null;
  timezone: string | null;
}

/** One attendee/organizer row — see tools/graph-cal _attendee. */
export interface CalAttendee {
  name: string | null;
  email: string | null;
  response_status: string | null;
}

/** Trimmed shape of one graph-cal `next` row (see tools/graph-cal event_fields). */
export interface CalEvent {
  id: string;
  subject: string | null;
  start: CalDateTime;
  end: CalDateTime;
  all_day: boolean;
  location: string | null;
  organizer: CalAttendee | null;
  attendees: CalAttendee[];
  is_online_meeting: boolean;
  web_link: string | null;
  body_preview: string | null;
}

export interface MeetingWatchFile {
  version: 1;
  /** recently briefed event ids, newest first, capped */
  briefed_ids: string[];
  updated_at: string;
}

export function emptyMeetingWatchFile(): MeetingWatchFile {
  return { version: 1, briefed_ids: [], updated_at: nowIso() };
}

// -------------------------------------------------------- selection logic
// Pure, unit-testable without Graph, a db, or a filesystem.

/**
 * Which polled events should be briefed right now.
 *
 * Rules (all must hold):
 *  - never brief the same event id twice (checked against `briefedIds`)
 *  - never brief an all-day block (not a meeting)
 *  - never brief an event with no other attendees (a solo calendar block
 *    isn't a meeting) — attendees empty/missing is skipped
 *  - never brief an event that has already started (start <= now)
 *  - only brief events starting within `leadMinutes` from `now` (events
 *    further out than that are left for a later tick, closer to start time)
 *  - an event with no usable start timestamp is skipped defensively (we'd
 *    rather miss a malformed row than spam a brief with garbage timing)
 */
export function selectMeetingsToBrief(
  events: CalEvent[],
  briefedIds: string[],
  leadMinutes: number,
  now: Date,
): CalEvent[] {
  const seen = new Set(briefedIds);
  const nowMs = now.getTime();
  return events.filter((e) => {
    if (!e.id || seen.has(e.id)) return false;
    if (e.all_day) return false;
    if (!e.attendees || e.attendees.length === 0) return false;
    const startIso = e.start?.iso;
    if (!startIso) return false;
    const startMs = Date.parse(startIso);
    if (Number.isNaN(startMs)) return false;
    if (startMs <= nowMs) return false; // already started
    const minutesUntil = (startMs - nowMs) / 60_000;
    return minutesUntil <= leadMinutes;
  });
}

/** Fold newly-briefed event ids into the capped ring, newest first. */
export function advanceBriefed(briefedIds: string[], newIds: string[]): string[] {
  const merged: string[] = [];
  for (const id of [...newIds, ...briefedIds]) {
    if (!merged.includes(id)) merged.push(id);
    if (merged.length >= BRIEFED_IDS_CAP) break;
  }
  return merged;
}

// ------------------------------------------------------------- formatting

function trim(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function parseDateTime(raw: unknown): CalDateTime {
  if (!raw || typeof raw !== "object") return { iso: null, local: null, timezone: null };
  const r = raw as Record<string, unknown>;
  return {
    iso: typeof r.iso === "string" ? r.iso : null,
    local: typeof r.local === "string" ? r.local : null,
    timezone: typeof r.timezone === "string" ? r.timezone : null,
  };
}

function parseAttendee(raw: unknown): CalAttendee | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    name: trim(r.name, 200),
    email: trim(r.email, 200),
    response_status: trim(r.response_status, 40),
  };
}

/** Defensive parse of graph-cal's JSON — never trust the shape blindly. */
export function parseNextOutput(stdout: string): CalEvent[] {
  const parsed: unknown = JSON.parse(stdout);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
    throw new Error(`graph-cal error: ${String((parsed as { error: unknown }).error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("graph-cal next did not return a JSON array");
  return parsed.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) return [];
    const attendees = Array.isArray(r.attendees) ? r.attendees.flatMap((a) => parseAttendee(a) ?? []) : [];
    return [
      {
        id: r.id,
        subject: trim(r.subject, 300),
        start: parseDateTime(r.start),
        end: parseDateTime(r.end),
        all_day: r.all_day === true,
        location: trim(r.location, 200),
        organizer: parseAttendee(r.organizer),
        attendees,
        is_online_meeting: r.is_online_meeting === true,
        web_link: typeof r.web_link === "string" ? r.web_link : null,
        body_preview: trim(r.body_preview, 400),
      },
    ];
  });
}

/** Compact payload shape for the trigger task — see meeting_brief in orchestrator.taskPrompt. */
export function eventForPayload(e: CalEvent): Record<string, unknown> {
  return {
    id: e.id,
    subject: e.subject,
    start: e.start,
    end: e.end,
    location: e.location,
    organizer: e.organizer,
    attendees: e.attendees,
    is_online_meeting: e.is_online_meeting,
    web_link: e.web_link,
    body_preview: e.body_preview,
  };
}

// ----------------------------------------------------------------- runner

export type CalCliRunner = (args: string[]) => Promise<string>;

function resolveCliPath(): string {
  const override = process.env.INTERNS_GRAPH_CAL;
  if (override) return override;
  // dev runs from src/, built code runs from dist/src/ — try both, then fall
  // back to the repo path so a stack trace names something meaningful.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../tools/graph-cal"),
    path.resolve(here, "../../tools/graph-cal"),
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

// --------------------------------------------------------- MeetingWatcher

export interface MeetingWatcherOptions {
  /** base dir for state files; defaults to INTERNS_HOME */
  home?: string;
  /** injectable CLI for tests */
  runCli?: CalCliRunner;
}

export class MeetingWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private consecutiveFailures = 0;
  private backingOff = false;
  private readonly home: string;
  private readonly runCli: CalCliRunner;

  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
    options: MeetingWatcherOptions = {},
  ) {
    this.home = options.home ?? internsHome();
    this.runCli = options.runCli ?? defaultRunner;
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
    // let an in-flight tick finish so state is never half-written
    while (this.ticking) await new Promise((r) => setTimeout(r, 25));
  }

  /** Minutes between ticks right now (backoff-aware). */
  intervalMinutes(): number {
    return this.backingOff ? BACKOFF_MINUTES : this.config.meeting_poll_minutes;
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
    try {
      const watchers = this.watchingInterns();
      if (watchers.length === 0) return;
      // Debriefs come from briefs already on record — no Graph call needed,
      // so they still go out while graph-cal is failing.
      try {
        this.askDebriefs();
      } catch (err) {
        console.error(`[meetingwatch] debriefs: ${describe(err)}`);
      }

      const leadMinutes = this.config.meeting_brief_lead_minutes;
      const windowMinutes = leadMinutes + WINDOW_SLACK_MINUTES;
      const mailbox = calendarMailbox(this.config);
      if (!mailbox) return;
      let events: CalEvent[];
      try {
        events = parseNextOutput(await this.runCli(["--mailbox", mailbox, "next", "--within-minutes", String(windowMinutes)]));
      } catch (err) {
        this.noteFailure(err);
        return;
      }
      this.noteSuccess();

      for (const slug of watchers) {
        try {
          await this.applyToIntern(slug, events, leadMinutes);
        } catch (err) {
          // one bad intern must not stop the others
          console.error(`[meetingwatch] ${slug}: ${describe(err)}`);
        }
      }
    } catch (err) {
      console.error(`[meetingwatch] tick failed: ${describe(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Interns whose manifest opts into pre-meeting briefing. */
  private watchingInterns(): string[] {
    return this.registry
      .list()
      // ...and may use the calendar's mailbox (manifest.mailboxes, see mailboxes.ts)
      .filter(({ manifest }) => manifest.triggers.meeting_brief === true && !manifest.paused && mailboxesFor(manifest, this.config).includes(calendarMailbox(this.config) ?? ""))
      .map(({ slug }) => slug);
  }

  /** Select, enqueue, persist for one intern. Never throws (caller wraps defensively). */
  private async applyToIntern(slug: string, events: CalEvent[], leadMinutes: number): Promise<void> {
    const file = this.readStateFile(slug);
    const toBrief = selectMeetingsToBrief(events, file.briefed_ids, leadMinutes, new Date());
    if (toBrief.length === 0) return;

    for (const event of toBrief) {
      const task = this.db.enqueueTask(slug, "trigger", { kind: "meeting_brief", event: eventForPayload(event) });
      console.log(`[meetingwatch] ${slug}: briefing "${event.id}" (starts ${event.start.local ?? event.start.iso}) → task ${task.id}`);
    }

    file.briefed_ids = advanceBriefed(file.briefed_ids, toBrief.map((e) => e.id));
    file.updated_at = nowIso();
    this.writeStateFile(slug, file);
  }

  /**
   * After a briefed meeting with someone from outside ends, its intern asks
   * JP once, in its own chat, how it went (docs/features/05-debrief.md).
   * Deterministic — no LLM call; the follow-up checklist is the intern's work
   * when JP answers. Never chased: one question per meeting, and only for
   * meetings that ended within the last few hours (a restart after a long
   * outage does not flood the chat with stale questions).
   */
  askDebriefs(now: Date = new Date()): number {
    const after = this.config.debrief_after_minutes;
    if (!after) return 0;
    const latestEnd = new Date(now.getTime() - after * 60_000).toISOString();
    const earliestEnd = new Date(now.getTime() - DEBRIEF_WINDOW_HOURS * 3_600_000).toISOString();
    let asked = 0;
    for (const brief of this.db.listMeetingBriefs(earliestEnd, latestEnd)) {
      if (brief.end_at > latestEnd || brief.end_at < earliestEnd) continue;
      if (!this.registry.get(brief.intern) || this.registry.get(brief.intern)?.paused) continue;
      const event = brief.event as { subject?: string | null; attendees?: CalAttendee[] };
      if (!hasExternalAttendee(event, this.config.own_domains)) continue;
      if (this.db.getDebrief(brief.event_id, brief.intern)) continue;
      const outsiders = (event.attendees ?? [])
        .filter((a) => isExternal(a.email, this.config.own_domains))
        .map((a) => a.name || a.email)
        .slice(0, 3);
      const subject = (event.subject ?? "the meeting").replace(/\*/g, "");
      const message = this.db.addMessage({
        intern: brief.intern,
        author: "intern",
        speaker: brief.intern,
        text: `How did **${subject}** go?${outsiders.length ? ` (with ${outsiders.join(", ")})` : ""}\n\n${quickRepliesFence(DEBRIEF_OPTIONS)}`,
        surface: "system",
        cause: "ask",
      });
      this.db.createDebrief({ event_id: brief.event_id, intern: brief.intern, message_id: message.id, event: brief.event });
      this.db.notifyAgenda(localDate(new Date(brief.start_at)));
      console.log(`[meetingwatch] ${brief.intern}: asked for a debrief of "${subject}"`);
      asked++;
    }
    return asked;
  }

  // ------------------------------------------------------- health/backoff

  private noteFailure(err: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === FAILURES_BEFORE_BACKOFF) {
      console.error(
        `[meetingwatch] !! graph-cal has failed ${this.consecutiveFailures} times in a row — ` +
          `Last error: ${describe(err)}. Check the calendar mailbox's token cache — meeting briefs are NOT firing.`,
      );
      if (!this.backingOff) {
        this.backingOff = true;
        console.error(`[meetingwatch] graph-cal failing — backing off to ${BACKOFF_MINUTES}m ticks until it recovers.`);
        this.scheduleNext();
      }
    } else if (this.consecutiveFailures < FAILURES_BEFORE_BACKOFF) {
      console.error(`[meetingwatch] graph-cal failed: ${describe(err)} — skipping tick`);
    }
    // beyond the threshold we stay quiet; the loud line above already said it
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.backingOff) {
      console.log(`[meetingwatch] graph-cal recovered — back to ${this.config.meeting_poll_minutes}m ticks`);
      this.backingOff = false;
      this.scheduleNext();
    }
  }

  // ------------------------------------------------------------ storage

  private statePath(slug: string): string {
    return path.join(this.home, slug, "meetingwatch.json");
  }

  readStateFile(slug: string): MeetingWatchFile {
    const file = this.statePath(slug);
    try {
      if (!fs.existsSync(file)) return emptyMeetingWatchFile();
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MeetingWatchFile>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.briefed_ids)) return emptyMeetingWatchFile();
      return { version: 1, briefed_ids: parsed.briefed_ids, updated_at: parsed.updated_at ?? nowIso() };
    } catch (err) {
      // A corrupt state file must not wedge the poller: start fresh (worst
      // case a handful of already-briefed events get re-briefed once).
      console.error(`[meetingwatch] unreadable state for ${slug}, resetting: ${describe(err)}`);
      return emptyMeetingWatchFile();
    }
  }

  writeStateFile(slug: string, data: MeetingWatchFile): void {
    const file = this.statePath(slug);
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
