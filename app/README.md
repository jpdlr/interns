# Interns — app

The mobile surface for the intern crew: a chat list of interns, threads you can
talk in, a card inbox, and settings. Expo + TypeScript + expo-router, targeting
**web/PWA first** (installed to the iPhone home screen); the codebase stays
native-ready but ships no native-only modules yet.

It renders backend state and nothing else — the orchestrator
(`../orchestrator`, fastify on `127.0.0.1:7810`) is the source of truth, exactly
like the Discord surface.

## Run it

```sh
cd app
npm install
npm run web          # or: npx expo start --web
```

The orchestrator now serves this bundle itself, so in normal use there is
nothing to configure: on web the API base URL defaults to `location.origin`,
which is the same host that served the app. Settings still overrides it for
development (e.g. pointing the Expo dev server at a remote orchestrator).

| field | value |
|---|---|
| API URL | defaults to wherever the app was served from; override for dev |
| API token | `api_token` from `~/.interns/config.json` |

```sh
cat ~/.interns/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["api_token"])'
```

Hit **Test connection** — it reports the intern count and open card count, and
tells you specifically whether the host was unreachable or the token was
rejected. Settings persist in AsyncStorage (localStorage on web); **nothing is
hardcoded**, so the same build works against localhost and Tailscale.

No orchestrator running? `npm run mock` starts a stand-in on `127.0.0.1:7811`
(token `test-token-abc`) with fixture interns, cards and a live SSE stream.

## Talking to the orchestrator

`../orchestrator` is not this app's lane, but two things there had to be right
and now are:

- **CORS** is registered (`@fastify/cors`, `origin: true`), with OPTIONS exempt
  from the auth hook.
- **The SSE route sets its own CORS header.** `GET /events` writes headers
  straight onto `reply.raw`, which bypasses the reply object @fastify/cors
  decorates; without an explicit `Access-Control-Allow-Origin` there the browser
  discarded the stream and Safari reported "Load failed". With it, the pill
  reads `live` — verified against the live API.

If the stream ever breaks again the app degrades instead of dying: two quick
attempts, then a 10s poll, the reason spelled out in Settings, and a quiet retry
every 60s that upgrades back to `live` on its own.

### Re-exporting requires an orchestrator restart (or a one-word fix)

`orchestrator/src/api.ts` registers `@fastify/static` with **`wildcard: false`**,
which walks the directory once at registration and registers one route per file
found. Files that appear later have no route, fall through to the SPA handler
and are answered with `index.html`. Since `expo export` content-hashes the
bundle filename, **every re-export produces a JS file the running server will
not serve** — the shell loads, asks for its bundle, gets HTML back and dies with
`Unexpected token '<'`. New top-level files (`sw.js`, `build.json`) are
swallowed the same way, which is why the observed behaviour is oddly selective:

```
/manifest.json   200 application/json   # existed when the server booted
/build.json      200 text/html          # created afterwards -> SPA fallback
/_expo/static/js/web/entry-<hash>.js
                 200 text/html          # on disk, referenced by the server's
                                        # own index.html, still not served
```

Dropping `wildcard: false` (the default wildcard route stats per request) makes
re-exports live immediately. Until then, restart the orchestrator after each
`npm run export:web`. Not fixed here — `orchestrator/` is not this app's lane.

### Reaching it

The API binds `127.0.0.1` by default. To reach it from your phone, set `bind`
to the machine's Tailscale IP (e.g. `http://100.64.0.10:7810`). For HTTPS (so an HTTPS-served PWA is not blocked
for mixed content) put Tailscale in front:

```sh
tailscale serve --bg --set-path /api 7810   # https://<host>.<tailnet>.ts.net/api
```

## Install on an iPhone

1. Serve the app over HTTPS on the tailnet (e.g. `npm run export:web` then serve
   `dist/`, or `tailscale serve` in front of `npx expo start --web`).
