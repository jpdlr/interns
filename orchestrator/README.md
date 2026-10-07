# Interns orchestrator

TypeScript/Node backend for the Interns crew (see `../docs/architecture.md`). Deterministic
orchestrator + Claude Agent SDK sessions per intern; Discord and the app are
renderers of the same SQLite state.

## Setup

```sh
cd orchestrator
npm install
npm run build     # tsc, strict
npm run smoke     # in-memory smoke test (temp HOME, fake engine, no network)
npm run dev       # tsx watch src/index.ts
```

First run creates `~/.interns/config.json` (chmod 600) with defaults and a
generated API bearer token. `INTERNS_HOME` overrides the base dir.

State layout:

```
~/.interns/
  config.json          # port, API token, services, secrets-by-path
  interns.db           # SQLite (WAL): office state, capabilities, approvals
  builds/<request>/    # Forge worktree metadata for approved capability builds
  <slug>/intern.yaml   # intern manifest (source of truth for identity/config)
  <slug>/memory/       # the intern's own files; also its Agent SDK cwd
  _fired/<slug>/       # archived (fired) interns, moved wholesale
```

## Config

See `config.example.json`. Notes:

- `owner_name` is what the interns call you (prompts, greetings, standups);
  default "Boss". `timezone` (IANA, e.g. `Europe/London`) drives Today, local
  dates and calendar times; empty = this machine's zone.
- `mailboxes` lists Outlook mailbox ids (`~/.interns/mailboxes/<id>/`, created
  by `tools/graph-login --mailbox <id>`); the first is the default and
  `calendar_mailbox` (empty = the first) feeds meeting briefs and Today.
  `graph.client_id` is your Entra app registration. Empty `mailboxes` = no
  mail or calendar features. `own_domains` marks your own organisations, so
  meetings with anyone else count as external (briefs, debriefs).

- `discord.dry_run` defaults to **true**: the gateway never connects and every
  outbound send is logged as `[discord dry] …`. Set a `bot_token`, `guild_id`,
  `office_channel_id` and flip `dry_run` to go live. Never commit tokens.
- `engine.model` empty = Agent SDK default. `max_turns` bounds each run.
- Every intern can hand a very small, mechanical chore (tagging a batch of
  photos, one lookup) to a `helper` subagent on Haiku 5.5 (`src/models.ts`,
  also used by every cheap call: triage, tags, responders, suggestions). It
  has the intern's own tools and permissions and can't start helpers; a hook
  refuses any other subagent and drops model overrides. Its tokens count a
  fortieth against the intern's daily cap (`SMALL_MODEL_CAP_WEIGHT`: Haiku 5.5
  costs 1/40 of Opus 5.5); recorded cost is the real cost. Never Haiku 4.5.
- Intern sessions and cheap calls load no MCP servers (`strictMcpConfig`),
  so the owner's claude.ai connectors never reach an intern.
- Per-intern budgets live in the manifest (`guardrails.daily_token_cap`);
  when exceeded the engine refuses to start and emits a coordinator card.
