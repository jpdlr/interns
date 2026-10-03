/**
 * Config lives at ~/.interns/config.json (0600). Created with defaults and a
 * freshly generated API bearer token on first run. INTERNS_HOME overrides the
 * base dir (used by the smoke test).
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import webpush from "web-push";

export const ConfigSchema = z.object({
  /** what the interns call you — in their prompts, greetings and standups */
  owner_name: z.string().min(1).default("Boss"),
  /** the front desk's name: the orchestrator's own voice in chats, standups and notifications */
  coordinator_name: z.string().min(1).default("Coordinator"),
  /** IANA time zone for Today, agendas and calendar times; empty = this machine's zone */
  timezone: z.string().default(""),
  /**
   * true once crons (intern schedules, standup_cron, suggest_cron) are written
   * in the owner's `timezone`. Older installs matched them on the server's
   * clock; startup migrates them once (schedules.ts) and sets this.
   */
  schedules_local: z.boolean().default(false),
  /** set when the app's first-run setup finishes; empty = show setup (unless a crew already exists) */
  setup_completed_at: z.string().default(""),
  /** localhost-only HTTP API port */
  port: z.number().int().default(7810),
  /** static bearer token for the HTTP API, generated on first run */
  api_token: z.string().default(""),
  heartbeat_minutes: z.number().positive().default(5),
  /** running tasks older than this are marked failed by the heartbeat */
  stale_task_minutes: z.number().positive().default(30),
  /** min gap between auto-enqueued backlog runs per intern */
  backlog_cooldown_minutes: z.number().positive().default(240),
  /** when true (default), idle backlog picks go through a cheap LLM judgment call (advisor.ts); when false, plain FIFO (backlog[0]) */
  idle_advisor: z.boolean().default(true),
  /** when true (default), an un-addressed message in a group chat goes through a cheap responder pre-check (responders.ts) instead of waking every member */
  room_responder_precheck: z.boolean().default(true),
  /** weekly coordinator suggestions (hire / integration / schedule ideas from the evidence) — 5-field cron, heartbeat-driven */
  suggest_cron: z.string().default("0 8 * * 1"),
  /** when false the weekly pass is skipped; POST /suggest/run still works */
  suggest_enabled: z.boolean().default(true),
  /** one day a month the standup arrives in a surprise voice (limerick, weather report…); false = always plain */
  standup_easter_eggs: z.boolean().default(true),
  /** 5-field cron for the automatic morning standup, in the owner's time zone (heartbeat-driven, same guard as intern crons) */
  standup_cron: z.string().default("0 7 * * 1-5"),
  /** how often mailwatch polls the graph-mail CLI for new inbox mail */
  mail_poll_minutes: z.number().positive().default(2),
  /** min gap between mail-trigger tasks per intern+mailbox (layer 2 batching) */
  mail_trigger_cooldown_minutes: z.number().positive().default(30),
  /** oldest a batched message may sit before it forces a trigger regardless of cooldown */
  mail_batch_max_wait_minutes: z.number().positive().default(120),
  /** how often meetingwatch polls the graph-cal CLI for upcoming calendar events */
  meeting_poll_minutes: z.number().positive().default(5),
  /** how far ahead of a meeting's start the pre-meeting brief should fire */
  meeting_brief_lead_minutes: z.number().positive().default(25),
  /** minutes after a briefed meeting ends before its intern asks the owner how it went (0 disables debriefs) */
  debrief_after_minutes: z.number().nonnegative().default(10),
  /** your own organisations' email domains: attendees outside these make a meeting "external" (debriefs, Today) */
  own_domains: z.array(z.string()).default([]),
  /**
   * Outlook mailboxes the interns may read and draft in (Microsoft Graph).
   * Each id is a directory under ~/.interns/mailboxes/<id> holding that
   * mailbox's token cache — create one with `tools/graph-login --mailbox <id>`.
   * The first is the default. Empty = no mail or calendar features.
   */
  mailboxes: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)).default([]),
  /** the one mailbox whose calendar drives meeting briefs and Today; empty = the first mailbox */
  calendar_mailbox: z.string().default(""),
  /** Microsoft Entra app registration used by graph-login / graph-mail / graph-cal */
  graph: z
    .object({
      /** "Application (client) ID" of a public-client app registration with device code flow enabled */
      client_id: z.string().default(""),
      /** "organizations", "common", "consumers" or a tenant id */
      authority: z.string().default("organizations"),
    })
    .prefault({}),
  /**
   * Layer 1 of mail triage: deterministic, free, regex-based filtering.
   * Messages matching ignore_from/ignore_subject are dropped before watermark/
   * trigger logic ever sees them (they still advance the watermark — never
   * re-surface). vip_from messages skip cooldown and the layer-3 LLM gate.
   * All patterns are case-insensitive regexes.
   */
  mail_triage: z
    .object({
      ignore_from: z
        .array(z.string())
        .default(["noreply", "no-reply", "notifications?@", "mailer-daemon", "newsletter", "list-"]),
      ignore_subject: z.array(z.string()).default(["unsubscribe"]),
      vip_from: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** API bind address — set to the Tailscale IP to let the phone app connect. */
  bind: z.string().default("127.0.0.1"),
  discord: z
    .object({
      bot_token: z.string().default(""),
      guild_id: z.string().default(""),
      office_channel_id: z.string().default(""),
      /** e.g. https://example.com/avatars — icon id is appended as <icon>.png */
      avatar_base_url: z.string().default(""),
      /** when true (default) nothing is sent to Discord; intended sends are logged */
      dry_run: z.boolean().default(true),
    })
    .prefault({}),
  engine: z
    .object({
      /** empty = Agent SDK default model */
      model: z.string().default(""),
      max_turns: z.number().int().positive().default(25),
      /**
       * "dontAsk": interns can use only their granted tools and their own
       * directory; anything else is denied. "bypassPermissions": every tool
       * runs (the grants become advisory) — only on a machine you'd let the
       * agents operate freely.
       */
      permission_mode: z.enum(["dontAsk", "bypassPermissions"]).default("dontAsk"),
    })
    .prefault({}),
  /**
   * Web Push (VAPID). Keys are generated once on first run (see loadConfig)
   * and never printed. iOS 16.4+ only delivers push to a PWA installed to
   * the home screen — see app/README.md.
   */
  push: z
    .object({
      vapid_public: z.string().default(""),
      vapid_private: z.string().default(""),
      /** contact URI push services see in the VAPID JWT (mailto: or https:) */
      subject: z.string().default("mailto:interns@example.com"),
    })
    .prefault({}),
  /** GitHub App credentials. Private keys and webhook secrets stay outside the repository. */
  github: z
    .object({
      app_id: z.string().default(""),
      installation_id: z.string().default(""),
      /** owner login -> installation id; installation_id remains as a legacy single-account fallback */
      installation_ids: z.record(z.string(), z.string()).default({}),
      private_key_path: z.string().default(""),
      webhook_secret: z.string().default(""),
      reviewer_slug: z.string().default("code-reviewer"),
      repositories: z.array(z.string()).default([]),
      poll_minutes: z.number().positive().default(2),
      api_base_url: z.string().default("https://api.github.com"),
      /**
       * Optional second PR viewer: PRs of `codeops_owners` link to
       * `<codeops_base_url>/PullRequests/Open?repository=…&number=…` first,
       * labelled `codeops_label`. GitHub remains the review data source.
       * Empty base URL = GitHub links only.
       */
      codeops_base_url: z.union([z.literal(""), z.string().url()]).default(""),
      codeops_owners: z.array(z.string()).default([]),
      codeops_label: z.string().default("CodeOps"),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The configured time zone, or this machine's when none is set. */
export function timeZone(config: Pick<Config, "timezone">): string {
  return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The calendar mailbox id, or undefined when no mailbox is configured. */
export function calendarMailbox(config: Pick<Config, "mailboxes" | "calendar_mailbox">): string | undefined {
  return config.calendar_mailbox || config.mailboxes[0];
}

/**
 * The repository checkout this code runs from: src/ in dev (tsx), dist/src/
 * once built. Used for the app build and the avatar PNGs.
 */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../.."), path.resolve(here, "../../..")];
  return candidates.find((c) => fs.existsSync(path.join(c, "avatars"))) ?? candidates[0]!;
}

export function internsHome(): string {
  return process.env.INTERNS_HOME ?? path.join(os.homedir(), ".interns");
}

export function loadConfig(baseDir: string = internsHome()): Config {
  const file = path.join(baseDir, "config.json");
  fs.mkdirSync(baseDir, { recursive: true });
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  }
  const config = ConfigSchema.parse(raw);
  let dirty = !fs.existsSync(file);
  // A new install starts with crons in the owner's zone: nothing to migrate.
  if (dirty) config.schedules_local = true;
  if (!config.api_token) {
    config.api_token = randomBytes(24).toString("base64url");
    dirty = true;
  }
  if (!config.push.vapid_public || !config.push.vapid_private) {
    // Generated once and persisted — regenerating would silently invalidate
    // every existing browser subscription. Never logged.
    const keys = webpush.generateVAPIDKeys();
    config.push.vapid_public = keys.publicKey;
    config.push.vapid_private = keys.privateKey;
    dirty = true;
  }
  if (dirty) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  return config;
}

/** Persist an already-validated config after a deliberate runtime update. */
export function saveConfig(config: Config, baseDir: string = internsHome()): void {
  const parsed = ConfigSchema.parse(config);
  const file = path.join(baseDir, "config.json");
  const tmp = `${file}.tmp`;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
