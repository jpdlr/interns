/**
 * SQLite state at ~/.interns/interns.db (WAL). Migrations run at open.
 * All writes that surfaces care about are emitted on the EventBus by the
 * accessors here, so renderers never poll.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachmentUrl } from "./attachments.js";
import { internsHome } from "./config.js";
import type { EventBus } from "./events.js";
import {
  Attachment,
  AttachmentSchema,
  Card,
  CardAction,
  CardResolution,
  CardSchema,
  CardSeverity,
  CardState,
  Message,
  MessageSchema,
  nowIso,
  Room,
  RoomSchema,
  SpendRow,
  Task,
  TaskKind,
  TaskSchema,
  TaskStatus,
  todayUtc,
  ApprovalJob,
  ApprovalJobKind,
  ApprovalJobSchema,
  CapabilityRequest,
  CapabilityRequestSchema,
  CapabilityStatus,
  Page,
  PageKind,
  PageSchema,
  Rule,
  RuleSchema,
  RuleType,
} from "./types.js";

/** The passive "I've read it" action every information card can be resolved with. */
export const SEEN_ACTION: CardAction = { id: "seen", label: "Seen", style: "primary", kind: "button" };
/** Task error that marks work set aside at the daily token limit (status paused). */
export const OVER_BUDGET = "over daily budget";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS interns (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'default',
    session_id TEXT,
    discord_channel_id TEXT,
    discord_webhook_url TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('jp','intern','coordinator')),
    text TEXT NOT NULL,
    ts TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('app','discord','system'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_intern_ts ON messages(intern, ts);
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','action','urgent')),
    state TEXT NOT NULL CHECK (state IN ('open','resolved','snoozed','expired')),
    actions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    snoozed_until TEXT,
    resolution TEXT,
    discord_message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trigger','scheduled','backlog','message')),
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(intern, status);
  CREATE TABLE IF NOT EXISTS spend (
    intern TEXT NOT NULL,
    day TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (intern, day)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS capability_requests (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    capability TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested','approved','building','testing','ready','active','rejected','failed')),
    spec TEXT NOT NULL DEFAULT '{}',
    card_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_capability_requests_status ON capability_requests(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_requests_open
    ON capability_requests(intern, capability)
    WHERE status NOT IN ('active','rejected','failed');

  CREATE TABLE IF NOT EXISTS approval_jobs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('capability.approve','capability.activate','github.publish_review')),
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(card_id, action_id)
  );

  CREATE TABLE IF NOT EXISTS github_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_pr_state (
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repository, pull_number)
  );
  `,
  // Kept as a separate idempotent migration because capability development may
  // have already advanced user_version before the polling fallback was added.
  `
  CREATE TABLE IF NOT EXISTS github_pr_state (
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repository, pull_number)
  );
  `,
  `
  ALTER TABLE cards ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
  `,
  `
  DROP INDEX IF EXISTS idx_tasks_status;
  ALTER TABLE tasks RENAME TO tasks_before_controls;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trigger','scheduled','backlog','message')),
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed','cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT
  );
  INSERT INTO tasks (id, intern, kind, payload, status, priority, created_at, started_at, finished_at, error)
    SELECT id, intern, kind, payload, status, 0, created_at, started_at, finished_at, error FROM tasks_before_controls;
  DROP TABLE tasks_before_controls;
  CREATE INDEX idx_tasks_status ON tasks(intern, status, priority, created_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    message_id TEXT,
    author TEXT NOT NULL CHECK (author IN ('jp','intern','coordinator')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image','svg','file')),
    sha256 TEXT NOT NULL,
    ext TEXT NOT NULL,
    caption TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_intern_created ON attachments(intern, created_at);
  `,
  `
  ALTER TABLE messages ADD COLUMN reply_to TEXT;
  CREATE TABLE IF NOT EXISTS run_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    day TEXT NOT NULL,
    intern TEXT NOT NULL,
    thread TEXT,
    task_id TEXT,
    kind TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_run_spend_day ON run_spend(day);
  CREATE INDEX IF NOT EXISTS idx_run_spend_thread ON run_spend(thread, day);
  `,
  `
  ALTER TABLE messages ADD COLUMN speaker TEXT;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    members TEXT NOT NULL DEFAULT '[]',
    topic TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rooms ADD COLUMN scratchpad TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(intern, pinned);
  `,
  // Pages, standing orders, the Today agenda and the coordinator's front desk
  // (docs/features). announcements queue fences a tool asked to show in the
  // intern's next reply, the same way attachments wait for theirs.
  `
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('people','board','table','list','draft')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pages_intern ON pages(intern, updated_at);
  CREATE INDEX IF NOT EXISTS idx_pages_thread ON pages(thread_key, updated_at);
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    intern TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('hard','soft')),
    type TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at TEXT,
    created_from_message TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rules_intern ON rules(intern, removed_at);
  CREATE TABLE IF NOT EXISTS rule_hits (
    rule_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rule_hits ON rule_hits(rule_id, ts);
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intern TEXT NOT NULL,
    fence TEXT NOT NULL,
    page_id TEXT,
    created_at TEXT NOT NULL,
    message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_announcements_pending ON announcements(intern, message_id);
  CREATE TABLE IF NOT EXISTS meeting_briefs (
    event_id TEXT NOT NULL,
    intern TEXT NOT NULL,
    event TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    task_id TEXT,
    message_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, intern)
  );
  CREATE INDEX IF NOT EXISTS idx_meeting_briefs_task ON meeting_briefs(task_id);
  CREATE TABLE IF NOT EXISTS debriefs (
    event_id TEXT NOT NULL,
    intern TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('asked','answered','skipped')),
    message_id TEXT,
    event TEXT NOT NULL,
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    PRIMARY KEY (event_id, intern)
  );
  CREATE INDEX IF NOT EXISTS idx_debriefs_message ON debriefs(message_id);
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

