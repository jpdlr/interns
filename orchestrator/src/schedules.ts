/**
 * Cron schedules, in the owner's time zone.
 *
 * Every cron (intern triggers.cron, standup_cron, suggest_cron) is written in
 * the owner's wall-clock time: "0 9 * * 1-5" is 09:00 on weekdays where the
 * owner lives (`timezone`), across daylight-saving changes. Before this, crons
 * were matched against the server's own clock; migrateSchedules() rewrites
 * those once (config.schedules_local marks it done).
 */
import type { Config } from "./config.js";
import { localZone } from "./profile.js";
import type { Registry } from "./registry.js";

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** minute, hour, day of month, month, weekday of `date` on `zone`'s wall clock. */
export function zonedFields(date: Date, zone: string): [number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return [Number(get("minute")), Number(get("hour")), Number(get("day")), Number(get("month")), WEEKDAYS[get("weekday")] ?? 0];
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return Number(part) === value;
  });
}

/**
 * Minimal 5-field cron matcher (minute hour dom month dow) on `zone`'s wall
 * clock. Supports "*", "*\/n", single numbers, comma lists and ranges "a-b";
 * weekday 7 is Sunday.
 */
export function cronMatches(expr: string, date: Date, zone = localZone()): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = zonedFields(date, zone);
  return fields.every((field, i) => fieldMatches(field, values[i]!) || (i === 4 && values[4] === 0 && fieldMatches(field, 7)));
}

/** How far `zone`'s clock is ahead of UTC at `at`, in minutes. */
export function zoneOffsetMinutes(zone: string, at: Date = new Date()): number {
  const [minute, hour, day, month] = zonedFields(at, zone);
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric" }).format(at));
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return Math.round((wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

function expand(field: string, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) if (fieldMatches(field, v) || (hi === 6 && v === 0 && fieldMatches(field, 7))) out.push(v);
  return out;
}

/** [0..59] → "*", [0,15,30,45] → "*\/15", [1,2,3,5] → "1-3,5". */
function compress(values: number[], lo: number, hi: number): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === hi - lo + 1) return "*";
  for (let step = 2; step <= hi; step++) {
    const stepped = expand(`*/${step}`, lo, hi);
    if (stepped.length === sorted.length && stepped.every((v, i) => v === sorted[i])) return `*/${step}`;
  }
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

/**
 * The same moments, on a clock `offset` minutes ahead (negative: behind).
 * "0 7 * * 1-5" shifted by +120 is "0 9 * * 1-5"; 23:00 Sunday moves to
 * 01:00 Monday. Null when the shifted moments are not one cron expression
 * (or day-of-month/month fields would need to move across midnight).
 */
export function shiftCron(expr: string, offset: number): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (offset === 0) return fields.join(" ");
  const minutes = expand(min, 0, 59);
  const hours = expand(hour, 0, 23);
  const days = expand(dow, 0, 6);
  if (!minutes.length || !hours.length || !days.length) return null;
  const WEEK = 7 * 1440;
  const shifted = new Set<number>();
  let crossesMidnight = false;
  for (const d of days) {
    for (const h of hours) {
      for (const m of minutes) {
        const t = ((d * 1440 + h * 60 + m + offset) % WEEK + WEEK) % WEEK;
        if (Math.floor(t / 1440) !== d) crossesMidnight = true;
        shifted.add(t);
      }
    }
  }
  // A day-of-month or month can't follow a time across midnight.
  if (crossesMidnight && (dom !== "*" || month !== "*")) return null;
  const ms = new Set<number>(), hs = new Set<number>(), ds = new Set<number>();
  for (const t of shifted) {
    ms.add(t % 60);
    hs.add(Math.floor((t % 1440) / 60));
    ds.add(Math.floor(t / 1440));
  }
  // Only a full product of minutes × hours × days is one cron line.
  if (ms.size * hs.size * ds.size !== shifted.size) return null;
  return [compress([...ms], 0, 59), compress([...hs], 0, 23), dom, month, compress([...ds], 0, 6)].join(" ");
}

export interface ScheduleMigration {
  offset: number;
  changed: { what: string; from: string; to: string }[];
  /** schedules left as they were because they can't be written as one cron in the new zone */
  unconverted: { what: string; cron: string }[];
}

/**
 * Rewrite every cron from `fromZone`'s clock (what the server matched before)
 * to `toZone`'s, so nothing fires at a different moment. Mutates `config`
 * (standup_cron, suggest_cron, schedules_local); the caller saves it.
 */
export function migrateSchedules(registry: Registry, config: Config, fromZone: string, toZone: string, now = new Date()): ScheduleMigration {
  const offset = zoneOffsetMinutes(toZone, now) - zoneOffsetMinutes(fromZone, now);
  const result: ScheduleMigration = { offset, changed: [], unconverted: [] };
  const convert = (what: string, cron: string, apply: (next: string) => void) => {
    const next = shiftCron(cron, offset);
    if (next === null) result.unconverted.push({ what, cron });
    else if (next !== cron.trim()) {
      apply(next);
      result.changed.push({ what, from: cron, to: next });
    }
  };
  if (offset !== 0) {
    for (const { slug, manifest } of registry.list()) {
      const cron = manifest.triggers.cron;
      if (cron) convert(manifest.name, cron, (next) => registry.save({ ...manifest, triggers: { ...manifest.triggers, cron: next } }, slug));
    }
    convert("standup", config.standup_cron, (next) => (config.standup_cron = next));
    convert("suggestions", config.suggest_cron, (next) => (config.suggest_cron = next));
  }
  config.schedules_local = true;
  return result;
}