2. Open it in **Safari** (not Chrome — only Safari can install to the home screen).
3. Share → **Add to Home Screen** → Add.

It launches full-screen with no browser chrome, dark status bar, and the
coordinator face as the icon (`+html.tsx` carries `apple-mobile-web-app-capable`
and friends; `public/manifest.json` carries the PWA manifest).

## Verify the web build

```sh
npm run typecheck
npm run export:web       # must succeed — this is the build gate
```

### Standalone-PWA layout checks

`tools/pwa-check.mjs` runs the exported bundle at a real iPhone 390x844 in
headless Chromium and asserts the home-screen layout in both display modes.
Safe-area insets come from CDP (`Emulation.setSafeAreaInsetsOverride`), so the
page's own `env()` resolution is exercised rather than a stub. Every assertion
also produces a full 390x844 screenshot with the status bar and home indicator
drawn on top, in `verify/round6/<mode>/`.

**It no longer emulates the keyboard, on purpose.** Earlier rounds drove a fake
`visualViewport` through the burst of half-finished resize/scroll events iOS
emits, and proved the JS compensation tracked it frame by frame. It passed
three times and failed on the real phone three times — so a green run there
meant nothing. What the tool checks now is *structural*: that the exported
shell has no inline viewport script, that no app code registers a
`visualViewport` or focus/orientation listener, that `#root` is untransformed
and unpinned, that the old `--app-height` / `--app-offset-top` / `--kb-height`
custom properties are gone, and that focusing the composer moves no layout by
itself. Real keyboard behaviour is the platform's and is verified on-device.

(One `visualViewport` `resize` listener does survive: react-native-web's
`Dimensions` module registers it unconditionally at import time. Nothing in
this app reads window dimensions for layout — driving a fake `visualViewport`
down to keyboard height moves `#root`, the header and the composer by 0px — so
it is inert. The check whitelists exactly that one and fails on anything more.)

```sh
npm run mock &                  # serves dist/ + the API on 7811
npm run export:web
PW_MODULES=/tmp/pw/node_modules MODE=standalone npm run check:pwa   # insets 59/34
PW_MODULES=/tmp/pw/node_modules MODE=browser    npm run check:pwa   # insets 0/0
```

Optional end-to-end smoke test in a real browser (needs `playwright-core` and a
Chromium available; installed outside this project so it stays dependency-free):

```sh
npm run mock &
npm run export:web && npm run serve:dist &
npm --prefix /tmp/pw i playwright-core
PW_MODULES=/tmp/pw/node_modules node tools/smoke-web.mjs   # settings -> crew -> thread -> card action
```

## How it is put together

```
app/
  app/                        expo-router routes
    _layout.tsx               providers (settings, live stream), dark nav theme
    +html.tsx                 web HTML shell — PWA + iOS install meta tags
    (tabs)/_layout.tsx        Crew / Today / Settings tab bar
    (tabs)/index.tsx          chat list: front desk pinned, faces, previews, unread
    (tabs)/today.tsx          the day: decisions, schedule + briefs, follow-ups, FYI
    history.tsx               audit timeline of finished work and resolved cards
    page/[id].tsx             a living page full screen (people, board, table, list, draft)
    (tabs)/settings.tsx       API URL + token + connection test
    chat/[slug].tsx           one thread: bubbles, optimistic send, live updates,
                              thinking indicator; plain-flow layout
    hire.tsx                  in-app hiring: prompt -> draft -> edit -> confirm
  src/
    api.ts                    typed orchestrator client + SSE/polling subscribe()
    settings.tsx              credentials in AsyncStorage
    live.tsx                  one shared /events connection, fanned out to screens
    theme.ts                  the design system: colours, spacing, radii, severity
    time.ts                   relative/clock/day-label formatting
    unread.ts                 per-intern last-seen marks
    faces.generated.ts        the 21 animated faces, inlined (npm run gen:faces)
    pwa.tsx                   service worker + build-stamp update handshake
    push.ts                   Web Push subscribe/unsubscribe state (usePushNotifications)
    ui/                       Text, Button, Screen, Bubble, CardView, Markdown,
                              InternFace, Icons, ConnectionPill, Composer,
                              ThinkingIndicator, FacePicker
  assets/faces/*.svg          copies of ../avatars/faces + coordinator
  public/                     manifest.json + PWA icons (copied verbatim to dist/)
  tools/                      mock orchestrator, static server, browser smoke test
  scripts/gen-faces.mjs       bundles assets/faces/*.svg -> src/faces.generated.ts
```

