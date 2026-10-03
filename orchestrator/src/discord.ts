/**
 * Discord adapter — a renderer of backend state, never the source of truth.
 *
 * - one channel per intern; outbound identity via per-intern webhook
 *   (username + avatar_url override, like the follow-up bot)
 * - cards render as embed + button rows; custom_id scheme follows
 *   the older follow-up bot's "fu:<action>[:arg]" style → here "card:<cardId>:<actionId>"
 * - button click → resolve card in db → edit the embed in place (footer stamp,
 *   buttons removed), same UX as bot.py's stamp_card()
 * - #office takes plain-text commands for now: !hire <role>, !confirm [icon],
 *   !standup, !status (slash commands later)
 * - dry_run (default true): every outbound call is logged instead of sent;
 *   the gateway is never connected. NO tokens are ever hardcoded here.
 *
 * NOTE: plain messages go out via webhook (identity override), but cards go
 * out via the bot user in the intern's channel — ordinary channel webhooks
 * can't carry interactive components.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type Interaction,
  type Message as DiscordMessage,
} from "discord.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AttachmentStore } from "./attachments.js";
import { renderRichBlocks, type RenderedImage } from "./render.js";
import { internsHome, type Config } from "./config.js";
import type { ApprovalService } from "./approvals.js";
import type { CapabilityService } from "./capabilities.js";
import type { Db } from "./db.js";
import { confirmHire, hire, NameTakenError, takenNames } from "./hire.js";
import { standup, stripRichBlocks } from "./standup.js";
import type { Registry } from "./registry.js";
import type { EventBus } from "./events.js";
import type { Attachment, CapabilityRequirement, Card, CardAction, InternManifest, Message } from "./types.js";
import { ICONS, AVATAR_PNG_DIR } from "./icons.js";
import { coordinatorName } from "./profile.js";

interface PendingHire {
  draft: InternManifest;
  requiredCapabilities: CapabilityRequirement[];
  roughRole: string;
  icon: string;
}

const SEVERITY_COLOR: Record<Card["severity"], number> = {
  info: 0x3b82f6,
  action: 0xf59e0b,
  urgent: 0xef4444,
};

/** Discord's hard per-message cap is 2000 chars; keep headroom below it. */
const DISCORD_CHUNK_LIMIT = 1900;

/**
 * Split text into Discord-safe chunks (≤ `limit` chars each).
 *
 * Break preference: paragraph (`\n\n`) → line (`\n`) → sentence end
 * (`. `/`! `/`? `) → space → hard cut (only when a single unbroken token
 * exceeds the limit, since there's nowhere else to cut). Never splits
 * mid-word except in that last-resort case.
 *
 * If a split lands inside a fenced ``` code block, the fence is closed at
 * the end of the chunk and reopened (same info string, e.g. ```ts) at the
 * start of the next chunk, so each chunk renders as valid markdown on its
 * own.
 */
export function chunkMessage(text: string, limit: number = DISCORD_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  // Reserve headroom for fence-close/reopen markers added in the second pass.
  const splitBudget = Math.max(1, limit - 24);
  const raw: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const [head, tail] = splitChunk(rest, splitBudget);
    raw.push(head);
    rest = tail;
  }
  if (rest.length) raw.push(rest);
  // Fence close/reopen markers can push a chunk past the reserve when the fence
  // info string is long — enforce Discord's hard cap as a final safety net.
  return preserveCodeFences(raw).flatMap((c) => {
    const hard: string[] = [];
    for (let i = 0; i < c.length; i += 1996) hard.push(c.slice(i, i + 1996));
    return hard;
  });
}

