/**
 * Canonical zod schemas + TS types for the Interns orchestrator.
 * These are the single source of truth for manifest/card/message/task shapes;
 * SQLite rows and YAML files are (de)serialized through them.
 */
import { StyleSchema } from "./style.js";
import { z } from "zod";

// ---------------------------------------------------------------- manifests

export const TriggersSchema = z.object({
  /** run when a Graph mail push notification arrives (stubbed for now) */
  mail_push: z.boolean().optional(),
  /** 5-field cron expression, e.g. "0 7 * * 1-5" */
  cron: z.string().optional(),
  /** other interns' @mentions wake this intern (default on); the owner's own @mentions always do */
  mentions: z.boolean().optional(),
  /** run a short pre-meeting rundown when a calendar event is about to start (see meetingwatch.ts) */
  meeting_brief: z.boolean().optional(),
});

export const GuardrailsSchema = z.object({
  /** anything outbound to other humans is drafts-only (human-gated via cards) */
  drafts_only: z.boolean().default(true),
  /** per-day token budget (input+output); engine refuses to start beyond it */
  daily_token_cap: z.number().int().positive().default(200_000),
});

/**
 * How much of an intern reaches JP's lock screen:
 *  all       — every message and card, straight away
 *  needs_you — replies to JP, questions and decisions now; the rest in the next summary
 *  summary   — everything in the summary (urgent still buzzes)
 *  off       — nothing (still in the app; urgent still buzzes)
 */
export const NotifyLevelSchema = z.enum(["all", "needs_you", "summary", "off"]);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;

export const InternManifestSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  /** avatar id — resolved against config.discord.avatar_base_url */
  icon: z.string().default("default"),
  /** voice / personality notes, prepended to the system prompt */
  persona: z.string().default(""),
  system_prompt: z.string().min(1),
  /** tool catalog names (see TOOL_CATALOG in engine.ts), not raw SDK tool names */
  tools: z.array(z.string()).default([]),
  triggers: TriggersSchema.default({}),
  /** standing idle work, plain-text items, FIFO for now */
  backlog: z.array(z.string()).default([]),
  guardrails: GuardrailsSchema.default({ drafts_only: true, daily_token_cap: 200_000 }),
  /** JP paused them: no schedule, backlog, mail, meetings, reviews or routing; direct messages still reach them */
  paused: z.boolean().optional(),
  /** Outlook mailboxes this intern may use (ids from config.mailboxes); unset = all of them */
  mailboxes: z.array(z.string()).optional(),
  /** personality dials (style.ts); unset = all in the middle */
  style: StyleSchema.optional(),
  /** what buzzes JP's phone (push.ts); unset = "needs_you" */
  notify: NotifyLevelSchema.optional(),
});
export type InternManifest = z.infer<typeof InternManifestSchema>;
export type Triggers = z.infer<typeof TriggersSchema>;
export type Guardrails = z.infer<typeof GuardrailsSchema>;

// ------------------------------------------------------------ capabilities

export const CapabilityRequirementSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  reason: z.string().min(1),
});
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

