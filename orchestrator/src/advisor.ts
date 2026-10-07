/**
 * Idle-priority advisor: one cheap Haiku-class query() call that picks which
 * (if any) backlog item is the best use of an idle intern's time right now.
 * Same query() pattern as triage.ts's classifyBatch — no tools, one turn,
 * spend recorded against "coordinator" (the office's own overhead).
 *
 * Unlike triage.ts (which fails OPEN to "wake" — silently dropping mail is
 * worse than an extra wake), this fails CLOSED: any SDK error, timeout, or
 * malformed response throws, and the caller (Orchestrator.advise()) catches
 * that and falls back to the old deterministic FIFO behaviour. A judgment
 * call going wrong should degrade to "boring but safe", not to inventing
 * work an intern shouldn't be doing.
 *
 * Verified against @anthropic-ai/claude-agent-sdk sdk.d.ts (see engine.ts's
 * header comment for the general query() shape) — same options shape as
 * triage.ts: options.model pinned to a full model id, tools: [] (hard
 * "none", distinct from allowedTools), settingSources: [], maxTurns: 1.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";
import type { Message } from "./types.js";
import { coordinatorName, ownerName } from "./profile.js";
import { SMALL_MODEL } from "./models.js";

const ADVISOR_MODEL = SMALL_MODEL;

const systemPrompt = () =>
  "You are the " + coordinatorName() + " deciding what an idle AI intern should work on right now, picking " +
  "from their standing backlog. Pick at most ONE item — the single best use of their time given " +
  "recent activity and how much is already waiting on " + ownerName() + " — or none if they should just stay idle " +
  "(e.g. they already have plenty of open cards waiting on " + ownerName() + ", recent messages suggest they just " +
  "handled something related, or nothing on the backlog is timely right now). " +
  'Respond with ONLY strict JSON, no other text: {"choice": <1-based index into the backlog, or null>, "reason": "<one short sentence>"}.';

export interface AdvisorVerdict {
  choice: number | null;
  reason: string;
}

function formatBacklog(backlog: string[]): string {
  return backlog.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function formatMessages(messages: Message[]): string {
  if (messages.length === 0) return "(none)";
  return messages.map((m) => `- [${m.author}] ${m.text.slice(0, 140).replace(/\n+/g, " ")}`).join("\n");
}

function formatNow(now: Date): string {
  return now.toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

function parseVerdict(text: string, backlogLength: number): AdvisorVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in advisor response");
  const parsed: unknown = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object") throw new Error("advisor response is not an object");
  const rawChoice = (parsed as Record<string, unknown>).choice;
  const reason = (parsed as Record<string, unknown>).reason;
  let choice: number | null;
  if (rawChoice === null || rawChoice === undefined) {
    choice = null;
  } else if (typeof rawChoice === "number" && Number.isInteger(rawChoice) && rawChoice >= 1 && rawChoice <= backlogLength) {
    choice = rawChoice;
  } else {
    throw new Error(`bad choice: ${JSON.stringify(rawChoice)}`);
  }
  return { choice, reason: typeof reason === "string" ? reason : "" };
}

/**
 * One idle-priority judgment call for `intern`, currently idle with a
 * non-empty backlog. Throws on any SDK/parse failure — callers must catch
 * and fail closed (Orchestrator.advise() does).
 */
export async function adviseIdlePriority(
  intern: { name: string; role: string },
  backlog: string[],
  recentMessages: Message[],
  openCardCount: number,
  now: Date,
  db: Db,
): Promise<AdvisorVerdict> {
  const prompt =
    `Intern: ${intern.name} (${intern.role}), currently idle.\n` +
    `Current time: ${formatNow(now)}\n` +
    `Open cards waiting on ${ownerName()} for this intern: ${openCardCount}\n\n` +
    `Backlog:\n${formatBacklog(backlog)}\n\n` +
    `Last ${recentMessages.length} messages:\n${formatMessages(recentMessages)}`;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let resultText = "";
  let sdkError: string | undefined;

  try {
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: systemPrompt(),
        model: ADVISOR_MODEL,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (message.type === "result") {
        for (const usage of Object.values(message.modelUsage ?? {})) {
          inputTokens += usage.inputTokens + usage.cacheCreationInputTokens;
          outputTokens += usage.outputTokens;
          costUsd += usage.costUSD;
        }
        if (message.subtype === "success") resultText = message.result;
        else sdkError = `advisor run ended with ${message.subtype}`;
      }
    }
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err);
  }

  // "the office's own cost" — record even a failed/partial call, since tokens
  // may still have been spent before the failure (same convention as triage.ts).
  if (inputTokens || outputTokens || costUsd) {
    db.recordSpend("coordinator", inputTokens, outputTokens, costUsd);
  }

  if (sdkError) throw new Error(sdkError);
  return parseVerdict(resultText, backlog.length);
}
