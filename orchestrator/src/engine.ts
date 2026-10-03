/**
 * Agent engine: wraps @anthropic-ai/claude-agent-sdk query() for intern runs.
 *
 * Verified against @anthropic-ai/claude-agent-sdk@0.3.241 sdk.d.ts:
 *  - query({ prompt, options }) is an async iterable of SDKMessage
 *  - the terminal message has type 'result'; subtype 'success' carries
 *    `.result` (text), errors carry subtype 'error_*'
 *  - token/cost accounting comes from `.modelUsage` (per-model inputTokens /
 *    outputTokens / costUSD) — the docs say to prefer it over `.usage`
 *  - `.session_id` on the result is what `options.resume` expects next time
 *  - options: systemPrompt (plain string ok), cwd, allowedTools, tools,
 *    permissionMode ('default' = conservative), resume, maxTurns, settingSources
 */
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { internsHome, type Config } from "./config.js";
import type { Db } from "./db.js";
import { instagramPrompt } from "./instagram.js";
import { mailboxEnv, mailboxPrompt } from "./mailboxes.js";
import { ownerName } from "./profile.js";
import type { Registry } from "./registry.js";
import { standingOrdersPrompt } from "./rules.js";
import { reactionsPrompt } from "./reactions.js";
import { stylePrompt } from "./style.js";
import type { InternManifest } from "./types.js";

/**
 * The intern CLIs live in orchestrator/tools. Resolved from this module
 * (src/ under tsx, dist/src/ when built) so prompts and allowlists name a
 * path that exists on this machine wherever the repo is checked out.
 */
export const TOOLS_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../tools"), path.resolve(here, "../../tools")];
  return candidates.find((c) => fs.existsSync(path.join(c, "intern-card"))) ?? candidates[1]!;
})();
const tool = (name: string) => `Bash(${TOOLS_DIR}/${name} *)`;

/**
 * Manifest tool names -> SDK tool names. Manifests use the friendly catalog
 * names on the left; anything not in the catalog is ignored (fail closed).
 */
export const TOOL_CATALOG: Record<string, string[]> = {
  "fs.read": ["Read", "Glob", "Grep"],
  "fs.write": ["Write", "Edit"],
  shell: ["Bash"],
  web: ["WebFetch", "WebSearch"],
  notebook: ["NotebookEdit"],
  todo: ["TodoWrite"],
  // Outlook via the read-and-draft-only graph-mail CLI (no send capability exists).
  mail: [tool("graph-mail")],
  // Outlook calendar via the read-only graph-cal CLI (no write/accept/create capability exists).
  calendar: [tool("graph-cal")],
  // Interactive cards for JP (create + read resolution) via the intern-card CLI.
  cards: [tool("intern-card")],
  // GitHub App: read PR data and submit a review proposal to the approval queue.
  // The CLI deliberately has no direct publish command.
  github: [tool("github")],
  // Forge-only build lifecycle helper. Deployment/activation remains card-gated.
  "integration.build": [tool("integration-work")],
  // Send JP a file/image/chart in the thread via the intern-attach CLI.
  attachments: [tool("intern-attach")],
  // Read/append the shared scratchpad of a group chat via the room-pad CLI.
  scratchpad: [tool("room-pad")],
  // Living pages (people, boards, tables, lists, drafts) shown in the chat.
  pages: [tool("intern-page")],
  // Standing orders JP gives in chat, saved so they stick.
  rules: [tool("intern-rule")],
  // Instagram research via the read-only ig-research CLI (public Business/Creator
  // profiles and hashtags; no publish, comment or message command exists).
  instagram: [tool("ig-research")],
};

/**
 * Granted to every intern regardless of manifest: exchanging files, keeping
 * pages and remembering JP's standing orders are part of chatting, not
 * capabilities. The CLIs only talk to the local API.
 */
export const BASE_TOOL_NAMES = ["attachments", "scratchpad", "pages", "rules"];

/** These are granted by a lifecycle service, never by a hire draft/editor. */
export const MANAGED_TOOL_NAMES = new Set(["github", "integration.build"]);
export const INTERN_ASSIGNABLE_TOOL_NAMES = Object.keys(TOOL_CATALOG).filter(
  (name) => !MANAGED_TOOL_NAMES.has(name) && !BASE_TOOL_NAMES.includes(name),
);

