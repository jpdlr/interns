/**
 * Closing a long session (src/engine.ts carryOverPrompt): the fresh session's
 * first run gets the end of the 1:1 chat, without the message it answers.
 *
 *   npm run test:session
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-session-"));
process.env.INTERNS_HOME = home;

const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { carryOverPrompt, SESSION_ROTATE_TOKENS } = await import("../src/engine.js");

const db = new Db(new EventBus(), home);
let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};

try {
  let t = Date.parse("2026-10-03T08:00:00Z");
  const add = (author: "jp" | "intern", text: string) => db.addMessage({ intern: "sam", author, speaker: author === "intern" ? "sam" : null, text, surface: "app", ts: new Date((t += 60_000)).toISOString() });
  for (let i = 0; i < 20; i++) add(i % 2 ? "intern" : "jp", `message ${i}`);
  add("intern", "Here are two:\n```writing\n" + "long ".repeat(200) + "\n```\nPick one.");
  add("jp", "Not the second one. Make it shorter.");

  check("the last messages, oldest first, without the one being answered", () => {
    const prompt = carryOverPrompt(db, "sam", "Sam", "Not the second one. Make it shorter.");
    assert.match(prompt, /^## Where you left off/);
    assert.match(prompt, /## Now$/);
    assert.ok(!prompt.includes("Make it shorter"), "the input itself isn't repeated");
    const lines = prompt.split("\n").filter((l) => l.startsWith("["));
    assert.equal(lines.length, 12);
    assert.match(lines.at(-1)!, /^\[You \(Sam\)\]: Here are two: \[block\] Pick one\.$/, "a long block is folded");
    assert.match(lines[0]!, /message 9/);
  });

  check("a session is closed well before the model's window fills", () => {
    assert.ok(SESSION_ROTATE_TOKENS >= 80_000 && SESSION_ROTATE_TOKENS <= 150_000);
  });
} finally {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall session checks passed" : `\n${failures} session check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