### Design system

One spacing scale (`space`, 4pt), one text component with variants (never a raw
`fontSize`), one palette in `src/theme.ts`. Dark `#0d0f14` family, violet
`#8b5cf6` accent, and the orchestrator's canonical severity colours — info
`#3b82f6`, action `#f59e0b`, urgent `#ef4444` — used for the card edge and
nothing else.

### The live stream

`GET /events` is authenticated with an `Authorization` header, and the
`EventSource` API cannot send headers — so the client streams the response with
`fetch` + `ReadableStream` instead, parsing SSE frames by hand and giving up
immediately on 401 (a bad token will not fix itself).

Anything else — no streaming fetch (React Native), a dead host, or a stream
blocked by missing CORS headers — lands in the same ladder: two quick attempts,
then a 10s poll tick that makes the visible screen refetch, plus a quiet stream
retry every 60s that upgrades back to `live` on its own. Stream events are
debounced into one refresh (`useRefreshSignal`), and tabs that are not on screen
skip it. A healthy stream shows no status pill at all; one appears in the tab
headers only while updates are delayed or offline (a thread shows an offline
banner instead), and Settings › Connect explains why.

### The faces

`../avatars/faces/face-NN.svg` animate with pure CSS keyframes (no SMIL), which
is exactly why they keep moving on iOS Safari in Low Power Mode. `<InternFace>`
injects that markup into the DOM on web so the animation runs, uniquifying the
SVG's internal ids per instance so two copies of one face cannot collide. Every
placement goes through that one component — an `<img>` or a background-image
would freeze the idle loop.

Faces are drawn on transparency: no card, no border, no clipping. They carry
their own drop shadows and their idle loops drift past the nominal viewBox, so a
box both flattens the character and lops the ends off the wider heads. Sizes are
generous enough for the blinking and glancing to read: 48px in the crew list,
40px beside each intern message group, 38px in the thread header.

Interns whose manifest icon is `default` (or unknown) get a stable face hashed
from their slug.

### The thread screen on iOS

**The app does nothing about the keyboard. That is the design.**

Three separate attempts lived here: mirroring `visualViewport.height` into a
custom property, then also `offsetTop` with a transform on the app box, then a
requestAnimationFrame loop coalescing both. Every one of them passed in
emulation and every one of them failed on a real iPhone — the composer
jumping to the top of the screen with a void beneath it on focus. Headless
Chromium cannot reproduce how iOS moves a page around a keyboard, so an
emulated pass here means nothing.

So the screen is boring on purpose:

- `#root` stays in **ordinary document flow** — not fixed, not transformed, no
  listeners. It is `100dvh` in a browser and uses WebKit's standalone `100vh`
  workaround when installed; neither height reacts to the keyboard.
- The thread is plain flexbox: the `ScrollView` takes the slack, the composer
  sits after it. Content is bottom-aligned (`flexGrow: 1` +
  `justifyContent: 'flex-end'`) so a short thread hugs the composer rather than
  floating above a gap.
- When the composer takes focus, **iOS moves the page** to reveal it. That is
  the platform's job and it is good at it.
- The single concession: `onFocus` schedules one `scrollToEnd` on the list
  after 350ms, so the newest message is back in view once iOS has settled. No
  geometry, no measurement, no viewport listeners.

