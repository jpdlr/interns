# Feature plan — October 2026

Specs for the next round of app features. Each file describes what JP should experience,
followed by what the app needs and what the backend needs. The refinement agent and the
backend agent both work from these files.

**Status:** approved by JP on 2026-10-02; implemented on branch `feature/pages-today-orders`. **[contracts.md](contracts.md)** defines the exact
shapes both sides build to: fences, routes, SSE events and the CLI.

## Principles

1. **Chats come first.** The Crew tab stays the first tab, and talking to interns stays the
   main way to use the app. Every new feature can be reached by asking an intern in a chat,
   for example "Tessa, show me my people" or "show me the pipeline".
2. **One new building block, not many new screens.** People, pipeline, living tables,
   ideas and drafts are all the same thing: a **page** that an intern posts in a chat and
   keeps up to date (see [02-pages.md](02-pages.md)). A page appears in the thread as a small
   preview and opens full screen when tapped.
3. **Pages are changed by talking to the intern.** Tapping an item on a page offers
   actions, and each action sends a normal chat message to the intern who owns the page
   ("Move Kettle Labs to Meeting"). The conversation stays the record of what changed, and no
   edit forms are needed.
4. **The tab count stays at three.** Today replaces Inbox: Crew · Today · Settings.
5. **Interns never send email.** Interns create drafts only, and that is not changing.

## Specs

| # | Spec | Size | Depends on |
|---|---|---|---|
| 01 | [Proper reply-all drafts](01-reply-all-drafts.md) — fix the threading bug | S, backend | — |
| 02 | [Pages](02-pages.md) — people, pipeline, boards, ideas, drafts | L | — |
| 03 | [Today tab](03-today.md) — replaces Inbox; includes the **Seen** button | M | 02 (optional) |
| 04 | [Standing orders](04-standing-orders.md) — tell an intern once, it sticks | M | — |
| 05 | [Debrief](05-debrief.md) — close the loop after meetings | S | 02, 03 |
| 06 | [Coordinator chat & ideas](06-coordinator-chat-ideas.md) — one front door, a place to jot ideas | M | 02 |

## Suggested order

1. **01** first, because it is a bug JP runs into every week.
2. **04** and the **Seen** button from 03 next, because they are small and remove daily noise.
3. **02**, starting with the `people` and `board` page kinds; `draft` is the third kind.
4. **03**, then **06**, then **05**.

## Small fixes to include along the way

- An intern's "(nothing)" reply still reaches JP's chat sometimes (Rhea, 9 Sept). It should
  never be shown, not even as a push notification.
- The empty state in `app/app/(tabs)/index.tsx` says "Hire one from Discord with /hire"; the
  command is `!hire`.
- `app/README.md` says firing an intern and card history are not wired up; both exist now.

## Decisions (2026-10-02)

- "A way to pen ideas" means jotting ideas down quickly. Spec 06 is built on that.
- The coordinator's row opens a real chat (spec 06). The Inbox becomes Today (spec 03).

## Handoff

| Agent | Owns | Starts with |
|---|---|---|
| Backend | `orchestrator/` (routes, tables, tools, watchers, Discord fallbacks) | 01, then the 04 hard rules and the "(nothing)" filter, then the 02 `pages` table and tool |
| App (refinement) | `app/` (fences, PagePreview and page screens, Today, rule chips, composer and menu items) | Seen and the fence renderers, built against `npm run mock`, then Pages, Today, the coordinator chat |

- The app agent extends the mock server (`app/tools/mock-orchestrator.mjs`) with the routes in
  `contracts.md`, so it doesn't have to wait for the backend.
- Both agents run the existing checks: the orchestrator smoke script (`orchestrator/scripts/smoke.ts`) and the app checks
  in `app/tools/` (`smoke-web`, `pwa-check`).
