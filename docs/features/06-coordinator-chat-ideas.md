# 06 — Coordinator chat and ideas

## Problem

- JP sometimes doesn't know, or doesn't care, which intern should handle something. He wants
  one place to say it.
- There is no place to jot an idea down: for the app, for the business, or for later.
- The Chaos Coordinator sits at the top of the Crew list, but tapping it opens the Inbox.
  Once Today replaces the Inbox (spec 03), that row is free.

## Design

**The coordinator row opens a real chat.** It is the front desk.

### 1. Routing

- When JP asks the coordinator something ("give me all my people", "anything on AI Expo?"),
  the message is handled like a group message that includes every intern. The existing
  check in `responders.ts` that picks which group member should reply chooses the right
  intern, and that intern answers **in the coordinator thread**. Its face and name appear on
  the message, the same way group replies look today.
- If the right intern is unclear, the coordinator asks one short question with intern chips:
  "Tessa or Ingrid?".
- Follow-ups in the same conversation stay with the intern that answered, until JP
  @mentions someone else.

### 2. Ideas

- Any message starting with **"idea:"** or **💡**, sent to the coordinator or any other chat,
  is added to the **Ideas** page. This is a `list` page (spec 02) owned by the coordinator
  and pinned in its thread.
- The long-press menu on any message gets **Save as idea**, for an idea that came up
  mid-conversation (an intern's suggestion, or something JP said).
- The coordinator's reply is a single line: "💡 Saved to Ideas (12)". It does not start a
  discussion.
- Each idea is stored with its text, the date, where it came from (with a link back to that
  message) and a tag added on the way in: `app`, `business`, `content`, `someday`. Tagging
  is one cheap Haiku call, and an idea is saved untagged if the call fails.
- On the Ideas page, each idea's item sheet has these actions:
  **Turn into work for…** (pick an intern) · **Discuss** · **Done** · **Drop**.
  "Turn into work" sends the idea to that intern's chat as a quoted message.
- The weekly suggestions pass (`suggest.ts`) also reads the Ideas page. An idea that keeps
  coming up, or that matches something an intern can't currently do, can become a
  suggestion card ("You've noted 3 ideas about LinkedIn posting; hire Julia's publishing
  capability?").

### 3. Composer shortcut

- In the coordinator chat only, a 💡 toggle next to the paperclip puts the composer into idea
  mode. The placeholder changes to "Jot an idea…" and pressing Send saves straight to Ideas.
  This is the fastest way to capture an idea.

## Rules

- The coordinator never does the work itself. It routes, records ideas and asks clarifying
  questions. This keeps the orchestrator deterministic, with LLM calls only where judgment is
  needed (choosing who replies, tagging an idea).
- Unread count and push notifications work exactly as for any other thread.

## App work

- `app/app/(tabs)/index.tsx`: the coordinator row opens `/chat/coordinator` instead of the
  Inbox, and shows a last-message preview like other rows.
- `chat/[slug].tsx` accepts `coordinator` as a thread. Messages from other interns in this
  thread show their faces, as in groups.
- Add the 💡 composer toggle (coordinator thread only) and the **Save as idea** menu item.

## Backend work

- Make `coordinator` a valid thread key for `GET|POST /interns/:key/messages`. Unaddressed
  messages go through the group responder check with all active interns as members.
- Detect the idea prefix in `orchestrator.ts` before routing, and append to the coordinator's
  Ideas page using the `intern-page` model from spec 02. Add a `POST /ideas` endpoint for
  Save as idea and idea mode.
- `suggest.ts`: add Ideas to its evidence.
