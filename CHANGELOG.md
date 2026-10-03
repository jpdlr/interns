# Changelog

All notable changes to Interns. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
