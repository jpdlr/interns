/**
 * /hire flow: one no-tools Agent SDK call expands a rough role description
 * into a full InternManifest draft (validated with zod), which JP approves
 * before confirmHire() writes it to disk and announces the intern.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CAPABILITY_CATALOG } from "./capabilities.js";
import type { Db } from "./db.js";
import { INTERN_ASSIGNABLE_TOOL_NAMES, MANAGED_TOOL_NAMES } from "./engine.js";
import { isReservedSlug, type Registry } from "./registry.js";
import {
  CapabilityRequirement,
  CapabilityRequirementSchema,
  InternManifest,
  InternManifestSchema,
  slugify,
} from "./types.js";
import { coordinatorName, ownerName } from "./profile.js";

export interface HireCandidate {
  draft: InternManifest;
  required_capabilities: CapabilityRequirement[];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const NAME_EXAMPLES = ["Milo", "Tessa", "Rowan", "Pia", "Otis"];

/** The hire prompt. `taken` keeps the model off names already on the crew (assertNameAvailable would refuse them). */
export const hirePrompt = (roughRole: string, taken: string[] = []) => {
  const isTaken = (n: string) => taken.some((t) => sameName(t, n));
  const examples = NAME_EXAMPLES.filter((n) => !isTaken(n)).slice(0, 2);
  const nameRule =
    `short friendly human first name (one word${examples.length ? `, e.g. ${examples.map((n) => `"${n}"`).join(", ")}` : ""})` +
    (taken.length ? `. These are already taken, so pick a name that is none of them: ${JSON.stringify(taken)}` : "");
  return `You are the ${coordinatorName()} hiring a new AI intern for ${ownerName()}'s personal crew.

Rough role from ${ownerName()}: "${roughRole}"

Expand this into a complete intern manifest. Respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:
- "name": ${nameRule}
- "role": one-line job title
- "icon": "default" (${ownerName()} picks the avatar later)
- "persona": 2-3 sentences describing the intern's voice and personality
- "system_prompt": a thorough system prompt for the intern's working sessions (their job, boundaries, how they report back). Written in second person.
- "tools": array chosen ONLY from this catalog: ${JSON.stringify(INTERN_ASSIGNABLE_TOOL_NAMES)} — pick the minimum the role needs
- "triggers": object; include "cron" (5-field cron string, in ${ownerName()}'s local time) only if the role benefits from a routine, "mentions": true
- "backlog": array of exactly 3 STRINGS (each one starter backlog item: standing idle work, concrete and self-contained — plain strings, not objects)
- "guardrails": {"drafts_only": true, "daily_token_cap": 200000}
- "required_capabilities": array of {"id","reason"}. Use a known id when applicable: ${JSON.stringify(
  Object.keys(CAPABILITY_CATALOG),
)}. A capability is external plumbing the role needs but the tool catalog cannot currently supply. For GitHub PR/code review work use id "github". Use a short lowercase dotted id for a genuinely new integration. Return [] when existing tools are enough.`;
};

/** Strip accidental code fences and parse the first JSON object in the text. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON object in hire response: ${text.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Expand a rough role into a validated manifest draft (does NOT write
 * anything). `taken` is takenNames() — the model is asked to avoid them, and
 * the app and confirmHire still refuse a clash if it doesn't.
 */
export async function hire(roughRole: string, taken: string[] = []): Promise<HireCandidate> {
  let text = "";
  for await (const message of query({
    prompt: hirePrompt(roughRole, taken),
    options: {
      systemPrompt: "You output only valid JSON. No prose, no markdown.",
      tools: [], // judgment call only — no tools
      allowedTools: [],
      permissionMode: "default",
      settingSources: [],
      maxTurns: 1,
    },
  })) {
    if (message.type === "result" && message.subtype === "success") text = message.result;
  }
  if (!text) throw new Error("hire: empty response from model");
  const raw = coerceManifest(extractJson(text));
  const draft = InternManifestSchema.parse(raw);
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fromModel = Array.isArray(record.required_capabilities)
    ? record.required_capabilities.flatMap((item) => {
        const parsed = CapabilityRequirementSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  // Deterministic backstop: a model must not accidentally hire a GitHub
  // reviewer with no way to see GitHub just because it omitted the extra key.
  const githubNeeded = /\b(github|pull request|pull requests|\bpr\b|code review|review code)\b/i.test(roughRole);
  const required = [...fromModel];
  if (githubNeeded && !required.some((r) => r.id === "github")) {
    required.push({ id: "github", reason: "Read pull requests, checks, diffs, and prepare approval-gated reviews." });
  }
  return { draft: withoutPendingCapabilityTools(draft, required), required_capabilities: required };
}

/** Capability-owned tools stay unavailable until their activation card runs. */
function withoutPendingCapabilityTools(
  draft: InternManifest,
  requirements: CapabilityRequirement[],
): InternManifest {
  const withheld = new Set([
    ...MANAGED_TOOL_NAMES,
    ...requirements.flatMap((requirement) => CAPABILITY_CATALOG[requirement.id]?.tools ?? []),
  ]);
  if (!withheld.size) return draft;
  return { ...draft, tools: draft.tools.filter((tool) => !withheld.has(tool)) };
}

/** Forgive common model deviations before strict validation (e.g. backlog items as objects). */
function coerceManifest(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const m = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(m.backlog)) {
    m.backlog = m.backlog.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        const s = o.task ?? o.item ?? o.description ?? o.title ?? o.text;
        if (typeof s === "string") return s;
        return Object.values(o).filter((v) => typeof v === "string").join(" — ") || JSON.stringify(o);
      }
      return String(item);
    });
  }
  if (Array.isArray(m.persona)) m.persona = m.persona.join(" ");
  if (Array.isArray(m.system_prompt)) m.system_prompt = m.system_prompt.join("\n");
  return m;
}

