# Changelog

All notable changes to Interns. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **A new hiring screen.** Describe the job, pick a starter from a card grid, or start from
  scratch. You then build the candidate:
  - a face picked from a strip, with the name and role edited in place;
  - personality dials with a live sample reply;
  - the job, schedule and triggers;
  - tools as tiles with real logos;
  - budget, drafts-only and notifications.

  A short welcome plays when you hire.
- **Personality dials** (`style` in the manifest): tone, length, initiative and humour,
  1–5 each. Moved dials add a "Style" block to the intern's prompt. The hire model sets
  them, the starters carry presets, and the dials can be changed on the profile.
- **Learning from your draft edits.** When you edit an intern's Outlook draft before
  sending it, the edit is kept. That's the text the intern wrote next to what went out,
  ignoring a signature Outlook adds. After two edits, one cheap model call looks for a
  pattern, and the intern asks in its chat whether to make it a standing order: Save it /
  Not now / Never.
  - `graph-mail` now remembers which intern wrote each draft, and has a new read-only
    `sent-drafts` command.
- **Teach by reacting.** Long-press an intern's message to react: Perfect, Too long, Too
  short, Too formal, Too casual or Missed the point. The intern acknowledges it, and the
  reaction shapes its next replies straight away. When 4 of its last 10 messages get the
  same reaction (net of the opposite one), it moves the matching dial one stop (Length or
  Tone) and says so on a card with Undo. Once you undo a move or set that dial yourself, it
  asks before moving it again.
  - The personality editor marks a dial set "from your reactions" and shows what was
    learned this week, with Undo.
  - `POST /messages/:id/reaction`, `GET /interns/:slug/learned`,
    `POST /interns/:slug/learned/:id/undo`.
- **Interview before hiring** (`POST /hire/interview`): put a question to a candidate and
  hear them answer in character. Nobody is hired; the coordinator pays for the call.
- **Instagram research connector.** Connect your Business or Creator account in
  Settings › Connectors › Instagram, then choose who researches. They get the read-only
  `ig-research` CLI (`instagram` tool): public Business/Creator profiles with recent posts
  and engagement, top and recent posts under a hashtag, and the weekly hashtag quota. It
  has no post, comment or message command.

### Fixed
- Brand logos with gradients (Outlook, Instagram, Office) no longer paint blank when the
  same logo is also on a screen underneath.

## [0.1.0] - 2026-10-03

The first public release, with a [28-second demo film](docs/media/interns-promo.mp4).

### Added
- **First-run setup** in the app: connect this device, tell the crew your name, time zone
  and work domains, then hire your first intern.
- **Starter interns** (`orchestrator/templates/`): inbox assistant, meeting briefer, chief
  of staff, researcher, writer, code reviewer and ops watchdog. You can open any of them
  from Setup or the Hire screen, and `~/.interns/templates/*.yaml` can override or add your
  own.
- **Notifications that learn**: replies and decisions buzz right away, everything else
  waits for summaries at times you choose; quiet hours; per-intern levels.
- `tools/graph-login` to connect Outlook mailboxes with device-code sign-in.
- `engine.permission_mode`: `dontAsk` (default) enforces each intern's tool grants plus
  read/write access to its own directory; `bypassPermissions` is an explicit opt-in.
- Settings for `owner_name`, `timezone`, `mailboxes`, `calendar_mailbox`, `graph.*` and
  `github.codeops_label`.
- **Connectors** (Settings › Connectors): connect Outlook and GitHub from the app, with
  no terminal, config editing or restart.
  - **Outlook**: guided Microsoft sign-in setup, then device-code sign-in per mailbox.
    Several mailboxes are supported; each can be renamed, made the default or the
    calendar source, checked, re-signed-in or disconnected.
  - **GitHub**: the App manifest flow from the browser. Turn reviews on per installed
    account and choose the reviewer.
- **Mailboxes per intern**: limit an intern to some Outlook mailboxes (`mailboxes` in the
  manifest). `graph-mail` and `graph-cal` enforce it, and the intern is told which it has.
- **Meeting briefs** switch on the intern profile (`triggers.meeting_brief` in the
  manifest API).

### Changed
- **The front desk is "Coordinator"**, and its name is a setting: `coordinator_name`
  in config (also on `GET/PATCH /owner`) sets what it's called in chats, prompts,
  standups and notifications.
- **Schedules run on your clock.** Intern schedules, `standup_cron` and `suggest_cron`
  are matched in your `timezone` (daylight saving included) instead of the server's
  clock. Existing installs are migrated once at startup so nothing fires at a different
  moment; a schedule that can't be converted is left as written and flagged on a card.
- Time zones, mailbox names, the owner's name and repository paths are configuration,
  not code.

[Unreleased]: https://github.com/jpdlr/interns/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jpdlr/interns/releases/tag/v0.1.0
