/**
 * Intern schedules as people think of them ("Mondays at 09:00"), stored as the
 * 5-field cron the orchestrator runs.
 *
 * The model is deliberately small: which days, and either one time of day or
 * "every N minutes/hours". No days = no schedule. Anything else a cron string
 * can say is kept untouched as `custom`.
 *
 * The orchestrator matches cron on the owner's wall clock (their `timezone`
 * setting), so the times here are stored as written: Mondays at 09:00 is
 * `0 9 * * 1`, all year round. Only "next run" needs the zone.
 */

export interface Schedule {
  /** local days, 0 = Sunday … 6 = Saturday; empty = no schedule */
  days: number[];
  /** local time of day (used when `every` is null) */
  hour: number;
  minute: number;
  /** repeat every N minutes through the day instead of once (15, 30, 60, 120, …) */
  every: number | null;
  /** repeats: true = around the clock; false = working hours (08:00–18:00 local) */
  allDay: boolean;
  /** a cron the model can't express, kept as typed */
  custom: string | null;
}

export const INTERVALS = [15, 30, 60, 120, 240, 360];
export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const EMPTY_SCHEDULE: Schedule = { days: [], hour: 9, minute: 0, every: null, allDay: false, custom: null };

/** Working hours for repeats: from 08:00, the last run at 18:00. */
export const WORK_START = 8;
export const WORK_END = 18;

/** The hour field for repeats inside working hours. */
function workHours(every: number): string {
  if (every < 60) return `${WORK_START}-${WORK_END - 1}`; // every 15/30 min, 08:00–17:45
  if (every === 60) return `${WORK_START}-${WORK_END}`; // hourly 08:00–18:00
  const hours: number[] = [];
  for (let h = WORK_START; h <= WORK_END; h += every / 60) hours.push(h);
  return hours.join(",");
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const pad = (n: number) => String(n).padStart(2, "0");
const sameDays = (a: number[], b: number[]) => [...a].sort().join() === [...b].sort().join();

/** "1-5" / "1,3,5" / "*" → day numbers (cron allows 7 for Sunday). Null when not a plain list. */
function parseDays(field: string): number[] | null {
  if (field === "*") return [...EVERY_DAY];
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 7) return null;
      for (let d = from; d <= to; d++) days.add(d % 7);
    } else if (/^\d$/.test(part) && Number(part) <= 7) {
      days.add(Number(part) % 7);
    } else {
      return null;
    }
  }
  return [...days].sort((a, b) => a - b);
}

/** [1,2,3,4,5] → "1-5"; [1,3] → "1,3"; all seven → "*". */
function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "*";
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

/** Read a stored cron into the schedule model. */
export function parseSchedule(cron: string | null | undefined): Schedule {
  const raw = (cron ?? "").trim();
  if (!raw) return { ...EMPTY_SCHEDULE };
  const custom: Schedule = { ...EMPTY_SCHEDULE, custom: raw };
  const f = raw.split(/\s+/);
  if (f.length !== 5) return custom;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (dom !== "*" || month !== "*") return custom;
  const cronDays = parseDays(dow);
  if (!cronDays || cronDays.length === 0) return custom;

  // Repeats through the day: "*/30 * * * 1-5", "0 */2 * * *", "0 * * * *".
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && INTERVALS.includes(Number(everyMin[1])) && (hour === "*" || hour === workHours(Number(everyMin[1])))) {
    return { ...EMPTY_SCHEDULE, days: cronDays, every: Number(everyMin[1]), allDay: hour === "*" };
  }
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (min === "0" && (hour === "*" || (everyHour && INTERVALS.includes(Number(everyHour[1]) * 60)))) {
    return { ...EMPTY_SCHEDULE, days: cronDays, every: hour === "*" ? 60 : Number(everyHour![1]) * 60, allDay: true };
  }
  if (min === "0") {
    const work = INTERVALS.filter((e) => e >= 60).find((e) => workHours(e) === hour);
    if (work) return { ...EMPTY_SCHEDULE, days: cronDays, every: work, allDay: false };
  }

  // Once a day at a fixed time.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || Number(min) > 59 || Number(hour) > 23) return custom;
  return { ...EMPTY_SCHEDULE, days: cronDays, hour: Number(hour), minute: Number(min) };
}

