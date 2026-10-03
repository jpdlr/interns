/** Crons in the owner's time zone (src/schedules.ts): matching, shifting and the one-time migration. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { cronMatches, migrateSchedules, shiftCron, zoneOffsetMinutes } from "../src/schedules.js";
import { InternManifestSchema } from "../src/types.js";

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : err}`);
  }
};

check("matches on the owner's wall clock", () => {
  const monday0700utc = new Date("2026-10-05T07:00:00Z");
  assert.ok(cronMatches("0 9 * * 1-5", monday0700utc, "Africa/Johannesburg"));
  assert.ok(!cronMatches("0 9 * * 1-5", monday0700utc, "UTC"));
  assert.ok(cronMatches("0 7 * * 1-5", monday0700utc, "UTC"));
  assert.ok(cronMatches("0 3 * * 1", monday0700utc, "America/New_York"), "EDT is UTC-4");
  assert.ok(cronMatches("0 9 * * 7", new Date("2026-10-04T07:00:00Z"), "Africa/Johannesburg"), "7 is Sunday");
});

check("follows daylight saving: 09:00 London is 08:00 UTC in summer, 09:00 in winter", () => {
  assert.ok(cronMatches("0 9 * * *", new Date("2026-07-01T08:00:00Z"), "Europe/London"));
  assert.ok(cronMatches("0 9 * * *", new Date("2026-12-01T09:00:00Z"), "Europe/London"));
});

check("shifts crons between clocks", () => {
  assert.equal(shiftCron("0 7 * * 1-5", 120), "0 9 * * 1-5");
  assert.equal(shiftCron("0 23 * * 0", 120), "0 1 * * 1", "the day moves across midnight");
  assert.equal(shiftCron("0 22 * * 1-5", 120), "0 0 * * 2-6");
  assert.equal(shiftCron("*/30 * * * *", 120), "*/30 * * * *");
  assert.equal(shiftCron("*/30 6-15 * * 1-5", 120), "*/30 8-17 * * 1-5");
  assert.equal(shiftCron("15 * * * *", 330), "45 * * * *", "half-hour zones move the minutes");
  assert.equal(shiftCron("0 6 * * 1-5", -300), "0 1 * * 1-5");
  assert.equal(shiftCron("0 7 1 * *", 120), "0 9 1 * *");
  assert.equal(shiftCron("0 23 1 * *", 120), null, "a day-of-month can't cross midnight");
  assert.equal(shiftCron("0 20-23 * * 1-5", 120), null, "not one cron line afterwards");
  assert.equal(shiftCron("nonsense", 120), null);
});

check("offsets", () => {
  assert.equal(zoneOffsetMinutes("UTC"), 0);
  assert.equal(zoneOffsetMinutes("Africa/Johannesburg"), 120);
  assert.equal(zoneOffsetMinutes("Asia/Kolkata"), 330);
});

check("a new install starts local; an old config does not", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "interns-sched-"));
  assert.equal(loadConfig(fresh).schedules_local, true);
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "interns-sched-"));
  fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ port: 7810, api_token: "x", push: { vapid_public: "a", vapid_private: "b" } }));
  assert.equal(loadConfig(old).schedules_local, false);
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
});

check("migration keeps every schedule firing at the same moment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-sched-"));
  const registry = new Registry(home);
  const manifest = (name: string, cron: string) =>
    InternManifestSchema.parse({ name, role: "Test", system_prompt: "Test.", triggers: { cron } });
  registry.save(manifest("Julia", "0 7 * * 1"), "julia");
  registry.save(manifest("Odd", "0 20-23 * * 1-5"), "odd");
  registry.save(InternManifestSchema.parse({ name: "None", role: "Test", system_prompt: "Test." }), "none");
  const config = ConfigSchema.parse({});
  const result = migrateSchedules(registry, config, "UTC", "Africa/Johannesburg", new Date("2026-10-03T10:00:00Z"));
  assert.equal(result.offset, 120);
  assert.equal(registry.get("julia")!.triggers.cron, "0 9 * * 1");
  assert.equal(registry.get("odd")!.triggers.cron, "0 20-23 * * 1-5", "left alone");
  assert.deepEqual(result.unconverted, [{ what: "Odd", cron: "0 20-23 * * 1-5" }]);
  assert.equal(config.standup_cron, "0 9 * * 1-5", "the default 07:00 UTC standup stays 09:00 SAST");
  assert.equal(config.suggest_cron, "0 10 * * 1");
  assert.equal(config.schedules_local, true);
  // the moment is unchanged: Monday 07:00 UTC
  assert.ok(cronMatches(registry.get("julia")!.triggers.cron!, new Date("2026-10-05T07:00:00Z"), "Africa/Johannesburg"));
  const same = ConfigSchema.parse({});
  assert.deepEqual(migrateSchedules(registry, same, "UTC", "UTC").changed, []);
  assert.equal(same.schedules_local, true);
  fs.rmSync(home, { recursive: true, force: true });
});

console.log(failures === 0 ? "schedules: all tests passed" : `schedules: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
