/**
 * Localhost HTTP + SSE API for the app surface. Static bearer token from
 * config (generated on first run). SSE streams the in-process EventBus.
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { notFoundPage, resolvePage } from "./appshell.js";
import { z } from "zod";
import type { ApprovalService } from "./approvals.js";
import {
  AttachmentStore,
  extensionFor,
  imageSize,
  kindFor,
  MAX_ATTACHMENT_BYTES,
  resolveMime,
  safeName,
  sha256,
  verifyAttachmentSig,
} from "./attachments.js";
import type { CapabilityService } from "./capabilities.js";
import { calendarMailbox, internsHome, repoRoot, type Config } from "./config.js";
import type { Db } from "./db.js";
import type { DiscordAdapter } from "./discord.js";
import { INTERN_ASSIGNABLE_TOOL_NAMES, MANAGED_TOOL_NAMES, TOOL_CATALOG } from "./engine.js";
import type { EventBus } from "./events.js";
import { assertNameAvailable, confirmHire, hire, NameTakenError, takenNames } from "./hire.js";
import { githubRepositoryAllowed, pullRequestLinks, verifyGithubWebhook, type GithubClient, type GithubReviewProposal } from "./github.js";
import { ICONS } from "./icons.js";
import type { PushService } from "./push.js";
import type { Registry } from "./registry.js";
import type { Orchestrator } from "./orchestrator.js";
import { awaySummaries, buildAgenda, cachedCalendar, localDate, type CalendarSource } from "./agenda.js";
import { ruleFence } from "./fences.js";
import { captureIdea, ideaText, tagIdea, type TagFn } from "./ideas.js";
import { addItem, announcePage, PageError, pageHeader, patchItem, removeItem, searchPages, validatePageData } from "./pages.js";
import { parseRuleParams, ruleKind } from "./rules.js";
import { loadMemory, startSuggestions, suggestStatus } from "./suggest.js";
import {
  CardActionSchema,
  CardSeveritySchema,
  CardStateSchema,
  InternManifest,
  InternManifestSchema,
  PageKindSchema,
  RuleTypeSchema,
  type Rule,
  type Task,
} from "./types.js";
import { SEEN_ACTION } from "./db.js";

const compact = (value: unknown, max = 72): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

type GithubCheckRun = { status?: string; conclusion?: string | null };

function summarizePullRequest(
  pull: null | { changed_files?: number; additions?: number; deletions?: number },
  runs: GithubCheckRun[],
) {
  const checks = {
    total: runs.length,
    passed: runs.filter((run) => run.status === "completed" && ["success", "neutral", "skipped"].includes(String(run.conclusion))).length,
    failed: runs.filter((run) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(String(run.conclusion))).length,
    pending: runs.filter((run) => run.status !== "completed" || !run.conclusion).length,
  };
  const changedFiles = Number(pull?.changed_files ?? 0);
  const additions = Number(pull?.additions ?? 0);
  const deletions = Number(pull?.deletions ?? 0);
  const changeSize = additions + deletions;
  const risk = checks.failed > 0 || changedFiles >= 30 || changeSize >= 1_000
    ? "high"
    : changedFiles >= 10 || changeSize >= 300 || checks.pending > 0
      ? "medium"
      : pull
        ? "low"
        : "unknown";
  return { checks, changedFiles, additions, deletions, risk };
}

/** Human-readable task state shared by Crew and the activity timeline. */
export function taskActivity(task: Task) {
  const p = task.payload;
  const prefix = task.status === "paused" ? "Paused: " : task.status === "queued" ? (task.priority > 0 ? "Priority: " : "Queued: ") : "";
  let label: string;
  if (p.type === "github_pull_request") {
    const target = `${String(p.repository ?? "repository")} #${String(p.pull_number ?? "?")}`;
    label = task.status === "done" ? `Reviewed ${target}` : task.status === "failed" ? `Review failed: ${target}` : task.status === "cancelled" ? `Cancelled review: ${target}` : `${prefix}Reviewing ${target}`;
  } else if (p.type === "capability_build") {
    const target = `${String(p.capability ?? "integration")} for ${String(p.requested_for ?? "intern")}`;
    label = task.status === "done" ? `Built ${target}` : task.status === "failed" ? `Build failed: ${target}` : task.status === "cancelled" ? `Cancelled build: ${target}` : `${prefix}Building ${target}`;
  } else if (p.kind === "new_mail") {
    const count = Number(p.count ?? 1);
    const mailbox = String(p.mailbox ?? "inbox");
    label = task.status === "done" ? `Triaged ${count} email${count === 1 ? "" : "s"} in ${mailbox}` : task.status === "failed" ? `Mail triage failed in ${mailbox}` : task.status === "cancelled" ? `Cancelled mail triage in ${mailbox}` : `${prefix}Triaging ${count} new email${count === 1 ? "" : "s"} in ${mailbox}`;
  } else if (p.kind === "meeting_brief") {
    const event = (p.event ?? {}) as Record<string, unknown>;
    const subject = compact(event.subject ?? event.title ?? "upcoming meeting", 54);
    label = task.status === "done" ? `Prepared brief: ${subject}` : task.status === "failed" ? `Brief failed: ${subject}` : task.status === "cancelled" ? `Cancelled brief: ${subject}` : `${prefix}Preparing brief: ${subject}`;
  } else if (task.kind === "message" && typeof p.thread === "string" && p.thread !== task.intern) {
    const room = p.room as { name?: string } | undefined;
    const where = room?.name ? `in ${room.name}` : p.thread === "coordinator" ? "at the front desk" : `in ${String(p.thread)}'s thread`;
    label = task.status === "done" ? `Replied ${where}` : task.status === "failed" ? `Reply failed ${where}` : task.status === "cancelled" ? `Cancelled reply ${where}` : `${prefix}Replying ${where}`;
  } else if (task.kind === "message") {
    label = task.status === "done" ? "Replied to you" : task.status === "failed" ? "Reply failed" : task.status === "cancelled" ? "Cancelled reply" : `${prefix}Replying to you`;
  } else if (task.kind === "backlog") {
    const item = compact(p.item ?? "backlog item", 62);
    label = task.status === "done" ? `Completed: ${item}` : task.status === "failed" ? `Failed: ${item}` : task.status === "cancelled" ? `Cancelled: ${item}` : `${prefix}Working on: ${item}`;
  } else if (task.kind === "scheduled") {
    label = task.status === "done" ? "Completed scheduled routine" : task.status === "failed" ? "Scheduled routine failed" : task.status === "cancelled" ? "Cancelled scheduled routine" : `${prefix}Running scheduled routine`;
  } else {
    label = task.status === "done" ? "Completed triggered work" : task.status === "failed" ? "Triggered work failed" : task.status === "cancelled" ? "Cancelled triggered work" : `${prefix}Handling an external trigger`;
  }
  return {
    id: task.id,
    intern: task.intern,
    kind: task.kind,
    status: task.status,
    priority: task.priority,
    label,
    repository: typeof p.repository === "string" ? p.repository : null,
    pull_number: typeof p.pull_number === "number" ? p.pull_number : null,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    error: task.error ? compact(task.error, 180) : null,
  };
}