/** The cron for a schedule; "" means no schedule. */
export function scheduleToCron(s: Schedule): string {
  if (s.custom !== null) return s.custom.trim();
  if (s.days.length === 0) return "";
  if (s.every) {
    const dow = formatDays(s.days);
    if (!s.allDay) return s.every < 60 ? `*/${s.every} ${workHours(s.every)} * * ${dow}` : `0 ${workHours(s.every)} * * ${dow}`;
    return s.every < 60 ? `*/${s.every} * * * ${dow}` : s.every === 60 ? `0 * * * ${dow}` : `0 */${s.every / 60} * * ${dow}`;
  }
  return `${s.minute} ${s.hour} * * ${formatDays(s.days)}`;
}

/** "Every day" / "Weekdays" / "Weekends" / "Mondays and Thursdays". */
export function daysPhrase(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (sameDays(days, WEEKDAYS)) return "Weekdays";
  if (sameDays(days, [0, 6])) return "Weekends";
  const names = [...days].sort((a, b) => mod(a - 1, 7) - mod(b - 1, 7)).map((d) => `${DAY_NAMES[d]}s`);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function everyPhrase(every: number): string {
  return every < 60 ? `every ${every} minutes` : every === 60 ? "every hour" : `every ${every / 60} hours`;
}

/** Plain words: "Mondays at 09:00", "Weekdays, every 2 hours", "Off". */
export function describeSchedule(s: Schedule): string {
  if (s.custom !== null) return `Custom: ${s.custom}`;
  if (s.days.length === 0) return "Off";
  if (s.every) return `${daysPhrase(s.days)}, ${everyPhrase(s.every)}${s.allDay ? ", around the clock" : `, ${pad(WORK_START)}:00–${pad(WORK_END)}:00`}`;
  return `${daysPhrase(s.days)} at ${pad(s.hour)}:${pad(s.minute)}`;
}

/** Describe a stored cron in words (summaries like the hire screen). */
export function describeCron(cron: string | null | undefined): string {
  return describeSchedule(parseSchedule(cron));
}

// --------------------------------------------------------------- next run

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return value % Number(step[1]) === 0;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return Number(part) === value;
  });
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** minute, hour, day, month, weekday of `d` on `zone`'s clock (same as the orchestrator's schedules.ts). */
function zonedFields(d: Date, zone: string): [number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return [Number(get("minute")), Number(get("hour")), Number(get("day")), Number(get("month")), WEEKDAY_INDEX[get("weekday")] ?? 0];
}

/** Same matcher as the orchestrator (schedules.ts cronMatches), on the owner's clock. */
function zonedMatches(cron: string, d: Date, zone: string): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const values = zonedFields(d, zone);
  return f.every((field, i) => fieldMatches(field, values[i]!) || (i === 4 && values[4] === 0 && fieldMatches(field, 7)));
}

/** The next time this cron fires after `from` (within 8 days) on `zone`'s clock, or null. */
export function nextRun(cron: string, from: Date = new Date(), zone?: string): Date | null {
  if (!cron.trim()) return null;
  const tz = zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 1; i <= 8 * 1440; i++) {
    const candidate = new Date(t.getTime() + i * 60_000);
    if (zonedMatches(cron, candidate, tz)) return candidate;
  }
  return null;
}

/** "Mon 5 Oct, 09:00" on `zone`'s clock. */
export function formatLocal(d: Date, zone?: string): string {
  const tz = zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [minute, hour, day, month, weekday] = zonedFields(d, tz);
  return `${DAY_NAMES[weekday]!.slice(0, 3)} ${day} ${MONTHS[month - 1]}, ${pad(hour)}:${pad(minute)}`;
}
