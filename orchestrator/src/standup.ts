/**
 * !standup — the Coordinator's morning digest.
 *
 * Deterministic collection (db), one cheap no-tools LLM call for the summary —
 * same query() pattern as hire.ts. Falls back to the raw facts if the model
 * call fails: a standup must never crash the office.
 */
import { plainFences } from "./fences.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "./db.js";
import { coordinatorName, ownerName } from "./profile.js";

const SPEND_DAYS = 7;

/**
 * A ```chart block of the last week's token spend, one series per intern
 * (stacked). The app renders it natively in the standup message and in the
 * standup card; Discord/push strip it (see stripRichBlocks). Deterministic —
 * no LLM involved — so the trend is always there even when the digest call
 * fails. Returns "" when there is nothing to plot.
 */
export function spendChartBlock(db: Db, days = SPEND_DAYS): string {
  const rows = db.spendLastDays(days);
  if (rows.length === 0) return "";
  const names = new Map(db.listInterns(true).map((i) => [i.slug, i.name]));
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) labels.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const slugs = [...new Set(rows.map((r) => r.intern))].slice(0, 8);
  const series = slugs.map((slug) => ({
    name: names.get(slug) ?? slug,
    data: labels.map((day) => {
      const row = rows.find((r) => r.intern === slug && r.day === day);
      return row ? row.input_tokens + row.output_tokens : 0;
    }),
  }));
  const spec = {
    type: "bar",
    stacked: true,
    title: `Token spend, last ${days} days`,
    labels: labels.map((d) => d.slice(5)), // MM-DD
    series,
    format: "number",
  };
  return "```chart\n" + JSON.stringify(spec) + "\n```";
}

/** Strip ```chart / ```svg / ```mermaid blocks for surfaces that cannot draw them (Discord, push). */
export function stripRichBlocks(text: string, placeholder = "(chart — open the app)"): string {
  return plainFences(text, "push")
    .replace(/```(?:chart|chart\.json)\s*[\s\S]*?```/gi, placeholder)
    .replace(/```svg\s*[\s\S]*?```/gi, "(drawing — open the app)")
    .replace(/```mermaid\s*[\s\S]*?```/gi, "(diagram — open the app)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collect(db: Db): string {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const lines: string[] = [];
  for (const intern of db.listInterns()) {
    const msgs = db.listMessages(intern.slug, 200).filter((m) => m.ts >= since);
    const fromIntern = msgs.filter((m) => m.author === "intern");
    const fromJp = msgs.filter((m) => m.author === "jp");
    const spend = db.spendToday(intern.slug);
    const queued = db.countTasks(intern.slug, "queued");
    const running = db.countTasks(intern.slug, "running");
    const paused = db.countTasks(intern.slug, "paused");
    lines.push(
      `### ${intern.name} (${intern.role})`,
      `- messages last 24h: ${fromIntern.length} from intern, ${fromJp.length} from ${ownerName()}`,
      `- tasks: ${running} running, ${queued} queued, ${paused} paused`,
      `- spend today: ${spend.input_tokens + spend.output_tokens} tokens ($${spend.cost_usd.toFixed(2)})`,
      ...fromIntern.slice(-3).map((m) => `- recent report: ${m.text.slice(0, 300).replace(/\n+/g, " ")}`),
    );
  }
  const openCards = db.listCards("open");
  lines.push(
    `### Cards`,
    `- open: ${openCards.length}`,
    ...openCards.slice(0, 8).map((c) => `- [${c.severity}] ${c.intern}: ${c.title}`),
  );
  return lines.join("\n");
}

const VOICES = [
  "as a limerick sequence — one limerick per intern, one for the cards; keep every fact accurate",
  "as a TV weather report — interns are weather systems, open cards are a front moving in; facts must stay accurate",
  "as a nature documentary narrated by a very calm British voice; facts must stay accurate",
  "as a noir detective's case notes, terse and rain-soaked; facts must stay accurate",
  "as a sports commentator's post-match summary; facts must stay accurate",
  "as a ship's log from a slightly over-dramatic captain; facts must stay accurate",
];

/**
 * One day a month the standup arrives in costume. Deterministic per month
 * (so it is the same day for every surface) and never the 1st, which tends
 * to be busy. Returns null on ordinary days or when disabled.
 */
export function easterEggVoice(now: Date, enabled: boolean): string | null {
  if (!enabled) return null;
  const key = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const day = 2 + ((key * 7919) % 26); // 2..27
  if (now.getUTCDate() !== day) return null;
  return VOICES[key % VOICES.length]!;
}

export async function standup(db: Db, opts: { easterEggs?: boolean; now?: Date } = {}): Promise<string> {
  const facts = collect(db);
  if (db.listInterns().length === 0) return "No interns on payroll — `!hire <role>`.";
  const chart = spendChartBlock(db);
  const withChart = (digest: string) => (chart ? `${digest.trim()}\n\n${chart}` : digest);
  const voice = easterEggVoice(opts.now ?? new Date(), opts.easterEggs ?? true);
  try {
    let text = "";
    for await (const message of query({
      prompt:
        `You are the ${coordinatorName()} giving ${ownerName()} the morning standup for their AI intern crew. ` +
        `Below are the raw facts from the last 24 hours. Write a tight digest (max ~10 lines, Discord ` +
        `markdown): one bullet per intern with what they actually did or found (from their recent ` +
        `reports), then anything waiting on ${ownerName()} (open cards). Dry, factual, zero fluff. If an intern ` +
        `did nothing, one short line saying so.` +
        (voice ? ` TODAY IS SPECIAL: write the whole digest ${voice}. Start with a one-line wink that today's standup is in costume.` : "") +
        `\n\n${facts}`,
      options: {
        systemPrompt: "You write terse, useful standup digests. Output only the digest text.",
        tools: [],
        allowedTools: [],
        permissionMode: "default",
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
      },
    })) {
      if (message.type === "result" && message.subtype === "success") text = message.result;
    }
    return withChart(text || facts);
  } catch (err) {
    console.error("[standup] digest call failed, returning raw facts:", err);
    return withChart(facts.slice(0, 1800));
  }
}