/** The name belongs to someone already on the crew (or to the Coordinator); JP has to pick another. */
export class NameTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameTakenError";
  }
}

/**
 * Throws NameTakenError if an active intern other than `exceptSlug` already
 * goes by `name`. Two interns sharing a name would make @mentions ambiguous.
 */
export function assertNameAvailable(name: string, deps: { db: Db; registry: Registry }, exceptSlug?: string): void {
  if (isReservedSlug(slugify(name)) || sameName(name, "Coordinator")) {
    throw new NameTakenError(`"${name.trim()}" is reserved — pick another name.`);
  }
  const clash = activeCrew(deps).find((i) => i.slug !== exceptSlug && sameName(i.name, name));
  if (clash) throw new NameTakenError(`${clash.name} is already on the crew — pick another name.`);
}

/** Every active intern, from disk and the db (either can briefly lag the other). */
function activeCrew(deps: { db: Db; registry: Registry }): { slug: string; name: string }[] {
  return [
    ...deps.registry.list().map(({ slug, manifest }) => ({ slug, name: manifest.name })),
    ...deps.db.listInterns().map(({ slug, name }) => ({ slug, name })),
  ];
}

/** Names a new hire can't take: the active crew's (deduped), plus the Coordinator's. */
export function takenNames(deps: { db: Db; registry: Registry }): string[] {
  const names: string[] = [];
  for (const { name } of activeCrew(deps)) if (!names.some((n) => sameName(n, name))) names.push(name.trim());
  return [...names, "Coordinator"];
}

/**
 * The slug for a new hire. Active namesakes are refused outright; an archived
 * intern keeps its slug (and its chat history, spend and tasks, which are all
 * keyed by slug), so a newcomer reusing the name gets "-2", "-3", ….
 */
export function allocateSlug(name: string, deps: { db: Db; registry: Registry }): string {
  assertNameAvailable(name, deps);
  const base = slugify(name);
  const taken = new Set(deps.db.listInterns(true).map((i) => i.slug));
  const free = (slug: string) => !taken.has(slug) && !deps.registry.has(slug) && !isReservedSlug(slug);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = base.slice(0, 32 - suffix.length) + suffix;
    if (free(slug)) return slug;
  }
}

/**
 * JP approved the draft (possibly edited, with a chosen avatar icon):
 * write manifest + memory dir, register in db, emit the intro message.
 */
export function confirmHire(
  draft: InternManifest,
  icon: string,
  deps: { db: Db; registry: Registry },
  requiredCapabilities: CapabilityRequirement[] = [],
): { slug: string; manifest: InternManifest } {
  // Repeat the withholding at the trust boundary: app/Discord clients may
  // submit edited or stale drafts, but only activation may grant these tools.
  const manifest = InternManifestSchema.parse({
    ...withoutPendingCapabilityTools(draft, requiredCapabilities),
    icon,
  });
  const slug = deps.registry.save(manifest, allocateSlug(manifest.name, deps));
  deps.db.upsertIntern({ slug, name: manifest.name, role: manifest.role, icon: manifest.icon });
  deps.db.addMessage({
    intern: slug,
    author: "intern",
    cause: "reply", // JP just hired them
    text:
      `Hi ${ownerName()}! I'm ${manifest.name}, your new ${manifest.role}.` +
      (manifest.persona ? ` ${manifest.persona.split(".")[0]}.` : "") +
      (manifest.backlog.length
        ? ` I've got ${manifest.backlog.length} starter items on my backlog — say the word or I'll pick them up when idle.`
        : " Backlog's empty — send me something to do."),
    surface: "system",
  });
  return { slug, manifest };
}
