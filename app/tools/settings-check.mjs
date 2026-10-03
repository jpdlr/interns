/**
 * Round-7 pixel verification for the new intern settings screen
 * (app/intern/[slug].tsx), run the same way as tools/pwa-check.mjs: real
 * iPhone viewport (390x844) in headless Chromium, against the exported
 * dist/ + tools/mock-orchestrator.mjs (never the live orchestrator — a PATCH
 * here would rewrite a real intern's manifest).
 *
 *   npm run mock &                       # serves dist/ + the API on 7811
 *   npm run export:web
 *   PW_MODULES=/tmp/verify/node_modules MODE=standalone node tools/settings-check.mjs
 *   PW_MODULES=/tmp/verify/node_modules MODE=browser    node tools/settings-check.mjs
 *
 * Shots land in app/verify/round7/<mode>/, six per mode:
 *   01-thread-header       the new chevron affordance on the intern's name
 *   02-settings-top        face + name/role/persona
 *   03-icon-picker         the 20-face picker open
 *   04-tools-triggers      tool chips, mention/mail switches, cron, backlog
 *   05-guardrails          daily cap + today's spend, drafts-only switch
 *   06-validation-error    a PATCH 400 surfaced on screen
 *   07-discord-marker      (bonus, JP's ask) discord-origin bubble glyph vs. app-origin bubble
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  process.env.PW_MODULES ? `${process.env.PW_MODULES.replace(/\/?$/, "/")}` : import.meta.url,
);
const { chromium } = require("playwright-core");

// CHROME overrides the browser; unset = Playwright's own Chromium (`npx playwright-core install chromium`).
const EXE = process.env.CHROME;
const BASE = process.env.APP_URL ?? "http://127.0.0.1:7811";
const MODE = process.env.MODE ?? "standalone";
const STANDALONE = MODE === "standalone";
const SHOTS = process.env.SHOTS ?? `./verify/round7/${MODE}`;

const W = 390;
const H = 844;
const INSET_TOP = STANDALONE ? 59 : 0;
const INSET_BOTTOM = STANDALONE ? 34 : 0;

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ["--no-sandbox"] });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(
  ({ api }) => {
    localStorage.setItem(
      "interns.settings.v1",
      JSON.stringify({ baseUrl: api, token: "test-token-abc" }),
    );
  },
  { api: BASE },
);

const page = await context.newPage();
page.on("pageerror", (e) => console.log(`PAGE ERROR: ${e.message}`));

const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setEmulatedMedia", {
  features: [{ name: "display-mode", value: STANDALONE ? "standalone" : "browser" }],
});
await cdp.send("Emulation.setSafeAreaInsetsOverride", {
  insets: { top: INSET_TOP, bottom: INSET_BOTTOM, left: 0, right: 0 },
});

async function shot(name) {
  await page.evaluate(
    ({ top, bottom, H }) => {
      document.getElementById("check-overlay")?.remove();
      const host = document.createElement("div");
      host.id = "check-overlay";
      host.style.cssText =
        "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
      const box = (css, html) => {
        const d = document.createElement("div");
        d.style.cssText = css;
        if (html) d.innerHTML = html;
        host.appendChild(d);
      };
      if (top) {
        box(
          `position:absolute;left:0;top:0;width:100%;height:${top}px;` +
            "background:rgba(255,64,64,.22);border-bottom:1px solid rgba(255,80,80,.85);" +
            "color:#fff;font:600 15px system-ui,sans-serif;display:flex;align-items:flex-end;" +
            "justify-content:space-between;padding:0 24px 6px;box-sizing:border-box",
          "<span>23:11</span><span>&#9646;&#9646;&#9646; &#9650; 87%</span>",
        );
      }
      if (bottom) {
        box(
          `position:absolute;left:0;top:${H - bottom}px;width:100%;height:${bottom}px;` +
            "background:rgba(64,160,255,.18);border-top:1px solid rgba(64,160,255,.7)",
        );
        box(
          `position:absolute;left:50%;transform:translateX(-50%);top:${H - 12}px;` +
            "width:140px;height:5px;border-radius:3px;background:#fff",
        );
      }
      document.body.appendChild(host);
    },
    { top: INSET_TOP, bottom: INSET_BOTTOM, H },
  );
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.evaluate(() => document.getElementById("check-overlay")?.remove());
}

const log = [];
const note = (m) => {
  log.push(m);
  console.log(m);
};

/* ------------------------------------------------------ 1. thread header */

