/**
 * Checks for src/schedule.ts: the schedule model ↔ cron, on the owner's clock.
 * The app has no test runner; run with the orchestrator's tsx:
 *
 *   npm run check:schedule
 */
const assert = {
  equal(actual: unknown, expected: unknown, note = "") {
    if (actual !== expected) throw new Error(`${note || "mismatch"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  },
};
import { describeCron, formatLocal, nextRun, parseSchedule, scheduleToCron } from "../src/schedule";
const rt = (cron: string) => scheduleToCron(parseSchedule(cron));
const once = (days: number[], hour: number, minute = 0) => scheduleToCron({ days, hour, minute, every: null, allDay: false, custom: null });
// times are stored as written: no conversion
assert.equal(describeCron("0 9 * * 1"), "Mondays at 09:00");
assert.equal(rt("0 9 * * 1"), "0 9 * * 1");
assert.equal(once([1], 1), "0 1 * * 1");
assert.equal(once([1, 2, 3, 4, 5], 7, 30), "30 7 * * 1-5");
assert.equal(describeCron("30 7 * * 1-5"), "Weekdays at 07:30");
assert.equal(describeCron("0 6 * * *"), "Every day at 06:00");
assert.equal(describeCron("0 10 * * 0,6"), "Weekends at 10:00");
assert.equal(describeCron("0 10 * * 1,3,5"), "Mondays, Wednesdays and Fridays at 10:00");
// repeats, with or without days
assert.equal(describeCron("*/30 * * * *"), "Every day, every 30 minutes, around the clock");
assert.equal(describeCron("0 */2 * * 1-5"), "Weekdays, every 2 hours, around the clock");
const rep = (every: number, allDay: boolean) => scheduleToCron({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0, every, allDay, custom: null });
assert.equal(rep(120, true), "0 */2 * * 1-5");
// working hours 08:00–18:00
assert.equal(rep(120, false), "0 8,10,12,14,16,18 * * 1-5");
assert.equal(rep(60, false), "0 8-18 * * 1-5");
assert.equal(rep(30, false), "*/30 8-17 * * 1-5");
assert.equal(rep(240, false), "0 8,12,16 * * 1-5");
for (const e of [15, 30, 60, 120, 240, 360]) for (const a of [true, false]) assert.equal(rt(rep(e, a)), rep(e, a), `round-trip every ${e} allDay ${a}`);
assert.equal(describeCron("0 8,10,12,14,16,18 * * 1-5"), "Weekdays, every 2 hours, 08:00–18:00");
assert.equal(scheduleToCron({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0, every: 15, allDay: true, custom: null }), "*/15 * * * *");
// no days = off; anything else stays custom, untouched
assert.equal(scheduleToCron({ days: [], hour: 9, minute: 0, every: null, allDay: false, custom: null }), "");
assert.equal(describeCron(""), "Off");
assert.equal(describeCron("*/5 * * * *"), "Custom: */5 * * * *");
assert.equal(rt("*/5 * * * *"), "*/5 * * * *");
assert.equal(describeCron("0 7 1 * *"), "Custom: 0 7 1 * *");
assert.equal(rt(""), "");
// next run on the owner's clock, whatever this device's zone is
const sat = new Date("2026-10-03T08:00:00Z");
assert.equal(formatLocal(nextRun("0 9 * * 1", sat, "Africa/Johannesburg")!, "Africa/Johannesburg"), "Mon 5 Oct, 09:00");
assert.equal(nextRun("0 9 * * 1", sat, "Africa/Johannesburg")!.toISOString(), "2026-10-05T07:00:00.000Z");
assert.equal(nextRun("0 9 * * 1", sat, "Europe/London")!.toISOString(), "2026-10-05T08:00:00.000Z", "BST");
assert.equal(formatLocal(nextRun("0 8,10 * * 1-5", sat, "America/New_York")!, "America/New_York"), "Mon 5 Oct, 08:00");
assert.equal(formatLocal(nextRun("0 9 * * 7", sat, "UTC")!, "UTC"), "Sun 4 Oct, 09:00", "7 is Sunday");
console.log("schedule: all checks passed");
