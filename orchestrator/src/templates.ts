/**
 * Starter interns: ready-made manifests in orchestrator/templates/*.yaml,
 * offered by the setup flow and the Hire screen. A template is an ordinary
 * intern manifest plus a few extra keys (`summary`, `order`, `required_capabilities`).
 *
 * ~/.interns/templates/*.yaml are read too and win on the same file name, so
 * a local install can tune or add starters without touching the repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { Config } from "./config.js";
import { repoRoot } from "./config.js";
import { CapabilityRequirementSchema, InternManifestSchema, type CapabilityRequirement, type InternManifest } from "./types.js";

/** What a template needs set up before it can do its job. */
export type TemplateNeed = "outlook" | "github";

export interface InternTemplate {
  /** the file name without .yaml */
  id: string;
  /** one sentence for the picker */
  summary: string;
  /** position in the picker, lowest first (then by id) */
  order: number;
  draft: InternManifest;
  required_capabilities: CapabilityRequirement[];
  needs: TemplateNeed[];
}

const OUTLOOK_TOOLS = new Set(["mail", "calendar"]);

export function templateDirs(home: string): string[] {
  return [path.join(repoRoot(), "orchestrator", "templates"), path.join(home, "templates")];
}

function needsOf(draft: InternManifest, required: CapabilityRequirement[]): TemplateNeed[] {
  const needs: TemplateNeed[] = [];
  if (draft.tools.some((t) => OUTLOOK_TOOLS.has(t)) || draft.triggers.mail_push || draft.triggers.meeting_brief) needs.push("outlook");
  if (required.some((r) => r.id === "github")) needs.push("github");
  return needs;
}

/** Every valid template, repo first and local overrides on top, in file-name order. A broken file is skipped and logged. */
export function listTemplates(home: string): InternTemplate[] {
  const byId = new Map<string, InternTemplate>();
  for (const dir of templateDirs(home)) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const id = file.replace(/\.ya?ml$/, "");
      try {
        const raw = YAML.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
        const draft = InternManifestSchema.parse(raw);
        const required = Array.isArray(raw.required_capabilities)
          ? raw.required_capabilities.map((r) => CapabilityRequirementSchema.parse(r))
          : [];
        byId.set(id, {
          id,
          summary: typeof raw.summary === "string" ? raw.summary.trim() : draft.role,
          order: typeof raw.order === "number" ? raw.order : 100,
          draft,
          required_capabilities: required,
          needs: needsOf(draft, required),
        });
      } catch (err) {
        console.error(`[templates] skipping ${path.join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Whether this install already has what a template needs. */
export function templateReady(template: InternTemplate, config: Config): boolean {
  return template.needs.every((need) =>
    need === "outlook" ? config.mailboxes.length > 0 : Boolean(config.github.app_id && config.github.private_key_path),
  );
}
