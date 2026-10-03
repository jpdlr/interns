/**
 * Personality dials (orchestrator src/style.ts): four 1–5 settings, 3 = no
 * preference. Here: what each dial is called, and a sample reply that shows
 * the combination at a glance — written from fixed pieces, so it changes the
 * instant a dial moves, with no model call.
 */
import type { Style } from "./api";

export const DEFAULT_STYLE: Style = { tone: 3, length: 3, initiative: 3, humour: 3 };

export const DIALS: { key: keyof Style; title: string; low: string; high: string; steps: string[] }[] = [
  { key: "tone", title: "Tone", low: "Casual", high: "Formal", steps: ["Very casual", "Casual", "Natural", "Polished", "Formal"] },
  { key: "length", title: "Length", low: "Brief", high: "Thorough", steps: ["One-liners", "Brief", "Balanced", "Thorough", "Detailed"] },
  { key: "initiative", title: "Initiative", low: "Waits to be asked", high: "Takes initiative", steps: ["Only when asked", "Mostly waits", "Balanced", "Proactive", "Very proactive"] },
  { key: "humour", title: "Humour", low: "Straight", high: "Playful", steps: ["No jokes", "Mostly serious", "Natural", "Dry wit", "Playful"] },
];

/** How a candidate with these dials would answer "Anything I need to know?" */
export function sampleReply(style: Style): string {
  const formal = style.tone >= 4;
  const parts: string[] = [];

  if (style.tone <= 2) parts.push(style.tone === 1 ? "Hey!" : "Hi!");
  else if (style.tone === 5) parts.push("Good morning.");
  if (style.humour === 5) parts.push(formal ? "The inbox is behaving, for once." : "Inbox is behaving, mostly 🙂");
  else if (style.humour === 4) parts.push(formal ? "A quiet morning, all things considered." : "Quiet inbox, loud Friday.");

  const body = [
    formal ? "Two replies are outstanding; both drafts are ready." : "2 replies owed, both drafted.",
    formal
      ? "You owe replies to Ada at Willowbrook Vet and to Northwind; both drafts are ready for your approval."
      : "You owe Ada (Willowbrook Vet) and Northwind a reply. Both are drafted, they just need your OK.",
  ];
  if (style.length <= 1) parts.push(body[0]!);
  else parts.push(body[1]!);
  if (style.length >= 3) parts.push(formal ? "Ada has been waiting since Tuesday." : "Ada's been waiting since Tuesday.");
  if (style.length >= 4) parts.push(formal ? "She asked about the demo date, so I proposed Thursday at 10:00." : "She asked about the demo, so I suggested Thursday at 10.");
  if (style.length >= 5)
    parts.push(formal ? "Northwind's question is about pricing; I kept the reply to a holding note and left the figures to you." : "Northwind's is about pricing, so I kept it to a holding note and left the numbers to you.");

  if (style.initiative === 1) parts.push(formal ? "Let me know if you would like me to do anything with them." : "Want me to do anything with them?");
  else if (style.initiative === 2) parts.push(formal ? "Shall I chase them?" : "Want me to chase them?");
  else if (style.initiative === 4) parts.push(formal ? "I will follow up with Ada on Friday if she has not replied." : "I'll nudge Ada on Friday if she goes quiet.");
  else if (style.initiative === 5)
    parts.push(formal ? "I have also drafted Friday follow-ups for both; they are waiting in your Drafts." : "I've also drafted Friday follow-ups for both, they're in your Drafts.");

  return parts.join(" ");
}
