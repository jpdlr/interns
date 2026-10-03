/**
 * The Today tab's data (docs/features/03-today.md): one read model built
 * from what already exists — open cards, the calendar, meeting briefs and
 * debriefs, people pages' follow-up dates, and finished tasks. Deterministic;
 * no LLM call. Served as GET /agenda (not /today: that path belongs to the
 * app's tab, and API paths need the bearer token a cold navigation lacks).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { localZone } from "./profile.js";
import { parseNextOutput, type CalAttendee, type CalEvent } from "./meetingwatch.js";
import type { Registry } from "./registry.js";
import type { Card, Message, Task } from "./types.js";

const execFileAsync = promisify(execFile);

/** Actions that only acknowledge — a card offering nothing else is "for your info", not a decision. */
const PASSIVE_ACTIONS = new Set(["seen", "ack", "read", "ok", "noted", "dismiss", "close"]);

export function isDecision(card: Card): boolean {
  if (card.severity === "action" || card.severity === "urgent") return true;
  return card.actions.some((a) => !PASSIVE_ACTIONS.has(a.id.toLowerCase()));
}

/** YYYY-MM-DD for `now` in the owner's time zone. */
export function localDate(now: Date = new Date(), zone = localZone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
}

/** How far `zone`'s wall clock is ahead of UTC at `at`, in ms. */
function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/** UTC instant of local midnight on `date` (YYYY-MM-DD) in `zone`; DST-safe. */
function localMidnight(date: string, zone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  const first = wall - zoneOffsetMs(wall, zone);
  return wall - zoneOffsetMs(first, zone);
}

/** UTC bounds of a local calendar day (23 or 25 hours long on DST changes). */
export function dayBounds(date: string, zone = localZone()): { from: string; to: string } {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { from: new Date(localMidnight(date, zone)).toISOString(), to: new Date(localMidnight(next, zone)).toISOString() };
}

export function isExternal(email: string | null | undefined, ownDomains: string[]): boolean {
  const host = (email ?? "").toLowerCase().split("@")[1];
  if (!host) return false;
  return !ownDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
}

export function isCancelled(subject: string | null | undefined): boolean {
  return /^\s*cancell?ed\s*:/i.test(subject ?? "");
}

/** Meetings worth a debrief: someone from outside the owner's organisations was invited, and it wasn't cancelled. */
export function hasExternalAttendee(event: { subject?: string | null; attendees?: CalAttendee[] }, ownDomains: string[]): boolean {
  if (isCancelled(event.subject)) return false;
  return (event.attendees ?? []).some((a) => isExternal(a.email, ownDomains));
}

// ----------------------------------------------------------------- calendar

export type CalendarSource = (date: string) => Promise<CalEvent[]>;

function resolveGraphCal(): string {
  const override = process.env.INTERNS_GRAPH_CAL;
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../tools/graph-cal"), path.resolve(here, "../../tools/graph-cal")];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[1]!;
}

/**
 * graph-cal agenda for one local day, cached briefly so pull-to-refresh doesn't
 * hammer Graph. No calendar mailbox configured = an empty schedule.
 */
