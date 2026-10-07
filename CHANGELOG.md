# Changelog

All notable changes to Interns. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Photos sync from Google Drive.** Connect Google Drive on the Google Photos screen and
  photos keep arriving on their own: a Google Takeout export of Google Photos delivered to
  Drive (once, or every two months) is found, downloaded and imported, and so is anything saved
  into the "Interns Photos" folder. Only photos taken from the start date you pick are kept;
  screenshots (optional), videos (optional, as a still) and duplicates are skipped; HEIC is
  converted. It checks every 6 hours, or on Sync now. `tools/photo-import` does the work;
  pillow-heif joins `tools/requirements.txt`.
- **Moodboards: a page of image cards.** Paste a link or an image into the board (or tap +
  to add photos) and it lands as a card; links get their preview image fetched and kept, with
  the post's caption and account (Instagram's image links expire, so a copy is stored with the
  page). Interns make them with `intern-page create --kind moodboard`, and `image_path` puts a
  local image (a shared photo, a downloaded post) on the board. Tap a card for the full image,
  the link and the note.
- **Google Photos connector.** Share albums or photos with the crew through Google's own picker
  (Google no longer lets apps read a whole library). Picked photos are copied to your server
  (`$INTERNS_HOME/photos`), so interns with the new `photos` tool can browse them any time:
  `photo-library` makes numbered contact sheets, lists them, and keeps tags and picks. Setup is
  your own Google Cloud OAuth client; the app shows the steps and the redirect address. Only
  the picker permission is requested.
- **`ig-research --sheet`** draws an account's or a hashtag's posts as one contact sheet, so
  interns can compare looks visually, for example to find accounts and feature pages with a
  style like yours. Pillow is now in `tools/requirements.txt`.
- **Writing cards.** Text meant to be pasted somewhere (a bio, caption, post or email) shows as
  a clean card in the reading font, wrapped, with Copy and Edit, not as a monospace code box.
  Labelled alternatives (`**My pick — 138 chars**` above each block) share one card behind
  numbered tabs. Edit opens the text to change it, then copy it or send it back to the
  intern. Interns are told to use ```` ```writing ```` blocks for this.
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
- **Helpers for small chores.** An intern can hand a very small, mechanical job (tagging a
  batch of photos, one lookup) to a helper on Haiku 5.5, and split a big chore across several.
  The helper has the intern's own tools and permissions and reports back; it can't start
  helpers of its own, and no other kind of subagent is allowed.

### Changed
- **Haiku 5.5 for every cheap call.** Mail triage, idea tags, responders, the advisor,
  suggestions and draft learning move from Haiku 4.5 to Haiku 5.5. Agent SDK 0.3.293.

### Fixed
- **Interns no longer get the owner's claude.ai connectors.** Every session loaded them
  (Microsoft 365 and Claude Docs here), and with `bypassPermissions` an intern, or an email
  read by triage, could have used them, including sending mail. Sessions now load no MCP servers.
- **Connectors open at once.** The list waited on GitHub's API every time; GitHub's state is now
  kept for a few minutes, refreshed in the background, and ready at startup. Settings lists every
  connector (Instagram and Google Photos too) with "All connectors" instead of "Something else",
  and both screens draw the last list straight away.
- **Photo sync downloads resume.** A Takeout zip is tens of GB; a restart or dropped connection
  used to start it again from the top. The partial file is kept and continued with a Range request.
- **No more "nothing new" messages.** Background runs (new mail, a schedule, a backlog item)
  are told nobody is waiting and to reply `(nothing)` when nothing needs you; they used to be
  told to "report", so an intern posted "Same oscillation, nothing new. No card." A short
  background reply that only says nothing happened is dropped as well. Answers to your own
  questions are never dropped.
- **Table pages no longer lose their rows.** A table written with `items` (as every other page
  kind calls its list) or columns with `label` saved empty, because unknown fields were dropped
  silently. Both are accepted now, and an empty table says so.
- **The attach button opens on iPhone again, and is now a +.** It acted on touchstart (to keep
  the keyboard up), which iOS doesn't count as a tap for opening the file picker, so nothing
  happened. It now acts on touchend, still keeping the keyboard up.
- **No dark flash in light mode.** The app's first frame (the loading screen, before the
  JavaScript runs) was always dark. It now paints from CSS variables that follow your phone or
  your Light/Dark setting, applied before the first paint.
- **Updates mostly install themselves.** An update that arrives while you're away goes in when
  you come back to the app. Mid-session, a small card below the status bar offers Refresh, or
  can be dismissed, instead of a tiny pill under the Dynamic Island.
- **Interns stop repeating what you turned down.** Every intern is told your latest message
  wins: use your version as given, drop a rejected idea everywhere and save it as a standing
  order ("I don't like X" now counts, not only "from now on"), don't critique your drafts
  unasked, and match the reply's length to your message. The sign-off line is only for longer
  updates they start themselves.
- **Long sessions are closed.** Once an intern's session carries more than 120K tokens of
  context, the next run starts fresh with the end of the chat. Before, every turn re-read the
  whole history, which was slow and costly and let old replies drown out new instructions.
- **New messages show up without leaving the chat.** A live stream that died quietly (a phone
  that slept, a dropped connection) kept saying "live" and delivered nothing. The app now
  replaces a stream that has been silent for a minute, catches up after every reconnect, and
  refetches the moment you come back to it. `npm run check:stream` covers this.
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