If the keyboard ever misbehaves again, the fix is a CSS or scroll-anchoring
change — do not reintroduce viewport maths.

Threads open pre-scrolled to the newest message with no animation; later growth
glides.

### Installed to the home screen (standalone)

A standalone PWA is a different layout problem from the same app in a Safari
tab, and all of it comes down to who pays the safe-area insets.

- **The status bar.** `apple-mobile-web-app-status-bar-style` is
  `black-translucent`, so the app draws edge-to-edge and `#root` pays
  `env(safe-area-inset-top)` once to clear the clock. On affected WebKit
  versions `100dvh` and `100svh` report the standalone canvas one safe-area
  inset too short (812px on the 874px phone). The shell therefore uses `100vh`
  for `html`, `body`, and `#root` only under `display-mode: standalone`; regular
  browser mode keeps `100dvh`. This is the workaround tracked by WebKit bug
  254868 and keeps the navigator at the physical screen bottom.
- **Nothing else may reserve the status bar.** The root `<Stack>` sets
  `headerStatusBarHeight: 0` on web, because React Navigation would otherwise
  reserve it a *second* time on top of `#root` — which put a whole status bar's
  worth of black void above the thread header.
- **React Navigation owns the tab bar geometry.** The web shell does not fix,
  resize, or pad it. Once the viewport itself is aligned correctly, the
  navigator's standard 49px content row plus the 34px home-indicator inset is
  the expected 83px iOS tab bar—not a custom bar plus a 62px dead strip. Its
  surface and separator are transparent, and its three items receive only a
  4px downward optical nudge; the measured bar and inset remain unchanged.
- **Screens inside the tabs do not pay the bottom inset either** — the tab bar
  is already covering the home indicator, so a list that adds `insets.bottom`
  just leaves a band of dead scroll above the bar. The thread and `hire` screens
  are full-screen stack routes with no tab bar, so they do pay it. While the
  keyboard is up iOS reports the bottom inset as 0 by itself, so that resolves
  without any help from us.

Safe-area insets themselves come from `react-native-safe-area-context`, which
reads `env()` correctly on web via its own probe element; nothing here needs a
second inset mechanism.

### Waiting for a reply

Interns routinely take 30s–2min, so `ThinkingIndicator` has to stay pleasant for
a long time: the face pops in, keeps a livelier bob, a thought bubble breathes
three dots, and after 45s the caption softens to "still working on it" so a slow
reply never reads as a hung screen. It shows while the owner is waiting on a reply they
asked for, or while `GET /interns` reports the intern queued/running *and* the
last word in the thread is still the owner's — without that second half an intern that
stays busy after answering would leave the indicator up forever. A six-minute
safety net hides it if a task dies silently.

### Hiring

The `+` on Crew opens `app/hire.tsx`: you describe a need in your own words,
`POST /hire` expands it into a full manifest (an LLM call — hence the rotating
coordinator wait state), and the draft lands in an editable candidate card. Name,
role, persona and system prompt are editable inline, the face comes from the
20-face animated picker, and Re-roll asks for a different candidate. Only the
Hire button calls `POST /hire/confirm`, which is the one that writes the manifest
and announces the intern — so nothing is created until you have seen it. On success
the app lands in the new intern's thread.

Verified against the mock only, deliberately: a real confirm creates a real
intern and a real Discord channel.

### Staying up to date

`npm run export:web` runs `scripts/stamp-sw.mjs`, which stamps a build id into
`dist/sw.js` and writes `dist/build.json`. Two mechanisms then carry an update
to an installed home-screen app:

- **Service worker** (`public/sw.js`) — network-first for the HTML shell so a
  new build is noticed on launch, cache-first for content-hashed assets under
  `/_expo/` so nothing is re-downloaded, `skipWaiting` + `clientsClaim`, and old
  caches deleted on activate. It explicitly **never** touches
  `/interns`, `/cards`, `/hire` or `/events` — the API shares this origin now,
  and a cached card list or a replayed event stream would be worse than no
  offline support at all.
