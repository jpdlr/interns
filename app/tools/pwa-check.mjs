/**
 * Standalone-PWA layout checks for the exported web build.
 *
 * Runs the exported bundle in headless Chromium at a real iPhone 390x844 and
 * proves the home-screen layout is right, in both display modes:
 *
 *   MODE=standalone  display-mode: standalone, safe-area insets 59 / 34
 *   MODE=browser     display-mode: browser,    safe-area insets 0 / 0
 *
 * Safe-area insets come from CDP (Emulation.setSafeAreaInsetsOverride), so the
 * page's own env() resolution is exercised rather than a stub.
 *
 * THERE IS DELIBERATELY NO KEYBOARD EMULATION HERE ANY MORE. Earlier rounds
 * drove a fake window.visualViewport to prove the JS keyboard compensation
 * tracked iOS frame by frame. It passed, three times, and failed on the real
 * phone every time — headless Chromium simply cannot reproduce how iOS moves a
 * page around its keyboard, so a green run meant nothing. The app now has no
 * keyboard code at all: iOS pans the page natively. What this tool checks
 * instead is *structural* — that nothing in the shipped bundle listens to
 * visualViewport, that the app box is untransformed, and that the composer is
 * in ordinary document flow. Real keyboard behaviour is verified on-device.
 *
 * Every screenshot is a full 390x844 frame with the status bar and home
 * indicator drawn on top, so a frame is exactly what the phone shows.
 *
 *   npm run mock &                       # serves dist/ + the API on 7811
 *   PW_MODULES=/tmp/verify/node_modules MODE=standalone node tools/pwa-check.mjs
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
const SHOTS = process.env.SHOTS ?? `./verify/round6/${MODE}`;

const W = 390;
const H = 844;
const INSET_TOP = STANDALONE ? 59 : 0;
const INSET_BOTTOM = STANDALONE ? 34 : 0;

mkdirSync(SHOTS, { recursive: true });

const results = [];
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `\n       ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ setup */

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ["--no-sandbox"] });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

/**
 * Instrument before any app code runs: every addEventListener on
 * visualViewport, and every keyboard-shaped listener on window, is recorded.
 * This is the structural proof that the keyboard machinery is gone — it
 * catches a listener wherever it is registered, including inside the bundle.
 */
await context.addInitScript(
  ({ api }) => {
    localStorage.setItem(
      "interns.settings.v1",
      JSON.stringify({ baseUrl: api, token: "test-token-abc" }),
    );

    window.__listeners = { visualViewport: [], window: [] };
    if (window.visualViewport) {
      const vvAdd = window.visualViewport.addEventListener.bind(window.visualViewport);
      window.visualViewport.addEventListener = function (type, ...rest) {
        window.__listeners.visualViewport.push({ type, stack: new Error().stack });
        return vvAdd(type, ...rest);
      };
    }
    const winAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, ...rest) {
      window.__listeners.window.push(type);
      return winAdd(type, ...rest);
    };
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

/**
 * Full-frame screenshot with the iOS furniture drawn on top: the status bar
 * region and the home indicator. Anything the app fails to cover shows through
 * as bare background.
 */
async function shot(name) {
  await page.evaluate(
    ({ top, bottom, H }) => {
      document.getElementById("pwa-check-overlay")?.remove();
      const host = document.createElement("div");
      host.id = "pwa-check-overlay";
      host.style.cssText =
        "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
      const box = (css, html) => {
        const d = document.createElement("div");
        d.style.cssText = css;
        if (html) d.innerHTML = html;
        host.appendChild(d);
        return d;
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
  await page.evaluate(() => document.getElementById("pwa-check-overlay")?.remove());
}

/** Tabs are clicked by position in the tablist: the inactive scenes stay
 * mounted, so their titles also match "Crew"/"Settings" by text. */
const tab = (i) => page.locator('[role="tablist"] a').nth(i);

const rect = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  }, sel);

const textRect = (text) =>
  page.evaluate((t) => {
    for (const el of document.querySelectorAll("div,span,p")) {
      if (el.textContent?.trim() !== t) continue;
      if (el.querySelector("div,span,p")) continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    }
    return null;
  }, text);

/** Title of the tab screen actually on screen (others stay mounted). */
const visibleTitle = (text) =>
  page.evaluate((t) => {
    const hits = [...document.querySelectorAll("div,span,p")].filter(
      (el) => el.textContent?.trim() === t && !el.querySelector("div,span,p"),
    );
    // The tab bar label is the small one; the screen title is the display text.
    let best = null;
    for (const el of hits) {
      const r = el.getBoundingClientRect();
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (!r.height || size < 20) continue;
      if (!best || r.top < best.top) best = { top: r.top, bottom: r.bottom, height: r.height };
    }
    return best;
  }, text);

/** The composer bar has no divider by design; target its stable test id. */
const composerBar = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-composer-bar"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      position: cs.position,
      transform: cs.transform,
    };
  });