export const CapabilityStatusSchema = z.enum([
  "requested",
  "approved",
  "building",
  "testing",
  "ready",
  "active",
  "rejected",
  "failed",
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityRequestSchema = z.object({
  id: z.string(),
  intern: z.string(),
  capability: z.string(),
  description: z.string(),
  status: CapabilityStatusSchema,
  spec: z.record(z.string(), z.unknown()).default({}),
  card_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  error: z.string().nullable().default(null),
});
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

export const ApprovalJobKindSchema = z.enum([
  "capability.approve",
  "capability.activate",
  "github.publish_review",
]);
export type ApprovalJobKind = z.infer<typeof ApprovalJobKindSchema>;
export const ApprovalJobStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type ApprovalJobStatus = z.infer<typeof ApprovalJobStatusSchema>;

export const ApprovalJobSchema = z.object({
  id: z.string(),
  card_id: z.string(),
  action_id: z.string(),
  kind: ApprovalJobKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  status: ApprovalJobStatusSchema,
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ApprovalJob = z.infer<typeof ApprovalJobSchema>;

// -------------------------------------------------------------------- cards

export const CardSeveritySchema = z.enum(["info", "action", "urgent"]);
export const CardStateSchema = z.enum(["open", "resolved", "snoozed", "expired"]);

export const CardActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  style: z.enum(["primary", "success", "neutral"]).default("neutral"),
  /** button = plain click; date/text = surface opens a modal and passes a note */
  kind: z.enum(["button", "date", "text"]).default("button"),
});
export type CardAction = z.infer<typeof CardActionSchema>;

export const CardResolutionSchema = z.object({
  via: z.enum(["app", "discord"]),
  /** the action id that resolved the card */
  action: z.string(),
  note: z.string().optional(),
});
export type CardResolution = z.infer<typeof CardResolutionSchema>;

export const CardSchema = z.object({
  id: z.string(),
  /** intern slug; "coordinator" for orchestrator-emitted cards */
  intern: z.string(),
  title: z.string(),
  /** markdown */
  body: z.string(),
  severity: CardSeveritySchema,
  state: CardStateSchema,
  actions: z.array(CardActionSchema).default([]),
  /** Surface-specific structured data; e.g. a GitHub review summary. */
  context: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(), // ISO 8601
  updated_at: z.string(),
  resolved_at: z.string().nullable().default(null),
  snoozed_until: z.string().nullable().default(null),
  resolution: CardResolutionSchema.nullable().default(null),
  /** set by the Discord adapter so it can edit the embed in place */
  discord_message_id: z.string().nullable().default(null),
});
export type Card = z.infer<typeof CardSchema>;
export type CardSeverity = z.infer<typeof CardSeveritySchema>;
export type CardState = z.infer<typeof CardStateSchema>;

// -------------------------------------------------------------- attachments

/**
 * A file exchanged in a thread: JP uploads from the app, interns upload via
 * the intern-attach CLI. Bytes live on disk under ~/.interns/<slug>/attachments;
 * this row is the metadata surfaces render from. `kind` is derived from the
 * MIME type so renderers pick a viewer without sniffing.
 */
export const AttachmentKindSchema = z.enum(["image", "svg", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  intern: z.string(),
  /** null until linked to a message (JP: on send; intern: when its reply lands) */
  message_id: z.string().nullable().default(null),
  author: z.enum(["jp", "intern", "coordinator"]),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: AttachmentKindSchema,
  /** sha256 hex of the bytes */
  sha256: z.string(),
  /** on-disk extension (the file is <id>.<ext> in the intern's attachments dir) */
  ext: z.string(),
  /** optional caption/alt text supplied by the uploader */
  caption: z.string().nullable().default(null),
  /** image pixel size when known (header sniff) */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  created_at: z.string(),
  /** app-relative download URL carrying its own signature (attachments.ts) */
  url: z.string().default(""),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// ----------------------------------------------------------------- messages

export const MessageSchema = z.object({
  id: z.string(),
  /** thread key: an intern slug (JP's 1:1 thread) or a room id (`room-…`, group chat) */
  intern: z.string(),
  author: z.enum(["jp", "intern", "coordinator"]),
  /** which intern spoke, when author is "intern" — differs from `intern` in rooms and handoffs */
  speaker: z.string().nullable().default(null),
  /** the message this one answers (threads inside rooms; set automatically for routed replies) */
  reply_to: z.string().nullable().default(null),
  /** pinned by JP: shown in the thread's pinned bar */
  pinned: z.coerce.boolean().default(false),
  text: z.string(),
  ts: z.string(), // ISO 8601
  surface: z.enum(["app", "discord", "system"]),
  attachments: z.array(AttachmentSchema).default([]),
  /** why an intern spoke: answering JP ("reply"), asking him something ("ask"), or on its own ("work") — drives notifications */
  cause: z.enum(["reply", "ask", "work"]).nullable().default(null),
});

// -------------------------------------------------------------------- rooms

/** A group chat: JP plus a set of interns. Messages use the room id as their thread key. */
export const RoomSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** intern slugs */
  members: z.array(z.string()).default([]),
  /** optional standing brief shown to every member with each message */
  topic: z.string().default(""),
  /** shared scratchpad (markdown): JP edits it in the app, interns via tools/room-pad; pinned above the thread */
  scratchpad: z.string().default(""),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable().default(null),
});
export type Room = z.infer<typeof RoomSchema>;
export type Message = z.infer<typeof MessageSchema>;

// -------------------------------------------------------------------- tasks

export const TaskKindSchema = z.enum(["trigger", "scheduled", "backlog", "message"]);
export const TaskStatusSchema = z.enum(["queued", "running", "paused", "done", "failed", "cancelled"]);

export const TaskSchema = z.object({
  id: z.string(),
  intern: z.string(),
  kind: TaskKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  status: TaskStatusSchema,
  priority: z.number().int().default(0),
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// -------------------------------------------------------------------- pages

/**
 * A page is a structured view an intern keeps up to date and shows JP in a
 * chat (docs/features/02-pages.md). The intern owns the facts; JP changes a
 * page by talking to its owner. `data` is validated per kind on every write.
 */
export const PageKindSchema = z.enum(["people", "board", "table", "list", "draft"]);
export type PageKind = z.infer<typeof PageKindSchema>;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "date as YYYY-MM-DD");
const itemId = z.string().min(1).max(80);

export const PersonSchema = z.object({
  id: itemId,
  name: z.string().min(1),
  company: z.string().optional(),
  email: z.string().optional(),
  tags: z.array(z.string()).default([]),
  how_met: z.string().optional(),
  last_touch: ymd.optional(),
  next_follow_up: ymd.optional(),
  stage: z.string().optional(),
  notes: z.string().optional(),
  timeline: z
    .array(z.object({ ts: z.string(), kind: z.enum(["mail", "meeting", "chat", "note"]), text: z.string(), ref: z.string().optional() }))
    .optional(),
});
export const PeopleDataSchema = z.object({ people: z.array(PersonSchema).default([]) });

export const BoardDataSchema = z
  .object({
    columns: z.array(z.object({ id: itemId, title: z.string().min(1) })).min(1),
    items: z
      .array(
        z.object({
          id: itemId,
          column: z.string().min(1),
          title: z.string().min(1),
          subtitle: z.string().optional(),
          due: ymd.optional(),
          person_id: z.string().optional(),
        }),
      )
      .default([]),
  })
  .refine((b) => b.items.every((i) => b.columns.some((c) => c.id === i.column)), "every item.column must be a column id");

export const TableDataSchema = z
  .object({
    columns: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), icon: z.boolean().optional() })).min(1),
    rows: z.array(z.object({ id: itemId }).catchall(z.union([z.string(), z.number(), z.null()]))).default([]),
  });

