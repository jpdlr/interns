# 02 — Pages

## Idea

A page is a structured view that an intern posts in a chat and keeps up to date. In the
thread it shows up as a compact preview; tapping it opens it full screen. Instead of posting
the same table again with every change, the intern updates the page, and the page always
shows its current state.

One page component covers the people list, the sales pipeline, Ingrid's events list, ideas
and draft review. No new tabs are needed.

## How JP gets to a page (always through a chat)

- JP asks an intern for it: "Tessa, show me all my people", "show me the pipeline",
  "Ingrid, put the October events on a board". The intern replies with the page.
- Pages JP opens often can be pinned with the existing pin feature. A pinned page appears
  among the chips at the top of the thread, so one tap opens it.
- The intern's file screen (`app/app/intern/[slug].tsx`) gets a short **Pages** list
  under "Files exchanged".

## Page kinds (v1)

| Kind | Example | Full-screen view | Tapping an item opens |
|---|---|---|---|
| `people` | Tessa: "My people" | Grid of person cards: face/initials, name, company, a tag such as `lead` or `client`, last contact, next follow-up | A **person sheet**: how JP knows them, a timeline of mails, meetings and chat mentions, follow-up date, notes |
| `board` | Tessa: "Pipeline", Julia: "Content calendar" | Columns of cards that scroll sideways (e.g. New → Contacted → Meeting → Signed) | An item sheet |
| `table` | Ingrid: "Events, Oct–Dec" | Table with an icon column, horizontal scroll, columns can be sorted | A row sheet |
| `list` | Coordinator: "Ideas" (spec 06), checklists | A list with optional checkboxes and tags | An item sheet |
| `draft` | Tessa: a reply draft | See [Draft view](#draft-view) | — |

## Preview inside the thread

```
┌──────────────────────────────────────┐
│ 👥  My people                    ›   │
│ 23 people · 4 follow-ups this week   │
│ Updated 2h ago · 2 changes since you │
│ looked                               │
└──────────────────────────────────────┘
```

- It has a kind icon, a title, a one-line summary written by the intern, and when it was
  last updated.
- **"N changes since you looked"** is worked out on the device from the version JP last
  opened, the same way unread works today (`app/src/unread.ts`).
- When a page is updated, the intern also posts a one-line chat message such as
  "Moved Ada to Signed". That keeps the thread a record of what changed, and the
  preview card is not posted again.

## Item sheet: actions are chat messages

Every item sheet ends with action chips. Each chip sends a normal message to the intern who
owns the page and quotes the item, using the existing reply/quote mechanism:

- Person: **Draft a follow-up** · **Change follow-up date** · **What's the history?** ·
  **Move stage…**
- Board item: **Move to…** (a column picker) · **Remind me** · **Ask about this**
- Event row: **Add to calendar** · **Not interested** (this sends a message; the intern
  can turn it into a standing order, see spec 04)

A free-text "Ask about this…" field is always available. JP never edits a page directly in
v1. The intern makes every change, so its memory and the page always agree.

## Draft view

The `draft` kind is the Draft Studio:

```
To   Ada Okafor
Cc   Lena (Side Project)
Re:  ClinicFlow for Willowbrook Vet          ✓ Reply-all in thread
─────────────────────────────────────────
Hi Ada, …  (JP's new text)
─────────────────────────────────────────
▸ 4 earlier emails                       (collapsed quoted thread)

[ Shorter ] [ Warmer ] [ More formal ] [ Afrikaans ]
[ Ask for a change… ]          [ Open in Outlook ↗ ]
```

- The badge comes from the CLI output described in spec 01. If `kind` is `new` when JP
  asked for a reply, the badge turns into a warning: "⚠ New email, not a reply".
- The tone chips send messages such as "Make it shorter". Tessa revises the **same** draft
  with `revise-draft`, so there is still one draft in Outlook and the page shows the new
  version.
- **Open in Outlook** follows `web_link`. JP sends the email from Outlook; there is still no
  Send button in the app.
- When the unsent-draft detection finds drafts sitting in Outlook, Tessa can show them as a
  `list` page called "Drafts waiting on you".

## App work

- Render the `page` fence in `app/src/ui/Markdown.tsx`, alongside the existing `chart`,
  `svg` and `mermaid` blocks:

  ````
  ```page
  {"id": "pg_…"}
  ```
  ````

- A new `app/src/ui/PagePreview.tsx` for the preview, and a full-screen route
  `app/app/page/[id].tsx` that loads the page and renders it by kind. Each kind is one small
  component.
- Item sheets reuse the bottom-sheet pattern from the message menu in `chat/[slug].tsx`.
  Chip actions call `api.sendMessage` with a quoted reply.
- Live updates arrive over SSE as a new event type, `page`, carrying `{id, version}`. On that
  event, re-fetch the page if it is open and refresh its preview.
- Discord shows a page as an embed with the title, the summary and an "Open in app" link.
  Rendering the page itself in Discord is out of scope.

## Backend work

- Table `pages`: `id, intern, thread_key, kind, title, summary, data JSON, version,
  updated_at, archived_at`.
- `GET /pages/:id`, `GET /interns/:key/pages`, and an SSE event `page`.
- An intern tool `intern-page` with the subcommands `create`, `update`, `patch-item`, `get`
  and `list`. It validates `data` against the schema for its kind and bumps `version`.
- Data for each kind (keep it small):
  - `people`: `{people: [{id, name, company, email?, tags[], how_met?, last_touch?,
    next_follow_up?, notes?}]}`
  - `board`: `{columns: [{id, title}], items: [{id, column, title, subtitle?, due?,
    person_id?}]}`
  - `table`: `{columns: [{key, title, icon?}], rows: [{id, …}]}`
  - `list`: `{items: [{id, text, done?, tags[], ts}]}`
  - `draft`: the output of `graph-mail draft` plus `{body, thread: [{from, date, preview}]}`
- The intern's own memory is where the facts live, and the page is how it shows them. For
  `people`, Tessa should keep the page as the structured copy of the contact knowledge in her memory and
  stop re-deriving it from the ledger markdown each time.

## Out of scope for v1

- Editing pages directly: dragging cards, inline cell edits.
- Pages shared between interns, and page history or diffs beyond "N changes".

### Moodboard shortlists

Moodboard cards have a Like button, with the same toggle in the item sheet.
The owner can add or remove tags in the sheet and reuse tags from other items
on the board. All/Liked and tag filters can be combined to find a shortlist.
Likes (`liked`, default `false`) and `tags` are saved through the item PATCH
endpoint, so they persist across devices and are visible to the owning intern.
Tags are also included in the existing cross-page search.

Interns can read the same likes and tags with `intern-page get` and curate
references with `intern-page patch-item <page_id> <item_id> --set
'{"liked":true,"tags":["wrist","use next"]}'`. Set `liked` to `false` to
unlike. The tags array replaces the previous array, so read it first to retain
existing tags when adding one. Interns should preserve owner choices during
unrelated updates and respect the owner's latest instructions.