/**
 * Top of the thread header. The crew list stays mounted under the thread and
 * has a "Milo" row of its own at y~650, so we take the topmost match: the
 * header when it is where it belongs, and still far above the crew row even if
 * a void has pushed it down.
 */
const threadHeaderTop = () =>
  page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll("div,span,p")) {
      if (el.textContent?.trim() !== "Milo") continue;
      if (el.querySelector("div,span,p")) continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      if (best === null || r.top < best) best = r.top;
    }
    return best;
  });

/* ----------------------------------------------- 1. crew: status bar + tabs */

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.getByText("Coordinator", { exact: true }).first().waitFor({ timeout: 25000 });
await page.waitForTimeout(800);

const env = await page.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;padding-top:env(safe-area-inset-top);" +
    "padding-bottom:env(safe-area-inset-bottom);visibility:hidden";
  document.body.appendChild(probe);
  const p = getComputedStyle(probe);
  const out = {
    envTop: parseFloat(p.paddingTop) || 0,
    envBottom: parseFloat(p.paddingBottom) || 0,
    rootPadTop: parseFloat(getComputedStyle(document.getElementById("root")).paddingTop) || 0,
  };
  probe.remove();
  return out;
});
check(
  "env() insets resolve as emulated, and #root pays the top one",
  env.envTop === INSET_TOP && env.envBottom === INSET_BOTTOM && env.rootPadTop === INSET_TOP,
  `env top=${env.envTop} bottom=${env.envBottom}, #root padding-top=${env.rootPadTop}`,
);

const crew = await textRect("Crew");
// The connection pill only shows when the stream is unhealthy; check it when present.
const pill =
  (await textRect("Delayed")) ?? (await textRect("Offline")) ?? (await textRect("Connecting…"));
const hire = await rect('[aria-label="Hire an intern"]');
check(
  "crew header clears the status bar",
  crew && hire && crew.top >= INSET_TOP && (!pill || pill.top >= INSET_TOP) && hire.top >= INSET_TOP,
  `title top=${crew?.top} pill top=${pill?.top} + button top=${hire?.top} (status bar ends at ${INSET_TOP})`,
);

const tabs = await page.evaluate(() => {
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist) return null;
  const bar = tablist.parentElement; // the styled bar; tablist is its content row
  const br = bar.getBoundingClientRect();
  const labels = ["Crew", "Today", "Settings"].map((t) => {
    const el = [...tablist.querySelectorAll("div,span")].find(
      (e) => e.textContent?.trim() === t && !e.querySelector("div,span"),
    );
    const r = el?.getBoundingClientRect();
    const cs = el ? getComputedStyle(el) : null;
    return {
      text: t,
      top: r?.top,
      bottom: r?.bottom,
      height: r?.height,
      fontSize: cs ? parseFloat(cs.fontSize) : 0,
      scrollH: el?.scrollHeight,
    };
  });
  return { bar: { top: br.top, bottom: br.bottom, height: br.height }, labels };
});

check(
  "tab bar reaches the bottom of the screen (no dead band under it)",
  tabs && near(tabs.bar.bottom, H, 1.5),
  `bar ${tabs?.bar.top?.toFixed(1)}..${tabs?.bar.bottom?.toFixed(1)} (h=${tabs?.bar.height?.toFixed(1)}), screen bottom ${H}`,
);
check(
  "tab labels are drawn at full height (not clipped)",
  tabs && tabs.labels.every((l) => l.height >= l.fontSize + 1 && l.height >= l.scrollH - 0.5),
  tabs?.labels
    .map((l) => `${l.text} h=${l.height?.toFixed(1)} (needs >=${(l.fontSize + 1).toFixed(0)}, content ${l.scrollH})`)
    .join(", "),
);
// The safe-area band begins well above the physical indicator. The tab items
// receive a deliberate 4px optical nudge into that band, while retaining 4px
// clearance from the indicator itself (drawn by shot() at H - 12).
const homeIndicatorLimit = INSET_BOTTOM ? H - 16 : H;
check(
  "tab labels sit above the home indicator",
  tabs && tabs.labels.every((l) => l.bottom <= homeIndicatorLimit + 0.5),
  tabs?.labels.map((l) => `${l.text} bottom=${l.bottom?.toFixed(1)}`).join(", ") +
    ` (label limit ${homeIndicatorLimit})`,
);