/**
 * The SDK `allowedTools` for an intern. With `ownDir`, the intern may also
 * read and write its own directory (memory, attachments, scratch files) even
 * without fs.* grants — under permission_mode "dontAsk" nothing else is
 * allowed, and these path rules are what keep memory working.
 */
export function allowedToolsFor(manifest: InternManifest, ownDir?: string): string[] {
  const tools = new Set<string>();
  for (const name of [...BASE_TOOL_NAMES, ...manifest.tools]) {
    for (const t of TOOL_CATALOG[name] ?? []) tools.add(t);
  }
  if (ownDir) {
    // `//` marks an absolute path in permission rules
    for (const t of ["Read", "Write", "Edit"]) tools.add(`${t}(/${ownDir}/**)`);
  }
  return [...tools];
}

/**
 * How to send the owner things that are not text. The app renders two fenced blocks
 * natively (```chart and ```svg) plus markdown images, and shows uploaded
 * files as inline previews; Discord gets the same files attached.
 */
export function richContentPrompt(owner = ownerName()): string {
  return `
## Files, images and charts
${owner}'s messages may list attached files with absolute paths — read them directly (images can be viewed with the Read tool).
To send ${owner} a file (a document, screenshot, exported CSV, rendered image, SVG…), run:
  ${TOOLS_DIR}/intern-attach --intern <your-slug> --file <path> [--caption "..."]
Anything you attach during a task is shown with your reply automatically; mention what it is in your text.
To draw a chart, put a JSON spec in a \`\`\`chart fenced block in your reply and the app renders it natively (do not also attach a PNG):
  \`\`\`chart
  {"type":"bar","title":"Open PRs by repo","labels":["api","web","infra"],"series":[{"name":"Open","data":[4,9,2]}]}
  \`\`\`
  type: bar | line | area | pie | donut | scatter (scatter: series data = [[x,y],...]). Optional: "stacked": true, "y_label", "format": "number"|"percent"|"currency", "unit".
  Keep charts honest: one axis, sorted where order is not meaningful, at most 8 series.
For flowcharts and sequence diagrams use a \`\`\`mermaid fenced block (flowchart TD/LR with [] () {} (( )) node shapes and --> / -.-> / ==> edges, or sequenceDiagram with ->> / -->> messages and notes); the app draws it.
To draw a picture, put standalone SVG markup in a \`\`\`svg fenced block; it renders inline and ${owner} can open/save it. Use a viewBox, no external references, no scripts.
These blocks also work inside card bodies (intern-card --body), so a card can carry a trend chart or a diagram.

## Colleagues
You have colleagues (other interns). Mention one with @Name (for example @Rhea) to hand them a question or pull them into the conversation — the orchestrator delivers your message to them and their reply appears in the same thread. Only mention someone when you genuinely need their role; never mention yourself. ${owner} may put you in a group chat with several colleagues; there, reply only when you have something to add. In a group, @all (or the group's name) addresses everyone; a plain message is routed to whoever is best placed to answer.
Every group has a shared scratchpad (markdown) pinned above the chat — decisions, owners, open questions. Read it with \`room-pad --room <id> get\`; record a decision with \`room-pad --room <id> append --text "..."\` (or \`set --file\` to rewrite). Keep it terse; it is the group's memory, not a transcript.

## Pages — living views you keep up to date
When ${owner} wants to see a set of things (people, a pipeline, a shortlist, a plan), keep it as a page instead of re-posting tables: it shows in the chat as a small preview and opens full screen, and you update it in place. Kinds: people (contact cards), board (columns of cards, e.g. New → Contacted → Meeting → Signed), table, list, draft (an email draft for review).
  ${TOOLS_DIR}/intern-page create --intern <your-slug> --kind people --title "My people" --summary "23 people · 4 follow-ups this week" --data-file <json>
  ${TOOLS_DIR}/intern-page list --intern <your-slug>        # your pages (check before creating a duplicate)
  ${TOOLS_DIR}/intern-page show <page_id>                    # attach an existing page's preview to this reply
  ${TOOLS_DIR}/intern-page patch-item <page_id> <item_id> --set '{"next_follow_up":"2026-10-09"}'   # change one item
  ${TOOLS_DIR}/intern-page add-item / remove-item / update / get   (run with --help for shapes)
A new page's preview is attached to your reply automatically. When you change a page, say what changed in one short line ("Moved Ada to Signed") — do not paste the page again. Keep the summary line current. Messages ${owner} sends from a page look like "Ada Okafor — draft a follow-up ⟨pg_…·p_3⟩": the marker at the end names the page and item to act on (${owner} sees it as a small link, so never repeat the ids back).
For email drafts: after graph-mail draft/revise-draft, pass its JSON to \`intern-page create --kind draft --data-file\` (first time) or \`intern-page update <page_id> --data-file\` (revisions), so ${owner} reviews the draft in the app. Revise the SAME draft (graph-mail revise-draft) when ${owner} asks for changes; never leave superseded drafts behind.

## Standing orders
When ${owner} tells you something lasting ("from now on…", "always…", "never…", "ignore X", "don't send me Y"), save it — otherwise it is forgotten:
  ${TOOLS_DIR}/intern-rule add --intern <your-slug> --type <type> --text "<one line, in ${owner}'s terms>" [params]
  types: mute_repo --repo owner/name   ·   mute_sender --address a@b.c | --domain b.c   ·   quiet_hours --from 21:00 --to 07:00   ·   hold_until --match "maya@brightline.example" --until 2026-10-01   ·   guidance (anything else, kept in your instructions)
The hard types filter INCOMING work before it reaches you: mute_repo drops PR reviews, mute_sender drops mail from a sender, hold_until parks incoming mail/PRs whose sender or subject contains --match (use an address or name that really appears there) and hands them back on the date, quiet_hours holds ${owner}'s phone notifications. Use a hard type whenever the instruction is about what ${owner} wants kept away from them.
Instructions about what YOU do — when to write to someone, how to draft, what to report — are guidance (e.g. "Don't message the conference leads before Mon 5 Oct"); never encode those as hold_until, which would hide those people's replies. The saved rule is shown under your reply with an Undo. \`intern-rule list --intern <your-slug>\` shows your rules; \`intern-rule remove <id>\` when ${owner} lifts one.

## Checklists
To propose steps ${owner} can approve in one tap, end your reply with a checklist block (JSON); ${owner} ticks what they want and you receive "Do these: 1, 3":
  \`\`\`checklist
  {"id":"next-steps","title":"Next steps for Willowbrook Vet","items":[{"id":"1","text":"Move Ada to Signed","checked":true},{"id":"2","text":"Draft a thank-you (reply-all)","checked":true}],"submit":"Do these"}
  \`\`\`
For a simple choice, offer quick-reply chips instead (${owner} taps one and it comes back as a reply):
  \`\`\`quick-replies
  {"options":["Yes","Not now"]}
  \`\`\`

## Sign-off
End each reply to ${owner} with one short sign-off line in your own voice, starting with an em dash: "— Rhea, still reading the diff" / "— Milo, drafts in your inbox". Vary it; never more than one line; skip it when your reply is a single sentence or "(nothing)".
`;
}

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface RunOpts {
  /** start a fresh session instead of resuming the persisted one */
  freshSession?: boolean;
  maxTurns?: number;
  abort?: AbortController;
}

