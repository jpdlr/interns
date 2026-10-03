/**
 * Intern schedules as people think of them ("Mondays at 09:00"), stored as the
 * 5-field cron the orchestrator runs.
 *
 * The model is deliberately small: which days, and either one time of day or
 * "every N minutes/hours". No days = no schedule. Anything else a cron string
 * can say is kept untouched as `custom`.
 *
 * The orchestrator matches cron against its own clock, which is UTC, while the
 * owner thinks in this device's local time. So times here are local and get
 * converted with the device's current UTC offset: in SAST (UTC+2), 09:00 on
 * Monday is `0 7 * * 1`, and 01:00 on Monday is `0 23 * * 0` (the day moves
 * too). In zones with daylight saving the stored cron keeps its UTC time, so
 * a schedule shifts by an hour when the clocks change.
 */

export const LOCAL_OFFSET_MINUTES = -new Date().getTimezoneOffset();
export const LOCAL_ZONE_LABEL =
  new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "local";

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
  /** a cron the model can't express, kept as typed (UTC) */
  custom: string | null;
}

export const INTERVALS = [15, 30, 60, 120, 240, 360];
export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const EMPTY_SCHEDULE: Schedule = { days: [], hour: 9, minute: 0, every: null, allDay: false, custom: null };

/** Working hours for repeats, local: from 08:00, the last run at 18:00. */
export const WORK_START = 8;
export const WORK_END = 18;
const utcHour = (localHour: number) => mod(Math.floor(localHour - LOCAL_OFFSET_MINUTES / 60), 24);

/** The UTC hour field for repeats inside working hours. */
function workHours(every: number): string {
  if (every < 60) return `${utcHour(WORK_START)}-${utcHour(WORK_END - 1)}`; // every 15/30 min, 08:00–17:45
  if (every === 60) return `${utcHour(WORK_START)}-${utcHour(WORK_END)}`; // hourly 08:00–18:00
  const hours: number[] = [];
  for (let h = WORK_START; h <= WORK_END; h += every / 60) hours.push(utcHour(h));
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

/** Read a stored (UTC) cron into the local-time model. */
export function parseSchedule(cron: string | null | undefined): Schedule {
  const raw = (cron ?? "").trim();
  if (!raw) return { ...EMPTY_SCHEDULE };
  const custom: Schedule = { ...EMPTY_SCHEDULE, custom: raw };
  const f = raw.split(/\s+/);
  if (f.length !== 5) return custom;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (dom !== "*" || month !== "*") return custom;
  const utcDays = parseDays(dow);
  if (!utcDays || utcDays.length === 0) return custom;

  // Repeats through the day: "*/30 * * * 1-5", "0 */2 * * *", "0 * * * *".
  // (Days for repeats stay as the server's days: a repeat spans the whole day.)
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && INTERVALS.includes(Number(everyMin[1])) && (hour === "*" || hour === workHours(Number(everyMin[1])))) {
    return { ...EMPTY_SCHEDULE, days: utcDays, every: Number(everyMin[1]), allDay: hour === "*" };
  }
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (min === "0" && (hour === "*" || (everyHour && INTERVALS.includes(Number(everyHour[1]) * 60)))) {
    return { ...EMPTY_SCHEDULE, days: utcDays, every: hour === "*" ? 60 : Number(everyHour![1]) * 60, allDay: true };
  }
  if (min === "0") {
    const work = INTERVALS.filter((e) => e >= 60).find((e) => workHours(e) === hour);
    if (work) return { ...EMPTY_SCHEDULE, days: utcDays, every: work, allDay: false };
  }

  // Once a day at a fixed time.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || Number(min) > 59 || Number(hour) > 23) return custom;
  const local = Number(hour) * 60 + Number(min) + LOCAL_OFFSET_MINUTES;
  const shift = Math.floor(local / 1440);
  const minutes = mod(local, 1440);
  return {
    ...EMPTY_SCHEDULE,
    days: utcDays.map((d) => mod(d + shift, 7)).sort((a, b) => a - b),
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  };
}

/** The (UTC) cron for a schedule; "" means no schedule. */
export function scheduleToCron(s: Schedule): string {
  if (s.custom !== null) return s.custom.trim();
  if (s.days.length === 0) return "";
  if (s.every) {
    const dow = formatDays(s.days);
    if (!s.allDay) return s.every < 60 ? `*/${s.every} ${workHours(s.every)} * * ${dow}` : `0 ${workHours(s.every)} * * ${dow}`;
    return s.every < 60 ? `*/${s.every} * * * ${dow}` : s.every === 60 ? `0 * * * ${dow}` : `0 */${s.every / 60} * * ${dow}`;
  }
  const utc = s.hour * 60 + s.minute - LOCAL_OFFSET_MINUTES;
  const shift = Math.floor(utc / 1440);
  const minutes = mod(utc, 1440);
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * ${formatDays(s.days.map((d) => mod(d + shift, 7)))}`;
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
  if (s.custom !== null) return `Custom: ${s.custom} (UTC)`;
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

/** Same matcher as the orchestrator (orchestrator.ts cronMatches), on UTC fields. */
function utcMatches(cron: string, d: Date): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return f.every((field, i) => fieldMatches(field, values[i]!));
}

/** The next time this cron fires after `from` (within 8 days), or null. */
export function nextRun(cron: string, from: Date = new Date()): Date | null {
  if (!cron.trim()) return null;
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 1; i <= 8 * 1440; i++) {
    const candidate = new Date(t.getTime() + i * 60_000);
    if (utcMatches(cron, candidate)) return candidate;
  }
  return null;
}

/** "Mon 5 Oct, 09:00" in local time. */
export function formatLocal(d: Date): string {
  const local = new Date(d.getTime() + LOCAL_OFFSET_MINUTES * 60_000);
  const day = DAY_NAMES[local.getUTCDay()]!.slice(0, 3);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][local.getUTCMonth()];
  return `${day} ${local.getUTCDate()} ${month}, ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}
