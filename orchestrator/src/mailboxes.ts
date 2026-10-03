/**
 * Outlook mailboxes as the orchestrator sees them. `config.mailboxes` lists
 * the connected ids (the first is the default); each id is a directory under
 * ~/.interns/mailboxes/ holding the token cache and a small config.json
 * ({mailbox_label, account}) written by tools/graph-login.
 *
 * An intern may be limited to some of them (manifest.mailboxes; unset = all).
 * The limit is enforced by the mail tools themselves via INTERNS_MAILBOXES,
 * so it holds whatever the engine's permission mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.js";
import type { InternManifest } from "./types.js";

export interface MailboxInfo {
  id: string;
  label: string;
  /** the signed-in address, when graph-login recorded it */
  account: string | null;
  /** a token cache exists (sign-in happened; it may still have expired) */
  signed_in: boolean;
}

export function mailboxesDir(home: string): string {
  return path.join(home, "mailboxes");
}

export function readMailbox(home: string, id: string): MailboxInfo {
  const dir = path.join(mailboxesDir(home), id);
  let cfg: { mailbox_label?: string; account?: string } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  } catch {
    // no config yet: the id is the label
  }
  return { id, label: cfg.mailbox_label || id, account: cfg.account ?? null, signed_in: fs.existsSync(path.join(dir, "token.json")) };
}

export function listMailboxes(home: string, config: Pick<Config, "mailboxes">): MailboxInfo[] {
  return config.mailboxes.map((id) => readMailbox(home, id));
}

/** The connected mailboxes this intern may use (manifest.mailboxes ∩ config.mailboxes; unset = all). */
export function mailboxesFor(manifest: Pick<InternManifest, "mailboxes">, config: Pick<Config, "mailboxes">): string[] {
  return manifest.mailboxes ? config.mailboxes.filter((id) => manifest.mailboxes!.includes(id)) : [...config.mailboxes];
}

/** Whether this intern works with Outlook at all. */
export function usesOutlook(manifest: Pick<InternManifest, "tools">): boolean {
  return manifest.tools.includes("mail") || manifest.tools.includes("calendar");
}

/** The system-prompt block naming the mailboxes an intern can use ("" without Outlook tools). */
export function mailboxPrompt(manifest: InternManifest, config: Pick<Config, "mailboxes">, home: string): string {
  if (!usesOutlook(manifest)) return "";
  const ids = mailboxesFor(manifest, config);
  if (ids.length === 0) return "\n## Mailboxes\nNo Outlook mailbox is connected for you yet. If a task needs one, say so instead of trying.";
  const lines = ids.map((id) => {
    const m = readMailbox(home, id);
    return `- \`${id}\`: ${m.label}${m.account ? ` (${m.account})` : ""}`;
  });
  return (
    `\n## Mailboxes\nYou can use these Outlook mailboxes; pass \`--mailbox <id>\` to graph-mail and graph-cal (the first is the default):\n` +
    lines.join("\n")
  );
}

/** Env for an intern's run: limits graph-mail/graph-cal to its mailboxes when it has a limit. */
export function mailboxEnv(manifest: Pick<InternManifest, "mailboxes">, config: Pick<Config, "mailboxes">): Record<string, string> {
  return manifest.mailboxes ? { INTERNS_MAILBOXES: mailboxesFor(manifest, config).join(",") } : {};
}
