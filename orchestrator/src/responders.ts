/**
 * Room responder pre-check: when JP posts in a group chat without mentioning
 * anyone, one cheap Haiku-class query() call picks which members should
 * actually answer, instead of every member burning a full agent run to
 * decide they have nothing to say. Same shape as advisor.ts: no tools, one
 * turn, spend recorded against "coordinator".
 *
 * Fails OPEN to "ask everyone": an unanswered message in a room reads as
 * broken, an extra run or two does not. Callers (Orchestrator.fanOutFromJp)
 * catch the throw and fall back.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";
import type { Message } from "./types.js";
import { ownerName } from "./profile.js";

const RESPONDER_MODEL = "claude-haiku-4-5";

const systemPrompt = () =>
  `You are the Chaos Coordinator moderating a group chat between ${ownerName()} (the boss) and their AI interns. ` +
  `${ownerName()} just posted without addressing anyone by name. Decide which interns should reply, based on their ` +
  "roles, the standing brief, and the recent conversation. Pick the FEWEST people who can actually " +
  "answer — usually one, sometimes two; everyone only for a genuine all-hands question ('how is " +
  "everyone doing', 'status from each of you'). A social remark or thanks may need nobody, but a " +
  "question always needs at least one. " +
  'Respond with ONLY strict JSON, no other text: {"responders": ["<slug>", ...], "reason": "<one short sentence>"}.';

export interface RoomMember {
  slug: string;
  name: string;
  role: string;
}

export interface ResponderVerdict {
  responders: string[];
  reason: string;
}

export type ChooseRespondersFn = (
  room: { id: string; name: string; topic: string; members: RoomMember[] },
  text: string,
  recent: Message[],
  displayName: (slug: string) => string,
  db: Db,
) => Promise<ResponderVerdict>;

function parseVerdict(text: string, members: RoomMember[]): ResponderVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in responder response");
  const parsed: unknown = JSON.parse(match[0]);
  if (!parsed || typeof parsed !== "object") throw new Error("responder response is not an object");
  const raw = (parsed as Record<string, unknown>).responders;
  if (!Array.isArray(raw)) throw new Error("responders is not an array");
  const valid = new Set(members.map((m) => m.slug));
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m.slug]));
  const responders = [...new Set(raw.map((r) => String(r)).map((r) => (valid.has(r) ? r : byName.get(r.toLowerCase()) ?? "")).filter(Boolean))];
  const reason = (parsed as Record<string, unknown>).reason;
  return { responders, reason: typeof reason === "string" ? reason : "" };
}

export const chooseResponders: ChooseRespondersFn = async (room, text, recent, displayName, db) => {
  const members = room.members.map((m) => `- ${m.slug}: ${m.name} — ${m.role}`).join("\n");
  const transcript = recent.length
    ? recent
        .map((m) => `[${m.author === "jp" ? ownerName() : m.author === "coordinator" ? "Coordinator" : displayName(m.speaker ?? m.intern)}]: ${m.text.replace(/\s+/g, " ").slice(0, 240)}`)
        .join("\n")
    : "(none)";
  const prompt =
    `Group: ${room.name}${room.topic ? `\nStanding brief: ${room.topic}` : ""}\n\n` +
    `Members (slug: name — role):\n${members}\n\n` +
    `Recent conversation:\n${transcript}\n\n` +
    `${ownerName()} just said: ${text}`;

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
        model: RESPONDER_MODEL,
        tools: [],
        maxTurns: 1,
        settingSources: [],
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
        else sdkError = `responder run ended with ${message.subtype}`;
      }
    }
  } catch (err) {
    sdkError = err instanceof Error ? err.message : String(err);
  }
  if (inputTokens || outputTokens || costUsd) {
    db.recordSpend("coordinator", inputTokens, outputTokens, costUsd);
    db.recordRunSpend({ intern: "coordinator", thread: room.id, kind: "precheck", inputTokens, outputTokens, costUsd });
  }
  if (sdkError) throw new Error(sdkError);
  return parseVerdict(resultText, room.members);
};