/** Find one split point in `text` within the first `limit` chars, honoring the break preference. */
function splitChunk(text: string, limit: number): [head: string, tail: string] {
  const window = text.slice(0, limit);

  let cut = window.lastIndexOf("\n\n");
  if (cut > 0) return [text.slice(0, cut), text.slice(cut + 2)];

  cut = window.lastIndexOf("\n");
  if (cut > 0) return [text.slice(0, cut), text.slice(cut + 1)];

  let sentenceCut = -1;
  for (const m of window.matchAll(/[.!?]\s/g)) sentenceCut = m.index! + 1;
  if (sentenceCut > 0) return [text.slice(0, sentenceCut), text.slice(sentenceCut + 1)];

  cut = window.lastIndexOf(" ");
  if (cut > 0) return [text.slice(0, cut), text.slice(cut + 1)];

  // No safe boundary anywhere in the window — a single token longer than the
  // limit (e.g. a URL). Hard-cut as a last resort; this is the only case
  // that can split mid-word.
  return [text.slice(0, limit), text.slice(limit)];
}

/** Second pass: close/reopen ``` fences that a split landed inside of. */
function preserveCodeFences(chunks: string[]): string[] {
  const fenceLine = /^```.*$/;
  let carry: string | null = null; // fence-opening line to prepend to the next chunk
  const out: string[] = [];
  for (const piece of chunks) {
    let chunk = carry !== null ? `${carry}\n${piece}` : piece;
    let inFence = false;
    let fenceOpenLine = "```";
    for (const line of chunk.split("\n")) {
      if (fenceLine.test(line)) {
        if (!inFence) {
          inFence = true;
          fenceOpenLine = line;
        } else {
          inFence = false;
        }
      }
    }
    if (inFence) {
      chunk = `${chunk}\n\`\`\``;
      carry = fenceOpenLine;
    } else {
      carry = null;
    }
    out.push(chunk);
  }
  return out;
}

const BUTTON_STYLE: Record<CardAction["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  neutral: ButtonStyle.Secondary,
};

export class DiscordAdapter {
  private client: Client | null = null;
  private pendingHires = new Map<string, PendingHire>(); // office channel → pending hire
  private unsubscribe: (() => void)[] = [];
  private provisioning = new Map<string, Promise<TextChannel | null>>();

  constructor(
    private db: Db,
    private registry: Registry,
    private bus: EventBus,
    private config: Config,
    private approvals?: ApprovalService,
    private capabilities?: CapabilityService,
  ) {}

  private get dryRun(): boolean {
    return this.config.discord.dry_run || !this.config.discord.bot_token;
  }

  async start(): Promise<void> {
    // Render backend state changes regardless of dry_run (dry_run just logs).
    this.unsubscribe.push(
      this.bus.on("message", (msg) => void this.onBackendMessage(msg)),
      this.bus.on("card", (card) => void this.sendCard(card)),
      this.bus.on("card_state", (card) => void this.onCardStateChanged(card)),
    );

    if (this.dryRun) {
      console.log("[discord] dry_run — gateway not connected, outbound calls will be logged");
      return;
    }

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.client.on(Events.MessageCreate, (msg) =>
      this.onDiscordMessage(msg).catch(async (err) => {
        console.error("[discord] message handler error:", err);
        await msg.reply(`⚠️ That fell over: ${String(err).slice(0, 300)}`).catch(() => {});
      }),
    );
    this.client.on(Events.InteractionCreate, (interaction) =>
      this.onInteraction(interaction).catch((err) => console.error("[discord] interaction handler error:", err)),
    );
    await this.client.login(this.config.discord.bot_token);
    console.log("[discord] gateway connected");
    await this.reconcileInternChannels();
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    await this.client?.destroy();
    this.client = null;
  }

  // ------------------------------------------------------------ outbound

  private avatarUrl(icon: string): string | undefined {
    const base = this.config.discord.avatar_base_url;
    return base ? `${base.replace(/\/$/, "")}/${icon}.png` : undefined;
  }

