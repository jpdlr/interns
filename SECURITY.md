# Security policy

Interns runs AI agents with access to your mail, calendar, GitHub and machine, so
security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through
[GitHub's private vulnerability reporting](https://github.com/jpdlr/interns/security/advisories/new).
Include steps to reproduce and the impact you expect. You'll get a reply within a week.

Good examples of what to report:

- a way for an intern to use a tool it wasn't granted, or to reach outside its directory
  under `engine.permission_mode: "dontAsk"`
- a path for mail, PR content or a web page to make an intern send, publish or delete
  something without an approval card
- API routes that work without the bearer token, or attachment URLs that can be forged
- secrets leaking into logs, push notifications, Discord or the app

## Scope and expectations

Interns is single-user software that you run yourself. Under
`engine.permission_mode: "bypassPermissions"`, interns can run any tool by design, so
that mode is out of scope. Prompt injection that stays within an intern's granted tools
is a known risk of agent systems; reports that show a way to cross a guardrail are what
helps most.
