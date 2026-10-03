/**
 * Message fences: in-message UI that rides inside a message's markdown as a
 * fenced JSON block, the same way ```chart does (docs/features/contracts.md
 * §1). The app renders them natively; Discord and push get the plain-text
 * fallbacks below, so neither surface ever shows raw JSON.
 *
 *   ```page          {"id","title","kind"}            page preview card
 *   ```rule          {"id","text","kind"}             standing-order chip
 *   ```quick-replies {"options":[…]}                  reply chips
 *   ```checklist     {"id","title","items":[…],"submit"}  tick-and-submit list
 */

export const FENCE_LANGS = ["page", "rule", "quick-replies", "checklist"] as const;
export type FenceLang = (typeof FENCE_LANGS)[number];

const FENCE_RE = /```(page|rule|quick-replies|checklist)[ \t]*\n([\s\S]*?)```/g;

export function fence(lang: FenceLang, body: Record<string, unknown>): string {
  return "```" + lang + "\n" + JSON.stringify(body) + "\n```";
}

export function pageFence(page: { id: string; title: string; kind: string }): string {
  return fence("page", { id: page.id, title: page.title, kind: page.kind });
}

export function ruleFence(rule: { id: string; text: string; kind: string }): string {
  return fence("rule", { id: rule.id, text: rule.text, kind: rule.kind });
}

export function quickRepliesFence(options: string[]): string {
  return fence("quick-replies", { options });
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

/** One fence → the text a surface without the app's renderer shows. */
function fallbackFor(lang: FenceLang, body: Record<string, unknown> | null, mode: "discord" | "push"): string {
  if (!body) return "";
  switch (lang) {
    case "page": {
      const title = str(body.title, "a page");
      return mode === "push" ? `📄 ${title}` : `📄 **${title}** (open in the app)`;
    }
    case "rule":
      return `📌 ${mode === "push" ? "" : "Standing order: "}${str(body.text, "standing order saved")}`;
    case "quick-replies": {
      const options = Array.isArray(body.options) ? body.options.map((o) => str(o)).filter(Boolean) : [];
      return mode === "push" || options.length === 0 ? "" : `_Reply with: ${options.join(" / ")}_`;
    }
    case "checklist": {
      const title = str(body.title, "Checklist");
      if (mode === "push") return `☑ ${title}`;
      const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
      const lines = items.map((item, i) => `${i + 1}. ${item?.checked === false ? "☐" : "☑"} ${str(item?.text)}`);
      const ids = items.map((item, i) => str(item?.id, String(i + 1))).join(",");
      return [`**${title}**`, ...lines, `_Reply "do ${ids}" (or the numbers you want)._`].join("\n");
    }
  }
}

/** Replace every message fence with its fallback text. Other fences (chart, svg…) are left alone. */
export function plainFences(text: string, mode: "discord" | "push" = "discord"): string {
  return text
    .replace(FENCE_RE, (_m, lang: FenceLang, body: string) => fallbackFor(lang, parse(body), mode))
    .replace(/\s*⟨pg_[^⟩]*⟩/g, "") // page references are for interns; surfaces show nothing
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** All fences of one kind in a message, parsed (invalid JSON skipped). */
export function findFences(text: string, lang: FenceLang): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    if (m[1] !== lang) continue;
    const body = parse(m[2]!);
    if (body) out.push(body);
  }
  return out;
}
