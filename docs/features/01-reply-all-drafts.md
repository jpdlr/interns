# 01 — Proper reply-all drafts

## Problem

When JP asks Tessa to reply to an email, the draft does not look like a reply in Outlook. It
shows up as "New Message", the earlier emails are missing, and anyone who was on CC has been
dropped. Tessa works around this by pasting the earlier emails into the body as plain text,
which is not a real reply-all. JP hit this with the Kai draft (14 Sept) and has asked again
since.

## Root cause (`orchestrator/tools/graph-mail`, `cmd_draft`)

```python
draft = graph(token, f"/me/messages/{args.reply_to}/createReply", "POST", {})
graph(token, f"/me/messages/{draft['id']}", "PATCH",
      {"body": {"contentType": "Text", "content": args.body}})
```

1. **`createReply` is used instead of `createReplyAll`**, so everyone on CC is dropped.
2. **The PATCH replaces the whole body.** Graph's reply comes pre-filled with the quoted
   earlier emails as HTML, and setting `body` to plain text deletes them. This is why the
   draft loses its history.
3. **Replying to a draft fails.** If the newest message in a thread is JP's own unsent draft,
   `createReply` fails. Tessa then retries by hand (see `tessa/memory/followup-history.md`)
   or creates a brand-new email instead.
4. **Superseded drafts cannot be deleted.** A wrong draft stays in Drafts, and JP has to
   find and delete it by hand.

## Fix (backend)

- `draft --reply-to <id>` should call `POST /me/messages/{id}/createReplyAll` with
  `{"comment": "<body>"}`. Graph places the comment above the quoted thread and keeps the To
  and CC lists and the subject. Do not PATCH the body afterwards.
- Add a `--sender-only` flag for the rare case where replying to the sender alone is wanted.
  Reply-all is the default.
- **Pick the right message to reply to inside the CLI** rather than leaving it to the
  intern's memory. If `--reply-to` points at a draft, or at one of JP's own sent messages,
  walk back through the conversation to the newest message from someone else, and reply to
  that one.
- **Never fall back silently to a new email.** If a reply was asked for and cannot be made,
  exit with an error and a clear reason.
- Add `revise-draft <draft_id> --body B`, which replaces only JP's new text and keeps the
  quoted thread. Implement it as: recreate the draft with `createReplyAll` and the new
  comment, then delete the old draft. The new draft id is returned.
- Add `delete-draft <draft_id>`. It may only delete drafts this tool created; keep those ids
  in a small ledger on disk. JP's own drafts are never touched. Sending stays impossible.
- Return everything the draft page needs (spec 02, kind `draft`):
  `{draft_id, kind: "reply_all"|"reply"|"new", to[], cc[], subject, conversation_id,
  in_reply_to, web_link, threaded: true}`. `web_link` is Graph's `webLink`, which opens the
  draft in Outlook.
- Update Tessa's manifest (`~/.interns/tessa/intern.yaml`) to describe the new behaviour.
  Mark the "build the quote block yourself" workaround in her memory as superseded, so she
  stops pasting earlier emails twice.

## Checks

- Reply to an email thread with three people: the draft opens in Outlook as **RE:**, every
  original recipient is on To or CC, the earlier emails are quoted underneath, and JP's text
  sits at the top.
- Reply where the newest message in the thread is JP's own unsent draft: the reply goes to
  the newest message from the other person.
- Revise a draft: there is still exactly one draft in Drafts, and the quoted history is still
  there.
- Point `--reply-to` at something invalid: the command exits non-zero and no new email is
  created.
