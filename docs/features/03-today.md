# 03 — Today tab

## Problem

Meeting briefs and other information arrive as cards. Cards are made for decisions, so JP has
to dismiss each one even though there was nothing to decide: 28 cards have been dismissed
with "ignore", most of them meeting briefs. The Inbox mixes these with real decisions, and
there is no single place to see the day.

## Design

**Today replaces Inbox as the second tab.** The tabs become Crew · Today · Settings. Crew
stays the first tab and does not change.

The tab is one scrolling page, made of sections, top to bottom:

1. **Needs you**: open cards that are actually decisions (severity `action` or `urgent`).
   They are the same `CardView` components as today, swipe gestures included. The section
   is hidden when empty.
2. **Schedule**: today's meetings on a simple timeline with a "now" line.
   - Each meeting row shows the time, title, attendees and which intern wrote its brief.
     Tap it to expand the brief inline. Nothing needs dismissing.
   - A meeting that ended within the last few hours shows a **Debrief** chip (spec 05).
   - A meeting starting within 15 minutes is highlighted.
   - A "Tomorrow ›" link at the bottom shows the next day in the same layout.
3. **Follow-ups due**: people with a follow-up due today or overdue, taken from Tessa's
   `people` page (spec 02). Tapping one opens the person sheet. Hidden until spec 02 ships.
4. **While you were away**: one line per intern summarising what it did since JP last
   opened Today ("Rhea reviewed 3 PRs", "Ingrid added 2 events"). Tap a line to open that
   intern's chat. The daily standup lives here instead of arriving as a card.

At the bottom, a **History ›** link opens the existing history timeline (now a screen that is
pushed on, not a toggle).

Everything on Today leads back to a chat. The tab only gathers things together.

The coordinator's row on Crew currently opens the Inbox. That changes in spec 06.

## The Seen button (can ship on its own, before Today)

- Information cards (severity `info`) get a single primary **Seen** button, and swiping right
  also marks them seen. Seen resolves the card with `{action: "seen"}`. "Ignore" stays on
  cards where it actually means "don't act on this".
- On Today, information items such as briefs and standups are marked seen automatically once
  JP has expanded them or scrolled past them, so they never pile up.
- Backend: give every `info` card a default action `{id: "seen", label: "Seen",
  style: "primary"}`. Treat `seen` as resolved in the suggestions evidence: it is not the same
  as "the user keeps ignoring this".

## App work

- `app/app/(tabs)/_layout.tsx`: rename `cards` to `today` (title "Today", calendar icon).
  Keep `/inbox?card=` deep links working; they now scroll Today to the card and highlight it.
- New sections can be small components in `app/src/ui/today/`.
- The Today tab badge counts **Needs you** items only, never information items.

## Backend work

- `GET /agenda?date=YYYY-MM-DD` (see contracts.md §4 for why not `/today`) returns:
  `{needs_you: Card[], schedule: [{event_id, start, end, title, attendees[],
  brief?: {intern, markdown}, debrief?: {state}}], follow_ups: [...],
  away: [{intern, summary, since}]}`.
- Meeting briefs (`meetingwatch.ts`) are stored by calendar `event_id` instead of being
  filed as cards. A brief only becomes a card if it contains something JP must decide; that
  is the intern's call, made through the `cards` tool as usual.
- The "away" summaries are built from `tasks` and `messages` since a `since` timestamp that
  the app sends. These are deterministic one-liners, so no LLM call is needed.
- Calendar: one mailbox only (`calendar_mailbox`, else the first of `mailboxes`). Its token
  needs calendar scope; a mail-only mailbox can't be used here.