- `push.vapid_public` / `push.vapid_private` — generated once on first run
  (`web-push`'s `generateVAPIDKeys()`) if either is blank, then persisted;
  never printed to logs. Regenerating them would silently invalidate every
  browser subscription, so they are written once and left alone.
  `push.subject` (default `mailto:interns@example.com` — set your own) is the contact URI the
  push services see in the VAPID JWT.
- `github` configures a GitHub App. Keep its private key outside the repository
  and put only its path in `private_key_path`. `repositories` is an explicit
  `OWNER/REPO` allowlist (or an explicit owner-wide entry such as `jpdlr/*`)
  enforced by webhook intake, the intern CLI, polling,
  and review proposals. The polling fallback runs every `poll_minutes`, so a
  public webhook endpoint and `webhook_secret` are optional. Restart the
  orchestrator after changing GitHub credentials or the repository allowlist.
  Multi-account Apps store one short-lived-token source per owner in
  `installation_ids`; repository calls are routed to the matching owner.

### GitHub App setup

The app does all of this from **Settings › Connectors › GitHub** (`src/connectors.ts`).
The manual route below is still supported.

Create a private GitHub App and install it only on the repositories the reviewer
may inspect. Grant **Metadata: read**, **Contents: read**, **Checks: read**, and
**Pull requests: read/write**. Subscribe to Pull request events if the
orchestrator is reachable at `POST /webhooks/github`; set the same high-entropy
secret in GitHub and `github.webhook_secret`. The write permission is held only
by the backend approval executor: the intern-facing `tools/github` command can
read data and create a local approval proposal, but it has no publish command.

Hiring a GitHub/code-review intern now shows `github` as a missing capability.
Confirming the hire creates a scope card. **Approve build** produces a separate
activation card; **Activate** grants the tool and records that intern as
`github.reviewer_slug`. Review results arrive as ordinary cards and are not
posted until **Publish review** is pressed.

## HTTP API (localhost only, `Authorization: Bearer <api_token>`)

| Route | Purpose |
| --- | --- |
| `GET /interns` | list interns + queue/spend snapshot |
| `GET /interns/:slug/messages` | chat history |
| `POST /interns/:slug/messages` `{text, attachment_ids?}` | record the owner's message (+ claim uploads) + enqueue task |
| `GET /cards?state=open` | list cards |
| `POST /cards/:id/actions/:actionId` `{note?}` | resolve a card |
| `POST /hire` `{role}` | manifest draft + missing capability requirements |
| `GET /templates` · `POST /hire/template` `{id}` | starter interns (`templates/*.yaml`, overridable from `~/.interns/templates/`); a template as a ready draft, no model call |
| `GET/PATCH /owner` `{owner_name?, timezone?, own_domains?, setup_complete?}` | first-run setup: who the crew works for, what's connected, whether setup is done |
| `POST /hire/confirm` `{draft, icon, required_capabilities}` | hire + capability requests |
| `GET /capabilities` | capability build/activation lifecycle |
| `POST /capabilities/:id/ready` | Forge reports branch + test results; creates activation card |
| `POST /github/reviews` | create a review approval card (does not publish) |
| `POST /webhooks/github` | signed GitHub App events; no bearer token |
| `GET /connectors` | Outlook (Microsoft app, mailboxes with health and who uses them, sign-ins in progress), GitHub (app, installations, reviewer) and Instagram (account, missing permissions, who researches) |
| `PUT /connectors/outlook/app` `{client_id, authority?}` | the owner's Entra app registration for device-code sign-in |
| `POST /connectors/outlook/mailboxes` `{label, mailbox?}` · `GET/DELETE /connectors/outlook/sessions/:id` | start a mailbox sign-in (returns the code to show), poll it, cancel it; `mailbox` reconnects an existing one |
| `PATCH/DELETE /connectors/outlook/mailboxes/:id` `{label?, calendar?, default?}` · `POST …/:id/check` | rename, calendar, default, disconnect; check access now |
| `GET/PATCH/DELETE /connectors/github` `{accounts?, reviewer?}` · `POST /connectors/github/sync` | status; reviews per account and the reviewer; refresh installations; disconnect |
| `POST /connectors/github/setup` `{login, origin}` · `POST /connectors/github/install` `{origin}` | the App manifest to post to github.com; a one-time install link |
| `GET/PUT/PATCH/DELETE /connectors/instagram` `{app_id, app_secret?, token, username?}` / `{interns}` · `POST /connectors/instagram/check` | Instagram research: status; connect from a Graph API Explorer token (kept as a non-expiring Page token in `instagram/config.json`); who has the `instagram` tool; disconnect; check access now |
| `GET /oauth/github/callback` · `GET /oauth/github/installed` | browser returns from github.com; no bearer token, single-use 15-minute state required |
| `GET /push/key` | `{vapid_public}` — for `pushManager.subscribe`'s `applicationServerKey` |
| `POST /push/subscribe` `{endpoint, keys}` | store a browser PushSubscription (204) |
| `POST /push/unsubscribe` `{endpoint}` | drop a subscription (204) |
| `POST /interns/:slug/attachments?name=&author=&caption=` (raw body) | upload one file (≤25 MB); returns the Attachment, unlinked |
| `GET /interns/:slug/attachments` | every file exchanged in that thread, newest first |
| `GET /attachments/:id[?download=1]` | bytes; bearer **or** the `sig` baked into `attachment.url` |
| `GET /attachments/:id/meta` | the Attachment record |
| `GET /rooms` · `POST /rooms {name, members, topic?}` | group chats (list carries `last_message`) |
| `GET/PATCH /rooms/:id` · `POST /rooms/:id/archive` | edit members/name/brief; archive hides + cancels queued replies |
| `GET/POST /interns/:key/messages` | `:key` is an intern slug **or** a room id — same thread API for both |
| `POST /suggest/run` (202) · `GET /suggest/status` · `GET /suggest/history` | start the coordinator's suggestion pass in the background; poll its status; past proposals + decisions |
| `POST /messages/:id/pin {pinned}` · `GET /interns/:key/pins` | pin a message to the top of a thread |
| `POST /messages/:id/reaction {reaction}` · `GET /interns/:slug/learned` · `POST /interns/:slug/learned/:id/undo` | react to an intern's message (`perfect`, `too_long`, `too_short`, `too_formal`, `too_casual`, `missed`, or `null`); 4 of one kind in its last 10 messages move its Length or Tone dial (`src/reactions.ts`) |
| `GET/PUT /rooms/:id/scratchpad` | the room's shared markdown pad (`append: true` adds; `author` leaves a note in the thread) |
| `GET /reports/spend?days=30` | per-intern-per-day spend + per-conversation spend (`run_spend`), with display names |
| `GET /events` | SSE: `message`, `card`, `card_state` |

## Attachments, charts and SVG

Files live at `~/.interns/<slug>/attachments/<id>.<ext>`; metadata is the
`attachments` table (`src/attachments.ts`, `db.ts`). `Message.attachments`
is hydrated on every read and on the `message` SSE event.

- **Owner → intern.** The app uploads each file as a raw `POST
  /interns/:slug/attachments` body (no multipart), then sends the message
  with `attachment_ids`. The `message` task payload carries the absolute
  paths, and the intern prompt lists them ("Sam attached 2 files — read them
  from disk"). The dir is inside the intern's cwd, so `fs.read` covers it
  and Claude's Read tool shows images.
- **Intern → owner.** `tools/intern-attach --intern <slug> --file <path>
  [--caption …]` uploads with `author=intern`. The CLI is a *base tool*
  (`BASE_TOOL_NAMES` in engine.ts): every intern gets it without a manifest
  entry. Anything uploaded during a run and still unlinked when the reply
  lands is linked to that reply (`linkOrphanInternAttachments`), and the
  message is re-emitted so surfaces pick up the files. Discord receives them
  as webhook file uploads (≤8 MB each; larger ones get a note).
- **Download URLs.** `<img src>` cannot send a bearer header, so
  `attachment.url` is `/attachments/<id>?sig=<hmac(api_token, id)>`. Rotating
  `api_token` invalidates every old URL. Bytes are served with `nosniff`, a
  sandboxing CSP, and `text/html` is downgraded to plain text unless
  explicitly downloaded.
- **Charts, diagrams and drawings** need no upload at all: the system prompt
  (`RICH_CONTENT_PROMPT`) tells interns to emit a ```` ```chart ```` JSON block
  (bar / stacked bar / line / area / pie / donut / scatter), a
  ```` ```mermaid ```` block (flowchart / sequence), or a ```` ```svg ````
  block, which the app renders natively (`app/src/ui/Chart.tsx`,
  `Mermaid.tsx`, `SvgBlock.tsx`). The same blocks work in card bodies.
  Discord gets real pictures: `src/render.ts` rasterizes each block with
  `@resvg/resvg-js` (server-side twins of the app renderers in
  `chartsvg.ts` and `mermaidsvg.ts`; system fonts via fontconfig) and the
  adapter attaches the PNGs — webhook multipart for messages, embed image
  for cards, `#office` for standups — leaving a numbered "(chart 1
  attached)" in the text. Unsupported Mermaid types, malformed specs, or a
  missing resvg binary fall back to the old placeholder; push bodies always
  use `stripRichBlocks()`.
- **Chart cards.** The morning standup appends a stacked 7-day token-spend
  chart per intern (`spendChartBlock`, from `db.spendLastDays`) to the digest
  and also files it as a coordinator card ("Standup · <date>", info, one
  Read action), so the trend is visible in the inbox, not only in the
  Coordinator thread. Interns can do the same from `intern-card --body`.

## Mentions, handoffs and group chats

`Message.intern` is a *thread key*: an intern slug (the owner's 1:1 thread) or a
room id (`room-<uuid>`, a group chat; `rooms` table). `Message.speaker` says
which intern spoke, which matters whenever a reply lands in a thread that is
not the speaker's own.

- **@mentions** (`src/mentions.ts`) resolve `@Name` / `@slug` / `@First`
  (case-insensitive) against the registry; `@everyone` expands to the room.
  The app draws a resolved mention as a chip with the intern's face.
- **Routing.** The owner posting in a room enqueues a `message` task for each
  mentioned member. `@all` / `@everyone` / `@<room name>` (full name, with
  `_`/`-` for spaces, or its first word) asks every member. With no mention
  at all, `src/responders.ts` makes one cheap Haiku call that picks the
  fewest members who can answer (possibly nobody for a "thanks"); if that
  call fails, everyone is asked, so a message never goes unanswered
  (`room_responder_precheck: false` in config restores always-everyone).
  Each task carries `thread`, `room`, `from` and `depth`. In a 1:1 thread the owner
  always gets the message, and any other intern the owner mentions is pulled into
  that same thread (a handoff). When an intern's reply mentions a colleague,
  `Orchestrator.routeMentions` enqueues the next hop with `depth + 1`;
  `MAX_MENTION_HOPS` (4) stops intern↔intern chains, and a message from the owner
  resets the count. Room replies are prompted with the recent transcript,
  the members, and the room's standing brief, and an intern may answer
  `(nothing)` to stay silent — such replies are dropped, not posted.
- **Threads inside rooms.** `Message.reply_to` links a message to the one it
  answers. The app sends it explicitly (Reply on a bubble); every routed
  intern reply gets it automatically — the message that triggered the task
  (the owner's post, or the colleague's mention) — so a room's structure is
  recoverable without the intern doing anything. The app draws a quote
  above the bubble and jumps to the original on tap.
- **Cost per conversation.** Every intern run and every responder pre-check
  is written to `run_spend` with the thread it happened in (intern slug or
  room id). `GET /spend` aggregates it next to the existing per-intern
  `spend` table; the app's Spend screen (Settings → General) draws both.
- **Scratchpad.** Every room has a shared markdown pad (`rooms.scratchpad`),
  pinned above the chat in the app and included in every member's prompt.
  The owner edits it in the group editor; interns use `tools/room-pad` (a base
  tool): `get`, `append --text`, `set --file`. Passing `--intern <slug>`
  leaves a one-line system note in the thread. Changes arrive over SSE as
  a `room` event.
- **Sign-offs.** The engine prompt asks each intern to end replies with a
  one-line em-dash sign-off in its own voice; the app draws it quieter.
- **Standup in costume.** On one deterministic day a month
  (`easterEggVoice`; `standup_easter_eggs: false` disables) the digest is
  written as a limerick, weather report, nature documentary, noir case
  notes, sports commentary or ship's log — facts unchanged.
- **Surfaces.** Rooms have no Discord channel; their traffic is mirrored into
  `#office` as `**Speaker** in _Room_`. Handoff replies in an intern's
  channel go out under the speaker's webhook identity. Push titles carry the
  speaker and the room. Room attachments live under `~/.interns/_rooms/`.

## Coordinator suggestions

`src/suggest.ts`. Every Monday 08:00 (`suggest_cron`; `suggest_enabled`
turns the schedule off, the manual route still works; `POST /suggest/run`
answers 202 immediately because the pass takes a minute or more and the
Tailscale proxy would time out a synchronous request — poll
`/suggest/status`) the coordinator
looks at the last 14 days and may raise up to two suggestion cards. The
pass is deterministic first: `collectEvidence` gathers repeated asks from
the owner (normalised phrases seen ≥2×, with an example and where), interns'
own "I can't / no access" complaints, failed tasks and cap hits, cards
the owner keeps dismissing, 7-day spend, the mention graph, rooms, the
capability catalog and pending requests. One Haiku call turns that into
proposals of a fixed kind — `hire`, `capability`, `trigger`, `backlog`,
`spend`, `merge`, `other` — with the evidence spelled out; it fails
closed (no cards). Each card's accept button leads into an existing
flow: **Draft this hire** opens the app's hire screen with the role
prefilled; **Request the build** creates a capability request for the
intern. **Not now** snoozes the idea 30 days, **Never** is permanent.
Decisions live in `~/.interns/coordinator/suggestions.json`
(`wireSuggestionDecisions` listens on card resolution) and suppress
repeats, including while a card is still open.

## Web Push

`src/push.ts`'s `PushService` sends via `web-push` to every subscription
stored in SQLite (`push_subscriptions`, added by an additive migration in
`db.ts`). `wirePushNotifications()` (also in `push.ts`, called from
`index.ts` once the bus exists) listens on the same `EventBus` the Discord
adapter and SSE route do — independently, no shared send logic:

- **`card` event** → `{title: "<Intern>: <card title>", body: <card.body>,
  url: "/inbox?card=<id>", tag: "card-<id>"}`
- **`message` event**, only when `author` is `intern` or `coordinator` (never
  the owner's own messages) → `{title: "<Intern>", body: <msg.text>, url:
  "/chat/<slug>", tag: "msg-<slug>"}`, debounced to at most one per intern per
  60s so a chatty intern can't spam the lock screen.

Call sites pass the intern's raw markdown. `notify()` runs every title and
body through `notificationText()` (`notifytext.ts`) first, so nothing an
intern writes reaches the lock screen as markup: links keep their text and
lose the URL, bold/headings/quotes/escapes go, bullets become `•`, table rows
read across as `a · b`, code and rich blocks become "(code — open the app)",
and the result is one line cut to 160 chars (80 for the title) on a word
boundary. Fixing it there rather than per call site means a new notification
cannot forget to do it.

`notify()` fans a payload out to every stored subscription and never throws;
a subscription whose endpoint answers 404/410 (browser dropped it) is pruned
from the table. Failures otherwise are logged and swallowed — a push hiccup
must never affect the card/message write it is reacting to.

iOS 16.4+ only delivers Web Push to a PWA installed to the Home Screen — see
`../app/README.md` for the client side and the exact enable steps.

## Discord

Channel per intern; plain messages go out via the intern's webhook
(username + avatar override, avatar = `avatar_base_url/<icon>.png`). Cards go
out via the bot user because ordinary channel webhooks cannot carry buttons.
Cards render as embed + button rows with custom ids `card:<cardId>:<actionId>`
(the `fu:*` pattern from an earlier follow-up bot); clicks resolve the card in the db
and edit the embed in place. `date`/`text` actions open a modal. `#office`
commands (plain text for now): `!hire <role>`, `!confirm [icon]`, `!status`,
`!standup`.

## Capability builds and approvals

`src/capabilities.ts` separates three jobs: the coordinator creates and routes
requests, the permanent Forge integration engineer builds unknown adapters in a
Git worktree created by `tools/integration-work`, and the hired specialist uses
an activated tool. A build approval never installs code. Forge must report a
branch, summary, and tests, which creates a second activation card.

Side-effecting card actions are rows in `approval_jobs`. `ApprovalService`
claims a pending row before execution and records its result before resolving
the card, so repeated app/Discord clicks cannot publish twice. Missing setup is
retryable and leaves the job pending; an uncertain outbound failure is marked
failed and produces an urgent coordinator card rather than silently retrying.

## Current status

Works today (verified by `npm run smoke` + `npm run build`):

- zod-validated manifests, YAML registry, archive-to-`_fired`
- SQLite state + migrations, WAL, typed accessors, event bus
- task queue: one task per intern at a time, interns concurrent, crash
  recovery (orphaned running tasks re-queued), stale-task kill + card
- heartbeat: minimal 5-field cron matcher, backlog auto-enqueue with cooldown
- engine wrapper against `@anthropic-ai/claude-agent-sdk@0.3.241`: session
  resume per intern, spend recording from `modelUsage`, daily-cap refusal card
- card lifecycle db ↔ bus ↔ (SSE / Discord renderer)
- fastify API incl. SSE
- Web Push: VAPID keygen on first run, `push_subscriptions` table, `/push/*`
  routes, card/message bus wiring with 404/410 pruning and per-intern message
  debounce (verified against a real `web-push` send to a local HTTPS
  listener — see `src/push.ts`)
- capability-aware hiring, scope/build/activation lifecycle, Forge worktrees,
  and exactly-once approval jobs shared by the app and Discord
- GitHub App short-lived authentication, repository allowlist, signed webhook
  intake, polling fallback, PR fixture tests, and approval-gated review posting

Stubbed / TODO:

- Discord live mode — code paths exist but only dry_run has been exercised;
  slash commands still plain-text `!commands`
- real intern runs need `claude` auth on this box (Agent SDK spawns the CLI)
- GitHub live mode needs a registered App, installed repository access, and the
  credentials described above; automated tests use fixtures and make no network
  calls