- **Build stamp poll** — browsers only register a service worker in a secure
  context, and the orchestrator currently serves plain `http://<ip>:7810`, so
  the worker silently does not install there. The app therefore also compares
  the build id it booted with against `/build.json` on focus and every 60s.
  This is what actually delivers updates today; the worker takes over the day
  the origin is HTTPS.

Either path behaves the same way: if the app only just opened it reloads
silently, and if you are mid-session it shows a small "Update ready — tap to
refresh" pill instead of yanking the screen away.

So the flow is: re-export `dist/` → (restart the orchestrator, see above) →
next app open or refocus picks it up.

### Web Push notifications

Your installed PWA buzzes your lock screen when an intern raises a card or
messages you — a card creates one notification (`title: "<Intern>: <card
title>"`, tapping it opens Cards), an intern/coordinator chat message creates
another (title = intern name, tapping it opens that chat), debounced
server-side to at most one message notification per intern per 60s so a
chatty intern can't spam the lock screen. Your own messages never notify.

**iOS 16.4+ only delivers Web Push to a PWA installed to the Home Screen —
never to an ordinary Safari tab.** There is no way around this; it is a
platform restriction, not a bug here. `src/push.ts`'s `usePushNotifications()`
hook detects the iOS-in-a-browser-tab case specifically (`Notification`/
`PushManager` both undefined, but the UA looks like iOS and
`display-mode: standalone`/`navigator.standalone` is false) and the Settings
screen shows the exact fix rather than a generic "not supported":

> Not available in Safari — install this app to your Home Screen first. Share
> (the box with the up arrow) → Add to Home Screen → open Interns from the
> icon it creates, then come back here.

**To enable push on an iPhone:**

1. Install the app to the Home Screen (see "Install on an iPhone" above) —
   push cannot work in a Safari tab at all, installed or not.
2. Open Interns from its Home Screen icon (not from Safari).
3. Settings → Notifications → **Enable notifications** → allow the iOS
   permission prompt.
4. Settings now shows "Subscribed — cards and intern messages will buzz this
   device."

**How it works under the hood:** the button requests `Notification`
permission, then `registration.pushManager.subscribe({ userVisibleOnly: true,
applicationServerKey: <from GET /push/key> })`, then `POST /push/subscribe`
with the resulting `PushSubscription.toJSON()`. The orchestrator
(`orchestrator/src/push.ts`) stores it in SQLite and fans out `web-push`
sends on `card`/`message` bus events; `public/sw.js`'s `push` handler calls
`showNotification`, and `notificationclick` focuses (or opens) an existing
tab and navigates it to the notification's `url`.

**Resetting a subscription** (stale after reinstalling the PWA, wiping Safari
data, or moving to a new phone): Settings → Notifications → **Disable**, which
calls `PushSubscription.unsubscribe()` and `POST /push/unsubscribe`. The
orchestrator also self-prunes: any subscription whose endpoint answers
404/410 (the browser silently dropped it) is deleted on the next failed send,
so a dead subscription left over from an uninstalled PWA does not linger
forever or throw errors into the void.

### Markdown

Interns write markdown, so both card bodies and chat bubbles render it —
bold, italic, inline code, fenced blocks, bullet and numbered lists,
blockquotes, headings and horizontal rules (`src/ui/Markdown.tsx`, no WebView,
no markdown dependency). It is memoised and bubbles are memoised around it, so a
long thread re-rendering on a stream event re-parses nothing. Chat-list previews
use `stripMarkdown()` so a one-line preview never shows stray backticks.

### Files, images, charts and SVG

