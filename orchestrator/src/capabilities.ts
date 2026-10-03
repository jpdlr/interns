/** Capability intake and activation. The coordinator routes; Forge builds. */
import { internsHome, saveConfig, type Config } from "./config.js";
import * as fs from "node:fs";
import type { Db } from "./db.js";
import { TOOL_CATALOG } from "./engine.js";
import { RetryableApprovalError } from "./errors.js";
import type { Registry } from "./registry.js";
import type { CapabilityRequest, CapabilityRequirement, InternManifest } from "./types.js";

export interface CapabilityDefinition {
  id: string;
  title: string;
  tools: string[];
  permissions: string[];
  builtIn: boolean;
}

export const CAPABILITY_CATALOG: Record<string, CapabilityDefinition> = {
  github: {
    id: "github",
    title: "GitHub pull-request review",
    tools: ["github"],
    permissions: ["Metadata: read", "Contents: read", "Pull requests: read/write", "Checks: read"],
    builtIn: true,
  },
};

const FORGE: InternManifest = {
  name: "Forge",
  role: "Integration engineer",
  icon: "face-16",
  persona: "Methodical, skeptical, and concise. Treats tests and rollback plans as part of the feature.",
  system_prompt:
    "You are Forge, the crew's integration engineer. Build missing capabilities only from approved capability requests. Work in the isolated worktree created by integration-work, never edit deployed credentials, never deploy or restart production, and never widen permissions beyond the approved specification. Add fixture-based tests, run them, document setup and rollback, then report readiness with integration-work ready. If credentials or external approval are required, raise a card instead of guessing.",
  tools: ["fs.read", "fs.write", "shell", "todo", "cards", "integration.build"],
  triggers: { mentions: true },
  backlog: [],
  guardrails: { drafts_only: true, daily_token_cap: 300_000 },
};

