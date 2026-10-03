# 05 — Debrief

## Problem

Interns brief JP before meetings but never hear how the meetings went. Outcomes only reach
them when JP happens to mention one: "The ada meeting went well they are signing up",
"I did call Greg today… everything is good", "Kai got it working so it is done". Follow-up
dates, pipeline stages and thank-you emails depend on those outcomes.

## Design

1. About 10 minutes after a meeting with outside attendees ends, the intern that wrote the
   brief (usually Tessa) posts a short message in **its own chat**:

   > How did **Ada · Willowbrook Vet** go?

   The message has quick replies: **Went well** · **Needs follow-up** · **Didn't happen** ·
   **Skip**.
2. The same question appears as a **Debrief** chip on the meeting row in Today (spec 03).
   Tapping the chip opens the chat with the composer focused.
3. JP taps a quick reply, adds a sentence if wanted, or dictates one with the iPhone
   keyboard's dictation (no extra voice feature is needed).
4. The intern replies with **proposed next steps as a checklist**:

   ```
   Next steps for Willowbrook Vet
   ☑ Move Ada to Signed on the pipeline
   ☑ Draft a thank-you + onboarding email (reply-all to the thread)
   ☑ Follow-up on Fri 9 Oct: check the account is set up
   ☐ Tell Lena
   [ Do these ]
   ```

   JP unticks anything unwanted and taps **Do these**. The intern does the ticked
   steps and posts one confirmation line for each: the page was updated, the draft is ready,
   the follow-up is set.
5. **Skip** and no answer are both fine. The question is asked once, never chased, and it
   disappears from Today at the end of the day.

## Rules

- Only meetings with someone outside JP's own organisation(s) are debriefed. Internal
  check-ins and standups are not.
- The meeting ending only triggers the question; asking it takes no LLM call. The checklist
  is the intern's work.
- A standing order (spec 04) can turn debriefs off for a given meeting series or
  attendee.

## App work

- Quick replies on a debrief message come from a `quick-replies` fence (see
  [contracts.md §1](contracts.md#1-message-fences)). Render them with the existing
  `QuickReplies.tsx` chips; when the fence is present, use its options instead of the
  keyword-matched ones.
- Checklist message: a `checklist` fence with checkbox items and one submit button. Submit
  sends "Do these: 1, 2, 3" as a reply to the checklist. Later this could be a `list` page;
  for now an inline block is enough.

## Backend work

- `meetingwatch.ts` already tracks events. Add a post-meeting trigger at `end + 10 min` for
  events that had a brief. It queues a `trigger` task for the briefing intern carrying the
  event context, and records the debrief state (`asked|answered|skipped`) for `/today`.
- Add the `checklist` fence to Discord rendering as a plain numbered list, with a hint to
  reply "do 1,2,3".