export function cachedCalendar(mailbox: string | undefined, ttlMs = 5 * 60_000): CalendarSource {
  const cache = new Map<string, { at: number; events: CalEvent[] }>();
  return async (date: string) => {
    if (!mailbox) return [];
    const hit = cache.get(date);
    if (hit && Date.now() - hit.at < ttlMs) return hit.events;
    const { stdout } = await execFileAsync(resolveGraphCal(), ["--mailbox", mailbox, "agenda", "--date", date], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const events = parseNextOutput(stdout);
    cache.set(date, { at: Date.now(), events });
    return events;
  };
}

// ------------------------------------------------------------------- shape

export interface ScheduleEntry {
  event_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  cancelled: boolean;
  attendees: { name: string; email: string; external: boolean }[];
  location?: string;
  web_link?: string;
  brief?: { intern: string; markdown: string; message_id?: string };
  debrief?: { state: "pending" | "asked" | "answered" | "skipped"; intern: string; message_id?: string };
}

export interface AgendaResponse {
  date: string;
  generated_at: string;
  needs_you: Card[];
  fyi: Card[];
  schedule: ScheduleEntry[];
  schedule_error?: string;
  follow_ups: { person_id: string; page_id: string; name: string; company?: string; due: string; overdue: boolean; intern: string }[];
  away: { intern: string; summary: string; count: number }[];
  standup?: { message_id: string; markdown: string; ts: string };
}

export interface AgendaDeps {
  db: Db;
  registry: Registry;
  calendar: CalendarSource;
  ownDomains: string[];
  now?: () => Date;
}

// ------------------------------------------------------------------- build

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line per intern of what they finished since `since` — deterministic, from task rows. */
export function awaySummaries(tasks: Task[], nameOf: (slug: string) => string): AgendaResponse["away"] {
  const by = new Map<string, Task[]>();
  for (const t of tasks) by.set(t.intern, [...(by.get(t.intern) ?? []), t]);
  const out: AgendaResponse["away"] = [];
  for (const [intern, list] of by) {
    const done = list.filter((t) => t.status === "done");
    const reviews = done.filter((t) => t.payload.type === "github_pull_request").length;
    const mails = done.filter((t) => t.payload.kind === "new_mail").reduce((n, t) => n + Number(t.payload.count ?? 1), 0);
    const briefs = done.filter((t) => t.payload.kind === "meeting_brief").length;
    const replies = done.filter((t) => t.kind === "message").length;
    const backlog = done.filter((t) => t.kind === "backlog").length;
    const routines = done.filter((t) => t.kind === "scheduled").length;
    const failed = list.filter((t) => t.status === "failed").length;
    const muted = list.filter((t) => t.status === "cancelled" && (t.error ?? "").startsWith("standing order")).length;
    const parts = [
      reviews && `reviewed ${plural(reviews, "PR")}`,
      mails && `triaged ${plural(mails, "email")}`,
      briefs && `prepared ${plural(briefs, "meeting brief")}`,
      replies && `answered ${plural(replies, "message")}`,
      backlog && `worked through ${plural(backlog, "backlog item")}`,
      routines && `ran ${plural(routines, "routine")}`,
      muted && `muted ${muted} by standing order`,
      failed && `${failed} failed`,
    ].filter(Boolean) as string[];
    if (parts.length === 0) continue;
    const text = parts.join(", ");
    out.push({ intern, summary: `${nameOf(intern)} ${text}`, count: list.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

export async function buildAgenda(deps: AgendaDeps, date: string, since: string | null): Promise<AgendaResponse> {
  const { db, registry } = deps;
  const now = deps.now?.() ?? new Date();
  const nameOf = (slug: string) => (slug === "coordinator" ? "Chaos Coordinator" : (registry.get(slug)?.name ?? slug));

  const open = db.listCards("open");
  const needs_you = open.filter(isDecision);
  const fyi = open.filter((c) => !isDecision(c));

  // ---- schedule: calendar first, briefs layered on; briefs alone if Graph is down
  const { from, to } = dayBounds(date);
  const briefs = db.listMeetingBriefs(from, to);
  let events: CalEvent[] = [];
  let schedule_error: string | undefined;
  try {
    events = await deps.calendar(date);
  } catch (err) {
    schedule_error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  const briefFor = (eventId: string) => briefs.find((b) => b.event_id === eventId);
  const entries = new Map<string, ScheduleEntry>();
  const toEntry = (e: CalEvent): ScheduleEntry => {
    const attendees = (e.attendees ?? []).map((a) => ({ name: a.name ?? a.email ?? "?", email: a.email ?? "", external: isExternal(a.email, deps.ownDomains) }));
    return {
      event_id: e.id,
      start: e.start?.iso ?? "",
      end: e.end?.iso ?? "",
      all_day: e.all_day,
      title: e.subject ?? "(no title)",
      cancelled: isCancelled(e.subject),
      attendees,
      ...(e.location ? { location: e.location } : {}),
      ...(e.web_link ? { web_link: e.web_link } : {}),
    };
  };
  for (const e of events) entries.set(e.id, toEntry(e));
  for (const b of briefs) {
    if (!entries.has(b.event_id)) entries.set(b.event_id, toEntry(b.event as unknown as CalEvent));
  }
  for (const entry of entries.values()) {
    const brief = briefFor(entry.event_id);
    const msg: Message | undefined = brief?.message_id ? db.getMessage(brief.message_id) : undefined;
    if (brief && msg) entry.brief = { intern: brief.intern, markdown: msg.text, message_id: msg.id };
    const intern = brief?.intern;
    if (intern) {
      const row = db.getDebrief(entry.event_id, intern);
      if (row) entry.debrief = { state: row.state, intern, ...(row.message_id ? { message_id: row.message_id } : {}) };
      else if (!entry.cancelled && entry.end && Date.parse(entry.end) <= now.getTime() && entry.attendees.some((a) => a.external)) {
        entry.debrief = { state: "pending", intern };
      }
    }
  }
  const schedule = [...entries.values()].sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start));

  // ---- follow-ups due from every people page
  const follow_ups: AgendaResponse["follow_ups"] = [];
  for (const page of db.listPagesOfKind("people")) {
    const people = Array.isArray(page.data.people) ? (page.data.people as Record<string, unknown>[]) : [];
    for (const p of people) {
      const due = typeof p.next_follow_up === "string" ? p.next_follow_up.slice(0, 10) : "";
      if (!due || due > date) continue;
      follow_ups.push({
        person_id: String(p.id),
        page_id: page.id,
        name: String(p.name ?? "?"),
        ...(typeof p.company === "string" ? { company: p.company } : {}),
        due,
        overdue: due < date,
        intern: page.intern,
      });
    }
  }
  follow_ups.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));

  // ---- while you were away (default: since the start of the day)
  const sinceIso = since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : from;
  const away = awaySummaries(db.tasksFinishedSince(sinceIso), nameOf);

  const standupId = db.getKv(`standup:${date}`);
  const standupMsg = standupId ? db.getMessage(standupId) : undefined;

  return {
    date,
    generated_at: now.toISOString(),
    needs_you,
    fyi,
    schedule,
    ...(schedule_error ? { schedule_error } : {}),
    follow_ups,
    away,
    ...(standupMsg ? { standup: { message_id: standupMsg.id, markdown: standupMsg.text, ts: standupMsg.ts } } : {}),
  };
}