export class CapabilityService {
  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
    private home: string = internsHome(),
  ) {}

  ensureBuilder(): string {
    const existing = this.registry.get("forge");
    const manifest = existing ?? FORGE;
    if (!existing) this.registry.save(manifest, "forge");
    this.db.upsertIntern({ slug: "forge", name: manifest.name, role: manifest.role, icon: manifest.icon });
    return "forge";
  }

  request(intern: string, requirement: CapabilityRequirement): CapabilityRequest {
    const definition = CAPABILITY_CATALOG[requirement.id];
    const request = this.db.createCapabilityRequest({
      intern,
      capability: requirement.id,
      description: requirement.reason,
      spec: definition
        ? { title: definition.title, tools: definition.tools, permissions: definition.permissions, built_in: definition.builtIn }
        : { title: requirement.id, tools: [], permissions: [], built_in: false },
    });
    if (request.card_id) return request;
    const permissions = definition?.permissions.map((p) => `- ${p}`).join("\n") || "- To be proposed by Forge before activation";
    const card = this.db.createCard({
      intern: "coordinator",
      title: `Capability requested: ${definition?.title ?? requirement.id}`,
      body:
        `**Requested for:** \`${intern}\`\n\n${requirement.reason}\n\n` +
        `**Maximum proposed permissions**\n${permissions}\n\n` +
        `Approval starts an isolated build/test job. It does not install, deploy, or publish anything.`,
      severity: "action",
      actions: [
        { id: "approve_build", label: "Approve build", style: "primary", kind: "button" },
        { id: "reject", label: "Not now", style: "neutral", kind: "button" },
      ],
    });
    this.db.setCapabilityRequestCard(request.id, card.id);
    this.db.createApprovalJob({
      cardId: card.id,
      actionId: "approve_build",
      kind: "capability.approve",
      payload: { request_id: request.id },
    });
    return this.db.getCapabilityRequest(request.id)!;
  }

  approve(requestId: string): Record<string, unknown> {
    const request = this.db.getCapabilityRequest(requestId);
    if (!request) throw new Error(`no capability request: ${requestId}`);
    if (request.status !== "requested") return { request_id: request.id, status: request.status };
    this.db.markCapabilityRequest(request.id, "approved");
    const definition = CAPABILITY_CATALOG[request.capability];
    if (definition?.builtIn) {
      this.db.markCapabilityRequest(request.id, "ready");
      this.createActivationCard(request.id);
      return { request_id: request.id, status: "ready", built_in: true };
    }
    const builder = this.ensureBuilder();
    this.db.markCapabilityRequest(request.id, "building");
    this.db.enqueueTask(builder, "trigger", {
      type: "capability_build",
      request_id: request.id,
      capability: request.capability,
      requested_for: request.intern,
      description: request.description,
      spec: request.spec,
    });
    return { request_id: request.id, status: "building", builder };
  }

  ready(requestId: string, report: { summary: string; tests: string[]; branch?: string }): CapabilityRequest {
    const request = this.db.getCapabilityRequest(requestId);
    if (!request) throw new Error(`no capability request: ${requestId}`);
    if (!["building", "testing", "approved"].includes(request.status)) {
      throw new Error(`capability request ${request.id} is ${request.status}, not buildable`);
    }
    this.db.markCapabilityRequest(request.id, "ready");
    this.createActivationCard(request.id, report);
    return this.db.getCapabilityRequest(request.id)!;
  }

  private createActivationCard(requestId: string, report?: { summary: string; tests: string[]; branch?: string }): void {
    const request = this.db.getCapabilityRequest(requestId)!;
    const definition = CAPABILITY_CATALOG[request.capability];
    const setup = request.capability === "github" && !this.githubConfigured()
      ? "\n\n⚠️ GitHub credentials are not configured yet. Add them to `~/.interns/config.json` before activating."
      : "";
    const card = this.db.createCard({
      intern: "coordinator",
      title: `Ready to activate: ${definition?.title ?? request.capability}`,
      body:
        `${report?.summary ?? "The built-in adapter and fixture tests are available."}` +
        (report?.tests?.length ? `\n\n**Tests**\n${report.tests.map((t) => `- ${t}`).join("\n")}` : "") +
        (report?.branch ? `\n\n**Build branch:** \`${report.branch}\`` : "") +
        setup +
        `\n\nActivation grants only the tools listed in the approved capability specification.`,
      severity: "action",
      actions: [
        { id: "activate", label: "Activate", style: "success", kind: "button" },
        { id: "reject", label: "Reject", style: "neutral", kind: "button" },
      ],
    });
    this.db.setCapabilityRequestCard(request.id, card.id);
    this.db.createApprovalJob({
      cardId: card.id,
      actionId: "activate",
      kind: "capability.activate",
      payload: { request_id: request.id },
    });
  }

  activate(requestId: string): Record<string, unknown> {
    const request = this.db.getCapabilityRequest(requestId);
    if (!request) throw new Error(`no capability request: ${requestId}`);
    if (request.status === "active") return { request_id: request.id, status: "active" };
    if (request.status !== "ready") throw new Error(`capability request ${request.id} is ${request.status}, not ready`);
    const definition = CAPABILITY_CATALOG[request.capability];
    if (!definition) {
      throw new RetryableApprovalError(`capability ${request.capability} is not registered; deploy the approved build first`);
    }
    if (request.capability === "github" && !this.githubConfigured()) {
      throw new RetryableApprovalError("GitHub App credentials are not configured in ~/.interns/config.json");
    }
    const manifest = this.registry.get(request.intern);
    if (!manifest) throw new Error(`requesting intern no longer exists: ${request.intern}`);
    const tools = [...new Set([...manifest.tools, ...definition.tools])];
    for (const tool of tools) {
      if (!(tool in TOOL_CATALOG)) throw new RetryableApprovalError(`tool is not registered: ${tool}`);
    }
    this.registry.save({ ...manifest, tools }, request.intern);
    if (request.capability === "github" && this.config.github.reviewer_slug !== request.intern) {
      this.config.github.reviewer_slug = request.intern;
      saveConfig(this.config, this.home);
    }
    this.db.markCapabilityRequest(request.id, "active");
    this.db.addMessage({
      intern: request.intern,
      author: "coordinator",
      text: `${definition.title} is active. New tools: ${definition.tools.map((t) => `\`${t}\``).join(", ")}.`,
      surface: "system",
    });
    return { request_id: request.id, status: "active", intern: request.intern, tools: definition.tools };
  }

  rejectForCard(cardId: string): void {
    const request = this.db.listCapabilityRequests().find((r) => r.card_id === cardId);
    if (request && !["active", "rejected", "failed"].includes(request.status)) {
      this.db.markCapabilityRequest(request.id, "rejected");
    }
  }

  private githubConfigured(): boolean {
    return Boolean(
      this.config.github.app_id &&
        (this.config.github.installation_id || Object.values(this.config.github.installation_ids).some(Boolean)) &&
        this.config.github.private_key_path &&
        fs.existsSync(this.config.github.private_key_path) &&
        this.config.github.repositories.length > 0,
    );
  }
}
