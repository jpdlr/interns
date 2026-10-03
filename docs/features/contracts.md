# Shared contract: app ↔ orchestrator

The app agent and the backend agent both build to this file. If a shape here has to change,
change this file in the same commit. Where it differs from a spec, this file wins.

Conventions follow the existing API: bearer auth on every route, ISO 8601 timestamps,
`snake_case` JSON, and errors as `{error: string}` with a 4xx/5xx status.

## 1. Message fences

New in-message UI travels inside the message `text` as fenced blocks, the same way `chart`,
`svg` and `mermaid` blocks already work (`app/src/ui/Markdown.tsx`). The `Message` schema
does not change. Each fence body is a single JSON object.

- The app renders each fence as described below.
- Discord renders the fallback text instead (`orchestrator/src/discord.ts`). Push
  notifications (`notifytext.ts`) reduce each fence to the label listed.
- If a fence's JSON is invalid, the app shows a quiet "couldn't show this block" line. It
  never shows the raw JSON.

| Fence | Body | App renders | Discord fallback | Push label |
|---|---|---|---|---|
| `page` | `{"id": "pg_…", "title": "My people", "kind": "people"}` | `PagePreview` (fetches `GET /pages/:id`) | `📄 <title> — <summary> (open in app)` | `📄 <title>` |
| `rule` | `{"id": "rl_…", "text": "Ignore all PRs in northwind/webapp", "kind": "hard"\|"soft"}` | Rule chip with **Undo** and **Edit** | `📌 Standing order: <text>` | `📌 <text>` |
| `quick-replies` | `{"options": ["Went well", "Needs follow-up", "Didn't happen", "Skip"]}` | Chips under the message. Tapping one sends its text as a reply to the message. The chips hide once JP has replied. | `Reply with: a / b / c` | (omitted) |
| `checklist` | `{"id": "cl_…", "title": "Next steps for Willowbrook Vet", "items": [{"id": "1", "text": "…", "checked": true}], "submit": "Do these"}` | Checkboxes plus a submit button. Submitting sends `Do these: 1, 2` (the ticked ids) as a reply, then locks the checklist on this device. | numbered list + `Reply "do 1,2,3"` | `☑ <title>` |

Fences produced by the backend are added by the orchestrator after the relevant tool call.
The intern's own prose is not edited.

## 2. Pages

```ts
type PageKind = "people" | "board" | "table" | "list" | "draft";

interface Page {
  id: string;              // "pg_<uuid>"
  intern: string;          // owner slug, or "coordinator"
  thread_key: string;      // thread it was first posted in
  kind: PageKind;
  title: string;
  summary: string;         // one line, intern-written
  version: number;         // +1 on every change
  updated_at: string;
  pinned: boolean;
  data: PeopleData | BoardData | TableData | ListData | DraftData;
}

interface Person {
  id: string; name: string; company?: string; email?: string;
  tags: string[];                 // e.g. "lead", "client", "expo:mining-week"
  how_met?: string; last_touch?: string; next_follow_up?: string;  // dates as YYYY-MM-DD
  stage?: string;                 // board column id when the person is on a pipeline
  notes?: string;
  timeline?: { ts: string; kind: "mail" | "meeting" | "chat" | "note"; text: string; ref?: string }[];
}
interface PeopleData { people: Person[] }

interface BoardData {
  columns: { id: string; title: string }[];
  items: { id: string; column: string; title: string; subtitle?: string; due?: string; person_id?: string }[];
}

interface TableData {
  columns: { key: string; title: string; icon?: boolean }[];   // icon: cell holds an emoji/icon name
  rows: ({ id: string } & Record<string, string | number | null>)[];
}

interface ListData {
  items: { id: string; text: string; done?: boolean; tags: string[]; ts: string;
           source?: { thread_key: string; message_id: string } }[];
}

interface DraftData {
  draft_id: string;                    // Outlook message id
  mailbox: string;                     // configured mailbox id, e.g. "work"
  kind: "reply_all" | "reply" | "new";
  intended_reply: boolean;             // true when JP asked for a reply; app warns if kind === "new"
  to: string[]; cc: string[]; subject: string;
  body: string;                        // JP's new text only (markdown-ish plain text)
  thread: { from: string; date: string; preview: string }[];   // newest first
  web_link: string;
}
```

| Route | Notes |
|---|---|
| `POST /pages` `{intern, kind, title, summary?, data, thread_key?, announce?}` → `Page` | intern-page create; `announce` (default true) puts the preview on the owner's next reply |
| `PUT /pages/:id` `{title?, summary?, data?}` → `Page` | intern-page update; `data` is validated against the kind |
| `POST /pages/:id/items` `{item}` · `PATCH /pages/:id/items/:itemId` `{set}` · `DELETE /pages/:id/items/:itemId` | add / merge (null clears a field) / remove one item; JP's app uses PATCH only to tick list items |
| `POST /pages/:id/show` · `POST /pages/:id/archive` | attach the preview to the next reply · retire the page |
| `GET /pages/:id` → `Page` | |
| `GET /interns/:key/pages` → `{pages: Omit<Page,"data">[]}` | `:key` = slug, room id or `coordinator`; archived pages excluded |
| `POST /pages/:id/pin` `{pinned: boolean}` → `Page` | shown among the thread's pinned chips |
| SSE `page` → `{id, version, intern, thread_key}` | app re-fetches if open; previews refresh |

