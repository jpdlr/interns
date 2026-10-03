/**
 * Renaming an intern carries through to the prose that talks about them: the
 * role, persona, system prompt and backlog are full of "You are Julia…", so
 * typing a new name rewrites those mentions as you go instead of leaving JP to
 * hunt them down by hand. Used by both the hire candidate card and the
 * settings screen.
 *
 * Every keystroke is applied to a snapshot taken when the rename started, not
 * to the live text — otherwise half-typed names would compound ("Julia" → "A"
 * → every standalone "A" in the prompt). The snapshot is dropped when the
 * Name field blurs or another named field is edited directly, so manual edits
 * are never overwritten.
 */
import { useMemo, useRef } from "react";

export interface NamedText {
  name: string;
  role: string;
  persona: string;
  system_prompt: string;
  backlog: string[];
}

export type ProseField = Exclude<keyof NamedText, "name">;

type Prose = Omit<NamedText, "name">;

export const PROSE_LABELS: Record<ProseField, string> = {
  role: "role",
  persona: "persona",
  system_prompt: "system prompt",
  backlog: "backlog",
};

/** What a rename keystroke did: the patch to apply and how much of the prose followed. */
export interface RenameResult {
  patch: NamedText;
  /** Fields whose text differs from what was on screen before this keystroke. */
  changed: ProseField[];
  /** Mentions rewritten since the rename started, by field. */
  mentions: Partial<Record<ProseField, number>>;
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  // Letters in any script (case-bearing), digits and underscore.
  return ch.toLowerCase() !== ch.toUpperCase() || /[0-9_]/.test(ch);
}

/** Splits `text` around whole-word, case-sensitive occurrences of `name`. */
function splitOnName(text: string, name: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let at = text.indexOf(name);
  while (at !== -1) {
    const end = at + name.length;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[end])) {
      parts.push(text.slice(cursor, at));
      cursor = end;
      at = text.indexOf(name, end);
    } else {
      at = text.indexOf(name, at + 1);
    }
  }
  parts.push(text.slice(cursor));
  return parts;
}

/**
 * Replaces whole-word, case-sensitive occurrences of `from` with `to`.
 * "Julia's" and "Julia," match; "Julian" and "julia" do not.
 */
export function replaceName(text: string, from: string, to: string): { text: string; count: number } {
  if (!from || from === to) return { text, count: 0 };
  const parts = splitOnName(text, from);
  return { text: parts.join(to), count: parts.length - 1 };
}

const firstWord = (name: string) => name.split(/\s+/)[0] ?? "";

/**
 * The full name first, then — when the old name had more than one word — its
 * first name on its own, so "Julia Chen" → "Alex Moore" also turns a casual
 * "Julia said" into "Alex said". The first-name pass only sees the text
 * between full-name matches, so it never rewrites the name just inserted.
 */
export function carryName(text: string, from: string, to: string): { text: string; count: number } {
  if (!from || from === to) return { text, count: 0 };
  const parts = splitOnName(text, from);
  let count = parts.length - 1;
  if (/\s/.test(from)) {
    for (let i = 0; i < parts.length; i++) {
      const first = replaceName(parts[i]!, firstWord(from), firstWord(to));
      parts[i] = first.text;
      count += first.count;
    }
  }
  return { text: parts.join(to), count };
}

export function useNameCarry() {
  /** The name the prose currently uses; null means "whatever the name field holds". */
  const proseName = useRef<string | null>(null);
  const snapshot = useRef<{ from: string; prose: Prose } | null>(null);

  return useMemo(
    () => ({
      rename(current: NamedText, nextName: string): RenameResult {
        if (!snapshot.current) {
          snapshot.current = {
            from: proseName.current ?? current.name.trim(),
            prose: {
              role: current.role,
              persona: current.persona,
              system_prompt: current.system_prompt,
              backlog: current.backlog,
            },
          };
        }
        const { from, prose } = snapshot.current;
        // A cleared field leaves the prose as it was until a new name arrives.
        const to = nextName.trim() || from;
        proseName.current = to;

        const mentions: RenameResult["mentions"] = {};
        const carry = (field: ProseField, text: string) => {
          const result = carryName(text, from, to);
          if (result.count) mentions[field] = (mentions[field] ?? 0) + result.count;
          return result.text;
        };
        const patch: NamedText = {
          name: nextName,
          role: carry("role", prose.role),
          persona: carry("persona", prose.persona),
          system_prompt: carry("system_prompt", prose.system_prompt),
          backlog: prose.backlog.map((item) => carry("backlog", item)),
        };
        const changed = (Object.keys(PROSE_LABELS) as ProseField[]).filter(
          (field) => JSON.stringify(patch[field]) !== JSON.stringify(current[field]),
        );
        return { patch, changed, mentions };
      },
      /** End the current rename: on Name blur, or before a direct edit to the prose. */
      settle() {
        snapshot.current = null;
      },
      /** Forget everything: a new draft or manifest has replaced the form. */
      reset() {
        snapshot.current = null;
        proseName.current = null;
      },
    }),
    [],
  );
}

/** "4 mentions in persona and system prompt" — the caption under the Name field. */
export function describeMentions(mentions: RenameResult["mentions"]): string | null {
  const fields = (Object.keys(PROSE_LABELS) as ProseField[]).filter((f) => mentions[f]);
  if (!fields.length) return null;
  const total = fields.reduce((sum, f) => sum + (mentions[f] ?? 0), 0);
  const labels = fields.map((f) => PROSE_LABELS[f]);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
  return `Also renamed ${total} ${total === 1 ? "mention" : "mentions"} in ${list}.`;
}
