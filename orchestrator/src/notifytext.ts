/**
 * Markdown → lock-screen text.
 *
 * Interns write markdown: their messages and card bodies are links, bold runs,
 * headings, tables and fenced blocks, because the app and Discord both render
 * it. A push notification renders none of it — the raw source lands on the
 * lock screen, so a message that opens with a link title shows up as
 * "[**widget #111 — CodeOps**](https://codeops.example.com/PullRequests/…"
 * and the owner sees a URL instead of the sentence.
 *
 * plainText() flattens the markup to the text a human would have read out —
 * link text without the URL, bullets as "•", tables as " · " rows, code and
 * charts as short placeholders — on a single line, since a notification body
 * is a couple of wrapped lines and blank-line structure is lost anyway.
 * PushService.notify() runs every payload through this, so no call site has to
 * remember to. The app has its own twin of this for chat-list previews
 * (stripMarkdown/cleanMessagePreview in app/src/ui/Markdown.tsx) — same intent,
 * but it lives in the React Native bundle and cannot be imported here.
 */
import { stripRichBlocks } from "./standup.js";

/** Lock-screen titles are truncated hard by the OS; leave room for the intern name prefix. */
export const NOTIFY_TITLE_CHARS = 80;
/** iOS shows ~4 wrapped lines of body before it truncates for us. */
export const NOTIFY_BODY_CHARS = 160;

/** Flatten markdown to the single line of prose a human would read out loud. */
export function plainText(input: string): string {
  let text = stripRichBlocks(input ?? "");

  // Fenced code — a stack trace or key fingerprint is noise on a lock screen.
  text = text.replace(/```[^\n]*\n[\s\S]*?```/g, " (code — open the app) ");
  text = text.replace(/```[^\n]*\n[\s\S]*$/g, " (code — open the app) "); // unterminated fence
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Links and images: keep what was meant to be read, drop the target.
  text = text.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, ""); // reference-link definitions
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1"); // reference links
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1"); // autolinks

  // Stray HTML an intern may have pasted in.
  text = text.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Block markers.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, "$1\n"); // heading becomes its own " · " chunk
  // Interns write a lot of headings as a fully bold line; same treatment.
  text = text.replace(/^[ \t]*(?:\*\*|__)(.+?)(?:\*\*|__)[ \t]*$/gm, "$1\n");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]{0,3}(?:[-*_] *){3,}$/gm, "");

  // Tables: drop the |---|---| rule, then read each row across.
  text = text.replace(/^[ \t]*\|?[ \t:|-]*\|[ \t:|-]*$/gm, "");
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_all, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" · "),
  );

  // Lists.
  text = text.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "• ");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  text = text.replace(/^[ \t]*(\d+)[.)][ \t]+/gm, "$1. ");

  // Emphasis. Bold first so **x** does not leave a stray asterisk behind.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1");
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1"); // escaped punctuation

  // Agent implementation detail is not lock-screen material — the same scrub
  // the app's cleanMessagePreview() does to chat-list rows.
  text = text
    .replace(/\s+(?:at|in|from)\s+\/(?:private\/)?tmp\/[^\s,;)}\]]+/gi, "")
    .replace(/\s+(?:at|in|from)\s+\/home\/[^\s,;)}\]]+/gi, "")
    .replace(/\/(?:private\/)?tmp\/[^\s,;)}\]]+/gi, "local workspace")
    .replace(/\/home\/[^\s,;)}\]]+/gi, "local workspace")
    .replace(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\S*/gi, "$1/$2 #$3");

  // One line: paragraphs (and a heading and the prose under it) become " · "
  // so they do not run into each other as one long sentence.
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return blocks
    .join(" · ")
    .replace(/\s*·\s*(?=•)/g, " ") // a list right after its lead-in line
    .replace(/([:,—–-])\s*·\s*/g, "$1 ") // …lead-in that already ends in punctuation
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/•\s*(?=•)/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/^[\s•·]+|[\s•·]+$/g, "")
    .trim();
}

/** plainText(), cut to `max` on a word boundary with an ellipsis when it does not fit. */
export function notificationText(input: string, max: number): string {
  const text = plainText(input);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the word boundary if it does not throw most of the line away.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.!?·•—-]+$/, "")}…`;
}