/** Shape returned by GET/PATCH /interns/:slug/manifest — the app's manifest-editor contract. */
function manifestResponse(slug: string, manifest: InternManifest, db: Db) {
  const row = db.getIntern(slug);
  const spend = db.spendToday(slug);
  return {
    slug,
    name: manifest.name,
    role: manifest.role,
    icon: manifest.icon,
    persona: manifest.persona,
    system_prompt: manifest.system_prompt,
    tools: manifest.tools,
    triggers: {
      cron: manifest.triggers.cron ?? null,
      // on unless switched off: other interns' @mentions wake them (orchestrator.ts takesMentions)
      mentions: manifest.triggers.mentions !== false,
      mail_push: manifest.triggers.mail_push ?? false,
    },
    backlog: manifest.backlog,
    guardrails: {
      drafts_only: manifest.guardrails.drafts_only,
      daily_token_cap: manifest.guardrails.daily_token_cap,
    },
    paused: manifest.paused === true,
    /** today's limit beyond the manifest cap, and work waiting for room under it */
    budget: {
      extra_today: db.budgetExtra(slug),
      held: db.budgetHeldTasks(slug).length,
    },
    spend_today: {
      input_tokens: spend.input_tokens,
      output_tokens: spend.output_tokens,
      cost_usd: spend.cost_usd,
    },
    discord: {
      channel_id: row?.discord_channel_id ?? null,
    },
  };
}

/** PATCH body: any subset of the manifest fields. `.strict()` rejects slug/session_id/etc smuggled in. */
const ManifestPatchSchema = z
  .object({
    name: z.string().optional(),
    role: z.string().optional(),
    icon: z.string().optional(),
    persona: z.string().optional(),
    system_prompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    triggers: z
      .object({
        mail_push: z.boolean().optional(),
        // null clears a previously-set cron; omitted leaves it untouched
        cron: z.string().nullable().optional(),
        mentions: z.boolean().optional(),
      })
      .optional(),
    backlog: z.array(z.string()).optional(),
    guardrails: z
      .object({
        drafts_only: z.boolean().optional(),
        daily_token_cap: z.number().optional(),
      })
      .optional(),
    paused: z.boolean().optional(),
  })
  .strict();

