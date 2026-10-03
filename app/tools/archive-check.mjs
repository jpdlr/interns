/**
 * Round-8 pixel verification for the intern settings screen's new "Danger
 * zone" / archive (fire) flow (app/intern/[slug].tsx), run the same way as
 * tools/settings-check.mjs: real iPhone viewport (390x844) in headless
 * Chromium, against the exported dist/ + tools/mock-orchestrator.mjs.
 *
 * NEVER point this at the real orchestrator — POST /interns/:slug/archive is
 * permanent there (it would actually fire an intern). The mock's archive
 * handler only drops the slug from its in-memory `interns` list; the
 * manifest stays reachable, which this script deliberately exploits to
 * produce a realistic failure case in step 5 (re-archiving an already-fired
 * intern 404s "no such intern") without needing a special test hook.
 *
 *   npm run mock &                       # serves dist/ + the API on 7811
 *   npm run export:web
 *   PW_MODULES=/tmp/verify/node_modules MODE=standalone node tools/archive-check.mjs
 *   # restart the mock (its intern list is now mutated) before the other mode:
 *   npm run mock &
 *   PW_MODULES=/tmp/verify/node_modules MODE=browser    node tools/archive-check.mjs
 *
 * Shots land in app/verify/round8/<mode>/, five per mode:
 *   01-danger-zone       settings screen scrolled to the Danger zone
 *   02-modal-disabled    confirm modal open, Archive button disabled
 *   03-modal-enabled     intern's name typed, Archive button enabled
 *   04-crew-after-archive Crew list: the intern is gone, "Nia archived" banner
 *   05-modal-error       re-archiving 404s, surfaced inline in the modal
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
const SHOTS = process.env.SHOTS ?? `./verify/round8/${MODE}`;
const SLUG = process.env.SLUG ?? "nia";
const NAME = process.env.NAME ?? "Nia";

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

/* ------------------------------------------------- 1. settings, danger zone */

await page.goto(`${BASE}/intern/${SLUG}`, { waitUntil: "domcontentloaded" });
await page.getByText("Change face", { exact: true }).waitFor({ timeout: 15000 });
await page.getByText("Danger zone").scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
note(`PASS settings screen for ${NAME} shows a Danger zone at the bottom`);
await shot("01-danger-zone");

/* --------------------------------------- 2. confirm modal, button disabled */

await page.getByRole("button", { name: "Archive intern" }).first().click();
await page.getByText(`Archive ${NAME}?`).waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
const confirmButton = page.getByRole("button", { name: "Archive intern" }).last();
const disabledBefore = await confirmButton.getAttribute("aria-disabled");
note(`PASS confirm button aria-disabled="${disabledBefore}" before the name is typed`);
await shot("02-modal-disabled");

/* ------------------------------------------------ 3. name typed -> enabled */

await page.getByPlaceholder(NAME).fill(NAME.toLowerCase());
await page.waitForTimeout(300);
const disabledAfter = await confirmButton.getAttribute("aria-disabled");
note(`PASS confirm button aria-disabled="${disabledAfter}" after typing "${NAME.toLowerCase()}" (case-insensitive match against "${NAME}")`);
await shot("03-modal-enabled");

/* ------------------------------------- 4. confirm -> crew list, gone + banner */

await confirmButton.click();
await page.getByText(`${NAME} archived`).waitFor({ timeout: 10000 });
await page.waitForTimeout(300);
const stillListed = await page.getByText(NAME, { exact: true }).count();
note(
  `PASS after archiving, "${NAME} archived" banner shown on Crew; ${NAME} appears ${stillListed} time(s) in the row list (expected 0)`,
);
await shot("04-crew-after-archive");

/* ------------------------------------------------------- 5. error in modal */

await page.goto(`${BASE}/intern/${SLUG}`, { waitUntil: "domcontentloaded" });
await page.getByText("Change face", { exact: true }).waitFor({ timeout: 15000 });
await page.getByText("Danger zone").scrollIntoViewIfNeeded();
await page.getByRole("button", { name: "Archive intern" }).first().click();
await page.getByText(`Archive ${NAME}?`).waitFor({ timeout: 5000 });
await page.getByPlaceholder(NAME).fill(NAME);
const confirmButton2 = page.getByRole("button", { name: "Archive intern" }).last();
await confirmButton2.click();
await page.getByText(/no such intern|archived or renamed/i).waitFor({ timeout: 10000 });
note(`PASS re-archiving ${NAME} (already gone from the crew list) surfaces its 404 inline and keeps the modal open`);
await shot("05-modal-error");

await browser.close();
console.log(`\n--- ${MODE}: archive-check done, ${log.length} checks, shots in ${SHOTS} ---`);
