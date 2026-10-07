/**
 * Layer 3 of mail triage: a cheap Haiku-class classification gate sitting
 * between Layer 2 ("this batch is ready to maybe wake the intern") and
 * actually enqueuing a trigger task. One query() call, no tools, one turn —
 * this is meant to cost pennies, not run an agent loop.
 *
 * Fails OPEN: any SDK error, timeout, or malformed response returns "wake".
 * Silently dropping mail is a worse failure than an extra wake.
 *
 * Verified against @anthropic-ai/claude-agent-sdk sdk.d.ts (see engine.ts's
 * header comment for the general query() shape):
 *  - options.model accepts an alias ('haiku') or a full model ID; we pin the
 *    full id (SMALL_MODEL, models.ts) so a future SDK default change can't
 *    silently upgrade this gate to a pricier tier.
 *  - options.tools: [] disables all built-in tools (distinct from
 *    allowedTools, which only allowlists — tools:[] is the hard "none" knob).
 *  - the terminal message has type 'result'; subtype 'success' carries
 *    `.result` (text); modelUsage carries per-model token/cost accounting.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";
import type { MailMessage } from "./mailwatch.js";
import { SMALL_MODEL } from "./models.js";

const TRIAGE_MODEL = SMALL_MODEL;

const SYSTEM_PROMPT =
  "You are a fast triage gate for a personal assistant's email inbox. You are shown a batch of " +
  "message headers (from / subject / short preview only — no bodies). Decide whether ANYTHING in " +
  "the batch plausibly needs the PA's attention today: real human correspondence, questions, " +
  "deadlines, invoices, anything the owner must personally see. Versus pure noise: newsletters, " +
  "automated notifications, receipts, marketing. If in doubt, prefer wake — this gate exists to " +
  "cut obvious noise, not to make judgment calls. " +
  'Respond with ONLY strict JSON, no other text: {"verdict": "wake" | "hold", "reason": "<one short sentence>"}.';

export interface TriageVerdict {
  verdict: "wake" | "hold";
  reason: string;
}

function formatForPrompt(messages: MailMessage[]): string {
  return messages
    .map((m, i) => `${i + 1}. from: ${m.from ?? "unknown"} | subject: ${m.subject ?? "(no subject)"} | preview: ${m.preview ?? "(none)"}`)
    .join("\n");
}

function parseVerdict(text: string): TriageVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in triage response");
  const parsed: unknown = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object") throw new Error("triage response is not an object");
  const verdict = (parsed as Record<string, unknown>).verdict;
  const reason = (parsed as Record<string, unknown>).reason;
  if (verdict !== "wake" && verdict !== "hold") throw new Error(`bad verdict: ${JSON.stringify(verdict)}`);
  return { verdict, reason: typeof reason === "string" ? reason : "" };
}

/**
 * Classify one Layer-2 batch. Spend is recorded against intern slug
 * "coordinator" — this is the office's own triage overhead, not the woken
 * intern's — via db.recordSpend, same accounting path as engine.ts.
 */
export async function classifyBatch(messages: MailMessage[], db: Db): Promise<"wake" | "hold"> {
  if (messages.length === 0) return "hold";

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let resultText = "";
  let sdkError: string | undefined;

  try {
    for await (const message of query({
      prompt: `Batch of ${messages.length} message(s):\n${formatForPrompt(messages)}`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: TRIAGE_MODEL,
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
        else sdkError = `triage run ended with ${message.subtype}`;
      }
    }
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err);
  }

  // "the office's own cost" — record even a failed/partial call, since tokens
  // may still have been spent before the failure.
  if (inputTokens || outputTokens || costUsd) {
    db.recordSpend("coordinator", inputTokens, outputTokens, costUsd);
  }

  if (sdkError) {
    console.error(`[triage] query failed, failing open to wake — ${sdkError}`);
    return "wake";
  }

  try {
    const { verdict, reason } = parseVerdict(resultText);
    console.log(`[triage] verdict=${verdict} reason="${reason}"`);
    return verdict;
  } catch (err) {
    console.error(`[triage] unparseable response, failing open to wake — ${err instanceof Error ? err.message : String(err)}`);
    return "wake";
  }
}