  /**
   * Plain intern message → the thread's channel webhook, chunked to fit
   * Discord's 2000-char cap. `speakerSlug` overrides the identity so a
   * handoff reply in Tessa's channel is shown as Rhea.
   */
  async send(internSlug: string, text: string, speakerSlug?: string): Promise<void> {
    const intern = this.db.getIntern(internSlug);
    const speaker = speakerSlug && speakerSlug !== internSlug ? (this.db.getIntern(speakerSlug) ?? intern) : intern;
    const username = speaker?.name ?? speakerSlug ?? internSlug;
    const avatarUrl = speaker ? this.avatarUrl(speaker.icon) : undefined;
    // Charts / drawings / diagrams become PNGs on the last chunk; the text keeps a numbered placeholder.
    const rendered = await renderRichBlocks(text);
    const chunks = chunkMessage(rendered.text);
    // Webhook messages carry identity per-message, so every chunk repeats it.
    for (const [i, content] of chunks.entries()) {
      const images = i === chunks.length - 1 ? rendered.images : [];
      const payload = { content, username, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) };
      if (this.dryRun || !intern?.discord_webhook_url) {
        console.log(`[discord dry] webhook message as ${username}: ${content.slice(0, 120)}${images.length ? ` +${images.length} image(s)` : ""}`);
        continue;
      }
      if (images.length) {
        await fetch(intern.discord_webhook_url, { method: "POST", body: webhookForm(payload, images) });
      } else {
        await fetch(intern.discord_webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
    }
  }

  /**
   * JP renamed/re-iconned an intern (via the manifest PATCH route) → keep the
   * webhook's display identity in sync. Goes straight to the webhook URL (like
   * `send()`), so it works without a connected gateway client. Best-effort:
   * caller must not let a Discord failure fail the manifest write, so every
   * failure path here logs and returns rather than throwing.
   */
  async updateWebhookIdentity(slug: string, manifest: InternManifest): Promise<void> {
    if (this.dryRun) {
      console.log(`[discord dry] would update webhook identity for ${slug} → name=${manifest.name} icon=${manifest.icon}`);
      return;
    }
    const intern = this.db.getIntern(slug);
    if (!intern?.discord_webhook_url) return;
    try {
      const payload: Record<string, unknown> = { name: manifest.name };
      const png = join(AVATAR_PNG_DIR, `${manifest.icon}.png`);
      if (existsSync(png)) {
        payload.avatar = `data:image/png;base64,${readFileSync(png).toString("base64")}`;
      }
      const res = await fetch(intern.discord_webhook_url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error(`[discord] webhook identity update for ${slug} failed: ${res.status} ${await res.text().catch(() => "")}`);
      }
    } catch (err) {
      console.error(`[discord] webhook identity update for ${slug} errored:`, err);
    }
  }

  /**
   * Plain text → #office, bot identity (not a webhook — #office has no
   * per-intern identity to override), chunked to fit Discord's 2000-char cap
   * so a long standup digest doesn't truncate. Used by the scheduled
   * standup (orchestrator.ts's OfficePoster dependency).
   */
  async postToOffice(text: string): Promise<void> {
    const rendered = await renderRichBlocks(text);
    const chunks = chunkMessage(rendered.text);
    if (this.dryRun) {
      for (const chunk of chunks) console.log(`[discord dry] office message: ${chunk.slice(0, 120)}`);
      if (rendered.images.length) console.log(`[discord dry] office images: ${rendered.images.map((i) => i.name).join(", ")}`);
      return;
    }
    const channel = await this.channelFor("coordinator");
    if (!channel) return;
    for (const [i, chunk] of chunks.entries()) {
      const files = i === chunks.length - 1 ? rendered.images.map((img) => ({ attachment: img.png, name: img.name })) : [];
      await channel.send(files.length ? { content: chunk, files } : chunk);
    }
  }

  /**
   * Fired an intern: best-effort farewell line + rename their channel to
   * `archived-<slug>` so it's visibly retired but history stays browsable.
   * Each step is independently wrapped — a failed farewell must not skip the
   * rename, and neither may ever throw into the caller (api.ts's /archive).
   */
  async archiveIntern(slug: string, manifest: InternManifest): Promise<void> {
    if (this.dryRun) {
      console.log(`[discord dry] would post farewell + rename channel for ${slug} → archived-${slug}`);
      return;
    }
    const channel = await this.channelFor(slug);
    if (!channel) return;
    try {
      await channel.send(`👋 ${manifest.name} has been let go. Thanks for the work — archiving this channel.`);
    } catch (err) {
      console.error(`[discord] farewell message for ${slug} failed:`, err);
    }
    try {
      await channel.setName(`archived-${slug}`);
    } catch (err) {
      console.error(`[discord] channel rename for ${slug} failed:`, err);
    }
  }

  /** Card → embed + button rows in the intern's channel (bot identity). */
  async sendCard(card: Card): Promise<void> {
    const rendered = await renderRichBlocks(card.body);
    const embed = this.cardEmbed(card, rendered.text);
    const rows = this.cardRows(card);
    // The first chart/diagram becomes the embed image; any others ride along as plain attachments.
    const files = rendered.images.map((img) => ({ attachment: img.png, name: img.name }));
    if (files[0]) embed.setImage(`attachment://${files[0].name}`);
    if (this.dryRun) {
      console.log(`[discord dry] card ${card.id} (${card.severity}) "${card.title}" with ${card.actions.length} actions${files.length ? ` +${files.length} image(s)` : ""}`);
      return;
    }
    const channel = await this.channelFor(card.intern);
    if (!channel) return;
    const msg = await channel.send({ embeds: [embed], components: rows, files });
    this.db.setCardDiscordMessage(card.id, msg.id);
  }

  private cardEmbed(card: Card, body: string = stripRichBlocks(card.body)): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(card.title.slice(0, 256))
      .setDescription(body.slice(0, 4000))
      .setColor(SEVERITY_COLOR[card.severity])
      .setFooter({ text: `${card.intern} · ${card.state}` });
  }