Seen-version tracking ("N changes since you looked") stays on the device, keyed by
`page.id → last opened version`, next to `app/src/unread.ts`. "N" is `version - seen`,
capped at a display of "9+".

Intern tool: `intern-page create|update|patch-item|get|list`. It validates `data` against
the kind's schema, bumps `version` and emits `page`. `create` returns the `page` fence for the
intern to include in its reply.

## 3. Standing orders

```ts
type RuleType = "mute_repo" | "mute_sender" | "quiet_hours" | "hold_until" | "guidance";
interface Rule {
  id: string; intern: string; kind: "hard" | "soft"; type: RuleType;
  params: Record<string, unknown>;  // mute_repo {repo}, mute_sender {address|domain},
                                    // quiet_hours {from:"21:00", to:"07:00", tz}, hold_until {match, until}
  text: string; enabled: boolean; hits: number; last_hit_at?: string;
  created_from_message?: string; created_at: string;
}
```

| Route | Notes |
|---|---|
| `POST /interns/:slug/rules` `{type, text, params}` → `Rule` | intern-rule add; the rule chip is attached to the intern's next reply |
| `GET /interns/:slug/rules` → `{rules: Rule[]}` | includes `hits` for the last 7 days as `hits_7d` |
| `GET /rules/:id` → `Rule` | removed rules stay readable, so an old chip can say "removed" |
| `PATCH /rules/:id` `{enabled}` → `Rule` | |
| `DELETE /rules/:id` → `{ok: true}` | the rule chip's **Undo** calls this |
| SSE `rule` → `Rule` | chip and settings list update live |

**Edit** on a rule chip calls no endpoint. It pre-fills the composer with
`Change that standing order to: <text>` as a reply to the chip's message.

## 4. Today

Served as `GET /agenda`, not `/today`: `/today` is the app's tab route, and a cold
navigation to an API path has no bearer token.

```ts
interface TodayResponse {
  date: string;                       // YYYY-MM-DD in the owner's `timezone`
  needs_you: Card[];                  // open decisions: severity action|urgent, or any non-passive action
  fyi: Card[];                        // open cards whose actions only acknowledge (seen/ack/read/ok…)
  schedule_error?: string;            // set when the calendar could not be read; briefed meetings still show
  schedule: {
    event_id: string; start: string; end: string; title: string;
    attendees: { name: string; email: string; external: boolean }[];
    location?: string; web_link?: string;
    brief?: { intern: string; markdown: string; message_id?: string };
    debrief?: { state: "pending" | "asked" | "answered" | "skipped"; intern: string; message_id?: string };
  }[];
  follow_ups: { person_id: string; page_id: string; name: string; company?: string;
                due: string; overdue: boolean; intern: string }[];
  away: { intern: string; summary: string; count: number }[];   // since ?since=
  standup?: { message_id: string; intern: "coordinator"; markdown: string };
}
```

| Route | Notes |
|---|---|
| `GET /agenda?date=YYYY-MM-DD&since=<iso>` → `TodayResponse` | `date` defaults to today; `since` is when the app last opened Today |
| SSE `agenda` → `{date}` | sent when a brief, debrief or standup lands; the app re-fetches |

Inbox deep links: `/inbox?card=<id>` keeps working and goes to Today with that card
highlighted.

## 5. Seen

- Every card with severity `info` gets the default action
  `{id: "seen", label: "Seen", style: "primary", kind: "button"}` unless the creator supplies
  its own actions. The backend resolves it like any other action.
- In the suggestions evidence (`suggest.ts`), `seen` does **not** count as a dismissal.

## 6. Coordinator thread and ideas

- `coordinator` is a valid thread key for `GET|POST /interns/:key/messages`. Messages in it
  use the room shape (`speaker` set to the intern that answered).
- Idea capture is triggered either by a message starting with `idea:` / `💡` in **any**
  thread, or by an explicit call to the route below.

| Route | Notes |
|---|---|
| `POST /ideas` `{text, source?: {thread_key, message_id}}` → `{page_id, item_id, count}` | appends to the coordinator's Ideas `list` page; tags are added asynchronously |

The coordinator acknowledges with a single message: `💡 Saved to Ideas (<count>)`, followed by
a `page` fence the first time the Ideas page is created.

## 7. graph-mail CLI (drafts)

```
graph-mail [--mailbox <id>] draft --reply-to <id> --body B [--sender-only]
graph-mail [--mailbox …] draft --to a,b --subject S --body B
graph-mail [--mailbox …] revise-draft <draft_id> --body B
graph-mail [--mailbox …] delete-draft <draft_id>         # only ids this tool created
```

`draft` and `revise-draft` print the `DraftData` shape above, without `body` and `thread`;
`intern-page` fills those in. Exit codes: `0` ok, `2` usage, `3` no repliable message in the
thread, `4` draft not owned by the tool (on delete or revise), `5` Graph error.

## 8. Message tasks carry what JP answered

When JP replies to a message (swipe-to-reply, a quick reply, a checklist), the
intern's task payload carries `quoted: {id, author, speaker, text}`; answering a
debrief question adds `debrief: <event>`. The intern's prompt spells both out.
A message `idea: …` / `💡 …` is filed on the Ideas page and wakes nobody
(`targets: []`); so does `Skip` on a debrief question.
