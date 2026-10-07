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

/**
 * What one SMALL_MODEL token counts for against an intern's daily token cap.
 * Haiku 5.5 is $0.10 in / $0.50 out per million tokens (prompts up to 100k),
 * Opus 5.5 (the interns' default model) $4 / $20: a fortieth of the price.
 * Recorded cost stays the real cost. Prices checked 2026-10-07 at
 * platform.claude.com/docs/en/about-claude/pricing.
 */
export const SMALL_MODEL_CAP_WEIGHT = 1 / 40;
