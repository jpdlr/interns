/**
 * Entry point: wire config → db → registry → engine → discord → api →
 * orchestrator loop, with graceful shutdown on SIGINT/SIGTERM.
 */
import { loadConfig, internsHome, saveConfig } from "./config.js";
import { ApprovalService } from "./approvals.js";
import { CapabilityService } from "./capabilities.js";
import { Db } from "./db.js";
import { DiscordAdapter } from "./discord.js";
import { SdkEngine } from "./engine.js";
import { EventBus } from "./events.js";
import { GithubClient } from "./github.js";
import { GithubWatcher } from "./githubwatch.js";
import { MailWatcher } from "./mailwatch.js";
import { MeetingWatcher } from "./meetingwatch.js";
import { Orchestrator } from "./orchestrator.js";
import { PushService, wirePushNotifications } from "./push.js";
import { ConnectorService } from "./connectors.js";
import { GooglePhotos } from "./photos.js";
import { DraftLearner } from "./draftlearn.js";
import { localZone, setProfile } from "./profile.js";
import { migrateSchedules } from "./schedules.js";
import { Registry } from "./registry.js";
import { wireSuggestionDecisions } from "./suggest.js";

async function main(): Promise<void> {
  const home = internsHome();
  const config = loadConfig(home);
  setProfile(config);
  const bus = new EventBus();
  const db = new Db(bus, home);
  db.apiToken = config.api_token; // attachments carry HMAC-signed download URLs
  const registry = new Registry(home);

  // Crons used to run on this machine's clock; move them to the owner's zone once.
  if (!config.schedules_local) {
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const result = migrateSchedules(registry, config, machineZone, localZone());
    saveConfig(config, home);
    for (const c of result.changed) console.log(`[schedules] ${c.what}: "${c.from}" → "${c.to}" (${machineZone} → ${localZone()})`);
    if (result.unconverted.length) {
      const list = result.unconverted.map((u) => `- **${u.what}**: \`${u.cron}\``).join("\n");
      db.createCard({
        intern: "coordinator",
        title: "Check these schedules",
        body: `Schedules now run on your clock (${localZone()}) instead of the server's (${machineZone}). These couldn't be moved automatically, so they now fire at the same clock time in your zone:\n\n${list}`,
        severity: "action",
        actions: [{ id: "ok", label: "Got it", style: "primary", kind: "button" }],
      });
    }
  }

  // Mirror on-disk manifests into db identity rows (manifests are truth).
  for (const { slug, manifest } of registry.list()) {
    db.upsertIntern({ slug, name: manifest.name, role: manifest.role, icon: manifest.icon });
  }

  const engine = new SdkEngine(db, registry, config);
  const capabilities = new CapabilityService(db, registry, config, home);
  // Forge is a permanent systems role, not a per-integration specialist. It is
  // created deterministically on first upgraded start and remains idle until
  // the owner approves a capability build.
  capabilities.ensureBuilder();
  const github = new GithubClient(config.github);
  const approvals = new ApprovalService(db, capabilities, github, registry);
  const githubwatch = new GithubWatcher(db, registry, config, github);
  const discord = new DiscordAdapter(db, registry, bus, config, approvals, capabilities);
  const mailwatch = new MailWatcher(db, registry, config, { home });
  const meetingwatch = new MeetingWatcher(db, registry, config, { home });
  const push = new PushService(db, config);
  // Connectors: Outlook sign-in and the GitHub App flow from the app (connectors.ts)
  // Google Photos: photos the owner picks, copied into a library interns can browse (photos.ts)
  const photos = new GooglePhotos(home, registry);
  const connectors = new ConnectorService({ db, registry, config, home, github, githubwatch, mailwatch, photos });
  const orchestrator = new Orchestrator(db, registry, engine, config, mailwatch, discord, push);
  orchestrator.suggestHome = home;
  wireSuggestionDecisions(bus, home, capabilities);

  await discord.start();
  const api = await (await import("./api.js")).startApi({
    db,
    registry,
    bus,
    config,
    discord,
    push,
    approvals,
    capabilities,
    github,
    orchestrator,
    home,
    connectors,
    photos,
  });
  const notifier = wirePushNotifications(bus, registry, push, db);
  // learn from the owner's draft edits: sent drafts are compared every half hour (draftlearn.ts)
  const draftLearner = new DraftLearner(db, registry, config, { home });
  setInterval(() => void draftLearner.tick().catch((err) => console.error("[draftlearn] tick failed:", err)), 30 * 60_000);
  // summaries at JP's summary times / when quiet hours end; daily "you never open these" check
  setInterval(() => void notifier.tick().catch((err) => console.error("[notify] tick failed:", err)), 20_000);
  orchestrator.start();
  mailwatch.start();
  meetingwatch.start();
  githubwatch.start();

  console.log(
    `[interns] up — home=${home} api=http://127.0.0.1:${config.port} ` +
      `interns=${registry.list().length} discord=${config.discord.dry_run ? "dry_run" : "live"}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[interns] ${signal} — shutting down`);
    await mailwatch.stop();
    await meetingwatch.stop();
    await githubwatch.stop();
    await orchestrator.stop();
    await discord.stop();
    await api.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Safety nets: a stray rejection must never take the whole office down.
  process.on("unhandledRejection", (err) => console.error("[interns] unhandled rejection:", err));
  process.on("uncaughtException", (err) => console.error("[interns] uncaught exception:", err));
}

main().catch((err) => {
  console.error("[interns] fatal:", err);
  process.exit(1);
});
