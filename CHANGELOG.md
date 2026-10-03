# Changelog

All notable changes to Interns. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Schedules run on your clock.** Intern schedules, `standup_cron` and `suggest_cron`
  are matched in your `timezone` (daylight saving included) instead of the server's
  clock. Existing installs are migrated once at startup so nothing fires at a different
  moment; a schedule that can't be converted is left as written and flagged on a card.

## [0.1.0] - 2026-10-03

The first public release.

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

### Changed
- Time zones, mailbox names, the owner's name and repository paths are configuration,
  not code.

[Unreleased]: https://github.com/jpdlr/interns/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jpdlr/interns/releases/tag/v0.1.0
