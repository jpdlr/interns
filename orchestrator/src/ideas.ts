/**
 * Ideas (docs/features/06-coordinator-chat-ideas.md): anything JP starts
 * with "idea:" or 💡 — in any chat — or saves from a message menu lands on
 * the coordinator's Ideas page, a `list` page pinned in the front desk.
 * Capture is deterministic and instant; a cheap Haiku call adds one tag
 * afterwards and the idea simply stays untagged if that call fails.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { pageFence } from "./fences.js";
import type { Page } from "./types.js";
import { ownerName } from "./profile.js";
import { SMALL_MODEL } from "./models.js";

export const IDEA_TAGS = ["app", "business", "content", "someday"] as const;
const TAG_MODEL = SMALL_MODEL;
const IDEAS_KV = "ideas_page";

/** The idea text when a message is an idea ("idea: …" or "💡 …"), else null. "Idea-wise, …" is not. */
export function ideaText(text: string): string | null {
  const m = text.match(/^\s*(?:idea\s*:|💡)\s*([\s\S]+)$/i);
  const idea = m?.[1]?.trim();
  return idea ? idea : null;
}

export type TagFn = (idea: string, db: Db) => Promise<string | null>;

/** One cheap call: pick one tag or none. Never throws. */
export const tagIdea: TagFn = async (idea, db) => {
  let result = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  try {
    for await (const message of query({
      prompt: `Idea: ${idea.slice(0, 600)}`,
      options: {
        systemPrompt:
          `Tag ${ownerName()}'s idea with exactly one word from: ${IDEA_TAGS.join(", ")}. ` +
          `app = the interns app/assistant itself; business = clients, sales, operations; ` +
          `content = posts, talks, writing; someday = personal or vague. Reply with the one word only.`,
        model: TAG_MODEL,
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
        if (message.subtype === "success") result = message.result;
      }
    }
  } catch (err) {
    console.error("[ideas] tagging failed, leaving untagged:", err instanceof Error ? err.message : err);
  }
  if (inputTokens || outputTokens || costUsd) {
    db.recordSpend("coordinator", inputTokens, outputTokens, costUsd);
    db.recordRunSpend({ intern: "coordinator", thread: "coordinator", kind: "ideas", inputTokens, outputTokens, costUsd });
  }
  const word = result.trim().toLowerCase().replace(/[^a-z]/g, "");
  return (IDEA_TAGS as readonly string[]).includes(word) ? word : null;
};

/** The coordinator's Ideas page, created (and pinned) on first use. */
export function ideasPage(db: Db): { page: Page; created: boolean } {
  const id = db.getKv(IDEAS_KV);
  const existing = id ? db.getPage(id) : undefined;
  if (existing && !existing.archived_at) return { page: existing, created: false };
  const page = db.createPage({ intern: "coordinator", thread_key: "coordinator", kind: "list", title: "Ideas", summary: "Nothing yet", data: { items: [] } });
  db.setPagePinned(page.id, true);
  db.setKv(IDEAS_KV, page.id);
  return { page: db.getPage(page.id)!, created: true };
}

function summary(items: { done?: boolean }[]): string {
  const open = items.filter((i) => !i.done).length;
  return `${items.length} idea${items.length === 1 ? "" : "s"}${open !== items.length ? ` · ${open} open` : ""}`;
}

export interface CapturedIdea {
  page_id: string;
  item_id: string;
  count: number;
  /** the page fence, set only when this capture created the page */
  fence: string | null;
}

/**
 * Append one idea. Tagging runs in the background (`tagFn`), patching the
 * item when it answers; a failure just leaves it untagged.
 */
export function captureIdea(db: Db, text: string, source: { thread_key: string; message_id: string } | null, tagFn: TagFn = tagIdea): CapturedIdea {
  const { page, created } = ideasPage(db);
  const items = Array.isArray(page.data.items) ? (page.data.items as Record<string, unknown>[]) : [];
  const itemId = `i_${randomUUID().slice(0, 8)}`;
  const next = [...items, { id: itemId, text: text.trim().slice(0, 2000), tags: [], ts: new Date().toISOString(), ...(source ? { source } : {}) }];
  db.updatePage(page.id, { data: { items: next }, summary: summary(next) });
  void tagFn(text, db)
    .then((tag) => {
      if (!tag) return;
      const fresh = db.getPage(page.id);
      const list = Array.isArray(fresh?.data.items) ? (fresh!.data.items as Record<string, unknown>[]) : [];
      const tagged = list.map((i) => (i.id === itemId ? { ...i, tags: [tag] } : i));
      db.updatePage(page.id, { data: { items: tagged } });
    })
    .catch(() => {});
  return { page_id: page.id, item_id: itemId, count: next.length, fence: created ? pageFence(page) : null };
}

/** Recent open ideas, for the weekly suggestions pass. */
export function openIdeas(db: Db, limit = 30): { text: string; tags: string[]; ts: string }[] {
  const id = db.getKv(IDEAS_KV);
  const page = id ? db.getPage(id) : undefined;
  const items = Array.isArray(page?.data.items) ? (page!.data.items as { text: string; tags?: string[]; ts: string; done?: boolean }[]) : [];
  return items
    .filter((i) => !i.done)
    .slice(-limit)
    .map((i) => ({ text: i.text, tags: i.tags ?? [], ts: i.ts }));
}