await shot("01-crew");

await tab(1).click();
await page.waitForTimeout(700);
await shot("02-today");
const inboxTitle = await visibleTitle("Today");
await tab(2).click();
await page.waitForTimeout(700);
await shot("03-settings");
const settingsTitle = await visibleTitle("Settings");
check(
  "every tab screen's title clears the status bar",
  inboxTitle && settingsTitle && inboxTitle.top >= INSET_TOP && settingsTitle.top >= INSET_TOP,
  `today title top=${inboxTitle?.top} settings title top=${settingsTitle?.top}`,
);

/* -------------------------------------------- 2. thread, keyboard CLOSED */

await tab(0).click();
await page.getByText("Coordinator", { exact: true }).first().waitFor({ timeout: 15000 });
await page.getByText("Milo", { exact: true }).first().click();
await page.getByText("Morning — anything owed today?").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);

const closedRoot = await rect("#root");
const closedHeaderTop = await threadHeaderTop();
const closedComposer = await composerBar();
const listRect = await page.evaluate(() => {
  const el = document.querySelector("textarea, input[type=text]");
  // The scroller is the tall overflow:auto box above the composer.
  for (const n of document.querySelectorAll("div")) {
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    if (r.height > 300 && (cs.overflowY === "auto" || cs.overflowY === "scroll") && !n.contains(el)) {
      return { top: r.top, bottom: r.bottom, scrollTop: n.scrollTop, scrollH: n.scrollHeight, clientH: n.clientHeight };
    }
  }
  return null;
});

check(
  "thread (keyboard closed): app box is exactly the screen, top to bottom",
  closedRoot && near(closedRoot.top, 0, 0.5) && near(closedRoot.bottom, H, 1.5),
  `#root ${closedRoot?.top?.toFixed(1)}..${closedRoot?.bottom?.toFixed(1)}, screen 0..${H}`,
);
check(
  "thread (keyboard closed): header sits at the top, no void above it",
  closedHeaderTop !== null && closedHeaderTop >= INSET_TOP && closedHeaderTop <= INSET_TOP + 40,
  `header "Milo" top=${closedHeaderTop?.toFixed(1)} (expected just under ${INSET_TOP}; a void would push it far lower)`,
);
check(
  "thread (keyboard closed): composer sits on the bottom edge",
  closedComposer && near(closedComposer.bottom, H, 1.5),
  `composer bar bottom=${closedComposer?.bottom?.toFixed(1)}, screen bottom ${H}`,
);
check(
  "thread (keyboard closed): list fills the gap between header and composer (no void)",
  listRect && closedComposer && listRect.bottom <= closedComposer.top + 1.5 &&
    listRect.bottom >= closedComposer.top - 1.5,
  `list ${listRect?.top?.toFixed(1)}..${listRect?.bottom?.toFixed(1)}, composer top=${closedComposer?.top?.toFixed(1)}`,
);
check(
  "thread: opens pre-scrolled to the newest message",
  listRect && listRect.scrollTop >= listRect.scrollH - listRect.clientH - 4,
  `scrollTop=${listRect?.scrollTop} of max ${listRect ? listRect.scrollH - listRect.clientH : "?"}`,
);
await shot("04-thread-keyboard-closed");

/* ----------------------- 3. STRUCTURAL: the keyboard machinery is really gone */

// The old machinery shipped as an inline <script> in the HTML shell, so the
// exported document itself is worth asserting on directly.
const shellScripts = await page.evaluate(() =>
  [...document.querySelectorAll("script:not([src])")].map((s) => s.textContent ?? "").join("\n"),
);
check(
  "the exported HTML shell carries no inline viewport script",
  !/visualViewport|--app-height|--app-offset-top|--kb-height|requestAnimationFrame/.test(shellScripts),
  `${shellScripts.length} bytes of inline script in the shell`,
);

const structure = await page.evaluate(() => {
  const root = document.getElementById("root");
  const rootCs = getComputedStyle(root);
  const bodyCs = getComputedStyle(document.body);
  const htmlCs = getComputedStyle(document.documentElement);
  const custom = (n) => htmlCs.getPropertyValue(n).trim();
  return {
    listeners: window.__listeners,
    rootPosition: rootCs.position,
    rootTransform: rootCs.transform,
    rootHeight: rootCs.height,
    bodyPosition: bodyCs.position,
    bodyOverscroll: bodyCs.overscrollBehavior || bodyCs.overscrollBehaviorY,
    htmlOverscroll: htmlCs.overscrollBehavior || htmlCs.overscrollBehaviorY,
    appHeightVar: custom("--app-height"),
    appOffsetVar: custom("--app-offset-top"),
    kbVar: custom("--kb-height"),
    kbGlobal: typeof window.__internsKeyboard,
  };
});