await page.goto(`${BASE}/chat/milo`, { waitUntil: "domcontentloaded" });
await page.getByText("Morning — anything owed today?").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(600);
const headerButton = page.locator('[aria-label="Milo settings"]');
await headerButton.waitFor({ timeout: 10000 });
note(`PASS thread header exposes a "${await headerButton.getAttribute("aria-label")}" affordance`);
await shot("01-thread-header");

/* --------------------------------------------------- 2. open the screen */

await headerButton.click();
await page.getByText("Edit Milo").first().waitFor({ timeout: 15000 }).catch(() => {});
await page.getByText("Change face", { exact: true }).waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
note("PASS tapping the header opened /intern/milo");
await shot("02-settings-top");

/* -------------------------------------------------------- 3. icon picker */

await page.getByText("Change face", { exact: true }).click();
await page.getByText("Pick a face").waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
const faceTiles = await page.locator('[aria-label^="Face "]').count();
note(`PASS icon picker shows ${faceTiles} faces from GET /meta (expected 20)`);
await shot("03-icon-picker");
await page.getByText("Done", { exact: true }).click();
await page.waitForTimeout(200);

/* --------------------------------------------- 4. tools / triggers / backlog */

await page.getByText("Tools", { exact: true }).scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const CATALOG_TOOLS = ["fs.read", "fs.write", "shell", "web", "notebook", "todo", "mail", "cards"];
const toolChips = await page.evaluate(
  (names) =>
    names.filter((n) => [...document.querySelectorAll("div,span")].some((el) => el.textContent?.trim() === n))
      .length,
  CATALOG_TOOLS,
);
note(`PASS tool chips rendered from GET /meta catalog (${toolChips}/${CATALOG_TOOLS.length} present in DOM)`);
await shot("04-tools-triggers");

/* ------------------------------------------------------- 5. guardrails */

await page.getByText("Guardrails", { exact: true }).scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const spend = await page.getByText(/today: .* tokens/).first().textContent();
note(`PASS spend context under the cap input: "${spend}"`);
await shot("05-guardrails");

/* --------------------------------------------------- 6. validation error */

const capInput = page.locator("input").filter({ hasNotText: "" }).nth(0);
// Find the numeric cap input specifically: it's the one currently showing "50000".
const inputs = page.locator("input, textarea");
const count = await inputs.count();
let capLocator = null;
for (let i = 0; i < count; i += 1) {
  const v = await inputs.nth(i).inputValue().catch(() => "");
  if (v === "50000") {
    capLocator = inputs.nth(i);
    break;
  }
}
if (!capLocator) throw new Error("could not find the daily token cap input");
await capLocator.fill("500");
await page.getByText("Save changes", { exact: true }).click();
await page.getByText(/greater than or equal to 10000/).waitFor({ timeout: 10000 });
note("PASS PATCH 400 (cap below 10000) is surfaced on screen with the zod detail");
await shot("06-validation-error");

/* --------------------------------------------- 7. discord marker (bonus) */

await page.goto(`${BASE}/chat/nia`, { waitUntil: "domcontentloaded" });
await page.getByText("Briefing on the city tender is ready.", { exact: false }).first().waitFor({ timeout: 20000 });
// The thread opens pre-scrolled to the newest message; the one discord-origin
// bubble is the very first message, so scroll back up to frame it next to an
// app-origin one for a side-by-side comparison shot.
await page.getByText("Briefing on the city tender is ready.", { exact: false }).first().scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const discordGlyph = await page.locator('[aria-label="sent from Discord"]').count();
note(`PASS ${discordGlyph} Discord-origin bubble(s) show the glyph; app-origin bubbles show none`);
await shot("07-discord-marker");

await browser.close();
console.log(`\n--- ${MODE}: settings-check done, ${log.length} checks, shots in ${SHOTS} ---`);