- **Sending files.** The paperclip in the composer opens the platform picker
  (on an iPhone PWA that is Take Photo / Photo Library / Browse); on the web
  you can also paste a screenshot into the field or drop files anywhere on the
  thread. Each file uploads immediately (`api.uploadAttachment`, raw body,
  progress via XHR) and sits in a strip above the composer with a Retry on
  failure; Send waits for the strip to settle and passes the ids along with
  the text. A message can be files only.
- **Receiving files.** `message.attachments` renders under the bubble
  (`src/ui/Attachments.tsx`): images and SVGs as tappable thumbnails, anything
  else as a chip with name, size and a download button. Tapping opens a
  full-screen viewer with Open (new tab) and Save. Image URLs are self-signed
  (`attachment.url` carries an HMAC), so plain `<img src>` works without the
  bearer header. Intern uploads arrive on the same `message` event, re-emitted
  once linked, and the thread replaces the message in place.
- **Charts.** A ```` ```chart ```` fenced block holding a JSON spec renders as
  a native chart (`src/ui/Chart.tsx`, react-native-svg): bar, stacked bar,
  horizontal bar, line, area, pie, donut, scatter. Tap a mark for its value;
  "Show data" flips to a table. Colors follow the validated data-viz palette
  in fixed order (light and dark variants), marks are thin with 2px surface
  gaps, one axis only, legend for ≥2 series.
- **SVG.** A ```` ```svg ```` block (or an uploaded `.svg`) is drawn inline
  (`src/ui/SvgBlock.tsx`): on web through an `<img>` data URL (fully
  sandboxed), on native through `SvgXml`. Scripts, `foreignObject`, event
  handlers and external hrefs are stripped first. Markdown images
  `![alt](https://…)` on their own line also render.