/**
 * react-native-web's own Dimensions module registers exactly one
 * visualViewport 'resize' listener, unconditionally, at import time — it is how
 * Dimensions.get('window') stays current. Nothing in this app reads window
 * dimensions for layout (verified: driving a fake visualViewport down to
 * keyboard height moves #root, the header and the composer by 0px), so that
 * listener is inert here. Anything BEYOND it is app code reintroducing the
 * keyboard machinery, which is what this check exists to catch.
 */
const vvTypes = structure.listeners.visualViewport.map((l) => l.type);
check(
  "no app visualViewport listener (only react-native-web's inert Dimensions resize)",
  vvTypes.length === 1 && vvTypes[0] === "resize",
  `visualViewport listeners: [${vvTypes.join(", ") || "none"}] ` +
    `(exactly one 'resize' expected, from react-native-web Dimensions)`,
);
const kbWindowEvents = structure.listeners.window.filter((t) =>
  ["focusin", "focusout", "orientationchange", "pageshow"].includes(t),
);
check(
  "no keyboard-shaped window listener (focusin/focusout/orientationchange/pageshow)",
  kbWindowEvents.length === 0,
  `window listeners: [${structure.listeners.window.join(", ") || "none"}]`,
);
check(
  "the app box is in normal flow: no transform, not fixed",
  structure.rootTransform === "none" && structure.rootPosition !== "fixed",
  `#root position=${structure.rootPosition} transform=${structure.rootTransform} height=${structure.rootHeight}`,
);
check(
  "body is not pinned; rubber-band is killed with overscroll-behavior instead",
  structure.bodyPosition !== "fixed" &&
    (structure.bodyOverscroll === "none" || structure.htmlOverscroll === "none"),
  `body position=${structure.bodyPosition}, overscroll-behavior body=${structure.bodyOverscroll} html=${structure.htmlOverscroll}`,
);
check(
  "the old geometry custom properties are gone",
  !structure.appHeightVar && !structure.appOffsetVar && !structure.kbVar &&
    structure.kbGlobal === "undefined",
  `--app-height="${structure.appHeightVar}" --app-offset-top="${structure.appOffsetVar}" ` +
    `--kb-height="${structure.kbVar}" window.__internsKeyboard=${structure.kbGlobal}`,
);
check(
  "the composer is in normal flow (not transformed, not JS-positioned)",
  closedComposer && closedComposer.transform === "none" &&
    ["static", "relative", "sticky"].includes(closedComposer.position),
  `composer bar position=${closedComposer?.position} transform=${closedComposer?.transform}`,
);

/**
 * The one allowed nicety: focusing the composer schedules a single scroll to
 * the bottom ~300ms later. Nothing else may move. We focus, wait past the
 * delay, and assert the layout is byte-for-byte where it was — Chromium has no
 * on-screen keyboard, so any movement here would be the app's own doing.
 */
await page.locator("textarea, input[type=text]").last().click();
await page.waitForTimeout(900);
const afterFocusRoot = await rect("#root");
const afterFocusComposer = await composerBar();
const afterFocusHeader = await threadHeaderTop();
check(
  "focusing the composer moves no layout by itself (only the list scrolls)",
  afterFocusRoot && afterFocusComposer &&
    near(afterFocusRoot.top, closedRoot.top, 0.5) &&
    near(afterFocusRoot.bottom, closedRoot.bottom, 0.5) &&
    near(afterFocusComposer.bottom, closedComposer.bottom, 0.5) &&
    near(afterFocusHeader, closedHeaderTop, 0.5),
  `#root ${afterFocusRoot?.top?.toFixed(1)}..${afterFocusRoot?.bottom?.toFixed(1)} ` +
    `(was ${closedRoot?.top?.toFixed(1)}..${closedRoot?.bottom?.toFixed(1)}), ` +
    `composer bottom=${afterFocusComposer?.bottom?.toFixed(1)} (was ${closedComposer?.bottom?.toFixed(1)}), ` +
    `header top=${afterFocusHeader?.toFixed(1)} (was ${closedHeaderTop?.toFixed(1)})`,
);
await shot("05-thread-composer-focused");

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n--- ${MODE}: ${results.length - failed.length}/${results.length} passed, shots in ${SHOTS} ---`);
console.log(
  "NOTE: real iOS keyboard behaviour is delegated to the platform and is NOT " +
    "tested here. Emulation cannot reproduce it; verify on-device.",
);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.name}`);
  process.exit(1);
}
