# 04 — Standing orders

## Problem

JP gives interns lasting instructions in chat, and they don't stick reliably. On 9 Sept JP
told Rhea "Ignore webapp PRs completely from now on", then "dont tell me you are skipping it",
then "Stop sending (nothing)", and then twice more "You are still sending". Nothing in the
app shows which instructions an intern is holding, and nothing guarantees it follows them.

## Design: said in chat, confirmed in chat

1. JP says something lasting in a normal message ("ignore webapp PRs from now on").
2. The intern spots that it is a standing instruction and saves it with the
   `intern-rule` tool. Its reply then ends with a **rule chip**:

   ```
   📌 Standing order saved: Ignore all PRs in northwind/webapp — no messages, no cards
      [Undo]   [Edit]
   ```

   **Undo** deletes the rule. **Edit** sends "Change that rule to…" with the text filled in,
   so editing is also done by talking.
3. Teaching from a message: the long-press menu in `chat/[slug].tsx` gets
   **"Don't send me this kind of thing…"**. It sends a quoted reply asking the intern to
   suggest a standing order, which then follows step 2.
4. To see the rules, JP can ask "what are your standing orders?" and the intern replies with
   a `list` page (spec 02). They also appear as a **Standing orders** section on the intern's
   file screen. Each rule has an on/off toggle and shows how many times it fired:
   "Muted 14 PRs this week". The counter shows JP the rule is working.

## Two kinds of rule

| Kind | How it is enforced | Examples |
|---|---|---|
| **Hard** (deterministic) | The orchestrator drops or holds work before the intern sees it | mute a repo; mute a sender or domain; quiet hours (no pushes 21:00–07:00); hold a person or topic until a date |
| **Soft** (guidance) | Added to the intern's system prompt as a "Standing orders" block | "write Afrikaans to Kettle Labs", "keep PR summaries to 3 lines", "never tell me you're skipping something" |

The intern picks the kind when it saves the rule. If the instruction matches a hard type, it
must use the hard type, because hard rules cannot be forgotten.

## Built-in rules that are always on

- **A "(nothing)" reply is never delivered.** The orchestrator drops it before the message is
  stored. It does not need a rule; it is a bug.
- **Hard rules apply silently.** A muted item produces nothing at all, not even a "skipped"
  note. The counter on the intern's file screen is the only trace.

## Backend work

- Table `rules`: `id, intern, kind (hard|soft), type (mute_repo|mute_sender|quiet_hours|
  hold_until|guidance), params JSON, text, enabled, hits, last_hit_at, created_from_message,
  created_at`.
- Intern tool `intern-rule` with the subcommands `add`, `list`, `disable`, `remove`. `add`
  returns the rule; the orchestrator then appends a `rule` fence to the intern's reply
  (see [contracts.md §1](contracts.md#1-message-fences)).
- Hard rules are checked where work enters the system: `githubwatch.ts` (repo),
  `mailwatch.ts` and `triage.ts` (sender/domain), `push.ts` (quiet hours) and task enqueueing
  (hold_until). Each match increments `hits`.
- Soft rules are added to the system prompt when a session starts.
- `GET /interns/:slug/rules`, `PATCH /rules/:id` (enable/disable), `DELETE /rules/:id`.

## App work

- Render the rule chip under the intern's message, with Undo and Edit.
- Add the menu item "Don't send me this kind of thing…".
- Add the Standing orders section on `intern/[slug].tsx` with toggles and hit counts.
