# Architecture

Interns is self-hosted and single-user: one person (the **owner**, `owner_name` in
config) and their crew. An **orchestrator**, the Chaos Coordinator, manages a crew of
**interns**: persistent AI agents with names, animated faces, roles, their own memory and
their own tools. You message interns directly; interns also work on their own, from
triggers and backlogs. The phone app (Expo, installed as a PWA) and an optional Discord
server are both renderers of the same backend state; neither is the source of truth.

```
Events in                         Orchestrator (TypeScript / Node, one process)
  app (HTTP + SSE)            →     • intern registry: ~/.interns/<slug>/intern.yaml manifests
  Discord gateway (optional)  →     • SQLite state: threads, messages, cards, tasks, pages, rules
  cron / heartbeat ticks      →     • task queue: one task per intern at a time, interns in parallel
  Outlook polling (optional)  →     • agent engine: a Claude Agent SDK session per intern (resumed)
  GitHub webhooks / polling   →     • guardrails: daily token caps, drafts-only tools, approval cards
        ↓ renderers
  App:      chat list of interns, rich cards, pages, Today; SSE stream; Web Push
  Discord:  a channel per intern (webhook identity = name + face), #office for the coordinator
```

## Core rules

- **The orchestrator is deterministic code.** It calls a model only for small judgment
  calls: expanding a hire, choosing who answers in a group chat, triaging a mail batch,
  picking idle backlog work, writing the standup. Interns do the real work in Agent SDK
  sessions.
- **Memory belongs to the intern** (`~/.interns/<slug>/memory/`); routing belongs to the
  orchestrator.
- **Anything outbound to other people is drafts-only.** Mail tools can read and draft but
  have no send command. A GitHub review is published only when you press a button.
- **Cards are stateful backend objects.** Surfaces render them and edit them in place when
  their state changes; a click on Discord and a tap in the app resolve the same card.
- **Side effects run exactly once.** Approval jobs are claimed in SQLite before they run, so
  a double tap can't publish twice.

## Interns

An intern is a YAML manifest plus a directory:

```yaml
name: Rhea
role: Code reviewer
icon: face-08                  # one of the 20 animated faces
persona: Precise, constructive, allergic to speculative criticism.
system_prompt: >-
  You review GitHub pull requests for correctness, security, regressions…
tools: [fs.read, cards]        # catalog names, mapped to SDK tools (engine.ts)
triggers:
  cron: "0 7 * * 1-5"          # scheduled routine work
  mentions: true               # colleagues' @mentions wake them
  mail_push: false             # new mail in the configured mailboxes
  meeting_brief: false         # brief you before external meetings
backlog: ["Tidy the open-PR list once a week"]
guardrails:
  drafts_only: true
  daily_token_cap: 200000
```

Every intern also gets the base tools: attachments, room scratchpads, pages and
standing orders. Tool grants are enforced by the Agent SDK's permission system
(`engine.permission_mode`, default `dontAsk`). An intern can use its granted tools
and its own directory, and nothing else.

## Work arrives as tasks

| Kind | From |
| --- | --- |
| `message` | you, in a 1:1 thread, a group chat, or the coordinator's front desk |
| `scheduled` | the intern's `cron` trigger (heartbeat-driven, 5-field cron) |
| `backlog` | idle time, optionally picked by a cheap advisor call |
| `trigger` | mail batches, meeting briefs, GitHub pull requests, released holds |

Mail goes through three filters before it wakes anyone. Layer 1 drops messages with
deterministic regexes (newsletters, noreply). Layer 2 batches the rest with a cooldown.
Layer 3 makes one cheap model call that wakes the intern or holds the batch for the next
digest. Standing orders ("ignore PRs in acme/webapp", "hold anything from Maya until
Monday") are applied before a task is created.

## Cards, pages and rich content

- **Cards**: id, intern, title, markdown body, severity (`info` | `action` | `urgent`),
  state, and up to five actions (`button` | `date` | `text`). They are used for approvals,
  questions, budget top-ups and suggestions.
- **Pages** are living views an intern keeps up to date: people, boards, tables, lists and
  email drafts. One shows up in the chat as a preview and opens full screen; tapping an
  item sends the intern a normal chat message.
- **Rich blocks**: interns write ```` ```chart ````, ```` ```mermaid ````, ```` ```svg ````,
  ```` ```checklist ```` and ```` ```quick-replies ```` blocks. The app renders them
  natively, and Discord gets server-rendered PNGs.

The detailed shapes are in [`features/contracts.md`](features/contracts.md); the design
notes for each feature are in [`features/`](features/).

## State on disk

```
~/.interns/
  config.json            settings + secrets (0600)
  interns.db             SQLite (WAL)
  <slug>/intern.yaml     manifest (source of truth for identity)
  <slug>/memory/         the intern's own files; its Agent SDK working dir
  <slug>/attachments/    files exchanged in its thread
  mailboxes/<id>/        Outlook token cache per mailbox (graph-login)
  builds/<request>/      Forge's git worktrees for capability builds
  _fired/<slug>/         archived interns
```

## Capability builds

When a hire needs a tool that doesn't exist yet, the coordinator files a capability
request. **Forge**, the permanent integration engineer, builds the adapter in a git
worktree and reports a branch and its test results. You approve the build on one card and
the activation on a second. Forge can't activate or deploy anything itself.