interface PageRow {
  id: string;
  intern: string;
  thread_key: string;
  kind: string;
  title: string;
  summary: string;
  data: string;
  version: number;
  pinned: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function rowToPage(row: PageRow): Page {
  return PageSchema.parse({ ...row, data: JSON.parse(row.data) as Record<string, unknown> });
}

interface RuleRow {
  id: string;
  intern: string;
  kind: string;
  type: string;
  params: string;
  text: string;
  enabled: number;
  hits: number;
  last_hit_at: string | null;
  created_from_message: string | null;
  created_at: string;
  removed_at: string | null;
}

function rowToRule(row: RuleRow): Rule {
  return RuleSchema.parse({ ...row, params: JSON.parse(row.params) as Record<string, unknown> });
}

export interface MeetingBriefRow {
  event_id: string;
  intern: string;
  event: Record<string, unknown>;
  start_at: string;
  end_at: string;
  task_id: string | null;
  message_id: string | null;
  created_at: string;
}

export interface DebriefRow {
  event_id: string;
  intern: string;
  state: "asked" | "answered" | "skipped";
  message_id: string | null;
  event: Record<string, unknown>;
  asked_at: string;
  answered_at: string | null;
}

interface CardRow {
  id: string;
  intern: string;
  title: string;
  body: string;
  severity: string;
  state: string;
  actions: string;
  context: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  snoozed_until: string | null;
  resolution: string | null;
  discord_message_id: string | null;
}

interface TaskRow {
  id: string;
  intern: string;
  kind: string;
  payload: string;
  status: string;
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface CapabilityRequestRow {
  id: string;
  intern: string;
  capability: string;
  description: string;
  status: string;
  spec: string;
  card_id: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface ApprovalJobRow {
  id: string;
  card_id: string;
  action_id: string;
  kind: string;
  payload: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface InternRow {
  slug: string;
  name: string;
  role: string;
  icon: string;
  session_id: string | null;
  discord_channel_id: string | null;
  discord_webhook_url: string | null;
  created_at: string;
  archived_at: string | null;
}

function rowToCard(row: CardRow): Card {
  return CardSchema.parse({
    ...row,
    actions: JSON.parse(row.actions) as CardAction[],
    context: row.context ? JSON.parse(row.context) : {},
    resolution: row.resolution ? (JSON.parse(row.resolution) as CardResolution) : null,
  });
}

function rowToTask(row: TaskRow): Task {
  return TaskSchema.parse({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> });
}

function rowToCapabilityRequest(row: CapabilityRequestRow): CapabilityRequest {
  return CapabilityRequestSchema.parse({ ...row, spec: JSON.parse(row.spec) });
}

function rowToApprovalJob(row: ApprovalJobRow): ApprovalJob {
  return ApprovalJobSchema.parse({
    ...row,
    payload: JSON.parse(row.payload),
    result: row.result ? JSON.parse(row.result) : null,
  });
}

interface AttachmentRow {
  id: string;
  intern: string;
  message_id: string | null;
  author: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  sha256: string;
  ext: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export class Db {
  readonly sqlite: Database.Database;
  /** Set by index.ts once config is loaded; attachments carry signed URLs derived from it. */
  apiToken = "";

  constructor(private bus: EventBus, baseDir: string = internsHome()) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.sqlite = new Database(path.join(baseDir, "interns.db"));
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const version = this.sqlite.pragma("user_version", { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.sqlite.exec(MIGRATIONS[i]!);
      this.sqlite.pragma(`user_version = ${i + 1}`);
    }
  }

  close(): void {
    this.sqlite.close();
  }

  // ------------------------------------------------------------- interns

  upsertIntern(row: Pick<InternRow, "slug" | "name" | "role" | "icon">): void {
    this.sqlite
      .prepare(
        `INSERT INTO interns (slug, name, role, icon, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name=excluded.name, role=excluded.role, icon=excluded.icon, archived_at=NULL`,
      )
      .run(row.slug, row.name, row.role, row.icon, nowIso());
  }

  getIntern(slug: string): InternRow | undefined {
    return this.sqlite.prepare("SELECT * FROM interns WHERE slug = ?").get(slug) as InternRow | undefined;
  }

  listInterns(includeArchived = false): InternRow[] {
    const sql = includeArchived
      ? "SELECT * FROM interns ORDER BY created_at"
      : "SELECT * FROM interns WHERE archived_at IS NULL ORDER BY created_at";
    return this.sqlite.prepare(sql).all() as InternRow[];
  }

  archiveIntern(slug: string): void {
    this.sqlite.prepare("UPDATE interns SET archived_at = ? WHERE slug = ?").run(nowIso(), slug);
  }

  setSessionId(slug: string, sessionId: string): void {
    this.sqlite.prepare("UPDATE interns SET session_id = ? WHERE slug = ?").run(sessionId, slug);
  }

  getSessionId(slug: string): string | null {
    return this.getIntern(slug)?.session_id ?? null;
  }

  setDiscordBinding(slug: string, channelId: string, webhookUrl: string): void {
    this.sqlite
      .prepare("UPDATE interns SET discord_channel_id = ?, discord_webhook_url = ? WHERE slug = ?")
      .run(channelId, webhookUrl, slug);
  }

  // ------------------------------------------------------------ messages

  /**
   * Record a message. `attachmentIds` links already-uploaded attachments to
   * it (JP's uploads from the app); they must belong to the same intern and
   * be unlinked. The emitted event carries the hydrated attachments so both
   * surfaces can render them without a second fetch.
   */
  addMessage(
    input: Omit<Message, "id" | "ts" | "attachments" | "speaker" | "reply_to" | "pinned"> & { id?: string; ts?: string; speaker?: string | null; reply_to?: string | null; attachmentIds?: string[] },
  ): Message {
    const { attachmentIds = [], ...rest } = input;
    // A caller may pick the id up front so things that belong to the message
    // (queued page/rule chips) can be claimed for it before it is emitted.
    const id = rest.id ?? randomUUID();
    const ts = rest.ts ?? nowIso();
    this.sqlite
      .prepare("INSERT INTO messages (id, intern, author, speaker, reply_to, text, ts, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, rest.intern, rest.author, rest.speaker ?? null, rest.reply_to ?? null, rest.text, ts, rest.surface);
    if (attachmentIds.length) this.linkAttachments(rest.intern, attachmentIds, id);
    const msg = this.getMessage(id)!;
    this.bus.emit("message", msg);
    return msg;
  }

  getMessage(id: string): Message | undefined {
    const row = this.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Omit<Message, "attachments"> | undefined;
    if (!row) return undefined;
    return MessageSchema.parse({ ...row, attachments: this.attachmentsForMessages([id]).get(id) ?? [] });
  }

  listMessages(intern: string, limit = 100): Message[] {
    const rows = (
      this.sqlite
        .prepare("SELECT * FROM messages WHERE intern = ? ORDER BY ts DESC LIMIT ?")
        .all(intern, limit) as Omit<Message, "attachments">[]
    ).reverse();
    const byMessage = this.attachmentsForMessages(rows.map((r) => r.id));
    return rows.map((r) => MessageSchema.parse({ ...r, attachments: byMessage.get(r.id) ?? [] }));
  }

  // --------------------------------------------------------------- rooms

  createRoom(input: { name: string; members: string[]; topic?: string }): Room {
    const now = nowIso();
    const room = RoomSchema.parse({
      id: `room-${randomUUID()}`,
      name: input.name.trim(),
      members: [...new Set(input.members)],
      topic: input.topic ?? "",
      created_at: now,
      updated_at: now,
      archived_at: null,
    });
    this.sqlite
      .prepare("INSERT INTO rooms (id, name, members, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(room.id, room.name, JSON.stringify(room.members), room.topic, now, now);
    return room;
  }

  getRoom(id: string): Room | undefined {
    const row = this.sqlite.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as (Omit<Room, "members"> & { members: string }) | undefined;
    return row ? RoomSchema.parse({ ...row, members: JSON.parse(row.members) }) : undefined;
  }

  listRooms(includeArchived = false): Room[] {
    const rows = this.sqlite
      .prepare(includeArchived ? "SELECT * FROM rooms ORDER BY updated_at DESC" : "SELECT * FROM rooms WHERE archived_at IS NULL ORDER BY updated_at DESC")
      .all() as (Omit<Room, "members"> & { members: string })[];
    return rows.map((row) => RoomSchema.parse({ ...row, members: JSON.parse(row.members) }));
  }

  updateRoom(id: string, patch: { name?: string; members?: string[]; topic?: string; scratchpad?: string }): Room | undefined {
    const existing = this.getRoom(id);
    if (!existing) return undefined;
    const next = {
      name: patch.name?.trim() || existing.name,
      members: patch.members ? [...new Set(patch.members)] : existing.members,
      topic: patch.topic ?? existing.topic,
      scratchpad: patch.scratchpad ?? existing.scratchpad,
    };
    this.sqlite
      .prepare("UPDATE rooms SET name = ?, members = ?, topic = ?, scratchpad = ?, updated_at = ? WHERE id = ?")
      .run(next.name, JSON.stringify(next.members), next.topic, next.scratchpad, nowIso(), id);
    const room = this.getRoom(id);
    if (room) this.bus.emit("room", room);
    return room;
  }

  archiveRoom(id: string): boolean {
    return this.sqlite.prepare("UPDATE rooms SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(nowIso(), nowIso(), id).changes === 1;
  }

  /** Bump updated_at so the room sorts to the top of the list when it gets a message. */
  touchRoom(id: string): void {
    this.sqlite.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  // --------------------------------------------------------- attachments

  private rowToAttachment(row: AttachmentRow): Attachment {
    return AttachmentSchema.parse({ ...row, url: attachmentUrl(this.apiToken, row.id) });
  }

  createAttachment(input: {
    intern: string;
    author: Attachment["author"];
    name: string;
    mime: string;
    size: number;
    kind: Attachment["kind"];
    sha256: string;
    ext: string;
    caption?: string | null;
    width?: number | null;
    height?: number | null;
    /** caller-chosen id so the file can be written under it before the row exists */
    id?: string;
  }): Attachment {
    const id = input.id ?? randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO attachments (id, intern, message_id, author, name, mime, size, kind, sha256, ext, caption, width, height, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.intern,
        input.author,
        input.name,
        input.mime,
        input.size,
        input.kind,
        input.sha256,
        input.ext,
        input.caption ?? null,
        input.width ?? null,
        input.height ?? null,
        nowIso(),
      );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): Attachment | undefined {
    const row = this.sqlite.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row ? this.rowToAttachment(row) : undefined;
  }

  /** Newest first; the app's per-intern "Files" view. */
  listAttachments(intern: string, limit = 200): Attachment[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM attachments WHERE intern = ? ORDER BY created_at DESC LIMIT ?")
      .all(intern, Math.max(1, Math.min(limit, 1000))) as AttachmentRow[];
    return rows.map((r) => this.rowToAttachment(r));
  }

  private attachmentsForMessages(messageIds: string[]): Map<string, Attachment[]> {
    const out = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return out;
    // SQLite caps bound parameters; chunk to stay well under it.
    for (let i = 0; i < messageIds.length; i += 400) {
      const chunk = messageIds.slice(i, i + 400);
      const rows = this.sqlite
        .prepare(`SELECT * FROM attachments WHERE message_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(...chunk) as AttachmentRow[];
      for (const row of rows) {
        const list = out.get(row.message_id!) ?? [];
        list.push(this.rowToAttachment(row));
        out.set(row.message_id!, list);
      }
    }
    return out;
  }

  /**
   * Attach uploaded files to a message. Only unlinked attachments of the same
   * intern qualify — an id that is unknown, foreign, or already used is
   * silently skipped rather than re-parented. Returns the number linked.
   */
  linkAttachments(intern: string, ids: string[], messageId: string): number {
    const stmt = this.sqlite.prepare(
      "UPDATE attachments SET message_id = ? WHERE id = ? AND intern = ? AND message_id IS NULL",
    );
    let linked = 0;
    for (const id of ids) linked += stmt.run(messageId, id, intern).changes;
    return linked;
  }

  /**
   * Intern-side linking: the intern-attach CLI cannot know the id of the
   * reply message that does not exist yet, so anything the intern uploaded
   * since its task started and left unlinked belongs to that reply.
   */
  linkOrphanInternAttachments(intern: string, sinceIso: string, messageId: string): Attachment[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM attachments WHERE intern = ? AND author = 'intern' AND message_id IS NULL AND created_at >= ?
         ORDER BY created_at ASC`,
      )
      .all(intern, sinceIso) as AttachmentRow[];
    if (rows.length === 0) return [];
    const stmt = this.sqlite.prepare("UPDATE attachments SET message_id = ? WHERE id = ?");
    for (const row of rows) stmt.run(messageId, row.id);
    return rows.map((r) => this.rowToAttachment({ ...r, message_id: messageId }));
  }

  /** Pin/unpin; the message is re-emitted so open threads update their pinned bar. */
  setPinned(id: string, pinned: boolean): Message | undefined {
    this.sqlite.prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    const msg = this.getMessage(id);
    if (msg) this.bus.emit("message", msg);
    return msg;
  }

  listPinned(thread: string): Message[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM messages WHERE intern = ? AND pinned = 1 ORDER BY ts ASC")
      .all(thread) as Omit<Message, "attachments">[];
    const byMessage = this.attachmentsForMessages(rows.map((r) => r.id));
    return rows.map((r) => MessageSchema.parse({ ...r, attachments: byMessage.get(r.id) ?? [] }));
  }

  /** Re-emit a message after its attachment set changed (renderers replace by id). */
  emitMessage(id: string): void {
    const msg = this.getMessage(id);
    if (msg) this.bus.emit("message", msg);
  }

  // --------------------------------------------------------------- cards

  createCard(input: {
    intern: string;
    title: string;
    body: string;
    severity?: CardSeverity;
    actions?: CardAction[];
    context?: Record<string, unknown>;
  }): Card {
    const now = nowIso();
    const severity = input.severity ?? "info";
    // An information card with nothing to decide still needs a way off the
    // list: it gets a single "Seen" (docs/features/03-today.md).
    const actions = input.actions?.length ? input.actions : severity === "info" ? [SEEN_ACTION] : [];
    const card = CardSchema.parse({
      id: randomUUID(),
      intern: input.intern,
      title: input.title,
      body: input.body,
      severity,
      state: "open",
      actions,
      context: input.context ?? {},
      created_at: now,
      updated_at: now,
    });
    this.sqlite
      .prepare(
        `INSERT INTO cards (id, intern, title, body, severity, state, actions, context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.id,
        card.intern,
        card.title,
        card.body,
        card.severity,
        card.state,
        JSON.stringify(card.actions),
        JSON.stringify(card.context),
        card.created_at,
        card.updated_at,
      );
    this.bus.emit("card", card);
    return card;
  }

  getCard(id: string): Card | undefined {
    const row = this.sqlite.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
    return row ? rowToCard(row) : undefined;
  }

  listCards(state?: CardState): Card[] {
    const rows = (
      state
        ? this.sqlite.prepare("SELECT * FROM cards WHERE state = ? ORDER BY created_at DESC").all(state)
        : this.sqlite.prepare("SELECT * FROM cards ORDER BY created_at DESC").all()
    ) as CardRow[];
    return rows.map(rowToCard);
  }

  setCardDiscordMessage(id: string, messageId: string): void {
    this.sqlite.prepare("UPDATE cards SET discord_message_id = ? WHERE id = ?").run(messageId, id);
  }

  /** Apply an action to a card; returns the updated card or undefined if unknown. */
  resolveCard(
    id: string,
    resolution: CardResolution,
    newState: CardState = "resolved",
    snoozedUntil?: string,
  ): Card | undefined {
    const existing = this.getCard(id);
    if (!existing) return undefined;
    const now = nowIso();
    this.sqlite
      .prepare(
        `UPDATE cards SET state = ?, resolution = ?, resolved_at = ?, snoozed_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        newState,
        JSON.stringify(resolution),
        newState === "resolved" ? now : null,
        snoozedUntil ?? null,
        now,
        id,
      );
    const updated = this.getCard(id)!;
    this.bus.emit("card_state", updated);
    return updated;
  }

  // -------------------------------------------------------- capabilities

  createCapabilityRequest(input: {
    intern: string;
    capability: string;
    description: string;
    spec?: Record<string, unknown>;
  }): CapabilityRequest {
    const existing = this.sqlite
      .prepare(
        `SELECT * FROM capability_requests WHERE intern = ? AND capability = ?
         AND status NOT IN ('active','rejected','failed') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.intern, input.capability) as CapabilityRequestRow | undefined;
    if (existing) return rowToCapabilityRequest(existing);
    const now = nowIso();
    const row = CapabilityRequestSchema.parse({
      id: randomUUID(),
      ...input,
      spec: input.spec ?? {},
      status: "requested",
      card_id: null,
      created_at: now,
      updated_at: now,
      error: null,
    });
    this.sqlite
      .prepare(
        `INSERT INTO capability_requests
         (id, intern, capability, description, status, spec, card_id, created_at, updated_at, error)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(row.id, row.intern, row.capability, row.description, row.status, JSON.stringify(row.spec), now, now);
    return row;
  }

  getCapabilityRequest(id: string): CapabilityRequest | undefined {
    const row = this.sqlite.prepare("SELECT * FROM capability_requests WHERE id = ?").get(id) as
      | CapabilityRequestRow
      | undefined;
    return row ? rowToCapabilityRequest(row) : undefined;
  }

  listCapabilityRequests(status?: CapabilityStatus): CapabilityRequest[] {
    const rows = (status
      ? this.sqlite.prepare("SELECT * FROM capability_requests WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.sqlite.prepare("SELECT * FROM capability_requests ORDER BY created_at DESC").all()) as CapabilityRequestRow[];
    return rows.map(rowToCapabilityRequest);
  }

  setCapabilityRequestCard(id: string, cardId: string): CapabilityRequest {
    this.sqlite.prepare("UPDATE capability_requests SET card_id = ?, updated_at = ? WHERE id = ?").run(cardId, nowIso(), id);
    const row = this.getCapabilityRequest(id);
    if (!row) throw new Error(`no capability request: ${id}`);
    return row;
  }

  markCapabilityRequest(id: string, status: CapabilityStatus, error?: string): CapabilityRequest {
    this.sqlite
      .prepare("UPDATE capability_requests SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, nowIso(), id);
    const row = this.getCapabilityRequest(id);
    if (!row) throw new Error(`no capability request: ${id}`);
    return row;
  }

  // ---------------------------------------------------------- approvals

  createApprovalJob(input: {
    cardId: string;
    actionId: string;
    kind: ApprovalJobKind;
    payload?: Record<string, unknown>;
  }): ApprovalJob {
    const now = nowIso();
    const job = ApprovalJobSchema.parse({
      id: randomUUID(),
      card_id: input.cardId,
      action_id: input.actionId,
      kind: input.kind,
      payload: input.payload ?? {},
      status: "pending",
      result: null,
      error: null,
      created_at: now,
      updated_at: now,
    });
    this.sqlite
      .prepare(
        `INSERT INTO approval_jobs
         (id, card_id, action_id, kind, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(job.id, job.card_id, job.action_id, job.kind, JSON.stringify(job.payload), now, now);
    return job;
  }

  getApprovalJob(cardId: string, actionId: string): ApprovalJob | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM approval_jobs WHERE card_id = ? AND action_id = ?")
      .get(cardId, actionId) as ApprovalJobRow | undefined;
    return row ? rowToApprovalJob(row) : undefined;
  }

  claimApprovalJob(id: string): boolean {
    const result = this.sqlite
      .prepare("UPDATE approval_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(nowIso(), id);
    return result.changes === 1;
  }

  finishApprovalJob(id: string, result: Record<string, unknown>): void {
    this.sqlite
      .prepare("UPDATE approval_jobs SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), nowIso(), id);
  }

  failApprovalJob(id: string, error: string): void {
    this.sqlite
      .prepare("UPDATE approval_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, nowIso(), id);
  }

  resetApprovalJob(id: string, error: string): void {
    this.sqlite
      .prepare("UPDATE approval_jobs SET status = 'pending', error = ?, updated_at = ? WHERE id = ?")
      .run(error, nowIso(), id);
  }

  recordGithubDelivery(deliveryId: string, event: string): boolean {
    const result = this.sqlite
      .prepare("INSERT OR IGNORE INTO github_deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)")
      .run(deliveryId, event, nowIso());
    return result.changes === 1;
  }

  /** True only for a new PR or a changed head SHA; also advances the watermark. */
  recordGithubPullRequest(repository: string, pullNumber: number, headSha: string): boolean {
    const existing = this.sqlite
      .prepare("SELECT head_sha FROM github_pr_state WHERE repository = ? AND pull_number = ?")
      .get(repository, pullNumber) as { head_sha: string } | undefined;
    if (existing?.head_sha === headSha) return false;
    this.sqlite
      .prepare(
        `INSERT INTO github_pr_state (repository, pull_number, head_sha, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repository, pull_number) DO UPDATE SET head_sha=excluded.head_sha, updated_at=excluded.updated_at`,
      )
      .run(repository, pullNumber, headSha, nowIso());
    return true;
  }

  // --------------------------------------------------------------- tasks

  enqueueTask(intern: string, kind: TaskKind, payload: Record<string, unknown> = {}): Task {
    const task = TaskSchema.parse({
      id: randomUUID(),
      intern,
      kind,
      payload,
      status: "queued",
      priority: 0,
      created_at: nowIso(),
    });
    this.sqlite
      .prepare("INSERT INTO tasks (id, intern, kind, payload, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.intern, task.kind, JSON.stringify(task.payload), task.status, task.priority, task.created_at);
    this.bus.emit("task_state", task);
    return task;
  }

  /** Oldest queued task per intern, one row per intern. */
  nextQueuedTasks(): Task[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT t.*, ROW_NUMBER() OVER (PARTITION BY intern ORDER BY priority DESC, created_at ASC) AS queue_rank
           FROM tasks t WHERE status = 'queued'
         ) WHERE queue_rank = 1`,
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  countTasks(intern: string, status: TaskStatus): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE intern = ? AND status = ?")
      .get(intern, status) as { n: number };
    return row.n;
  }

  /** Tasks set aside because the intern reached today's token limit (oldest first). */
  budgetHeldTasks(intern?: string): Task[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM tasks WHERE status = 'paused' AND error = ? ${intern ? "AND intern = ?" : ""} ORDER BY created_at ASC`)
      .all(...(intern ? [OVER_BUDGET, intern] : [OVER_BUDGET])) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Put an intern's budget-held tasks back in the queue; returns how many. */
  releaseBudgetHeld(intern: string): number {
    const held = this.budgetHeldTasks(intern);
    for (const task of held) this.markTask(task.id, "queued");
    return held.length;
  }

  /** Extra tokens JP allowed an intern for one UTC day, on top of their daily_token_cap. */
  budgetExtra(intern: string, day = todayUtc()): number {
    return Number(this.getKv(`budget_extra:${intern}:${day}`) ?? 0) || 0;
  }

  addBudgetExtra(intern: string, tokens: number, day = todayUtc()): number {
    const total = this.budgetExtra(intern, day) + Math.max(0, Math.round(tokens));
    this.setKv(`budget_extra:${intern}:${day}`, String(total));
    return total;
  }

  /**
   * One intern's week, for their profile: tasks by outcome, what they wrote
   * to JP, drafts and pages, cards they raised, and spend per UTC day.
   */
  internWeek(intern: string, sinceIso: string): {
    tasks: Task[];
    messages: number;
    drafts: { id: string; title: string; updated_at: string }[];
    pages_created: number;
    pages_updated: number;
    cards_raised: number;
    cards_decided: number;
    days: { day: string; tokens: number; cost_usd: number }[];
  } {
    const tasks = (this.sqlite
      .prepare("SELECT * FROM tasks WHERE intern = ? AND COALESCE(finished_at, created_at) >= ? ORDER BY created_at ASC")
      .all(intern, sinceIso) as TaskRow[]).map(rowToTask);
    const messages = (this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE author = 'intern' AND COALESCE(speaker, intern) = ? AND ts >= ?")
      .get(intern, sinceIso) as { n: number }).n;
    const pages = (this.sqlite.prepare("SELECT * FROM pages WHERE intern = ? AND updated_at >= ?").all(intern, sinceIso) as PageRow[]).map(rowToPage);
    const drafts = pages
      .filter((p) => p.kind === "draft" && p.created_at >= sinceIso && !p.archived_at)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => ({ id: p.id, title: p.title, updated_at: p.updated_at }));
    const cards = (this.sqlite.prepare("SELECT * FROM cards WHERE intern = ? AND (created_at >= ? OR resolved_at >= ?)").all(intern, sinceIso, sinceIso) as CardRow[]).map(rowToCard);
    const firstDay = sinceIso.slice(0, 10);
    const days: { day: string; tokens: number; cost_usd: number }[] = [];
    for (let t = Date.parse(`${firstDay}T00:00:00Z`); t <= Date.now(); t += 86_400_000) days.push({ day: new Date(t).toISOString().slice(0, 10), tokens: 0, cost_usd: 0 });
    for (const row of this.sqlite.prepare("SELECT day, input_tokens + output_tokens AS tokens, cost_usd FROM spend WHERE intern = ? AND day >= ?").all(intern, firstDay) as { day: string; tokens: number; cost_usd: number }[]) {
      const slot = days.find((d) => d.day === row.day);
      if (slot) Object.assign(slot, { tokens: row.tokens, cost_usd: row.cost_usd });
    }
    return {
      tasks,
      messages,
      drafts,
      pages_created: pages.filter((p) => p.created_at >= sinceIso && p.kind !== "draft").length,
      pages_updated: pages.filter((p) => p.created_at < sinceIso).length,
      cards_raised: cards.filter((c) => c.created_at >= sinceIso).length,
      cards_decided: cards.filter((c) => c.state === "resolved" && (c.resolved_at ?? "") >= sinceIso && c.resolution?.action !== "seen").length,
      days,
    };
  }

  /** Running task wins; otherwise the oldest queued task is the visible activity. */
  currentTask(intern: string): Task | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM tasks WHERE intern = ? AND status IN ('running','paused','queued')
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, priority DESC, created_at ASC LIMIT 1`,
      )
      .get(intern) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  listRecentTasks(limit = 100): Task[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 500))) as TaskRow[];
    return rows.map(rowToTask);
  }

  markTask(id: string, status: TaskStatus, error?: string): void {
    const now = nowIso();
    if (status === "running") {
      this.sqlite.prepare("UPDATE tasks SET status = ?, started_at = ?, finished_at = NULL, error = NULL WHERE id = ?").run(status, now, id);
    } else if (status === "queued") {
      this.sqlite.prepare("UPDATE tasks SET status = ?, started_at = NULL, finished_at = NULL, error = NULL WHERE id = ?").run(status, id);
    } else if (status === "paused") {
      // a reason marks who paused it: none = JP; OVER_BUDGET = waiting on the daily limit
      this.sqlite.prepare("UPDATE tasks SET status = ?, finished_at = NULL, error = ? WHERE id = ?").run(status, error ?? null, id);
    } else {
      this.sqlite
        .prepare("UPDATE tasks SET status = ?, finished_at = ?, error = ? WHERE id = ?")
        .run(status, now, error ?? null, id);
    }
    const updated = this.getTask(id);
    if (updated) this.bus.emit("task_state", updated);
  }

  prioritizeTask(id: string): Task | undefined {
    const task = this.getTask(id);
    if (!task || !["queued", "running", "paused"].includes(task.status)) return undefined;
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(priority), 0) AS max_priority FROM tasks WHERE intern = ?").get(task.intern) as { max_priority: number };
    this.sqlite.prepare("UPDATE tasks SET priority = ? WHERE id = ? AND status IN ('queued','running','paused')").run(row.max_priority + 1, id);
    const updated = this.getTask(id);
    if (updated) this.bus.emit("task_state", updated);
    return updated;
  }

  /**
   * Mark every still-queued task for an intern as failed with `reason` —
   * used by /archive so the worker never picks up a fired intern's backlog.
   * Running work finishes/fails on its own (the stale-task heartbeat sweep is
   * the backstop); queued and paused work must not survive an archive.
   */
  cancelQueuedTasks(intern: string, reason: string): number {
    const result = this.sqlite
      .prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = ? WHERE intern = ? AND status IN ('queued','paused')")
      .run(nowIso(), reason, intern);
    return result.changes;
  }

  getTask(id: string): Task | undefined {
    const row = this.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** Running tasks whose started_at is older than the cutoff. */
  staleRunningTasks(olderThanMinutes: number): Task[] {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const rows = this.sqlite
      .prepare("SELECT * FROM tasks WHERE status = 'running' AND started_at < ?")
      .all(cutoff) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Most recent finished_at for an intern's tasks of a given kind (backlog cooldowns). */
  lastFinishedAt(intern: string, kind: TaskKind): string | null {
    const row = this.sqlite
      .prepare(
        "SELECT MAX(finished_at) AS ts FROM tasks WHERE intern = ? AND kind = ? AND finished_at IS NOT NULL",
      )
      .get(intern, kind) as { ts: string | null };
    return row.ts;
  }

  // --------------------------------------------------------------- spend

  recordSpend(intern: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO spend (intern, day, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(intern, day) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(intern, todayUtc(), inputTokens, outputTokens, costUsd);
  }

  /** Per-intern daily spend for the last N days (UTC), oldest day first; days without spend are absent. */
  spendLastDays(days: number): SpendRow[] {
    const since = new Date(Date.now() - (Math.max(1, days) - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.sqlite
      .prepare("SELECT * FROM spend WHERE day >= ? ORDER BY day ASC, intern ASC")
      .all(since) as SpendRow[];
  }

  /**
   * Per-run spend with the thread it happened in — what a conversation
   * cost. `kind` is "run" for intern runs, "precheck"/"advisor"/"standup"
   * for the coordinator's own calls.
   */
  recordRunSpend(input: { intern: string; thread?: string | null; taskId?: string | null; kind: string; inputTokens: number; outputTokens: number; costUsd: number }): void {
    if (!input.inputTokens && !input.outputTokens && !input.costUsd) return;
    const now = nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO run_spend (ts, day, intern, thread, task_id, kind, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now, now.slice(0, 10), input.intern, input.thread ?? null, input.taskId ?? null, input.kind, input.inputTokens, input.outputTokens, input.costUsd);
  }

  /** Aggregates for the spend screen: per intern per day, and per thread, over the last N days. */
  spendReport(days: number): {
    days: string[];
    by_intern: { intern: string; day: string; tokens: number; cost_usd: number }[];
    by_thread: { thread: string; tokens: number; cost_usd: number; runs: number; last_ts: string }[];
    by_thread_day: { thread: string; day: string; cost_usd: number }[];
  } {
    const n = Math.max(1, Math.min(days, 365));
    const since = new Date(Date.now() - (n - 1) * 86_400_000).toISOString().slice(0, 10);
    const list: string[] = [];
    for (let i = n - 1; i >= 0; i--) list.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
    const by_intern = this.sqlite
      .prepare("SELECT intern, day, input_tokens + output_tokens AS tokens, cost_usd FROM spend WHERE day >= ? ORDER BY day, intern")
      .all(since) as { intern: string; day: string; tokens: number; cost_usd: number }[];
    const by_thread = this.sqlite
      .prepare(
        `SELECT thread, SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost_usd, COUNT(*) AS runs, MAX(ts) AS last_ts
         FROM run_spend WHERE day >= ? AND thread IS NOT NULL GROUP BY thread ORDER BY cost_usd DESC`,
      )
      .all(since) as { thread: string; tokens: number; cost_usd: number; runs: number; last_ts: string }[];
    const by_thread_day = this.sqlite
      .prepare("SELECT thread, day, SUM(cost_usd) AS cost_usd FROM run_spend WHERE day >= ? AND thread IS NOT NULL GROUP BY thread, day ORDER BY day")
      .all(since) as { thread: string; day: string; cost_usd: number }[];
    return { days: list, by_intern, by_thread, by_thread_day };
  }

  spendToday(intern: string): SpendRow {
    const row = this.sqlite
      .prepare("SELECT * FROM spend WHERE intern = ? AND day = ?")
      .get(intern, todayUtc()) as SpendRow | undefined;
    return row ?? { intern, day: todayUtc(), input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  }

  // --------------------------------------------------------------- pages

  createPage(input: { intern: string; thread_key: string; kind: PageKind; title: string; summary?: string; data: Record<string, unknown> }): Page {
    const now = nowIso();
    const id = `pg_${randomUUID()}`;
    this.sqlite
      .prepare(
        `INSERT INTO pages (id, intern, thread_key, kind, title, summary, data, version, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, input.intern, input.thread_key, input.kind, input.title, input.summary ?? "", JSON.stringify(input.data), now, now);
    const page = this.getPage(id)!;
    this.bus.emit("page", page);
    return page;
  }

  getPage(id: string): Page | undefined {
    const row = this.sqlite.prepare("SELECT * FROM pages WHERE id = ?").get(id) as PageRow | undefined;
    return row ? rowToPage(row) : undefined;
  }

  /** Pages owned by `key` (an intern) or first shown in thread `key`; newest change first. */
  listPages(key: string, opts: { includeArchived?: boolean } = {}): Page[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM pages WHERE (intern = ? OR thread_key = ?) ${opts.includeArchived ? "" : "AND archived_at IS NULL"}
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all(key, key) as PageRow[];
    return rows.map(rowToPage);
  }

  /** Every live page (search). */
  listAllPages(): Page[] {
    const rows = this.sqlite.prepare("SELECT * FROM pages WHERE archived_at IS NULL ORDER BY updated_at DESC").all() as PageRow[];
    return rows.map(rowToPage);
  }

  listPagesOfKind(kind: PageKind): Page[] {
    const rows = this.sqlite.prepare("SELECT * FROM pages WHERE kind = ? AND archived_at IS NULL ORDER BY updated_at DESC").all(kind) as PageRow[];
    return rows.map(rowToPage);
  }

  /** Write a new version. Only the fields given change; every write bumps `version`. */
  updatePage(id: string, patch: { title?: string; summary?: string; data?: Record<string, unknown>; thread_key?: string }): Page | undefined {
    const existing = this.getPage(id);
    if (!existing) return undefined;
    this.sqlite
      .prepare("UPDATE pages SET title = ?, summary = ?, data = ?, thread_key = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(
        patch.title ?? existing.title,
        patch.summary ?? existing.summary,
        JSON.stringify(patch.data ?? existing.data),
        patch.thread_key ?? existing.thread_key,
        nowIso(),
        id,
      );
    const page = this.getPage(id)!;
    this.bus.emit("page", page);
    return page;
  }

  /** Pinning is JP's bookmark, not content: it does not bump the version. */
  setPagePinned(id: string, pinned: boolean): Page | undefined {
    this.sqlite.prepare("UPDATE pages SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    const page = this.getPage(id);
    if (page) this.bus.emit("page", page);
    return page;
  }

  /** Record which thread a page was first shown in (no version bump: nothing JP sees changed). */
  setPageThread(id: string, threadKey: string): void {
    this.sqlite.prepare("UPDATE pages SET thread_key = ? WHERE id = ?").run(threadKey, id);
  }

  archivePage(id: string): Page | undefined {
    this.sqlite.prepare("UPDATE pages SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").run(nowIso(), nowIso(), id);
    const page = this.getPage(id);
    if (page) this.bus.emit("page", page);
    return page;
  }

  // ------------------------------------------------------- announcements

  /** Queue a fence (a page or rule chip) for the intern's next reply. */
  announce(intern: string, fence: string, pageId: string | null = null): void {
    this.sqlite.prepare("INSERT INTO announcements (intern, fence, page_id, created_at) VALUES (?, ?, ?, ?)").run(intern, fence, pageId, nowIso());
  }

  /**
   * Claim the fences queued for an intern since a run started, in order,
   * for the reply message `messageId`. A page announced twice in one run is
   * shown once.
   */
  claimAnnouncements(intern: string, sinceIso: string, messageId: string): { fence: string; page_id: string | null }[] {
    const rows = this.sqlite
      .prepare("SELECT id, fence, page_id FROM announcements WHERE intern = ? AND message_id IS NULL AND created_at >= ? ORDER BY id ASC")
      .all(intern, sinceIso) as { id: number; fence: string; page_id: string | null }[];
    const stmt = this.sqlite.prepare("UPDATE announcements SET message_id = ? WHERE id = ?");
    const seenPages = new Set<string>();
    const out: { fence: string; page_id: string | null }[] = [];
    for (const row of rows) {
      stmt.run(messageId, row.id);
      if (row.page_id) {
        if (seenPages.has(row.page_id)) continue;
        seenPages.add(row.page_id);
      }
      out.push({ fence: row.fence, page_id: row.page_id });
    }
    return out;
  }

  hasPendingAnnouncements(intern: string, sinceIso: string): boolean {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM announcements WHERE intern = ? AND message_id IS NULL AND created_at >= ?")
      .get(intern, sinceIso) as { n: number };
    return row.n > 0;
  }

  /** Replace a message's text in place (a reply gaining its page/rule chips) and re-emit it. */
  setMessageText(id: string, text: string): Message | undefined {
    this.sqlite.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, id);
    const msg = this.getMessage(id);
    if (msg) this.bus.emit("message", msg);
    return msg;
  }

  // --------------------------------------------------------------- rules

  createRule(input: { intern: string; kind: "hard" | "soft"; type: RuleType; params: Record<string, unknown>; text: string; created_from_message?: string | null }): Rule {
    const id = `rl_${randomUUID()}`;
    this.sqlite
      .prepare(
        `INSERT INTO rules (id, intern, kind, type, params, text, enabled, hits, created_from_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, input.intern, input.kind, input.type, JSON.stringify(input.params), input.text, input.created_from_message ?? null, nowIso());
    const rule = this.getRule(id)!;
    this.bus.emit("rule", rule);
    return rule;
  }

  getRule(id: string): Rule | undefined {
    const row = this.sqlite.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  /** Live (not removed) rules; `enabledOnly` for enforcement. */
  listRules(intern: string, opts: { enabledOnly?: boolean } = {}): Rule[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM rules WHERE intern = ? AND removed_at IS NULL ${opts.enabledOnly ? "AND enabled = 1" : ""} ORDER BY created_at ASC`)
      .all(intern) as RuleRow[];
    return rows.map(rowToRule);
  }

  updateRule(id: string, patch: { enabled?: boolean; text?: string }): Rule | undefined {
    const existing = this.getRule(id);
    if (!existing || existing.removed_at) return existing;
    this.sqlite
      .prepare("UPDATE rules SET enabled = ?, text = ? WHERE id = ?")
      .run((patch.enabled ?? existing.enabled) ? 1 : 0, patch.text ?? existing.text, id);
    const rule = this.getRule(id)!;
    this.bus.emit("rule", rule);
    return rule;
  }

  /** Soft delete, so a rule chip in an old message can still say "removed". */
  removeRule(id: string): Rule | undefined {
    this.sqlite.prepare("UPDATE rules SET removed_at = ?, enabled = 0 WHERE id = ? AND removed_at IS NULL").run(nowIso(), id);
    const rule = this.getRule(id);
    if (rule) this.bus.emit("rule", rule);
    return rule;
  }

  recordRuleHit(id: string, detail: string, count = 1): void {
    const now = nowIso();
    this.sqlite.prepare("UPDATE rules SET hits = hits + ?, last_hit_at = ? WHERE id = ?").run(count, now, id);
    const stmt = this.sqlite.prepare("INSERT INTO rule_hits (rule_id, ts, detail) VALUES (?, ?, ?)");
    for (let i = 0; i < count; i++) stmt.run(id, now, detail.slice(0, 300));
  }

  ruleHitsSince(id: string, sinceIso: string): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS n FROM rule_hits WHERE rule_id = ? AND ts >= ?").get(id, sinceIso) as { n: number };
    return row.n;
  }

  // ------------------------------------------------- briefs + debriefs

  recordMeetingBrief(input: { event_id: string; intern: string; event: Record<string, unknown>; start_at: string; end_at: string; task_id: string }): void {
    this.sqlite
      .prepare(
        `INSERT INTO meeting_briefs (event_id, intern, event, start_at, end_at, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, intern) DO UPDATE SET event = excluded.event, start_at = excluded.start_at, end_at = excluded.end_at, task_id = excluded.task_id`,
      )
      .run(input.event_id, input.intern, JSON.stringify(input.event), input.start_at, input.end_at, input.task_id, nowIso());
  }

  /** The brief task finished: its reply message is the brief. */
  linkMeetingBriefMessage(taskId: string, messageId: string): MeetingBriefRow | undefined {
    this.sqlite.prepare("UPDATE meeting_briefs SET message_id = ? WHERE task_id = ?").run(messageId, taskId);
    const row = this.sqlite.prepare("SELECT * FROM meeting_briefs WHERE task_id = ?").get(taskId) as (Omit<MeetingBriefRow, "event"> & { event: string }) | undefined;
    return row ? { ...row, event: JSON.parse(row.event) as Record<string, unknown> } : undefined;
  }

  /** Briefs for meetings overlapping [fromIso, toIso). */
  listMeetingBriefs(fromIso: string, toIso: string): MeetingBriefRow[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM meeting_briefs WHERE end_at > ? AND start_at < ? ORDER BY start_at ASC")
      .all(fromIso, toIso) as (Omit<MeetingBriefRow, "event"> & { event: string })[];
    return rows.map((r) => ({ ...r, event: JSON.parse(r.event) as Record<string, unknown> }));
  }

  createDebrief(input: { event_id: string; intern: string; message_id: string; event: Record<string, unknown> }): void {
    this.sqlite
      .prepare("INSERT OR IGNORE INTO debriefs (event_id, intern, state, message_id, event, asked_at) VALUES (?, ?, 'asked', ?, ?, ?)")
      .run(input.event_id, input.intern, input.message_id, JSON.stringify(input.event), nowIso());
  }

  getDebrief(eventId: string, intern: string): DebriefRow | undefined {
    const row = this.sqlite.prepare("SELECT * FROM debriefs WHERE event_id = ? AND intern = ?").get(eventId, intern) as (Omit<DebriefRow, "event"> & { event: string }) | undefined;
    return row ? { ...row, event: JSON.parse(row.event) as Record<string, unknown> } : undefined;
  }

  debriefForMessage(messageId: string): DebriefRow | undefined {
    const row = this.sqlite.prepare("SELECT * FROM debriefs WHERE message_id = ?").get(messageId) as (Omit<DebriefRow, "event"> & { event: string }) | undefined;
    return row ? { ...row, event: JSON.parse(row.event) as Record<string, unknown> } : undefined;
  }

  setDebriefState(eventId: string, intern: string, state: "answered" | "skipped"): void {
    this.sqlite.prepare("UPDATE debriefs SET state = ?, answered_at = ? WHERE event_id = ? AND intern = ? AND state = 'asked'").run(state, nowIso(), eventId, intern);
  }

  /** Tell the Today tab that a day's agenda changed (a brief or debrief landed). */
  notifyAgenda(date: string): void {
    this.bus.emit("agenda", date);
  }

  // --------------------------------------------------------------- holds

  /** Park work a hold_until standing order held back, to re-enqueue on `until` (YYYY-MM-DD, local). */
  addHold(hold: { intern: string; until: string; rule: string; payload: Record<string, unknown> }): void {
    const holds = this.listHolds();
    holds.push({ ...hold, created_at: nowIso() });
    this.setKv("holds", JSON.stringify(holds));
  }

  listHolds(): { intern: string; until: string; rule: string; payload: Record<string, unknown>; created_at: string }[] {
    try {
      const parsed: unknown = JSON.parse(this.getKv("holds") ?? "[]");
      return Array.isArray(parsed) ? (parsed as ReturnType<Db["listHolds"]>) : [];
    } catch {
      return [];
    }
  }

  /** Remove and return the holds due on or before `today` (YYYY-MM-DD); `keep` leaves some parked (a paused intern's). */
  takeDueHolds(today: string, keep: (intern: string) => boolean = () => false): ReturnType<Db["listHolds"]> {
    const holds = this.listHolds();
    const due = holds.filter((h) => h.until <= today && !keep(h.intern));
    if (due.length) this.setKv("holds", JSON.stringify(holds.filter((h) => !due.includes(h))));
    return due;
  }

  // ------------------------------------------------------------------ kv

  getKv(key: string): string | undefined {
    const row = this.sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.sqlite
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, nowIso());
  }

  /** Tasks that finished since a moment, for Today's "while you were away". */
  tasksFinishedSince(sinceIso: string): Task[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM tasks WHERE finished_at IS NOT NULL AND finished_at >= ? ORDER BY finished_at ASC")
      .all(sinceIso) as TaskRow[];
    return rows.map(rowToTask);
  }

  // -------------------------------------------------------------- push

  upsertPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    this.sqlite
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, nowIso());
  }

  deletePushSubscription(endpoint: string): void {
    this.sqlite.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return this.sqlite.prepare("SELECT * FROM push_subscriptions").all() as PushSubscriptionRow[];
  }
}
