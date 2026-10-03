# Contributing

Thanks for wanting to help the crew. Interns is a small, opinionated project: it's built
for one person running their own office, and it should stay easy to self-host and to
read.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened.
  Include orchestrator log lines (with tokens and email addresses removed).
- **Features:** open an issue or discussion first, so we can agree on the shape before
  you build it. Specs for bigger features live in [`docs/features/`](docs/features/).
- **Security problems:** please don't open a public issue; see [SECURITY.md](SECURITY.md).

## Setting up

```sh
cd orchestrator && npm ci && npm test        # offline: fake engine, temp HOME, no network
cd ../app && npm ci && npm run typecheck && npm run check:schedule
```

For UI work, run `npm run mock` in `app/` (a demo backend on :7811) and
`npx expo start --web`. To try the real orchestrator without touching your own crew, run
it with `INTERNS_HOME=$(mktemp -d)`.

## Ground rules

- **Guardrails are features.** Don't add a send command to `graph-mail`, a write command
  to `graph-cal`, or a publish path that skips an approval card. New side effects go
  through `approval_jobs` so they run exactly once.
- **The orchestrator stays deterministic.** Use a model call only for judgment (and give
  it a cheap model and a fail-safe default), never for routing or state.
- **Tests:** add a check to `orchestrator/scripts/smoke.ts` or `features.test.ts` for
  backend behaviour. The tests must stay offline.
- **Shared shapes:** the app and the orchestrator agree on the shapes in
  [`docs/features/contracts.md`](docs/features/contracts.md). Change it in the same PR.
- **Style:** match the surrounding code: TypeScript strict mode, small modules, and
  comments that say *why*. Run `npm run typecheck` in both packages before you push.
- **No secrets in the repo.** Fixtures use `example.com`-style addresses and made-up
  people.

## Pull requests

Keep PRs focused. Describe the change, say how you tested it, and include before/after
screenshots for UI changes. CI runs the typechecks, the orchestrator test suite and a
web export of the app.

By contributing you agree that your work is released under the [MIT license](LICENSE).
