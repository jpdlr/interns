/**
 * Personality dials: four 1–5 settings the owner turns when hiring (and later
 * on the profile) instead of rewriting a persona by hand. 3 is "no
 * preference", so only the dials someone moved add a line to the intern's
 * system prompt, under "## Style".
 *
 *   tone        1 casual … 5 formal
 *   length      1 brief … 5 thorough
 *   initiative  1 waits to be asked … 5 takes initiative
 *   humour      1 straight … 5 playful
 */
import { z } from "zod";

const Dial = z.number().int().min(1).max(5);
export const StyleSchema = z.object({ tone: Dial, length: Dial, initiative: Dial, humour: Dial });
export type Style = z.infer<typeof StyleSchema>;
export const DEFAULT_STYLE: Style = { tone: 3, length: 3, initiative: 3, humour: 3 };

const LINES: Record<keyof Style, Record<number, string>> = {
  tone: {
    1: "Write casually, like a colleague on chat.",
    2: "Keep it friendly and informal.",
    4: "Keep it professional and polished.",
    5: "Be formal: complete sentences, no slang.",
  },
  length: {
    1: "Be extremely brief: one or two lines, the verdict only.",
    2: "Keep messages short: a few lines at most.",
    4: "Be thorough: give the context and your reasoning.",
    5: "Be detailed: full context, the options, and clear next steps.",
  },
  initiative: {
    1: "Only do what you are asked; never volunteer extra work.",
    2: "Mostly wait to be asked; suggest at most one next step.",
    4: "Take initiative: propose next steps and handle routine follow-ups within your tools.",
    5: "Be highly proactive: anticipate needs, flag problems early, and act within your guardrails without waiting to be asked.",
  },
  humour: {
    1: "No jokes; stay strictly to the point.",
    2: "Mostly serious.",
    4: "A little dry wit is welcome.",
    5: "Be playful and warm; light humour where it fits.",
  },
};

/** The "## Style" block for an intern's system prompt ("" when every dial is in the middle). */
export function stylePrompt(style: Style | undefined): string {
  if (!style) return "";
  const lines = (Object.keys(LINES) as (keyof Style)[]).map((dial) => LINES[dial][style[dial]]).filter(Boolean);
  return lines.length ? `\n## Style\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}
