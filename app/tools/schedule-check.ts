/**
 * Checks for src/schedule.ts (local time ↔ the server's UTC cron). The fixtures are
 * written for SAST (UTC+2, no DST), so pin the zone. The app has no test runner; run
 * with the orchestrator's tsx:
 *
 *   npm run check:schedule   # TZ=Africa/Johannesburg ../orchestrator/node_modules/.bin/tsx tools/schedule-check.ts
 */
const assert = {
  equal(actual: unknown, expected: unknown, note = "") {
    if (actual !== expected) throw new Error(`${note || "mismatch"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  },
};
import { describeCron, formatLocal, nextRun, parseSchedule, scheduleToCron } from "../src/schedule";
const rt = (cron: string) => scheduleToCron(parseSchedule(cron));
const once = (days: number[], hour: number, minute = 0) => scheduleToCron({ days, hour, minute, every: null, allDay: false, custom: null });
// Julia's real schedule: 07:00 UTC Monday = 09:00 SAST Monday
assert.equal(describeCron("0 7 * * 1"), "Mondays at 09:00");
assert.equal(rt("0 7 * * 1"), "0 7 * * 1");
// local -> utc, including the day moving back across midnight
assert.equal(once([1], 1), "0 23 * * 0");
assert.equal(describeCron("0 23 * * 0"), "Mondays at 01:00");
assert.equal(once([1, 2, 3, 4, 5], 7, 30), "30 5 * * 1-5");
assert.equal(describeCron("30 5 * * 1-5"), "Weekdays at 07:30");
assert.equal(once([1, 2, 3, 4, 5], 1), "0 23 * * 0-4");
assert.equal(describeCron("0 23 * * 0-4"), "Weekdays at 01:00");
assert.equal(describeCron("0 6 * * *"), "Every day at 08:00");
assert.equal(describeCron("0 8 * * 0,6"), "Weekends at 10:00");
assert.equal(describeCron("0 8 * * 1,3,5"), "Mondays, Wednesdays and Fridays at 10:00");
// repeats, with or without days
assert.equal(describeCron("*/30 * * * *"), "Every day, every 30 minutes, around the clock");
assert.equal(describeCron("0 */2 * * 1-5"), "Weekdays, every 2 hours, around the clock");
const rep = (every: number, allDay: boolean) => scheduleToCron({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0, every, allDay, custom: null });
assert.equal(rep(120, true), "0 */2 * * 1-5");
// working hours 08:00–18:00 SAST = 06–16 UTC
assert.equal(rep(120, false), "0 6,8,10,12,14,16 * * 1-5");
assert.equal(rep(60, false), "0 6-16 * * 1-5");
assert.equal(rep(30, false), "*/30 6-15 * * 1-5");
assert.equal(rep(240, false), "0 6,10,14 * * 1-5");
for (const e of [15, 30, 60, 120, 240, 360]) for (const a of [true, false]) assert.equal(rt(rep(e, a)), rep(e, a), `round-trip every ${e} allDay ${a}`);
assert.equal(describeCron("0 6,8,10,12,14,16 * * 1-5"), "Weekdays, every 2 hours, 08:00–18:00");
assert.equal(formatLocal(nextRun("0 6,8,10,12,14,16 * * 1-5", new Date("2026-10-03T08:00:00Z"))!), "Mon 5 Oct, 08:00");
assert.equal(scheduleToCron({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0, every: 15, allDay: true, custom: null }), "*/15 * * * *");
// no days = off; anything else stays custom, untouched
assert.equal(scheduleToCron({ days: [], hour: 9, minute: 0, every: null, allDay: false, custom: null }), "");
assert.equal(describeCron(""), "Off");
assert.equal(describeCron("*/5 * * * *"), "Custom: */5 * * * * (UTC)");
assert.equal(rt("*/5 * * * *"), "*/5 * * * *");
assert.equal(describeCron("0 7 1 * *"), "Custom: 0 7 1 * * (UTC)");
assert.equal(rt(""), "");
// next run, shown in SAST: from Sat 3 Oct 08:00 UTC, Monday 07:00 UTC = Mon 5 Oct 09:00 SAST
assert.equal(formatLocal(nextRun("0 7 * * 1", new Date("2026-10-03T08:00:00Z"))!), "Mon 5 Oct, 09:00");
console.log("schedule: all checks passed");