  private cardRows(card: Card): ActionRowBuilder<ButtonBuilder>[] {
    if (card.actions.length === 0 || card.state !== "open") return [];
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < card.actions.length; i += 5) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          card.actions.slice(i, i + 5).map((action) =>
            new ButtonBuilder()
              .setCustomId(`card:${card.id}:${action.id}`)
              .setLabel(action.label.slice(0, 80))
              .setStyle(BUTTON_STYLE[action.style]),
          ),
        ),
      );
    }
    return rows;
  }

  /** Backend card state changed (e.g. resolved via app) → edit embed in place. */
  private async onCardStateChanged(card: Card): Promise<void> {
    if (this.dryRun) {
      console.log(`[discord dry] card ${card.id} → ${card.state} (${card.resolution?.via ?? "?"}:${card.resolution?.action ?? "?"})`);
      return;
    }
    if (!card.discord_message_id || card.resolution?.via === "discord") return; // discord path edits inline
    const channel = await this.channelFor(card.intern);
    if (!channel) return;
    const msg = await channel.messages.fetch(card.discord_message_id).catch(() => null);
    if (!msg) return;
    const embed = this.cardEmbed(card).setColor(0x2b2d31);
    await msg.edit({ embeds: [embed], components: [] });
  }

  private async onBackendMessage(msg: Message): Promise<void> {
    // Only render intern/coordinator output; JP's own messages came from a surface.
    if (msg.author === "jp") return;
    // A message is re-emitted once its attachments are linked (orchestrator.ts);
    // the text went out on the first emit, so only the files go out now.
    const seen = this.sentMessageIds.has(msg.id);
    this.sentMessageIds.add(msg.id);
    if (this.sentMessageIds.size > 500) this.sentMessageIds.delete(this.sentMessageIds.values().next().value!);
    if (msg.intern.startsWith("room-")) {
      // Group chats have no channel of their own: mirror them into #office.
      if (!seen && msg.text.trim()) {
        const room = this.db.getRoom(msg.intern);
        const who = msg.author === "coordinator" ? coordinatorName() : (this.db.getIntern(msg.speaker ?? "")?.name ?? msg.speaker ?? msg.intern);
        await this.postToOffice(`**${who}** in _${room?.name ?? "group"}_:\n${stripRichBlocks(msg.text)}`);
      }
      return;
    }
    if (!seen && msg.text.trim()) await this.send(msg.intern, msg.text, msg.speaker ?? undefined);
    if (msg.attachments.length) await this.sendFiles(msg.intern, msg.attachments);
  }

  private sentMessageIds = new Set<string>();

  /** Attach files to the intern's channel via the webhook (multipart). Discord caps free uploads at 8 MB each. */
  private async sendFiles(internSlug: string, attachments: Attachment[]): Promise<void> {
    const intern = this.db.getIntern(internSlug);
    const username = intern?.name ?? internSlug;
    const store = new AttachmentStore(internsHome());
    const form = new FormData();
    let count = 0;
    const skipped: string[] = [];
    for (const att of attachments) {
      if (att.size > 8 * 1024 * 1024) {
        skipped.push(att.name);
        continue;
      }
      const file = store.locate(att.intern, att.id, att.ext);
      if (!file) continue;
      form.append(`files[${count}]`, new Blob([readFileSync(file)], { type: att.mime }), att.name);
      count++;
      if (count === 10) break; // Discord's per-message cap
    }
    const note = skipped.length ? `(${skipped.join(", ")} too large for Discord — open it in the app)` : "";
    if (count === 0 && !note) return;
    const avatarUrl = intern ? this.avatarUrl(intern.icon) : undefined;
    form.append("payload_json", JSON.stringify({ content: note, username, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) }));
    if (this.dryRun || !intern?.discord_webhook_url) {
      console.log(`[discord dry] webhook files as ${username}: ${attachments.map((a) => a.name).join(", ")}`);
      return;
    }
    const res = await fetch(intern.discord_webhook_url, { method: "POST", body: form });
    if (!res.ok) console.error(`[discord] file upload for ${internSlug} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  /** Resolve the intern's text channel via its stored discord_channel_id. */
  private async channelFor(internSlug: string): Promise<TextChannel | null> {
    if (!this.client) return null;
    const channelId =
      internSlug === "coordinator"
        ? this.config.discord.office_channel_id
        : this.db.getIntern(internSlug)?.discord_channel_id;
    if (!channelId) return null;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    return channel instanceof TextChannel ? channel : null;
  }

  // ------------------------------------------------------------- inbound

  private async onDiscordMessage(msg: DiscordMessage): Promise<void> {
    if (msg.author.bot || !msg.guild) return;
    if (msg.channelId === this.config.discord.office_channel_id) {
      await this.handleOfficeCommand(msg);
      return;
    }
    // Message in an intern channel → record as JP's message + enqueue a task.
    const intern = this.db
      .listInterns()
      .find((i) => i.discord_channel_id === msg.channelId);
    if (!intern) return;
    this.db.addMessage({ intern: intern.slug, author: "jp", text: msg.content, surface: "discord" });
    this.db.enqueueTask(intern.slug, "message", { text: msg.content });
  }

  /** Reply with text that may exceed Discord's 2000-char cap, sent as sequential in-order chunks. */
  private async replyChunked(msg: DiscordMessage, text: string): Promise<void> {
    const chunks = chunkMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) await msg.reply(chunks[i]!);
      else if (msg.channel.isSendable()) await msg.channel.send(chunks[i]!);
    }
  }

  private async handleOfficeCommand(msg: DiscordMessage): Promise<void> {
    const [cmd, ...rest] = msg.content.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "!hire": {
        if (!arg) return void msg.reply("Usage: `!hire <rough role description>`");
        await msg.reply(`Interviewing candidates for: *${arg.slice(0, 200)}* …`);
        const candidate = await hire(arg, takenNames({ db: this.db, registry: this.registry }));
        const pending: PendingHire = {
          draft: candidate.draft,
          requiredCapabilities: candidate.required_capabilities,
          roughRole: arg,
          icon: "face-01",
        };
        this.pendingHires.set(msg.channelId, pending);
        await msg.reply(this.hireCardPayload(pending));
        break;
      }
      case "!confirm": {
        const pending = this.pendingHires.get(msg.channelId);
        if (!pending) return void msg.reply("No pending hire — `!hire <role>` first.");
        let hired: ReturnType<typeof confirmHire>;
        try {
          hired = confirmHire(
            pending.draft,
            arg || pending.icon,
            { db: this.db, registry: this.registry },
            pending.requiredCapabilities,
          );
        } catch (err) {
          // The card stays pending so JP can hit Re-roll for a different name.
          if (err instanceof NameTakenError) return void msg.reply(`${err.message} Hit Re-roll on the card for a fresh draft.`);
          throw err;
        }
        this.pendingHires.delete(msg.channelId);
        const { slug, manifest } = hired;
        for (const requirement of pending.requiredCapabilities) this.capabilities?.request(slug, requirement);
        await this.ensureInternChannel(slug, manifest, msg.guild);
        await msg.reply(`Hired **${manifest.name}** (\`${slug}\`). Welcome aboard.`);
        break;
      }
      case "!status": {
        const lines = this.db.listInterns().map((i) => {
          const spend = this.db.spendToday(i.slug);
          const queued = this.db.countTasks(i.slug, "queued");
          const running = this.db.countTasks(i.slug, "running");
          const paused = this.db.countTasks(i.slug, "paused");
          return `**${i.name}** (\`${i.slug}\`) — ${running ? "working" : paused ? "paused" : queued ? "queued" : "idle"}, today ${spend.input_tokens + spend.output_tokens} tok / $${spend.cost_usd.toFixed(2)}`;
        });
        await this.replyChunked(msg, lines.join("\n") || "No interns yet — `!hire <role>`.");
        break;
      }
      case "!standup": {
        await msg.reply("Collecting the standup…");
        const digest = await standup(this.db);
        await this.replyChunked(msg, digest);
        break;
      }
    }
  }

  /** The hire draft as a card: embed + icon select + Hire/Re-roll buttons. */
  private hireCardPayload(pending: PendingHire) {
    const { draft, icon } = pending;
    const iconLabel = ICONS.find((i) => i.id === icon)?.label ?? icon;
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`🎓 ${draft.name} — ${draft.role}`)
      .setDescription(draft.persona)
      .addFields(
        { name: "Tools", value: draft.tools.map((t) => `\`${t}\``).join(" ") || "none", inline: false },
        {
          name: "Capabilities to build/approve",
          value:
            pending.requiredCapabilities.map((r) => `• \`${r.id}\` — ${r.reason}`).join("\n").slice(0, 1024) || "none",
          inline: false,
        },
        { name: "Backlog", value: draft.backlog.map((b) => `• ${b}`).join("\n").slice(0, 1024) || "—", inline: false },
        { name: "Icon", value: `${icon} · ${iconLabel}`, inline: false },
      )
      .setFooter({ text: "Pick an icon, then Hire — or Re-roll for a new candidate." });
    const select = new StringSelectMenuBuilder()
      .setCustomId("hire:icon")
      .setPlaceholder("Choose an avatar…")
      .addOptions(ICONS.map((i) => ({ label: i.label.slice(0, 100), value: i.id, default: i.id === icon })));
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("hire:confirm").setLabel("Hire").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hire:reroll").setLabel("Re-roll").setEmoji("🎲").setStyle(ButtonStyle.Secondary),
    );
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), buttons],
    };
  }

  /**
   * Ensure an intern has exactly one usable Discord channel + webhook binding.
   *
   * App hires and permanent system roles do not originate from a Discord guild
   * interaction, so startup reconciliation calls this for every active intern.
   * Existing channels are adopted by slug before a new one is created, making
   * restarts and retries safe from duplicate channels.
   */
  async ensureInternChannel(
    slug: string,
    manifest: InternManifest,
    interactionGuild: Guild | null = null,
  ): Promise<TextChannel | null> {
    if (this.dryRun) {
      console.log(`[discord dry] would ensure #${slug} + webhook for ${manifest.name}`);
      return null;
    }
    const pending = this.provisioning.get(slug);
    if (pending) return pending;
    const work = this.ensureInternChannelOnce(slug, manifest, interactionGuild).finally(() => {
      this.provisioning.delete(slug);
    });
    this.provisioning.set(slug, work);
    return work;
  }

  /** Repair Discord bindings for app-created hires and permanent roles. */
  async reconcileInternChannels(): Promise<void> {
    if (this.dryRun) return;
    for (const { slug, manifest } of this.registry.list()) {
      try {
        await this.ensureInternChannel(slug, manifest);
      } catch (err) {
        console.error(`[discord] could not reconcile #${slug}:`, err);
      }
    }
  }

  private async ensureInternChannelOnce(
    slug: string,
    manifest: InternManifest,
    interactionGuild: Guild | null,
  ): Promise<TextChannel | null> {
    const guild = interactionGuild ?? (await this.configuredGuild());
    if (!guild) throw new Error("Discord guild is not configured or accessible");

    const row = this.db.getIntern(slug);
    let channel: TextChannel | null = null;
    if (row?.discord_channel_id) {
      const bound = await guild.channels.fetch(row.discord_channel_id).catch(() => null);
      if (bound instanceof TextChannel) channel = bound;
    }
    if (!channel) {
      const channels = await guild.channels.fetch();
      channel = channels.find((candidate) => candidate instanceof TextChannel && candidate.name === slug) as
        | TextChannel
        | undefined ?? null;
    }
    if (!channel) {
      channel = await guild.channels.create({ name: slug, type: ChannelType.GuildText });
      console.log(`[discord] created #${slug}`);
    }

    // A complete binding can be reused. If the channel was adopted or the
    // webhook was lost, create a fresh webhook and persist the repaired pair.
    if (row?.discord_channel_id === channel.id && row.discord_webhook_url) return channel;
    const png = join(AVATAR_PNG_DIR, `${manifest.icon}.png`);
    const webhook = await channel.createWebhook({
      name: manifest.name,
      ...(existsSync(png) ? { avatar: readFileSync(png) } : {}),
    });
    this.db.setDiscordBinding(slug, channel.id, webhook.url);
    console.log(`[discord] bound ${manifest.name} to #${slug}`);
    return channel;
  }

  private async configuredGuild(): Promise<Guild | null> {
    if (!this.client || !this.config.discord.guild_id) return null;
    return this.client.guilds.fetch(this.config.discord.guild_id).catch(() => null);
  }

  // -------------------------------------------------------- interactions

  private async onInteraction(interaction: Interaction): Promise<void> {
    // Hire card: icon select + Hire / Re-roll buttons
    if (interaction.isStringSelectMenu() && interaction.customId === "hire:icon") {
      const pending = this.pendingHires.get(interaction.channelId);
      if (!pending) return void interaction.reply({ content: "This hire card is stale — `!hire` again.", ephemeral: true });
      pending.icon = interaction.values[0] ?? pending.icon;
      await interaction.update(this.hireCardPayload(pending));
      return;
    }
    if (interaction.isButton() && interaction.customId === "hire:confirm") {
      const pending = this.pendingHires.get(interaction.channelId);
      if (!pending) return void interaction.reply({ content: "This hire card is stale — `!hire` again.", ephemeral: true });
      let hired: ReturnType<typeof confirmHire>;
      try {
        hired = confirmHire(pending.draft, pending.icon, { db: this.db, registry: this.registry }, pending.requiredCapabilities);
      } catch (err) {
        if (err instanceof NameTakenError) {
          return void interaction.reply({ content: `${err.message} Hit Re-roll for a fresh draft.`, ephemeral: true });
        }
        throw err;
      }
      this.pendingHires.delete(interaction.channelId);
      const { slug, manifest } = hired;
      for (const requirement of pending.requiredCapabilities) this.capabilities?.request(slug, requirement);
      await this.ensureInternChannel(slug, manifest, interaction.guild);
      const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setColor(0x22c55e)
        .setFooter({ text: `✅ Hired · say hi in #${slug}` });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
    if (interaction.isButton() && interaction.customId === "hire:reroll") {
      const pending = this.pendingHires.get(interaction.channelId);
      if (!pending) return void interaction.reply({ content: "This hire card is stale — `!hire` again.", ephemeral: true });
      const embed = EmbedBuilder.from(interaction.message.embeds[0]!).setFooter({ text: "🎲 Re-rolling…" });
      await interaction.update({ embeds: [embed], components: [] });
      const candidate = await hire(pending.roughRole, takenNames({ db: this.db, registry: this.registry }));
      pending.draft = candidate.draft;
      pending.requiredCapabilities = candidate.required_capabilities;
      await interaction.message.edit(this.hireCardPayload(pending));
      return;
    }

    // Buttons: custom_id = card:<cardId>:<actionId>
    if (interaction.isButton() && interaction.customId.startsWith("card:")) {
      const [, cardId, actionId] = interaction.customId.split(":");
      const card = cardId ? this.db.getCard(cardId) : undefined;
      const action = card?.actions.find((a) => a.id === actionId);
      if (!card || !action) {
        await interaction.reply({ content: "Unknown or stale card.", ephemeral: true });
        return;
      }
      if (action.kind === "button") {
        let updated: Card | undefined;
        try {
          updated = this.approvals
            ? await this.approvals.handle(card.id, action.id, { via: "discord", action: action.id })
            : this.db.resolveCard(card.id, { via: "discord", action: action.id });
        } catch (err) {
          await interaction.reply({
            content: `Could not run that approval: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1900),
            ephemeral: true,
          });
          return;
        }
        if (updated) {
          const embed = this.cardEmbed(updated).setColor(0x2b2d31);
          await interaction.update({ embeds: [embed], components: [] });
        }
      } else {
        // date/text actions collect input via modal (bot.py SnoozeModal/NoteModal pattern)
        const modal = new ModalBuilder()
          .setCustomId(`cardmodal:${card.id}:${action.id}`)
          .setTitle(action.label.slice(0, 45))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("value")
                .setLabel(action.kind === "date" ? "Date (YYYY-MM-DD or 10d/3w)" : "Note")
                .setStyle(action.kind === "date" ? TextInputStyle.Short : TextInputStyle.Paragraph)
                .setRequired(true),
            ),
          );
        await interaction.showModal(modal);
      }
      return;
    }

    // Modal submits: custom_id = cardmodal:<cardId>:<actionId>
    if (interaction.isModalSubmit() && interaction.customId.startsWith("cardmodal:")) {
      const [, cardId, actionId] = interaction.customId.split(":");
      const card = cardId ? this.db.getCard(cardId) : undefined;
      if (!card || !actionId) return;
      const note = interaction.fields.getTextInputValue("value");
      let updated: Card | undefined;
      try {
        updated = this.approvals
          ? await this.approvals.handle(card.id, actionId, { via: "discord", action: actionId, note })
          : this.db.resolveCard(card.id, { via: "discord", action: actionId, note });
      } catch (err) {
        await interaction.reply({
          content: `Could not run that approval: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1900),
          ephemeral: true,
        });
        return;
      }
      if (updated && interaction.isFromMessage()) {
        const embed = this.cardEmbed(updated).setColor(0x2b2d31);
        await interaction.update({ embeds: [embed], components: [] });
      }
    }
  }
}

/** Multipart body for a webhook post with image attachments (payload_json + files[n]). */
function webhookForm(payload: Record<string, unknown>, images: RenderedImage[]): FormData {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  images.forEach((img, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(img.png)], { type: "image/png" }), img.name));
  return form;
}