- **Mermaid.** A ```` ```mermaid ```` block is drawn by a small in-house
  renderer (`src/ui/Mermaid.tsx`, no dependency): flowcharts (`graph` /
  `flowchart` in any direction, the common node shapes, labelled / dotted /
  thick edges, chains and `&` fan-out) and sequence diagrams (participants
  with aliases, every arrow form, notes, loop/alt/opt/par frames). `pie` is
  handed to the chart renderer. Other diagram types show the source as code
  with a note.
- **Files screen.** The paperclip in the thread header (and "Files
  exchanged" on the intern's settings screen) opens `/files/<slug>`: a
  picture grid plus files grouped by day, filterable, newest first, with the
  same viewer and downloads as the thread.
- **Copy and export.** Every code fence has a Copy button (Share sheet on
  native). Charts have Copy (image to clipboard) and PNG (download) on web,
  rasterized at 2x with the title, legend and a solid background so they
  paste cleanly into mail or Slack.
- Native (Expo Go / a real build) has no file picker wired yet; the paperclip
  explains that. Everything else works on both.

### Mentions and group chats

- **@Name** anywhere in a message renders as a chip with the intern's face
  (`MentionChip` in `src/ui/Markdown.tsx`, directory from `src/crew.tsx`);
  tapping it opens that intern's thread. Typing `@` in the composer shows a
  row of matching members to tap in. Mentioning another intern in a 1:1
  thread hands them the question — their reply appears in the same thread
  with their own face and a name label.
- **Groups** (`/group/new`, the people button on Crew) are rooms with a
  name, a member list and an optional standing brief. A room is a thread
  like any other (`/chat/<room-id>`): stacked member faces in the header
  and on its Crew row, speaker names on bubbles, "@ to mention" in the
  composer. `@Name` reaches that intern only; the "Everyone" suggestion
  inserts `@all` (the room's name works too) and reaches every member; a
  plain message lets the orchestrator pick who should answer. The gear opens
  the group editor, where it can be archived.
- **Threads inside a group.** Each bubble in a room has a Reply action; the
  composer shows "Replying to …" and the sent message carries `reply_to`.
  Intern replies link to whatever triggered them automatically. A replied-to
  message shows as a quote above the bubble; tapping it scrolls to and
  highlights the original.
- **Coordinator suggestions.** Settings → General → "Ask for suggestions
  now" runs the weekly pass on demand and reports what it looked at; new
  suggestions land in the inbox as coordinator cards. Accepting a hire
  suggestion opens `/hire?role=…` with the role prefilled and drafting
  already under way.
- **Long-press a bubble** for Reply (rooms), Copy, Forward to another
  intern (posts a quoted message in their thread and opens it), Pin /
  Unpin, and Turn into a card (an action card in the inbox). Pinned
  messages sit in a chip bar above the thread; tap one to jump to it.
- **Search this conversation** (magnifier in the thread header): matches
  count up, arrows step through them, each match scrolls into view and
  flashes.
- **Read receipts.** The thinking indicator says "has it queued…" until
  the intern's task starts, then "has seen this, working on it…".
- **Faces that react.** The header face nods when the intern picks your
  message up and winces when its task fails; a card's face grins when you
  accept its work. Faces quiet for three days doze on Crew. The office
  strip above the Crew list shows everyone at their desk (green lamp =
  working, "in <room>" members lean toward each other, "away" dozes).
- **Haptics.** A soft tap when a reply lands, two when a room message
  addresses you, a longer buzz on a failure. Android and desktop only:
  iOS Safari exposes no haptics to web apps, so an iPhone PWA stays silent
  until a native build ships (expo-haptics is picked up automatically then).
- **Sign-offs.** An intern's trailing "— Name, …" line renders as a quiet
  italic signature under the bubble.
- **Swipe cards** in the inbox: right runs the affirmative action
  (green, else primary), left snoozes/dismisses when the card has such a
  button. The label fades in as you drag; release past the threshold to
  fire.
- **Room scratchpad.** A collapsible panel above a group thread shows the
  shared notes; Edit opens the group editor, where the pad is a markdown
  field. Interns update it themselves and a system note marks each edit.
- **Spend** (Settings → General → Open spend report, `/spend`): total for
  the window, a stacked cost-per-day chart by intern, a cost-per-conversation
  bar chart, and a list of conversations with runs, tokens and cost that
  opens the thread. 7 / 30 / 90-day windows.

## What is stubbed / deferred

- **Native rendering of the faces.** `<InternFace>` falls back to
  `react-native-svg`'s `SvgXml` off web, which draws the face correctly but
  ignores the CSS keyframes, so it is static. See the TODO at the top of
  `src/ui/InternFace.tsx` — the plan is a Reanimated idle loop.
- **The coordinator's chat is the front desk.** `coordinator` is still a
  reserved slug in the registry (it is not an intern), but its thread exists:
  messages there are routed to one intern, and `idea:` lands on the Ideas page
  (docs/features/06-coordinator-chat-ideas.md).
- **Unread is local.** The API has no read receipts, so unread = "newer than the
  last message this device saw" (`src/unread.ts`), not synced with Discord.
- **Native rendering of the idle bob** is web-only (a CSS keyframe); native
  faces are still static — same TODO as the faces themselves.
- **`kind: "date"` actions** open a plain text prompt, not a date picker — no
  native-only module until the native build exists.
- **Not wired up:** firing an intern, snooze/expire card states beyond what the
  actions return, and card history (only `state=open` is shown).

## Later: native

Nothing here blocks an iOS build; it is deferred, not designed out.

- `npx expo prebuild` + EAS build when there is a paid Apple account. Bundle id
  is set to `io.github.jpdlr.interns` in `app.json`; change it to your own.
- Web Push (see above) already covers "an intern needs your attention" for an
  installed PWA — `expo-notifications` would only be worth it for richer native
  notification UI (actions, images) once a native build exists.
- Live Activities / Dynamic Island for a running intern task — needs a native
  widget extension, so it is strictly post-EAS.
- Keep new dependencies web-compatible, or split them behind `Platform.OS`
  checks the way `InternFace` does, so `expo export --platform web` keeps passing.