export const ListDataSchema = z.object({
  items: z
    .array(
      z.object({
        id: itemId,
        text: z.string().min(1),
        done: z.boolean().optional(),
        tags: z.array(z.string()).default([]),
        ts: z.string(),
        source: z.object({ thread_key: z.string(), message_id: z.string() }).optional(),
      }),
    )
    .default([]),
});

export const DraftDataSchema = z.object({
  draft_id: z.string().min(1),
  /** a `config.mailboxes` id */
  mailbox: z.string().min(1),
  kind: z.enum(["reply_all", "reply", "new"]),
  intended_reply: z.boolean(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
  thread: z.array(z.object({ from: z.string(), date: z.string().nullable().optional(), preview: z.string() })).default([]),
  web_link: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  in_reply_to: z.string().nullable().optional(),
});

export const PAGE_DATA_SCHEMAS = {
  people: PeopleDataSchema,
  board: BoardDataSchema,
  table: TableDataSchema,
  list: ListDataSchema,
  draft: DraftDataSchema,
} as const;

/** The array inside `data` that holds a kind's items (null: the kind has no items). */
export const PAGE_ITEM_FIELD: Record<PageKind, "people" | "items" | "rows" | null> = {
  people: "people",
  board: "items",
  table: "rows",
  list: "items",
  draft: null,
};

export const PageSchema = z.object({
  id: z.string(),
  intern: z.string(),
  thread_key: z.string(),
  kind: PageKindSchema,
  title: z.string(),
  summary: z.string().default(""),
  version: z.number().int().positive(),
  pinned: z.coerce.boolean().default(false),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable().default(null),
});
export type Page = z.infer<typeof PageSchema>;

// ------------------------------------------------------------------- rules

/**
 * Standing orders (docs/features/04-standing-orders.md). Hard rules are
 * enforced by the orchestrator before work reaches the intern; soft rules
 * ride along in the intern's system prompt.
 */
export const RuleTypeSchema = z.enum(["mute_repo", "mute_sender", "quiet_hours", "hold_until", "guidance"]);
export type RuleType = z.infer<typeof RuleTypeSchema>;

export const RULE_PARAMS_SCHEMAS = {
  mute_repo: z.object({ repo: z.string().min(1) }),
  mute_sender: z
    .object({ address: z.string().min(3).optional(), domain: z.string().min(3).optional() })
    .refine((p) => Boolean(p.address || p.domain), "mute_sender needs address or domain"),
  quiet_hours: z.object({
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    /** IANA zone; omitted = the owner's `timezone` */
    tz: z.string().optional(),
  }),
  hold_until: z.object({ match: z.string().min(2), until: ymd }),
  guidance: z.object({}).passthrough(),
} as const;

export const RuleSchema = z.object({
  id: z.string(),
  intern: z.string(),
  kind: z.enum(["hard", "soft"]),
  type: RuleTypeSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  text: z.string(),
  enabled: z.coerce.boolean(),
  hits: z.number().int().nonnegative().default(0),
  last_hit_at: z.string().nullable().default(null),
  created_from_message: z.string().nullable().default(null),
  created_at: z.string(),
  removed_at: z.string().nullable().default(null),
});
export type Rule = z.infer<typeof RuleSchema>;

// -------------------------------------------------------------------- spend

export interface SpendRow {
  intern: string;
  /** YYYY-MM-DD (UTC) */
  day: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// -------------------------------------------------------------------- misc

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "intern";
}