export async function startApi(deps: {
  db: Db;
  registry: Registry;
  bus: EventBus;
  config: Config;
  /** optional: when present and Discord is live, name/icon PATCHes keep the intern's webhook identity in sync (best-effort) */
  discord?: DiscordAdapter;
  push: PushService;
  approvals: ApprovalService;
  capabilities: CapabilityService;
  github: GithubClient;
  orchestrator: Pick<Orchestrator, "pauseTask" | "resumeTask" | "cancelTask" | "prioritizeTask" | "fanOutFromJp" | "proposeFn">;
  /** base dir for attachment bytes (defaults to INTERNS_HOME) */
  home?: string;
  /** Today's calendar source — graph-cal by default; tests inject a fake */
  calendar?: CalendarSource;
  /** idea tagging call — Haiku by default; tests inject a fake */
  tagFn?: TagFn;
}): Promise<FastifyInstance> {
  const { db, registry, bus, config, discord, push, approvals, capabilities, github, orchestrator } = deps;
  const calendar = deps.calendar ?? cachedCalendar(calendarMailbox(config));
  const tagFn = deps.tagFn ?? tagIdea;
  const attachments = new AttachmentStore(deps.home ?? internsHome());
  const app = Fastify({ logger: false, bodyLimit: MAX_ATTACHMENT_BYTES + 4096 });

  // Uploads arrive as a raw body on the attachments route; the body is
  // buffered and never JSON-parsed. A catch-all parser is safe globally:
  // every other route declares application/json.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "application/octet-stream", "application/pdf", "text/plain", "text/csv", "text/markdown"]) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  // The app surface (PWA in a browser) is on a different origin; auth is the
  // bearer token, so any origin may attempt — the token decides.
  await app.register(cors, { origin: true });

  /** Paths that are API (bearer-token gated); everything else is the static app shell. */
  const API_PREFIXES = ["/interns", "/tasks", "/cards", "/activity", "/hire", "/events", "/meta", "/push", "/capabilities", "/github", "/webhooks", "/attachments", "/rooms", "/reports", "/suggest", "/messages", "/pages", "/rules", "/agenda", "/ideas"];
  /** A thread key is an intern slug, a live room id, or the coordinator's front desk. */
  const threadExists = (key: string) => key === "coordinator" || Boolean(registry.get(key)) || Boolean(db.getRoom(key)?.archived_at === null);
  const isApiPath = (url: string) => API_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));

  // The built app (app/dist), served from the same origin as the API below.
  const appDist = process.env.INTERNS_APP_DIST ?? path.join(repoRoot(), "app", "dist");
  const servesApp = existsSync(appDist);
  /**
   * The app page for a browser loading the URL itself (address bar, reload,
   * notification tap) — never the app's own fetches, which aren't navigations.
   * /hire and /cards are both screens and API prefixes; reloading one must
   * get the screen, not a 401.
   */
  const navigationPage = (req: FastifyRequest) =>
    servesApp && req.method === "GET" && (req.headers["sec-fetch-mode"] === "navigate" || /\btext\/html\b/.test(req.headers.accept ?? ""))
      ? resolvePage(appDist, req.url)
      : null;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "OPTIONS") return; // CORS preflight carries no auth header
    if (!isApiPath(req.url)) return; // app shell + assets are public; data stays token-gated
    const page = navigationPage(req);
    if (page) return reply.type("text/html").sendFile(page);
    if (req.url.startsWith("/webhooks/github")) return; // authenticated by X-Hub-Signature-256 below
    const auth = req.headers.authorization ?? "";
    if (auth === `Bearer ${config.api_token}`) return;
    // <img src> / <a download> cannot send headers: a GET for attachment bytes
    // may instead carry the per-attachment HMAC signature in its query string.
    if (req.method === "GET" && req.url.startsWith("/attachments/")) {
      const parsed = new URL(req.url, "http://localhost");
      const id = decodeURIComponent(parsed.pathname.slice("/attachments/".length));
      if (verifyAttachmentSig(config.api_token, id, parsed.searchParams.get("sig") ?? undefined)) return;
    }
    return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/interns", async () => {
    return registry.list().map(({ slug, manifest }) => {
      const row = db.getIntern(slug);
      const spend = db.spendToday(slug);
      const current = db.currentTask(slug);
      return {
        slug,
        name: manifest.name,
        role: manifest.role,
        icon: manifest.icon,
        session_id: row?.session_id ?? null,
        queued: db.countTasks(slug, "queued"),
        running: db.countTasks(slug, "running"),
        paused: db.countTasks(slug, "paused"),
        /** JP paused the intern itself (not a task) */
        on_pause: manifest.paused === true,
        activity: current ? taskActivity(current) : null,
        spend_today: spend.input_tokens + spend.output_tokens,
        cost_today_usd: spend.cost_usd,
      };
    });
  });

  app.get<{ Querystring: { limit?: string } }>("/activity", async (req) => {
    const limit = Number(req.query.limit ?? 100);
    return db.listRecentTasks(Number.isFinite(limit) ? limit : 100).map(taskActivity);
  });

  app.post<{ Params: { id: string; action: string } }>("/tasks/:id/actions/:action", async (req, reply) => {
    const action = z.enum(["pause", "resume", "cancel", "prioritize"]).safeParse(req.params.action);
    if (!action.success) return reply.code(404).send({ error: "unknown task action" });
    if (!db.getTask(req.params.id)) return reply.code(404).send({ error: "no such task" });
    try {
      const task = action.data === "pause"
        ? orchestrator.pauseTask(req.params.id)
        : action.data === "resume"
          ? orchestrator.resumeTask(req.params.id)
          : action.data === "cancel"
            ? orchestrator.cancelTask(req.params.id)
            : orchestrator.prioritizeTask(req.params.id);
      return taskActivity(task);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { slug: string } }>("/interns/:slug/messages", async (req, reply) => {
    if (!threadExists(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    return db.listMessages(req.params.slug);
  });

  // ---------------------------------------------------------------- rooms

  const RoomBodySchema = z.object({
    name: z.string().trim().min(1).max(80),
    members: z.array(z.string().min(1)).min(1).max(12),
    topic: z.string().max(2000).default(""),
    scratchpad: z.string().max(20_000).default(""),
  });

  // ---- pins: JP pins a message; the thread shows a pinned bar
  app.post<{ Params: { id: string } }>("/messages/:id/pin", async (req, reply) => {
    const body = z.object({ pinned: z.boolean().default(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "pinned must be boolean" });
    const msg = db.setPinned(req.params.id, body.data.pinned);
    if (!msg) return reply.code(404).send({ error: "no such message" });
    return msg;
  });

  app.get<{ Params: { slug: string } }>("/interns/:slug/pins", async (req, reply) => {
    if (!threadExists(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    return db.listPinned(req.params.slug);
  });

  // ---- scratchpad: a shared markdown pad per room (JP in the app, interns via tools/room-pad)
  app.get<{ Params: { id: string } }>("/rooms/:id/scratchpad", async (req, reply) => {
    const room = db.getRoom(req.params.id);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return { id: room.id, name: room.name, scratchpad: room.scratchpad, updated_at: room.updated_at };
  });

  app.put<{ Params: { id: string } }>("/rooms/:id/scratchpad", async (req, reply) => {
    const body = z.object({ scratchpad: z.string().max(20_000), append: z.boolean().default(false), author: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "scratchpad required", detail: body.error.issues });
    const room = db.getRoom(req.params.id);
    if (!room) return reply.code(404).send({ error: "no such room" });
    const next = body.data.append ? `${room.scratchpad.trimEnd()}${room.scratchpad.trim() ? "\n\n" : ""}${body.data.scratchpad.trim()}` : body.data.scratchpad;
    const updated = db.updateRoom(room.id, { scratchpad: next.slice(0, 20_000) })!;
    if (body.data.author && registry.get(body.data.author)) {
      // A short system note in the thread so the edit is visible in the conversation.
      db.addMessage({ intern: room.id, author: "coordinator", text: `📝 ${registry.get(body.data.author)!.name} updated the scratchpad.`, surface: "system" });
    }
    return { id: updated.id, name: updated.name, scratchpad: updated.scratchpad, updated_at: updated.updated_at };
  });

  app.get("/rooms", async () =>
    db.listRooms().map((room) => {
      const last = db.listMessages(room.id, 1)[0] ?? null;
      return { ...room, last_message: last };
    }),
  );

  app.post("/rooms", async (req, reply) => {
    const body = RoomBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid room", detail: body.error.issues });
    const unknown = body.data.members.filter((m) => !registry.get(m));
    if (unknown.length) return reply.code(400).send({ error: "unknown member(s)", detail: unknown });
    const room = db.createRoom(body.data);
    db.addMessage({
      intern: room.id,
      author: "coordinator",
      text: `Group created: **${room.name}** with ${room.members.map((m) => registry.get(m)?.name ?? m).join(", ")}. Mention someone with @Name to bring them in; with no mention everyone may answer.`,
      surface: "system",
    });
    return reply.code(201).send(room);
  });

  app.get<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
    const room = db.getRoom(req.params.id);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return room;
  });

  app.patch<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
    const body = RoomBodySchema.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid room", detail: body.error.issues });
    if (body.data.members) {
      const unknown = body.data.members.filter((m) => !registry.get(m));
      if (unknown.length) return reply.code(400).send({ error: "unknown member(s)", detail: unknown });
    }
    const room = db.updateRoom(req.params.id, body.data);
    if (!room) return reply.code(404).send({ error: "no such room" });
    return room;
  });

  app.post<{ Params: { id: string } }>("/rooms/:id/archive", async (req, reply) => {
    if (!db.getRoom(req.params.id)) return reply.code(404).send({ error: "no such room" });
    db.archiveRoom(req.params.id);
    db.cancelQueuedTasks(req.params.id, "room archived");
    return { id: req.params.id, archived: true };
  });

  app.post<{ Params: { slug: string } }>("/interns/:slug/messages", async (req, reply) => {
    const body = z
      .object({ text: z.string().default(""), attachment_ids: z.array(z.string().min(1)).max(20).default([]), reply_to: z.string().nullable().optional() })
      .safeParse(req.body);
    if (!body.success || (!body.data.text.trim() && body.data.attachment_ids.length === 0)) {
      return reply.code(400).send({ error: "text or attachment_ids required" });
    }
    if (!threadExists(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    for (const id of body.data.attachment_ids) {
      const att = db.getAttachment(id);
      if (!att || att.intern !== req.params.slug || att.message_id) {
        return reply.code(400).send({ error: "unknown or already-used attachment", detail: id });
      }
    }
    const quotedMsg = body.data.reply_to ? db.getMessage(body.data.reply_to) : undefined;
    const replyTo = quotedMsg?.intern === req.params.slug ? quotedMsg.id : null;
    const message = db.addMessage({
      intern: req.params.slug,
      author: "jp",
      text: body.data.text,
      surface: "app",
      reply_to: replyTo,
      attachmentIds: body.data.attachment_ids,
    });

    // "idea: …" / "💡 …" in any chat is filed on the Ideas page, not sent to an intern.
    const idea = body.data.attachment_ids.length === 0 ? ideaText(body.data.text) : null;
    if (idea) {
      const captured = captureIdea(db, idea, { thread_key: req.params.slug, message_id: message.id }, tagFn);
      db.addMessage({
        intern: req.params.slug,
        author: "coordinator",
        text: `💡 Saved to Ideas (${captured.count})${captured.fence ? `\n\n${captured.fence}` : ""}`,
        surface: "system",
        reply_to: message.id,
      });
      return { message, task_id: "", targets: [] };
    }

    // Answering a debrief question: "Skip" closes it quietly; anything else
    // reaches the intern with the meeting attached (docs/features/05-debrief.md).
    const debrief = replyTo ? db.debriefForMessage(replyTo) : undefined;
    const debriefExtra: Record<string, unknown> = {};
    if (debrief?.state === "asked") {
      const start = (debrief.event.start as { iso?: string } | undefined)?.iso;
      const skip = /^\s*skip\s*\.?\s*$/i.test(body.data.text) && body.data.attachment_ids.length === 0;
      db.setDebriefState(debrief.event_id, debrief.intern, skip ? "skipped" : "answered");
      db.notifyAgenda(localDate(start ? new Date(start) : new Date()));
      if (skip) return { message, task_id: "", targets: [] };
      debriefExtra.debrief = debrief.event;
    }
    // The intern reads attachments straight off disk, so the task carries
    // resolved paths + metadata rather than ids. Mentions fan the message
    // out (room members, or another intern pulled into a 1:1 thread).
    const extra = message.attachments.length
      ? {
          attachments: message.attachments.map((a) => ({
            id: a.id,
            name: a.name,
            mime: a.mime,
            size: a.size,
            kind: a.kind,
            path: attachments.pathFor(a.intern, a.id, a.ext),
            caption: a.caption,
          })),
        }
      : {};
    // What JP is replying to travels with the task, so the intern knows (swipe-to-reply used to be invisible to it).
    const quoted = replyTo && quotedMsg
      ? { quoted: { id: quotedMsg.id, author: quotedMsg.author, speaker: quotedMsg.speaker, text: quotedMsg.text.slice(0, 1000) } }
      : {};
    const targets = await orchestrator.fanOutFromJp(req.params.slug, body.data.text, { ...extra, ...quoted, ...debriefExtra, reply_to: message.id });
    const first = targets[0] ? db.currentTask(targets[0]) : undefined;
    return { message, task_id: first?.id ?? "", targets };
  });

  // -------------------------------------------------------- attachments

  /**
   * Upload one file as a raw request body. Metadata rides in the query
   * string so nothing needs a multipart parser:
   *   POST /interns/:slug/attachments?name=chart.svg&author=jp&caption=...
   *   Content-Type: image/svg+xml (or application/octet-stream)
   * Returns the Attachment. It stays unlinked until a message claims it
   * (`attachment_ids` on POST /messages for JP; the intern's next reply for
   * interns — see orchestrator.ts).
   */
  app.post<{ Params: { slug: string }; Querystring: { name?: string; author?: string; caption?: string } }>(
    "/interns/:slug/attachments",
    async (req, reply) => {
      const { slug } = req.params;
      if (slug !== "coordinator" && !threadExists(slug)) return reply.code(404).send({ error: "no such intern" });
      const author = z.enum(["jp", "intern", "coordinator"]).safeParse(req.query.author ?? "jp");
      if (!author.success) return reply.code(400).send({ error: "bad author" });
      const raw = req.body;
      const bytes = Buffer.isBuffer(raw) ? raw : typeof raw === "string" ? Buffer.from(raw) : null;
      if (!bytes || bytes.length === 0) return reply.code(400).send({ error: "empty body" });
      if (bytes.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: `file exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
      const name = safeName(String(req.query.name ?? req.headers["x-file-name"] ?? "upload"));
      const mime = resolveMime(req.headers["content-type"], name, bytes);
      const kind = kindFor(mime);
      const ext = extensionFor(name, mime);
      const size = imageSize(mime, bytes);
      const id = randomUUID();
      attachments.write(slug, id, ext, bytes);
      const caption = typeof req.query.caption === "string" && req.query.caption.trim() ? req.query.caption.trim().slice(0, 500) : null;
      const record = db.createAttachment({
        id,
        intern: slug,
        author: author.data,
        name,
        mime,
        size: bytes.length,
        kind,
        sha256: sha256(bytes),
        ext,
        caption,
        width: size?.width ?? null,
        height: size?.height ?? null,
      });
      return reply.code(201).send({ ...record, path: attachments.pathFor(slug, id, ext) });
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>("/interns/:slug/attachments", async (req, reply) => {
    if (req.params.slug !== "coordinator" && !threadExists(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    const limit = Number(req.query.limit ?? 200);
    return db.listAttachments(req.params.slug, Number.isFinite(limit) ? limit : 200);
  });

  app.get<{ Params: { id: string } }>("/attachments/:id/meta", async (req, reply) => {
    const att = db.getAttachment(req.params.id);
    if (!att) return reply.code(404).send({ error: "no such attachment" });
    return att;
  });

  /** Bytes. `?download=1` forces a save-as; otherwise images/SVG/PDF/text display inline. */
  app.get<{ Params: { id: string }; Querystring: { download?: string; sig?: string } }>("/attachments/:id", async (req, reply) => {
    const att = db.getAttachment(req.params.id);
    if (!att) return reply.code(404).send({ error: "no such attachment" });
    const file = attachments.locate(att.intern, att.id, att.ext);
    if (!file) return reply.code(410).send({ error: "attachment bytes are gone" });
    const download = req.query.download === "1" || req.query.download === "true";
    const inlineOk = att.kind === "image" || att.kind === "svg" || att.mime === "application/pdf" || att.mime.startsWith("text/");
    const disposition = `${download || !inlineOk ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(att.name)}`;
    // text/html would run as a same-origin page with access to the app's
    // storage — serve it as plain text unless explicitly downloaded.
    const type = att.mime === "text/html" && !download ? "text/plain; charset=utf-8" : att.mime;
    return reply
      .header("Content-Type", type)
      .header("Content-Length", String(att.size))
      .header("Content-Disposition", disposition)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(createReadStream(file));
  });

  app.get<{ Params: { slug: string } }>("/interns/:slug/manifest", async (req, reply) => {
    const { slug } = req.params;
    if (slug === "coordinator") return reply.code(404).send({ error: "no such intern" }); // coordinator is orchestrator, not a hired intern
    const manifest = registry.get(slug);
    if (!manifest) return reply.code(404).send({ error: "no such intern" });
    return manifestResponse(slug, manifest, db);
  });

  /**
   * Partial update: merges the body over the stored manifest (deep-merging
   * triggers/guardrails, replacing tools/backlog arrays wholesale when given),
   * validates the merged result, and writes it back. `slug` is the intern's
   * stable identity — even a `name` change keeps the same slug/dir/session.
   */
  app.patch<{ Params: { slug: string } }>("/interns/:slug/manifest", async (req, reply) => {
    const { slug } = req.params;
    if (slug === "coordinator") return reply.code(404).send({ error: "no such intern" });
    const existing = registry.get(slug);
    if (!existing) return reply.code(404).send({ error: "no such intern" });

    const body = ManifestPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid patch", detail: body.error.issues });
    const patch = body.data;

    if (patch.tools) {
      const invalid = patch.tools.filter((t) => !(t in TOOL_CATALOG));
      if (invalid.length) {
        return reply.code(400).send({ error: "unknown tool(s)", detail: invalid, valid: INTERN_ASSIGNABLE_TOOL_NAMES });
      }
      const managedAdditions = patch.tools.filter((t) => MANAGED_TOOL_NAMES.has(t) && !existing.tools.includes(t));
      if (managedAdditions.length) {
        return reply.code(403).send({
          error: "managed tool(s) require capability activation",
          detail: managedAdditions,
        });
      }
    }
    if (patch.name !== undefined && patch.name.trim() !== existing.name) {
      try {
        assertNameAvailable(patch.name, { db, registry }, slug);
      } catch (err) {
        if (err instanceof NameTakenError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    }
    if (patch.icon !== undefined && !ICONS.some((i) => i.id === patch.icon)) {
      return reply.code(400).send({ error: "unknown icon", detail: patch.icon, valid: ICONS.map((i) => i.id) });
    }
    if (patch.guardrails?.daily_token_cap !== undefined) {
      const cap = patch.guardrails.daily_token_cap;
      if (!Number.isInteger(cap) || cap < 10_000) {
        return reply.code(400).send({ error: "guardrails.daily_token_cap must be an integer >= 10000" });
      }
    }

    // deep-merge triggers: explicit null clears cron, omitted keys are left as-is
    const triggers = { ...existing.triggers };
    if (patch.triggers) {
      if (patch.triggers.mail_push !== undefined) triggers.mail_push = patch.triggers.mail_push;
      if (patch.triggers.mentions !== undefined) triggers.mentions = patch.triggers.mentions;
      if ("cron" in patch.triggers) {
        if (patch.triggers.cron === null) delete triggers.cron;
        else if (patch.triggers.cron !== undefined) triggers.cron = patch.triggers.cron;
      }
    }

    const merged = {
      ...existing,
      ...patch,
      triggers,
      guardrails: { ...existing.guardrails, ...(patch.guardrails ?? {}) },
    };
    const parsed = InternManifestSchema.safeParse(merged);
    if (!parsed.success) return reply.code(400).send({ error: "invalid manifest", detail: parsed.error.issues });
    const manifest = parsed.data;

    // slug is the stable identity: save/upsert under the *existing* slug even
    // though `name` (and hence what a fresh slugify() would produce) may differ.
    registry.save(manifest, slug);
    db.upsertIntern({ slug, name: manifest.name, role: manifest.role, icon: manifest.icon });

    // A raised limit gives work held at the old one room to carry on now.
    if (patch.guardrails?.daily_token_cap !== undefined) {
      const spend = db.spendToday(slug);
      if (spend.input_tokens + spend.output_tokens < manifest.guardrails.daily_token_cap + db.budgetExtra(slug)) db.releaseBudgetHeld(slug);
    }

    const nameChanged = patch.name !== undefined && patch.name !== existing.name;
    const iconChanged = patch.icon !== undefined && patch.icon !== existing.icon;
    if (nameChanged || iconChanged) {
      // Best-effort: keep the Discord webhook's display name/avatar in sync, but
      // a Discord hiccup must never fail the manifest PATCH itself.
      try {
        await discord?.updateWebhookIdentity(slug, manifest);
      } catch (err) {
        console.error(`[api] discord identity update failed for ${slug}:`, err);
      }
    }

    return manifestResponse(slug, manifest, db);
  });

  /**
   * An intern's last seven days for their profile: what they got done (the
   * same wording as Today's "while you were away"), drafts, pages, cards and
   * spend per day.
   */
  app.get<{ Params: { slug: string } }>("/interns/:slug/week", async (req, reply) => {
    const { slug } = req.params;
    const manifest = registry.get(slug);
    if (!manifest) return reply.code(404).send({ error: "no such intern" });
    const since = new Date(Date.now() - 6 * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const week = db.internWeek(slug, since.toISOString());
    const finished = week.tasks.filter((t) => t.finished_at);
    const line = awaySummaries(finished, () => "")[0]?.summary.trim() ?? "";
    return {
      since: since.toISOString(),
      summary: line ? line[0]!.toUpperCase() + line.slice(1) : "",
      done: finished.filter((t) => t.status === "done").length,
      failed: finished.filter((t) => t.status === "failed").length,
      muted: finished.filter((t) => t.status === "cancelled" && (t.error ?? "").startsWith("standing order")).length,
      messages: week.messages,
      drafts: week.drafts.slice(0, 5),
      draft_count: week.drafts.length,
      pages_created: week.pages_created,
      pages_updated: week.pages_updated,
      cards_raised: week.cards_raised,
      cards_decided: week.cards_decided,
      days: week.days,
      tokens: week.days.reduce((n, d) => n + d.tokens, 0),
      cost_usd: week.days.reduce((n, d) => n + d.cost_usd, 0),
    };
  });

  /**
   * "Fire" an intern: moves ~/.interns/<slug> → ~/.interns/_fired/<slug>,
   * marks the db row archived, cancels queued work, and best-effort tells
   * Discord. Order matters: registry.archive() first (so a crash mid-way
   * leaves the dir moved — the strongest signal — rather than a db row
   * marked archived pointing at a live dir); Discord is last and never fails
   * the request.
   */
  app.post<{ Params: { slug: string } }>("/interns/:slug/archive", async (req, reply) => {
    const { slug } = req.params;
    if (slug === "coordinator") return reply.code(404).send({ error: "no such intern" });
    const manifest = registry.get(slug);
    if (!manifest) return reply.code(404).send({ error: "no such intern" });

    registry.archive(slug);
    db.archiveIntern(slug);
    db.cancelQueuedTasks(slug, "intern archived");

    if (discord) {
      try {
        await discord.archiveIntern(slug, manifest);
      } catch (err) {
        console.error(`[api] discord archive for ${slug} failed:`, err);
      }
    }

    return { slug, archived: true, name: manifest.name };
  });

  // ---------------------------------------------------------------- pages
  // Interns write through tools/intern-page; the app reads, pins, and ticks
  // list items. docs/features/02-pages.md, contracts.md §2.

  const ownerExists = (slug: string) => slug === "coordinator" || Boolean(registry.get(slug));
  const pageErr = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PageError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.post("/pages", async (req, reply) => {
    const body = z
      .object({
        intern: z.string().min(1),
        kind: PageKindSchema,
        title: z.string().trim().min(1).max(120),
        summary: z.string().max(240).default(""),
        data: z.unknown(),
        thread_key: z.string().optional(),
        announce: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid page", detail: body.error.issues });
    if (!ownerExists(body.data.intern)) return reply.code(404).send({ error: "no such intern" });
    try {
      const data = validatePageData(body.data.kind, body.data.data);
      const thread = body.data.thread_key && threadExists(body.data.thread_key) ? body.data.thread_key : body.data.intern;
      const page = db.createPage({ intern: body.data.intern, thread_key: thread, kind: body.data.kind, title: body.data.title, summary: body.data.summary, data });
      if (body.data.announce) announcePage(db, page);
      return reply.code(201).send(page);
    } catch (err) {
      return pageErr(reply, err);
    }
  });

  /** Search people, cards, rows and list items across every page (Crew search). */
  app.get<{ Querystring: { q?: string; limit?: string } }>("/pages/search", async (req) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 30) || 30, 100));
    return { hits: searchPages(db.listAllPages(), String(req.query.q ?? ""), limit) };
  });

  app.get<{ Params: { id: string } }>("/pages/:id", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    return page;
  });

  app.get<{ Params: { key: string }; Querystring: { archived?: string } }>("/interns/:key/pages", async (req, reply) => {
    if (!threadExists(req.params.key)) return reply.code(404).send({ error: "no such thread" });
    return { pages: db.listPages(req.params.key, { includeArchived: req.query.archived === "1" }).map(pageHeader) };
  });

  app.put<{ Params: { id: string } }>("/pages/:id", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    const body = z
      .object({ title: z.string().trim().min(1).max(120).optional(), summary: z.string().max(240).optional(), data: z.unknown().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid page update", detail: body.error.issues });
    try {
      const data = body.data.data === undefined ? undefined : validatePageData(page.kind, body.data.data);
      return db.updatePage(page.id, { title: body.data.title, summary: body.data.summary, data });
    } catch (err) {
      return pageErr(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/pages/:id/items", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    const body = z.object({ item: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "item required" });
    try {
      return addItem(db, page, body.data.item);
    } catch (err) {
      return pageErr(reply, err);
    }
  });

  app.patch<{ Params: { id: string; itemId: string } }>("/pages/:id/items/:itemId", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    const body = z.object({ set: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "set required" });
    try {
      return patchItem(db, page, req.params.itemId, body.data.set);
    } catch (err) {
      return pageErr(reply, err);
    }
  });

  app.delete<{ Params: { id: string; itemId: string } }>("/pages/:id/items/:itemId", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    try {
      return removeItem(db, page, req.params.itemId);
    } catch (err) {
      return pageErr(reply, err);
    }
  });

  /** Attach a page's preview to the owner's next reply (`intern-page show`). */
  app.post<{ Params: { id: string } }>("/pages/:id/show", async (req, reply) => {
    const page = db.getPage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    announcePage(db, page);
    return { id: page.id, queued: true };
  });

  app.post<{ Params: { id: string } }>("/pages/:id/pin", async (req, reply) => {
    const body = z.object({ pinned: z.boolean().default(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "pinned must be boolean" });
    const page = db.setPagePinned(req.params.id, body.data.pinned);
    if (!page) return reply.code(404).send({ error: "no such page" });
    return page;
  });

  app.post<{ Params: { id: string } }>("/pages/:id/archive", async (req, reply) => {
    const page = db.archivePage(req.params.id);
    if (!page) return reply.code(404).send({ error: "no such page" });
    return page;
  });

  // -------------------------------------------------------- standing orders
  // docs/features/04-standing-orders.md, contracts.md §3.

  const withHits = (rule: Rule) => ({ ...rule, hits_7d: db.ruleHitsSince(rule.id, new Date(Date.now() - 7 * 86_400_000).toISOString()) });

  app.post<{ Params: { slug: string } }>("/interns/:slug/rules", async (req, reply) => {
    if (!registry.get(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    const body = z
      .object({
        type: RuleTypeSchema,
        text: z.string().trim().min(3).max(300),
        params: z.record(z.string(), z.unknown()).default({}),
        created_from_message: z.string().nullable().optional(),
        announce: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid rule", detail: body.error.issues });
    let params: Record<string, unknown>;
    try {
      params = parseRuleParams(body.data.type, body.data.params);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const rule = db.createRule({
      intern: req.params.slug,
      kind: ruleKind(body.data.type),
      type: body.data.type,
      params,
      text: body.data.text,
      created_from_message: body.data.created_from_message ?? null,
    });
    if (body.data.announce) db.announce(rule.intern, ruleFence(rule));
    return reply.code(201).send(withHits(rule));
  });

  app.get<{ Params: { slug: string } }>("/interns/:slug/rules", async (req, reply) => {
    if (!registry.get(req.params.slug)) return reply.code(404).send({ error: "no such intern" });
    return { rules: db.listRules(req.params.slug).map(withHits) };
  });

  app.get<{ Params: { id: string } }>("/rules/:id", async (req, reply) => {
    const rule = db.getRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: "no such rule" });
    return withHits(rule);
  });

  app.patch<{ Params: { id: string } }>("/rules/:id", async (req, reply) => {
    const body = z.object({ enabled: z.boolean().optional(), text: z.string().trim().min(3).max(300).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid rule update", detail: body.error.issues });
    const existing = db.getRule(req.params.id);
    if (!existing) return reply.code(404).send({ error: "no such rule" });
    if (existing.removed_at) return reply.code(409).send({ error: "rule was removed" });
    return withHits(db.updateRule(existing.id, body.data)!);
  });

  app.delete<{ Params: { id: string } }>("/rules/:id", async (req, reply) => {
    const rule = db.removeRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: "no such rule" });
    return { ok: true, rule: withHits(rule) };
  });

  // ------------------------------------------------------------------ today
  // GET /agenda, not /today: /today is the app's tab route (docs/features/03-today.md).

  app.get<{ Querystring: { date?: string; since?: string } }>("/agenda", async (req, reply) => {
    const date = req.query.date ?? localDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
    return buildAgenda({ db, registry, calendar, ownDomains: config.own_domains }, date, req.query.since ?? null);
  });

  // ------------------------------------------------------------------ ideas

  app.post("/ideas", async (req, reply) => {
    const body = z
      .object({ text: z.string().trim().min(1).max(2000), source: z.object({ thread_key: z.string(), message_id: z.string() }).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "text required" });
    const captured = captureIdea(db, body.data.text, body.data.source ?? null, tagFn);
    return reply.code(201).send({ page_id: captured.page_id, item_id: captured.item_id, count: captured.count });
  });

  /** Spend over the last N days: per intern per day (the spend table), and per thread/room (run_spend) — "what did that conversation cost". */
  // Coordinator suggestions: the weekly pass, on demand. Starts in the
  // background and answers 202 at once — the model call outlives proxy
  // timeouts. The app polls /suggest/status; cards arrive over /events.
  app.post("/suggest/run", async (_req, reply) => {
    const status = startSuggestions({ db, registry, home: deps.home ?? internsHome(), proposeFn: orchestrator.proposeFn });
    return reply.code(202).send(status);
  });

  app.get("/suggest/status", async () => suggestStatus());

  app.get("/suggest/history", async () => loadMemory(deps.home ?? internsHome()));

  // Under /reports so the app can own the /spend page route (API prefixes are not served as app shell).
  app.get<{ Querystring: { days?: string } }>("/reports/spend", async (req) => {
    const days = Number(req.query.days ?? 30);
    const report = db.spendReport(Number.isFinite(days) ? days : 30);
    const names: Record<string, string> = { coordinator: "Chaos Coordinator" };
    for (const row of db.listInterns(true)) names[row.slug] = row.name;
    for (const room of db.listRooms(true)) names[room.id] = room.name;
    return { ...report, names };
  });

  // Icon + tool catalogs the app's pickers render from, so they never drift from the backend's source of truth.
  app.get("/meta", async () => {
    return { icons: ICONS, tools: INTERN_ASSIGNABLE_TOOL_NAMES };
  });

  app.get<{ Querystring: { state?: string } }>("/cards", async (req, reply) => {
    if (req.query.state) {
      const state = CardStateSchema.safeParse(req.query.state);
      if (!state.success) return reply.code(400).send({ error: "bad state" });
      return db.listCards(state.data);
    }
    return db.listCards();
  });

  app.get<{ Params: { id: string } }>("/cards/:id", async (req, reply) => {
    const card = db.getCard(req.params.id);
    if (!card) return reply.code(404).send({ error: "no such card" });
    return card;
  });

  app.post("/cards", async (req, reply) => {
    const body = z
      .object({
        intern: z.string().min(1),
        title: z.string().min(1),
        // non-empty: an empty body renders as an invalid Discord embed description
        body: z.string().min(1),
        severity: CardSeveritySchema.default("info"),
        // one Discord button row holds 5 — refuse more than the surfaces can render
        actions: z.array(CardActionSchema).max(5).default([]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid card", detail: body.error.issues });
    if (body.data.intern !== "coordinator" && !registry.get(body.data.intern)) {
      return reply.code(404).send({ error: "no such intern" });
    }
    const ids = new Set(body.data.actions.map((a) => a.id));
    if (ids.size !== body.data.actions.length) {
      return reply.code(400).send({ error: "duplicate action ids" });
    }
    return db.createCard(body.data);
  });

  app.post<{ Params: { id: string; actionId: string } }>(
    "/cards/:id/actions/:actionId",
    async (req, reply) => {
      const card = db.getCard(req.params.id);
      // "seen" is always available: it only acknowledges (Today's FYI list,
      // and information cards raised before every card carried it).
      const action = card?.actions.find((a) => a.id === req.params.actionId) ?? (card && req.params.actionId === "seen" ? SEEN_ACTION : undefined);
      if (!card || !action) return reply.code(404).send({ error: "no such card/action" });
      if (action.id === "seen" && !card.actions.some((a) => a.id === "seen")) {
        if (card.state !== "open") return card;
        return db.resolveCard(card.id, { via: "app", action: "seen" });
      }
      const body = z.object({ note: z.string().optional() }).safeParse(req.body ?? {});
      try {
        return await approvals.handle(card.id, action.id, {
          via: "app",
          action: action.id,
          ...(body.success && body.data.note ? { note: body.data.note } : {}),
        });
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get("/capabilities", async () => db.listCapabilityRequests());

  app.post<{ Params: { id: string } }>("/capabilities/:id/ready", async (req, reply) => {
    const body = z
      .object({ summary: z.string().min(1), tests: z.array(z.string()).default([]), branch: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid readiness report", detail: body.error.issues });
    try {
      return capabilities.ready(req.params.id, body.data);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const GithubReviewProposalSchema = z.object({
    intern: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    pull_number: z.number().int().positive(),
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
    body: z.string().min(1),
    comments: z
      .array(
        z.object({
          path: z.string().min(1),
          line: z.number().int().positive().optional(),
          side: z.enum(["LEFT", "RIGHT"]).optional(),
          body: z.string().min(1),
        }),
      )
      .default([]),
    head_sha: z.string().optional(),
  });

  app.get<{ Querystring: { repository?: string; number?: string } }>("/github/pr-preview", async (req, reply) => {
    const parsed = z.object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      number: z.coerce.number().int().positive(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "repository and pull request number required" });
    const repository = parsed.data.repository;
    if (!githubRepositoryAllowed(config.github.repositories, repository)) {
      return reply.code(403).send({ error: "repository is not allowlisted", detail: repository });
    }
    const [owner, repo] = repository.split("/") as [string, string];
    try {
      const pull = await github.getPullRequest(owner, repo, parsed.data.number) as {
        title?: string;
        html_url?: string;
        state?: string;
        draft?: boolean;
        changed_files?: number;
        additions?: number;
        deletions?: number;
        updated_at?: string;
        user?: { login?: string };
        head?: { sha?: string };
      };
      const checkResponse = pull.head?.sha
        ? await github.getChecks(owner, repo, pull.head.sha).catch(() => null) as null | { check_runs?: GithubCheckRun[] }
        : null;
      const summary = summarizePullRequest(pull, checkResponse?.check_runs ?? []);
      const githubUrl = pull.html_url ?? `https://github.com/${repository}/pull/${parsed.data.number}`;
      const links = pullRequestLinks(config.github, repository, parsed.data.number, githubUrl);
      return {
        repository,
        pull_number: parsed.data.number,
        title: pull.title ?? `${repository} #${parsed.data.number}`,
        state: pull.state ?? "open",
        draft: Boolean(pull.draft),
        author: pull.user?.login ?? null,
        updated_at: pull.updated_at ?? null,
        changed_files: summary.changedFiles,
        additions: summary.additions,
        deletions: summary.deletions,
        checks: summary.checks,
        risk: summary.risk,
        ...links,
      };
    } catch (error) {
      return reply.code(502).send({ error: "could not load pull request", detail: compact(error, 220) });
    }
  });

  app.post("/github/reviews", async (req, reply) => {
    const parsed = GithubReviewProposalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid review proposal", detail: parsed.error.issues });
    const proposingIntern = registry.get(parsed.data.intern);
    if (!proposingIntern) return reply.code(404).send({ error: "no such intern" });
    if (!proposingIntern.tools.includes("github")) {
      return reply.code(403).send({ error: "intern does not have the github capability" });
    }
    const fullRepo = `${parsed.data.owner}/${parsed.data.repo}`;
    if (!githubRepositoryAllowed(config.github.repositories, fullRepo)) {
      return reply.code(403).send({ error: "repository is not allowlisted", detail: fullRepo });
    }
    const { intern, ...proposal } = parsed.data;
    const [pull, checks] = await Promise.all([
      github.getPullRequest(proposal.owner, proposal.repo, proposal.pull_number).catch(() => null),
      proposal.head_sha ? github.getChecks(proposal.owner, proposal.repo, proposal.head_sha).catch(() => null) : null,
    ]) as [
      null | { title?: string; html_url?: string; changed_files?: number; additions?: number; deletions?: number },
      null | { check_runs?: { status?: string; conclusion?: string | null }[] },
    ];
    const summary = summarizePullRequest(pull, checks?.check_runs ?? []);
    const { checks: checkSummary, changedFiles, additions, deletions, risk } = summary;
    const githubUrl = pull?.html_url ?? `https://github.com/${fullRepo}/pull/${proposal.pull_number}`;
    const links = pullRequestLinks(config.github, fullRepo, proposal.pull_number, githubUrl);
    const linkLine = links.codeops_url
      ? `[Open in ${links.primary_label}](${links.codeops_url}) · [Open on GitHub](${links.github_url})`
      : `[Open on GitHub](${links.github_url})`;
    const card = db.createCard({
      intern,
      title: pull?.title ?? `Review ready: ${proposal.owner}/${proposal.repo}#${proposal.pull_number}`,
      body:
        `**Recommended action:** ${proposal.event.replace("_", " ")}\n\n${proposal.body}\n\n` +
        `${proposal.comments.length} inline comment${proposal.comments.length === 1 ? "" : "s"}. ` +
        `Nothing has been posted to GitHub.\n\n${linkLine}`,
      severity: proposal.event === "REQUEST_CHANGES" ? "action" : "info",
      actions: [
        {
          id: "publish",
          label: proposal.event === "APPROVE" ? "Approve PR" : proposal.event === "REQUEST_CHANGES" ? "Request changes" : "Publish comment",
          style: "success",
          kind: "button",
        },
        { id: "ignore", label: "Dismiss", style: "neutral", kind: "button" },
      ],
      context: {
        type: "github_review",
        repository: fullRepo,
        pull_number: proposal.pull_number,
        url: links.primary_url,
        ...links,
        recommendation: proposal.event,
        risk,
        changed_files: changedFiles,
        additions,
        deletions,
        checks: checkSummary,
        inline_comments: proposal.comments.length,
        head_sha: proposal.head_sha ?? null,
      },
    });
    db.createApprovalJob({
      cardId: card.id,
      actionId: "publish",
      kind: "github.publish_review",
      payload: proposal as GithubReviewProposal as unknown as Record<string, unknown>,
    });
    return { card };
  });

  app.get("/github/repositories", async () => {
    const configured = config.github.repositories;
    const exact = configured.filter((repository) => !repository.endsWith("/*"));
    const owners = configured
      .filter((repository) => repository.endsWith("/*"))
      .map((repository) => repository.slice(0, -2));
    const expanded = await Promise.all(
      owners.map((owner) => github.listInstallationRepositories(owner).catch((error) => {
        console.error(`[github] failed to list repositories for ${owner}:`, error);
        return [];
      })),
    );
    return { repositories: [...new Set([...exact, ...expanded.flat()])].sort() };
  });

  app.post(
    "/webhooks/github",
    {
      bodyLimit: 2_000_000,
      preParsing: async (req, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks);
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
        return Readable.from(raw);
      },
    },
    async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      if (!verifyGithubWebhook(raw, req.headers["x-hub-signature-256"] as string | undefined, config.github.webhook_secret)) {
        return reply.code(401).send({ error: "invalid webhook signature" });
      }
      const delivery = String(req.headers["x-github-delivery"] ?? "");
      const event = String(req.headers["x-github-event"] ?? "");
      if (!delivery || !event) return reply.code(400).send({ error: "missing GitHub delivery headers" });
      if (event !== "pull_request") {
        const fresh = db.recordGithubDelivery(delivery, event);
        return { accepted: true, ignored: true, duplicate: !fresh };
      }
      const payload = req.body as Record<string, any>;
      if (!["opened", "reopened", "synchronize", "ready_for_review", "review_requested"].includes(String(payload.action))) {
        const fresh = db.recordGithubDelivery(delivery, event);
        return { accepted: true, ignored: true, duplicate: !fresh };
      }
      const repo = String(payload.repository?.full_name ?? "");
      if (!githubRepositoryAllowed(config.github.repositories, repo)) {
        const fresh = db.recordGithubDelivery(delivery, event);
        return { accepted: true, ignored: true, duplicate: !fresh, reason: "repository not allowlisted" };
      }
      const pullNumber = Number(payload.pull_request?.number);
      const headSha = String(payload.pull_request?.head?.sha ?? "");
      if (!pullNumber || !headSha) return reply.code(400).send({ error: "incomplete pull request payload" });
      const reviewer = config.github.reviewer_slug;
      if (!registry.get(reviewer)) return reply.code(409).send({ error: `reviewer intern not found: ${reviewer}` });
      if (registry.get(reviewer)?.paused) return { accepted: true, ignored: true, reason: "reviewer paused" };
      if (!db.recordGithubDelivery(delivery, event)) return { accepted: true, duplicate: true };
      if (!db.recordGithubPullRequest(repo, pullNumber, headSha)) {
        return { accepted: true, duplicate: true, reason: "pull request head already queued" };
      }
      const task = db.enqueueTask(reviewer, "trigger", {
        type: "github_pull_request",
        action: payload.action,
        repository: repo,
        owner: payload.repository?.owner?.login,
        pull_number: pullNumber,
        title: payload.pull_request?.title,
        author: payload.pull_request?.user?.login,
        head_sha: headSha,
        base_sha: payload.pull_request?.base?.sha,
        draft: payload.pull_request?.draft,
        url: pullRequestLinks(
          config.github,
          repo,
          pullNumber,
          String(payload.pull_request?.html_url ?? `https://github.com/${repo}/pull/${pullNumber}`),
        ).primary_url,
        links: pullRequestLinks(
          config.github,
          repo,
          pullNumber,
          String(payload.pull_request?.html_url ?? `https://github.com/${repo}/pull/${pullNumber}`),
        ),
      });
      return reply.code(202).send({ accepted: true, task_id: task.id });
    },
  );

  app.post("/hire", async (req, reply) => {
    const body = z.object({ role: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "role required" });
    return hire(body.data.role, takenNames({ db, registry }));
  });

  app.post("/hire/confirm", async (req, reply) => {
    const body = z
      .object({
        draft: InternManifestSchema,
        icon: z.string().default("default"),
        required_capabilities: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })).default([]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid draft", detail: body.error.issues });
    let hired: ReturnType<typeof confirmHire>;
    try {
      hired = confirmHire(body.data.draft, body.data.icon, { db, registry }, body.data.required_capabilities);
    } catch (err) {
      if (err instanceof NameTakenError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    const requests = body.data.required_capabilities.map((requirement) => capabilities.request(hired.slug, requirement));
    try {
      await discord?.ensureInternChannel(hired.slug, hired.manifest);
    } catch (err) {
      // Hiring is the source-of-truth write; Discord is a repairable renderer.
      // Startup reconciliation will retry if Discord is temporarily unavailable.
      console.error(`[api] discord provisioning for ${hired.slug} failed:`, err);
    }
    return { ...hired, capability_requests: requests };
  });

  // Web Push (iOS 16.4+ requires the PWA installed to the home screen — see
  // app/README.md). Subscriptions are keyed by endpoint, one row per browser
  // install; JP is single-user so there is no per-subscription ownership check.
  app.get("/push/key", async () => {
    return { vapid_public: push.vapidPublicKey };
  });

  app.get("/push/status", async () => push.status());

  app.post("/push/test", async () => {
    return push.notify({
      title: "Interns notifications are working",
      body: "This is a delivery test from your orchestrator.",
      url: "/settings?tab=notifications",
      tag: "interns-push-test",
    });
  });

  const PushSubscriptionBodySchema = z.object({
    endpoint: z.string().min(1),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    expirationTime: z.number().nullable().optional(),
  });

  app.post("/push/subscribe", async (req, reply) => {
    const body = PushSubscriptionBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid subscription", detail: body.error.issues });
    push.subscribe(body.data);
    return reply.code(204).send();
  });

  app.post("/push/unsubscribe", async (req, reply) => {
    const body = z.object({ endpoint: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "endpoint required" });
    push.unsubscribe(body.data.endpoint);
    return reply.code(204).send();
  });

  // SSE: new messages/cards plus task changes so Crew's activity is genuinely live.
  app.get("/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // raw writeHead bypasses the reply object @fastify/cors decorates —
      // without these the browser discards the stream ("Load failed").
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      Vary: "Origin",
    });
    reply.raw.write(": connected\n\n");
    const write = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const offs = [
      bus.on("message", (m) => write("message", m)),
      bus.on("card", (c) => write("card", c)),
      bus.on("card_state", (c) => write("card_state", c)),
      bus.on("task_state", (t) => write("task_state", taskActivity(t))),
      bus.on("room", (r) => write("room", r)),
      bus.on("page", (p) => write("page", { id: p.id, version: p.version, intern: p.intern, thread_key: p.thread_key, pinned: p.pinned, archived: Boolean(p.archived_at) })),
      bus.on("rule", (r) => write("rule", r)),
      bus.on("agenda", (date) => write("agenda", { date })),
    ];
    const keepalive = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(keepalive);
      for (const off of offs) off();
    });
    // hold the connection open — fastify must not try to serialize a body
    await new Promise(() => {});
  });

  // Serve the built app (app/dist) from the same origin as the API — no CORS,
  // no second server. Deep links get their route's own pre-rendered page
  // (appshell.ts): hydrating another route's HTML fails with React #418.
  if (servesApp) {
    const fastifyStatic = (await import("@fastify/static")).default;
    // wildcard route (default) resolves files per-request — a re-exported dist/
    // (new content-hashed bundles) is served without restarting the orchestrator.
    await app.register(fastifyStatic, { root: appDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !isApiPath(req.url)) {
        const page = resolvePage(appDist, req.url);
        return reply
          .code(page ? 200 : 404)
          .type("text/html")
          .sendFile(page ?? notFoundPage(appDist));
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  // Fastify allows a single listen(); binding one non-loopback address silently
  // broke intern-card (it dials 127.0.0.1) — every card an intern raised failed
  // for 24h. "0.0.0.0" covers loopback AND the tailnet; the bearer token is the
  // access control, and the box is not exposed beyond the tailnet anyway.
  const host = config.bind === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
  await app.listen({ port: config.port, host });
  return app;
}
