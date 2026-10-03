/**
 * Typed client for the Interns orchestrator API (fastify, default
 * 127.0.0.1:7810, static bearer token from ~/.interns/config.json).
 *
 * Shapes mirror orchestrator/src/types.ts. Keep them in sync by hand — the
 * app is deliberately dependency-free of the backend package.
 *
 * Two deviations from a textbook SSE client, both forced by the backend:
 *  1. `GET /events` authenticates with an Authorization header, and the
 *     EventSource API cannot send headers. So the live stream is read with
 *     fetch + ReadableStream instead, which supports headers everywhere the
 *     web PWA runs. See subscribe() for the fallback ladder.
 *  2. The SSE route writes its headers straight onto `reply.raw`, which
 *     bypasses @fastify/cors — so cross-origin browsers block the stream even
 *     though the preflight passes and every other route is fine. Confirmed on
 *     the live API: /interns carries access-control-allow-origin, /events does
 *     not. Until the orchestrator sets that header on the raw response, the
 *     stream is unusable from a browser on another origin, so subscribe()
 *     stops retrying after a couple of failures and drops to polling rather
 *     than leaving the app dead. See README.
 */

// ------------------------------------------------------------------- types

export type CardSeverity = "info" | "action" | "urgent";
export type CardState = "open" | "resolved" | "snoozed" | "expired";
export type CardActionStyle = "primary" | "success" | "neutral";
export type CardActionKind = "button" | "date" | "text";
export type MessageAuthor = "jp" | "intern" | "coordinator";
export type MessageSurface = "app" | "discord" | "system";

export interface Intern {
  slug: string;
  name: string;
  role: string;
  /** avatar id, e.g. "face-05"; "default" when the manifest never picked one */
  icon: string;
  session_id: string | null;
  queued: number;
  running: number;
  /** tasks paused (by JP, or waiting at the daily limit) */
  paused: number;
  /** JP paused the intern itself: no automatic work */
  on_pause?: boolean;
  notify?: NotifyLevel;
  activity: TaskActivity | null;
  spend_today: number;
  cost_today_usd: number;
}

