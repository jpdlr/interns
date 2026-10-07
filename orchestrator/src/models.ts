/**
 * The small model, for every cheap call (triage, tagging, picking responders,
 * suggestions, learning from edits) and the interns' helper subagent.
 *
 * Haiku 5.5 only — never Haiku 4.5, which isn't good enough for this work.
 * Pinned to the full id so an SDK alias change can't move it. Fine for very
 * short, very small tasks; anything that needs judgement stays on the
 * intern's own model.
 */
export const SMALL_MODEL = "claude-haiku-5-5";
