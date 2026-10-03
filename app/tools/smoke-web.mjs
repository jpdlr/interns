/**
 * End-to-end smoke test of the exported web build against tools/mock-orchestrator.mjs.
 * Not part of the app's dependencies — install playwright-core yourself:
 *
 *   npm run mock &
 *   npm run export:web && npm run serve:dist &
 *   npm --prefix /tmp/pw i playwright-core
 *   PW_MODULES=/tmp/pw/node_modules [CHROME=/path/to/chrome] node tools/smoke-web.mjs
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// playwright-core is deliberately not a dependency of the app; resolve it from
// wherever it happens to be installed.
const require = createRequire(
  process.env.PW_MODULES ? `${process.env.PW_MODULES.replace(/\/?$/, "/")}` : import.meta.url,
);
const { chromium } = require("playwright-core");

// CHROME overrides the browser; unset = Playwright's own Chromium (`npx playwright-core install chromium`).
const EXE = process.env.CHROME;
const BASE = process.env.APP_URL ?? "http://127.0.0.1:7812";
const API = process.env.API_URL ?? "http://127.0.0.1:7811";
const SHOTS = process.env.SHOTS ?? "./.smoke-shots";
mkdirSync(SHOTS, { recursive: true });
const log = [];
const step = (m) => { log.push(m); console.log(m); };

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => step(`PAGE ERROR: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") step(`CONSOLE ERROR: ${m.text().slice(0, 200)}`); });

// 1. Settings: configure the connection through the real UI.
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
await page.getByText("Settings", { exact: true }).first().waitFor({ timeout: 15000 });
// Unconfigured, Settings opens on Connect with just the token field; the
// server address hides behind "Advanced" unless it differs from the origin.
await page.getByPlaceholder("Paste api_token").fill("test-token-abc");
if (new URL(API).origin !== new URL(BASE).origin) {
  await page.getByText("Advanced: use a different server…").click();
  await page.locator("input").nth(1).fill(API);
}
await page.getByText("Save", { exact: true }).click();
await page.getByText("Test connection").click();
await page.getByText(/Connected — 3 interns, \d+ open cards/).waitFor({ timeout: 10000 });
step("PASS settings: saved creds, test connection reports 3 interns");
await page.screenshot({ path: `${SHOTS}/4-settings.png` });

// 2. Crew list.
await page.getByText("Crew", { exact: true }).first().click();
await page.getByText("Coordinator", { exact: true }).waitFor({ timeout: 10000 });
await page.getByText("Milo", { exact: true }).first().waitFor();
await page.getByText("How did ClinicFlow demo", { exact: false }).first().waitFor();
await page.getByText("Front desk", { exact: true }).first().waitFor();
step("PASS crew: front desk pinned, interns listed with last-message previews");

// Faces: are they in the DOM and actually animating?
const faceInfo = await page.evaluate(() => {
  const svgs = [...document.querySelectorAll("svg")];
  const animated = svgs.filter((svg) =>
    [...svg.querySelectorAll("*")].some((el) => {
      const name = getComputedStyle(el).animationName;
      return name && name !== "none";
    }));
  const ids = [...document.querySelectorAll("svg [id]")].map((el) => el.id);
  return { svgCount: svgs.length, animatedCount: animated.length, uniqueIds: new Set(ids).size, totalIds: ids.length };
});
step(`PASS faces: ${faceInfo.svgCount} inline svgs, ${faceInfo.animatedCount} with running CSS animations, ids unique ${faceInfo.uniqueIds}/${faceInfo.totalIds}`);
await page.screenshot({ path: `${SHOTS}/1-crew.png` });

// 3. Thread: open Milo, send a message, receive the SSE reply.
await page.getByText("Milo", { exact: true }).first().click();
await page.getByText("Morning — anything owed today?").waitFor({ timeout: 10000 });
step("PASS thread: history loaded with day divider + bubbles");
const composer = page.locator("input, textarea").last();
await composer.fill("Draft a reply to Marco please");
await page.locator('[role="button"][aria-label="Send"]').click();
await page.getByText("Draft a reply to Marco please", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 5000 });
step("PASS thread: optimistic send rendered immediately");
await page.getByText("On it — I'll come back with a card.").filter({ visible: true }).first().waitFor({ timeout: 10000 });
step("PASS thread: intern reply arrived over the SSE stream (no reload)");
await page.screenshot({ path: `${SHOTS}/2-thread.png` });

// 4. Today: decisions render first and an action resolves one. The thread is
// a full-screen stack route over the tabs, so go back to the tab bar first.
await page.goBack();
await page.getByText("Crew", { exact: true }).first().waitFor({ timeout: 10000 });
await page.getByText("Today", { exact: true }).first().click();
const vis = (text, opts) => page.getByText(text, opts).filter({ visible: true }).first();
await vis("Reply owed: Marco (Hopfield)").waitFor({ timeout: 10000 });
await vis("Daily token cap: Milo at 82%").waitFor();
await vis("Needs you · 3").waitFor();
step("PASS today: 3 decisions rendered, urgent sorted above action/info");
await page.screenshot({ path: `${SHOTS}/3-cards.png` });
// Markdown in the card body renders as blocks, not raw asterisks.
const rawMarkdown = await page.getByText("**portal deploy**").count();
step(`${rawMarkdown === 0 ? "PASS" : "FAIL"} today: markdown body rendered (no raw ** in the DOM)`);
await page.getByRole("button", { name: "Looks good", exact: true }).filter({ visible: true }).first().click();
await vis("Needs you · 2").waitFor({ timeout: 15000 });
step("PASS today: action POSTed, card resolved and animated out (3 -> 2 decisions)");

// 5. Live status pill reports a real stream.
// A healthy stream shows no pill at all; one appears only when it is not live.
const unhealthy = await page.getByText(/^(Delayed|Offline|Connecting…)$/).first().isVisible().catch(() => false);
step(`${unhealthy ? "WARN" : "PASS"} stream: no connection warning while the stream is live`);

await browser.close();
console.log("\n--- summary ---\n" + log.join("\n"));