export type TaskStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface TaskActivity {
  id: string;
  intern: string;
  kind: string;
  status: TaskStatus;
  priority: number;
  label: string;
  repository: string | null;
  pull_number: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export type AttachmentKind = "image" | "svg" | "file";

/** A file exchanged in a thread — see orchestrator/src/attachments.ts. */
export interface Attachment {
  id: string;
  intern: string;
  message_id: string | null;
  author: MessageAuthor;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  sha256: string;
  ext: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  /** app-relative, self-signed: `${baseUrl}${url}` needs no Authorization header */
  url: string;
}

export interface Message {
  id: string;
  /** thread key: an intern slug, or a room id (`room-…`) for a group chat */
  intern: string;
  author: MessageAuthor;
  /** which intern spoke (differs from `intern` in group chats and handoffs) */
  speaker?: string | null;
  /** the message this one answers — threads inside a room */
  reply_to?: string | null;
  /** pinned by JP: shown in the thread's pinned bar */
  pinned?: boolean;
  text: string;
  /** ISO 8601 */
  ts: string;
  surface: MessageSurface;
  attachments: Attachment[];
}

export interface CardAction {
  id: string;
  label: string;
  style: CardActionStyle;
  /** button = plain click; date/text = the surface collects a note first */
  kind: CardActionKind;
}

export interface CardResolution {
  via: "app" | "discord";
  action: string;
  note?: string;
}

export interface Card {
  id: string;
  /** intern slug, or "coordinator" for orchestrator-emitted cards */
  intern: string;
  title: string;
  /** markdown */
  body: string;
  severity: CardSeverity;
  state: CardState;
  actions: CardAction[];
  /** Structured metadata for rich card renderers (for example GitHub reviews). */
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  snoozed_until: string | null;
  resolution: CardResolution | null;
  discord_message_id: string | null;
}

export interface PushDeliveryReport {
  attempted_at: string;
  subscriptions: number;
  sent: number;
  failed: number;
  removed: number;
  errors: string[];
}

export interface PushStatus {
  configured: boolean;
  subscriptions: number;
  last_delivery: PushDeliveryReport | null;
}

export interface PullRequestPreview {
  repository: string;
  pull_number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  updated_at: string | null;
  changed_files: number;
  additions: number;
  deletions: number;
  checks: { total: number; passed: number; failed: number; pending: number };
  risk: "low" | "medium" | "high" | "unknown";
  github_url: string;
  codeops_url: string | null;
  primary_url: string;
  primary_label: string;
}

/** The manifest shape the /hire flow drafts and /hire/confirm writes to disk. */
export interface InternManifest {
  name: string;
  role: string;
  /** avatar id; the draft comes back as "default" and JP picks a face */
  icon: string;
  persona: string;
  system_prompt: string;
  /** tool catalog names, chosen by the coordinator */
  tools: string[];
  triggers: { mail_push?: boolean; cron?: string; mentions?: boolean };
  backlog: string[];
  guardrails: { drafts_only: boolean; daily_token_cap: number };
}

export interface CapabilityRequirement {
  id: string;
  reason: string;
}

export interface CapabilityRequest {
  id: string;
  intern: string;
  capability: string;
  description: string;
  status: "requested" | "approved" | "building" | "testing" | "ready" | "active" | "rejected" | "failed";
  card_id: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export interface HireResult {
  slug: string;
  manifest: InternManifest;
  capability_requests: CapabilityRequest[];
}

/**
 * The intern "employee file" — GET/PATCH /interns/:slug/manifest. A superset
 * of InternManifest: it carries the slug, today's spend and the Discord
 * channel, none of which are edited from this screen.
 */
export interface InternManifestDetail {
  slug: string;
  name: string;
  role: string;
  icon: string;
  persona: string;
  system_prompt: string;
  tools: string[];
  triggers: { cron?: string | null; mentions?: boolean; mail_push?: boolean };
  backlog: string[];
  guardrails: { drafts_only: boolean; daily_token_cap: number };
  /** no schedule, mail, meetings, reviews or routing; JP's own messages still reach them */
  paused?: boolean;
  /** tokens JP allowed on top of the cap today, and tasks waiting for room under it */
  budget?: { extra_today: number; held: number };
  /** what reaches JP's lock screen from them */
  notify?: NotifyLevel;
  /** the last two weeks: buzzed now (and how many he opened), held for summaries, left in the app */
  notify_stats?: { now: number; opened: number; summary: number; off: number };
  spend_today: { input_tokens: number; output_tokens: number; cost_usd: number };
  discord: { channel_id: string | null };
}

/**
 * How much of an intern reaches the lock screen (orchestrator notify.ts):
 * all — everything at once; needs_you — replies, questions and decisions at
 * once, the rest in the summary; summary — all in the summary; off — nothing.
 * Urgent always comes through.
 */
export type NotifyLevel = "all" | "needs_you" | "summary" | "off";

/** GET/PATCH /notify/settings */
export interface NotifySettings {
  /** local "HH:MM" */
  summary_times: string[];
  quiet: { enabled: boolean; from: string; to: string };
}

/** GET /interns/:slug/week — the profile's "This week". */
export interface InternWeek {
  since: string;
  /** "Reviewed 2 PRs, answered 7 messages" — empty when nothing finished */
  summary: string;
  done: number;
  failed: number;
  muted: number;
  messages: number;
  drafts: { id: string; title: string; updated_at: string }[];
  draft_count: number;
  pages_created: number;
  pages_updated: number;
  cards_raised: number;
  cards_decided: number;
  /** oldest first, UTC days */
  days: { day: string; tokens: number; cost_usd: number }[];
  tokens: number;
  cost_usd: number;
}

/** PATCH body: any subset of the editable fields (never slug/spend_today/discord). */
export type InternManifestPatch = Partial<
  Pick<
    InternManifestDetail,
    "name" | "role" | "icon" | "persona" | "system_prompt" | "tools" | "triggers" | "backlog" | "guardrails" | "paused" | "notify"
  >
>;

export interface MetaResponse {
  icons: { id: string; label: string }[];
  tools: string[];
}

/**
 * POST /interns/:slug/archive result. Permanent from the app's perspective —
 * there is no un-archive endpoint. See InternsApi.archiveIntern.
 */
export interface ArchiveInternResult {
  slug: string;
  archived: true;
  name: string;
}

/** The shape browser PushSubscription.toJSON() returns — see src/push.ts. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface SendMessageResult {
  message: Message;
  task_id: string;
  /** intern slugs that were asked to reply (mentioned members, or everyone in a room) */
  targets?: string[];
}

/** A group chat: JP plus a set of interns. Its id is the thread key for messages. */
export interface Room {
  id: string;
  name: string;
  members: string[];
  topic: string;
  /** shared markdown pad, pinned above the room */
  scratchpad: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface RoomListEntry extends Room {
  last_message: Message | null;
}

export interface SuggestStatus {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  last: {
    created: number;
    proposed: number;
    skipped: string[];
    titles: string[];
    error: string | null;
    evidence_summary: { window_days?: number; jp_messages?: number; repeated_asks?: number; capability_gaps?: number; interns?: number };
  } | null;
}

export interface SpendReport {
  days: string[];
  by_intern: { intern: string; day: string; tokens: number; cost_usd: number }[];
  by_thread: { thread: string; tokens: number; cost_usd: number; runs: number; last_ts: string }[];
  by_thread_day: { thread: string; day: string; cost_usd: number }[];
  /** thread key → display name (interns and rooms) */
  names: Record<string, string>;
}

// ------------------------------------------------------------------ pages
// docs/features/contracts.md §2 — living views an intern keeps up to date.

export type PageKind = "people" | "board" | "table" | "list" | "draft";

export interface Person {
  id: string;
  name: string;
  company?: string;
  email?: string;
  tags: string[];
  how_met?: string;
  last_touch?: string;
  next_follow_up?: string;
  stage?: string;
  notes?: string;
  timeline?: { ts: string; kind: "mail" | "meeting" | "chat" | "note"; text: string; ref?: string }[];
}
export interface PeopleData {
  people: Person[];
}
export interface BoardItem {
  id: string;
  column: string;
  title: string;
  subtitle?: string;
  due?: string;
  person_id?: string;
}
export interface BoardData {
  columns: { id: string; title: string }[];
  items: BoardItem[];
}
export interface TableData {
  columns: { key: string; title: string; icon?: boolean }[];
  rows: ({ id: string } & Record<string, string | number | null>)[];
}
export interface ListItem {
  id: string;
  text: string;
  done?: boolean;
  tags: string[];
  ts: string;
  source?: { thread_key: string; message_id: string };
}
export interface ListData {
  items: ListItem[];
}
export interface DraftData {
  draft_id: string;
  mailbox: string;
  kind: "reply_all" | "reply" | "new";
  intended_reply: boolean;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  thread: { from: string; date?: string | null; preview: string }[];
  web_link?: string | null;
}

export interface PageHeader {
  id: string;
  intern: string;
  thread_key: string;
  kind: PageKind;
  title: string;
  summary: string;
  version: number;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  items?: number;
}

export interface Page extends PageHeader {
  data: PeopleData | BoardData | TableData | ListData | DraftData | Record<string, unknown>;
}

export interface PageSearchHit {
  page_id: string;
  page_title: string;
  kind: PageKind;
  intern: string;
  /** null when the page itself matched rather than one of its items */
  item_id: string | null;
  label: string;
  detail: string;
}

// -------------------------------------------------------- standing orders

export type RuleType = "mute_repo" | "mute_sender" | "quiet_hours" | "hold_until" | "guidance";

export interface Rule {
  id: string;
  intern: string;
  kind: "hard" | "soft";
  type: RuleType;
  params: Record<string, unknown>;
  text: string;
  enabled: boolean;
  hits: number;
  hits_7d?: number;
  last_hit_at: string | null;
  created_at: string;
  removed_at: string | null;
}

// ------------------------------------------------------------------ today

export interface ScheduleEntry {
  event_id: string;
  start: string;
  end: string;
  all_day: boolean;
  title: string;
  cancelled: boolean;
  attendees: { name: string; email: string; external: boolean }[];
  location?: string;
  web_link?: string;
  brief?: { intern: string; markdown: string; message_id?: string };
  debrief?: { state: "pending" | "asked" | "answered" | "skipped"; intern: string; message_id?: string };
}

export interface Agenda {
  date: string;
  generated_at: string;
  needs_you: Card[];
  fyi: Card[];
  schedule: ScheduleEntry[];
  schedule_error?: string;
  follow_ups: { person_id: string; page_id: string; name: string; company?: string; due: string; overdue: boolean; intern: string }[];
  away: { intern: string; summary: string; count: number }[];
  standup?: { message_id: string; markdown: string; ts: string };
}

/** Actions that only acknowledge; a card offering nothing else is "for your info", not a decision. */
const PASSIVE_ACTIONS = new Set(["seen", "ack", "read", "ok", "noted", "dismiss", "close"]);

/** Same rule as the orchestrator's agenda.ts: action/urgent, or any non-passive action. */
export function isDecision(card: Card): boolean {
  if (card.severity === "action" || card.severity === "urgent") return true;
  return card.actions.some((a) => !PASSIVE_ACTIONS.has(a.id.toLowerCase()));
}

/** What the composer hands to uploadAttachment: a Blob/File on web, bytes elsewhere. */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
  data: Blob | ArrayBuffer | Uint8Array;
}

export interface Credentials {
  baseUrl: string;
  token: string;
}

// ------------------------------------------------------------------ errors

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the token is wrong/missing rather than the request being bad. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Network-level failure (host unreachable, DNS, CORS block, TLS). */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

// ------------------------------------------------------------------ client

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new NetworkError("No API URL configured — set one in Settings.");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** SSE `page` payload: enough to refetch, never the data itself. */
export interface PageEvent {
  id: string;
  version: number;
  intern: string;
  thread_key: string;
  pinned: boolean;
  archived: boolean;
}

export interface StreamEvent {
  /** "poll" is synthesised by the polling fallback: refetch everything. */
  type: "message" | "card" | "card_state" | "task_state" | "room" | "page" | "rule" | "agenda" | "poll";
  data?: Message | Card | TaskActivity | Room | PageEvent | Rule | { date: string };
}

const STREAM_TYPES = new Set(["message", "card", "card_state", "task_state", "room", "page", "rule", "agenda"]);

export type StreamStatus = "connecting" | "live" | "polling" | "offline";

export interface SubscribeHandlers {
  onEvent: (event: StreamEvent) => void;
  onStatus?: (status: StreamStatus, detail?: string) => void;
}

export class InternsApi {
  constructor(private credentials: Credentials) {}

  get baseUrl(): string {
    return normalizeBaseUrl(this.credentials.baseUrl);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const token = this.credentials.token.trim();
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: this.headers({
          Accept: "application/json",
          ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}),
          ...((init?.headers as Record<string, string>) ?? {}),
        }),
      });
    } catch (cause) {
      throw new NetworkError(
        `Cannot reach ${this.baseUrl}. Check the URL, that the orchestrator is running, and that CORS is enabled.`,
        cause,
      );
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const detail = raw ? extractErrorDetail(raw) : "";
      throw new ApiError(
        response.status === 401
          ? "Unauthorized — the API token is wrong or missing."
          : `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        response.status,
        url,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // ------------------------------------------------------------- endpoints

  listInterns(): Promise<Intern[]> {
    return this.request<Intern[]>("/interns");
  }

  listMessages(slug: string): Promise<Message[]> {
    return this.request<Message[]>(`/interns/${encodeURIComponent(slug)}/messages`);
  }

  sendMessage(slug: string, text: string, attachmentIds: string[] = [], replyTo: string | null = null): Promise<SendMessageResult> {
    return this.request<SendMessageResult>(`/interns/${encodeURIComponent(slug)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, attachment_ids: attachmentIds, reply_to: replyTo }),
    });
  }

  /** Start the coordinator's suggestion pass (returns at once; poll getSuggestStatus). */
  runSuggestions(): Promise<SuggestStatus> {
    return this.request<SuggestStatus>("/suggest/run", { method: "POST", body: "{}" });
  }

  getSuggestStatus(): Promise<SuggestStatus> {
    return this.request<SuggestStatus>("/suggest/status");
  }

  /** Spend over the last N days: per intern per day, per conversation. */
  getSpend(days = 30): Promise<SpendReport> {
    return this.request<SpendReport>(`/reports/spend?days=${days}`);
  }

  // ----------------------------------------------------------------- rooms

  listRooms(): Promise<RoomListEntry[]> {
    return this.request<RoomListEntry[]>("/rooms");
  }

  getRoom(id: string): Promise<Room> {
    return this.request<Room>(`/rooms/${encodeURIComponent(id)}`);
  }

  createRoom(body: { name: string; members: string[]; topic?: string }): Promise<Room> {
    return this.request<Room>("/rooms", { method: "POST", body: JSON.stringify(body) });
  }

  /** Replace or append to a room's shared scratchpad. */
  putScratchpad(id: string, scratchpad: string, append = false): Promise<{ id: string; name: string; scratchpad: string; updated_at: string }> {
    return this.request(`/rooms/${encodeURIComponent(id)}/scratchpad`, { method: "PUT", body: JSON.stringify({ scratchpad, append }) });
  }

  pinMessage(id: string, pinned: boolean): Promise<Message> {
    return this.request<Message>(`/messages/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
  }

  listPins(thread: string): Promise<Message[]> {
    return this.request<Message[]>(`/interns/${encodeURIComponent(thread)}/pins`);
  }

  /** Raise a card by hand (e.g. "turn this message into a card"). */
  createCard(body: { intern: string; title: string; body: string; severity?: CardSeverity; actions?: CardAction[] }): Promise<Card> {
    return this.request<Card>("/cards", { method: "POST", body: JSON.stringify(body) });
  }

  patchRoom(id: string, body: Partial<{ name: string; members: string[]; topic: string; scratchpad: string }>): Promise<Room> {
    return this.request<Room>(`/rooms/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  archiveRoom(id: string): Promise<{ id: string; archived: true }> {
    return this.request<{ id: string; archived: true }>(`/rooms/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" });
  }

  // ----------------------------------------------------------- attachments

  /**
   * Upload one file as a raw body. Returns the stored Attachment, unlinked
   * until sendMessage() claims it. `onProgress` is best-effort (XHR on web,
   * where fetch has no upload progress; a single 1.0 tick elsewhere).
   */
  async uploadAttachment(
    slug: string,
    file: UploadableFile,
    opts: { caption?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<Attachment> {
    const query = new URLSearchParams({ name: file.name, author: "jp" });
    if (opts.caption) query.set("caption", opts.caption);
    const url = `${this.baseUrl}/interns/${encodeURIComponent(slug)}/attachments?${query.toString()}`;
    const headers = this.headers({ "Content-Type": file.type || "application/octet-stream", Accept: "application/json" });
    if (typeof XMLHttpRequest !== "undefined" && opts.onProgress) {
      return new Promise<Attachment>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
        };
        xhr.onerror = () => reject(new NetworkError(`Upload failed — cannot reach ${this.baseUrl}.`));
        xhr.onabort = () => reject(new Error("Upload cancelled"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as Attachment);
            } catch (e) {
              reject(e);
            }
          } else {
            const detail = xhr.responseText ? extractErrorDetail(xhr.responseText) : "";
            reject(new ApiError(`${xhr.status} ${xhr.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`, xhr.status, url));
          }
        };
        opts.signal?.addEventListener("abort", () => xhr.abort());
        xhr.send(file.data as XMLHttpRequestBodyInit);
      });
    }
    const result = await this.request<Attachment>(
      `/interns/${encodeURIComponent(slug)}/attachments?${query.toString()}`,
      { method: "POST", body: file.data as BodyInit, headers: { "Content-Type": file.type || "application/octet-stream" }, signal: opts.signal ?? null },
    );
    opts.onProgress?.(1);
    return result;
  }

  listAttachments(slug: string, limit = 200): Promise<Attachment[]> {
    return this.request<Attachment[]>(`/interns/${encodeURIComponent(slug)}/attachments?limit=${limit}`);
  }

  /** Absolute URL for <img src> / open-in-browser; add `download` for a save-as. */
  attachmentUrl(attachment: Pick<Attachment, "url">, download = false): string {
    return `${this.baseUrl}${attachment.url}${download ? "&download=1" : ""}`;
  }

  listCards(state?: CardState): Promise<Card[]> {
    return this.request<Card[]>(`/cards${state ? `?state=${encodeURIComponent(state)}` : ""}`);
  }

  listActivity(limit = 100): Promise<TaskActivity[]> {
    return this.request<TaskActivity[]>(`/activity?limit=${Math.max(1, Math.min(limit, 250))}`);
  }

  runTaskAction(taskId: string, action: "pause" | "resume" | "cancel" | "prioritize"): Promise<TaskActivity> {
    return this.request<TaskActivity>(`/tasks/${encodeURIComponent(taskId)}/actions/${action}`, { method: "POST", body: "{}" });
  }

  listGithubRepositories(): Promise<string[]> {
    return this.request<{ repositories: string[] }>("/github/repositories").then((result) => result.repositories);
  }

  getPullRequestPreview(repository: string, number: number): Promise<PullRequestPreview> {
    const query = `repository=${encodeURIComponent(repository)}&number=${encodeURIComponent(String(number))}`;
    return this.request<PullRequestPreview>(`/github/pr-preview?${query}`);
  }

  getCard(id: string): Promise<Card> {
    return this.request<Card>(`/cards/${encodeURIComponent(id)}`);
  }

  /** Fire a card action. Returns the card in its new (usually resolved) state. */
  runCardAction(cardId: string, actionId: string, note?: string): Promise<Card> {
    return this.request<Card>(
      `/cards/${encodeURIComponent(cardId)}/actions/${encodeURIComponent(actionId)}`,
      { method: "POST", body: JSON.stringify(note ? { note } : {}) },
    );
  }

  /**
   * Expand a rough role into a full manifest draft. This is an LLM call on the
   * orchestrator and routinely takes many seconds — the UI shows the
   * coordinator thinking while it runs. Nothing is written to disk yet.
   */
  hire(role: string): Promise<{ draft: InternManifest; required_capabilities: CapabilityRequirement[] }> {
    return this.request<{ draft: InternManifest; required_capabilities: CapabilityRequirement[] }>("/hire", {
      method: "POST",
      body: JSON.stringify({ role }),
    });
  }

  /** Commit a (possibly edited) draft: writes the manifest and announces the intern. */
  confirmHire(
    draft: InternManifest,
    icon: string,
    requiredCapabilities: CapabilityRequirement[] = [],
  ): Promise<HireResult> {
    return this.request<HireResult>("/hire/confirm", {
      method: "POST",
      body: JSON.stringify({ draft: { ...draft, icon }, icon, required_capabilities: requiredCapabilities }),
    });
  }

  /** The intern's full "employee file", including today's spend. */
  getInternManifest(slug: string): Promise<InternManifestDetail> {
    return this.request<InternManifestDetail>(`/interns/${encodeURIComponent(slug)}/manifest`);
  }

  /** Partial update; returns the updated manifest. 400s carry a zod-shaped detail. */
  patchInternManifest(slug: string, patch: InternManifestPatch): Promise<InternManifestDetail> {
    return this.request<InternManifestDetail>(`/interns/${encodeURIComponent(slug)}/manifest`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Summary times and quiet hours for the lock screen. */
  getNotifySettings(): Promise<NotifySettings> {
    return this.request<NotifySettings>("/notify/settings");
  }

  patchNotifySettings(patch: { summary_times?: string[]; quiet?: Partial<NotifySettings["quiet"]> }): Promise<NotifySettings> {
    return this.request<NotifySettings>("/notify/settings", { method: "PATCH", body: JSON.stringify(patch) });
  }

  /** What the intern did over the last seven days. */
  getInternWeek(slug: string): Promise<InternWeek> {
    return this.request<InternWeek>(`/interns/${encodeURIComponent(slug)}/week`);
  }

  /** Icon catalog + tool catalog, for the settings screen's pickers. */
  getMeta(): Promise<MetaResponse> {
    return this.request<MetaResponse>("/meta");
  }

  /**
   * Fire an intern — permanent from here. Server-side: directory moves to
   * `~/.interns/_fired/<slug>`, the db row is archived, queued tasks are
   * cancelled, and the Discord channel is renamed `archived-<slug>` with a
   * farewell message. 404 for an unknown slug or "coordinator". There is no
   * un-archive endpoint, so the Danger zone confirm modal is the only guard.
   */
  archiveIntern(slug: string): Promise<ArchiveInternResult> {
    return this.request<ArchiveInternResult>(`/interns/${encodeURIComponent(slug)}/archive`, {
      method: "POST",
    });
  }

  // ------------------------------------------------------------- pages

  getPage(id: string): Promise<Page> {
    return this.request<Page>(`/pages/${encodeURIComponent(id)}`);
  }

  /** Pages owned by an intern, or first shown in a thread (rooms, the front desk). */
  listPages(key: string): Promise<PageHeader[]> {
    return this.request<{ pages: PageHeader[] }>(`/interns/${encodeURIComponent(key)}/pages`).then((r) => r.pages);
  }

  /** People, cards, rows and list items across every page that match all of `q`'s words. */
  searchPages(q: string, limit = 30): Promise<PageSearchHit[]> {
    return this.request<{ hits: PageSearchHit[] }>(`/pages/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.hits);
  }

  pinPage(id: string, pinned: boolean): Promise<Page> {
    return this.request<Page>(`/pages/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
  }

  /** JP's own edits are limited to ticking list items; everything else goes through the owner. */
  patchPageItem(id: string, itemId: string, set: Record<string, unknown>): Promise<Page> {
    return this.request<Page>(`/pages/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify({ set }) });
  }

  removePageItem(id: string, itemId: string): Promise<Page> {
    return this.request<Page>(`/pages/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  }

  // --------------------------------------------------- standing orders

  listRules(slug: string): Promise<Rule[]> {
    return this.request<{ rules: Rule[] }>(`/interns/${encodeURIComponent(slug)}/rules`).then((r) => r.rules);
  }

  getRule(id: string): Promise<Rule> {
    return this.request<Rule>(`/rules/${encodeURIComponent(id)}`);
  }

  setRuleEnabled(id: string, enabled: boolean): Promise<Rule> {
    return this.request<Rule>(`/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  }

  /** Undo: a soft delete, so the chip in the old message can say "Removed". */
  removeRule(id: string): Promise<{ ok: true; rule: Rule }> {
    return this.request<{ ok: true; rule: Rule }>(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ------------------------------------------------------- today, ideas

  /** The Today tab. `since` = when JP last opened Today ("while you were away"). */
  getAgenda(date?: string, since?: string | null): Promise<Agenda> {
    const query = new URLSearchParams();
    if (date) query.set("date", date);
    if (since) query.set("since", since);
    return this.request<Agenda>(`/agenda${query.size ? `?${query.toString()}` : ""}`);
  }

  saveIdea(text: string, source?: { thread_key: string; message_id: string }): Promise<{ page_id: string; item_id: string; count: number }> {
    return this.request(`/ideas`, { method: "POST", body: JSON.stringify({ text, ...(source ? { source } : {}) }) });
  }

  /** Settings' "test connection": proves URL + token + reachability at once. */
  async ping(): Promise<{ interns: number; openCards: number }> {
    const [interns, cards] = await Promise.all([this.listInterns(), this.listCards("open")]);
    return { interns: interns.length, openCards: cards.length };
  }

  /** VAPID public key for `PushManager.subscribe`'s `applicationServerKey`. */
  getPushKey(): Promise<{ vapid_public: string }> {
    return this.request<{ vapid_public: string }>("/push/key");
  }

  /** Register a browser PushSubscription with the orchestrator. */
  subscribePush(sub: PushSubscriptionJSON): Promise<void> {
    return this.request<void>("/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
  }

  /** Drop a subscription (JP disabled notifications, or before re-subscribing). */
  unsubscribePush(endpoint: string): Promise<void> {
    return this.request<void>("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
  }

  getPushStatus(): Promise<PushStatus> {
    return this.request<PushStatus>("/push/status");
  }

  testPush(): Promise<PushDeliveryReport> {
    return this.request<PushDeliveryReport>("/push/test", { method: "POST", body: "{}" });
  }

  // ---------------------------------------------------------------- stream

  /**
   * Live updates. Prefers a streamed fetch of GET /events (real SSE, header
   * auth, reconnecting with backoff). Falls back to a 10s poll tick when the
   * runtime has no streaming fetch (React Native's fetch, older browsers) or
   * when the stream keeps failing — a CORS-blocked stream would otherwise
   * retry forever and leave the app looking dead. Polling keeps periodically
   * re-attempting the stream so it upgrades itself once the API is fixed.
   * Returns an unsubscribe function.
   */
  subscribe(handlers: SubscribeHandlers): () => void {
    let closed = false;
    let attempt = 0;
    let polling = false;
    let controller: AbortController | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const status = (next: StreamStatus, detail?: string) => {
      if (!closed) handlers.onStatus?.(next, detail);
    };

    /** Start the 10s refetch tick, and keep quietly trying to get SSE back. */
    const startPolling = (detail: string) => {
      if (polling) return;
      polling = true;
      status("polling", detail);
      const tick = () => {
        if (closed) return;
        handlers.onEvent({ type: "poll" });
        pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      };
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      armUpgrade();
    };

    /** Retry the stream in the background; the pill stays on "polling". */
    const armUpgrade = () => {
      retryTimer = setTimeout(() => {
        if (closed) return;
        attempt = 0;
        void connect(true);
      }, STREAM_RETRY_WHILE_POLLING_MS);
    };

    const stop = () => {
      if (pollTimer) clearTimeout(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      pollTimer = null;
      retryTimer = null;
      polling = false;
    };

    const connect = async (silent = false) => {
      if (closed) return;
      if (!silent) status("connecting");
      controller = new AbortController();
      try {
        const response = await fetch(`${this.baseUrl}/events`, {
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new ApiError(`events stream refused (${response.status})`, response.status, "/events");
        }
        const body = response.body;
        if (!body || typeof body.getReader !== "function") {
          // No streaming fetch in this runtime (notably React Native).
          controller.abort();
          throw new NoStreamingFetch();
        }
        attempt = 0;
        stop(); // cancel the polling tick — the real stream is up
        status("live");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line.
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const parsed = parseFrame(frame);
            if (parsed) handlers.onEvent(parsed);
          }
        }
        throw new Error("stream ended");
      } catch (error) {
        if (closed) return;
        if (error instanceof ApiError && error.isAuth) {
          stop();
          status("offline", "Unauthorized — check the API token in Settings.");
          return; // a bad token will not fix itself; stop retrying
        }
        const message =
          error instanceof NoStreamingFetch
            ? "This runtime has no streaming fetch."
            : error instanceof Error
              ? error.message
              : String(error);

        if (polling) {
          // Already degraded: fail quietly and try again later.
          armUpgrade();
          return;
        }
        attempt += 1;
        if (attempt >= STREAM_ATTEMPTS_BEFORE_POLLING || error instanceof NoStreamingFetch) {
          startPolling(describeStreamFailure(message));
          return;
        }
        retryTimer = setTimeout(
          () => void connect(),
          Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS),
        );
      }
    };

    if (typeof fetch === "undefined") startPolling("This runtime has no fetch.");
    else void connect();

    return () => {
      closed = true;
      controller?.abort();
      stop();
    };
  }
}

/** Thrown when the runtime cannot stream a fetch response body. */
class NoStreamingFetch extends Error {}

const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;
/** Two quick failures is enough to conclude the stream is not coming back. */
const STREAM_ATTEMPTS_BEFORE_POLLING = 2;
const STREAM_RETRY_WHILE_POLLING_MS = 60_000;

/**
 * A cross-origin fetch blocked by missing CORS headers rejects with an opaque
 * TypeError ("Load failed" on Safari, "Failed to fetch" on Chrome) — the same
 * shape as a dead host. Say what it most likely is instead of echoing that.
 */
function describeStreamFailure(message: string): string {
  const opaque = /load failed|failed to fetch|network ?error/i.test(message);
  return opaque
    ? "Live stream blocked — the /events response carries no CORS headers (the orchestrator's SSE route bypasses @fastify/cors). Polling every 10s instead."
    : `Live stream unavailable (${message}). Polling every 10s instead.`;
}

/**
 * Error bodies are usually JSON — a plain `{error}`/`{message}` string, or a
 * zod validation shape (`{detail: [{path, message}]}` or similar). Turn
 * whichever one shows up into one readable line; fall back to the raw text
 * (already truncated by the caller) for anything else, e.g. an HTML 502 page.
 */
function extractErrorDetail(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return raw;
  const obj = parsed as Record<string, unknown>;

  const issueText = (issue: unknown): string | null => {
    if (typeof issue === "string") return issue;
    if (issue && typeof issue === "object") {
      const i = issue as Record<string, unknown>;
      const path = Array.isArray(i.path) ? i.path.join(".") : undefined;
      const message = typeof i.message === "string" ? i.message : undefined;
      if (path && message) return `${path}: ${message}`;
      if (message) return message;
    }
    return null;
  };

  for (const key of ["detail", "issues", "errors"]) {
    const value = obj[key];
    if (Array.isArray(value)) {
      const lines = value.map(issueText).filter((x): x is string => !!x);
      if (lines.length) return lines.join("; ");
    } else if (typeof value === "string") {
      return value;
    }
  }
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.error === "string") return obj.error;
  return raw;
}

function parseFrame(frame: string): StreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keepalive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  if (!STREAM_TYPES.has(event)) return null;
  try {
    return { type: event as StreamEvent["type"], data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

export function createApi(credentials: Credentials): InternsApi {
  return new InternsApi(credentials);
}