export interface Engine {
  runIntern(slug: string, input: string, opts?: RunOpts): Promise<RunResult>;
}

/** Colleagues an @mention from this intern won't wake (paused, or mentions off). */
function unreachableColleagues(registry: Registry, slug: string): string {
  const names = registry
    .list()
    .filter((c) => c.slug !== slug && (c.manifest.paused || c.manifest.triggers.mentions === false))
    .map((c) => `${c.manifest.name}${c.manifest.paused ? " (paused)" : ""}`);
  if (names.length === 0) return "";
  return `\n## Colleagues you can't @mention right now\n${names.join(", ")}: an @mention won't reach them. If you need one of them, say so to ${ownerName()} instead.`;
}

export class CapExceededError extends Error {
  constructor(
    slug: string,
    readonly used: number,
    readonly cap: number,
  ) {
    super(`daily token cap for ${slug}: used ${used} of ${cap}`);
    this.name = "CapExceededError";
  }
}

export class SdkEngine implements Engine {
  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
  ) {}

  async runIntern(slug: string, input: string, opts: RunOpts = {}): Promise<RunResult> {
    const manifest = this.registry.get(slug);
    if (!manifest) throw new Error(`no manifest for intern: ${slug}`);

    // Guardrail: refuse to start past the daily token cap (plus anything the
    // owner allowed on top today). The orchestrator holds the task and asks.
    const spend = this.db.spendToday(slug);
    const used = spend.input_tokens + spend.output_tokens;
    const cap = manifest.guardrails.daily_token_cap + this.db.budgetExtra(slug);
    if (used >= cap) throw new CapExceededError(slug, used, cap);

    const systemPrompt = [
      manifest.system_prompt,
      manifest.persona ? `\n## Voice\n${manifest.persona}` : "",
      stylePrompt(manifest.style),
      reactionsPrompt(this.db, slug),
      manifest.guardrails.drafts_only
        ? "\n## Hard rule\nAnything outbound to other humans (email, messages) is DRAFTS ONLY — never send; produce a draft and surface it for approval."
        : "",
      `\n## Links\nWhen you mention a pull request, repository, document, ticket, or other web resource, include its full URL or a descriptive Markdown link so ${ownerName()} can open it directly from your message. Prefer a supplied \`primary_url\`; include useful alternate links when supplied.`,
      richContentPrompt(),
      `\nYour slug is \`${slug}\`.`,
      standingOrdersPrompt(this.db.listRules(slug)),
      unreachableColleagues(this.registry, slug),
      mailboxPrompt(manifest, this.config, internsHome()),
      instagramPrompt(manifest, internsHome()),
    ].join("");

    const options: Options = {
      systemPrompt,
      cwd: this.registry.internDir(slug),
      additionalDirectories: [this.registry.memoryDir(slug)],
      allowedTools: allowedToolsFor(manifest, this.registry.internDir(slug)),
      // Headless sessions can't answer permission prompts. "dontAsk" (default)
      // runs exactly what allowedTools lists — the catalog grants plus the
      // intern's own dir — and denies everything else. "bypassPermissions"
      // runs ANY tool: allowedTools does not restrict it, so an intern without
      // the shell grant can still run commands. Opt-in only (config).
      permissionMode: this.config.engine.permission_mode,
      ...(this.config.engine.permission_mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      // don't inherit the owner's user/project Claude settings into intern sessions
      settingSources: [],
      maxTurns: opts.maxTurns ?? this.config.engine.max_turns,
      ...(this.config.engine.model ? { model: this.config.engine.model } : {}),
      ...(opts.abort ? { abortController: opts.abort } : {}),
      // graph-mail / graph-cal only see the mailboxes this intern may use (mailboxes.ts)
      // graph-mail/graph-cal see only this intern's mailboxes (mailboxes.ts), and graph-mail
      // records which intern wrote each draft (learning from the owner's edits, draftlearn.ts)
      env: { ...process.env, INTERNS_INTERN: slug, ...mailboxEnv(manifest, this.config) },
    };

    const prevSession = opts.freshSession ? null : this.db.getSessionId(slug);
    if (prevSession) options.resume = prevSession;

    let text = "";
    let sessionId: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let error: string | undefined;

    try {
      for await (const message of query({ prompt: input, options })) {
        if (message.type === "result") {
          sessionId = message.session_id ?? null;
          // modelUsage covers main loop + subagents; docs prefer it over .usage
          for (const usage of Object.values(message.modelUsage ?? {})) {
            inputTokens += usage.inputTokens + usage.cacheCreationInputTokens;
            outputTokens += usage.outputTokens;
            costUsd += usage.costUSD;
          }
          if (message.subtype === "success") {
            text = message.result;
          } else {
            error = `agent run ended with ${message.subtype}`;
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // A failed resume (expired/corrupt session) should not wedge the intern:
      // drop the persisted session so the next run starts fresh.
      if (prevSession && /resume|session/i.test(error)) {
        this.db.setSessionId(slug, "");
      }
    }

    if (inputTokens || outputTokens || costUsd) {
      this.db.recordSpend(slug, inputTokens, outputTokens, costUsd);
    }
    if (sessionId) this.db.setSessionId(slug, sessionId);

    return { ok: !error, text, sessionId, inputTokens, outputTokens, costUsd, error };
  }
}
