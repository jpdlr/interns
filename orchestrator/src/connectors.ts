/**
 * Connectors: hooking the crew up to the owner's tools from the app instead
 * of a terminal.
 *
 * Outlook — one card per mailbox. "Connect" starts Microsoft's device-code
 * sign-in (tools/graph-login --json), hands the code to the app, and adds
 * the mailbox to config.mailboxes once sign-in completes. The watchers read
 * config on every poll, so nothing restarts. Before the first mailbox, the
 * owner pastes the Application (client) ID of their Entra app registration.
 *
 * GitHub — the App manifest flow, run from the orchestrator's own origin:
 * the app posts a prefilled manifest to github.com, GitHub sends the browser
 * back to /oauth/github/callback (code → App id + private key), then to the
 * installation page, then to /oauth/github/installed, which syncs the
 * installations. The owner then picks which accounts get reviews and which
 * intern reviews. Browser-side redirects only: no tunnel, no restart.
 *
 * Instagram — research only, through the owner's Business or Creator account
 * linked to a Facebook Page. The owner creates a Meta app, generates a user
 * token in Graph API Explorer and pastes it here with the app's ID and
 * secret; connecting swaps it for a long-lived token and keeps the Page's
 * token, which doesn't expire (instagram.ts). Choosing who researches here
 * grants the `instagram` tool.
 *
 * All /connectors routes are token-gated; the two /oauth/github routes are
 * plain browser navigations, guarded by one-time state (callback) or by
 * only reading from GitHub with the App's own credentials (installed).
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { saveConfig, type Config } from "./config.js";
import type { Db } from "./db.js";
import { TOOLS_DIR } from "./engine.js";
import type { GithubClient, GithubInstallation } from "./github.js";
import {
  actingScopes,
  expiry,
  GraphError,
  graphGet,
  missingScopes,
  readInstagram,
  removeInstagram,
  usesInstagram,
  writeInstagram,
  type GraphFetch,
} from "./instagram.js";
import { listMailboxes, mailboxesDir, mailboxesFor, readMailbox, usesOutlook } from "./mailboxes.js";
import type { Registry } from "./registry.js";

// ------------------------------------------------------------------ types

export type LoginState = "waiting" | "connected" | "failed" | "cancelled";

export interface LoginSession {
  id: string;
  mailbox: string;
  label: string;
  state: LoginState;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  account: string | null;
  error: string | null;
}

/** A running `graph-login --json`: JSON lines in, a kill switch out. */
export interface LoginProcess {
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export type StartLogin = (args: string[], env: NodeJS.ProcessEnv) => LoginProcess;

export interface ConnectorDeps {
  db: Db;
  registry: Registry;
  config: Config;
  home: string;
  github: Pick<GithubClient, "configured" | "getApp" | "convertManifest" | "accountType" | "listInstallations" | "resetTokens">;
  githubwatch?: { refresh(): void };
  mailwatch?: { health(mailboxId: string): { last_ok_at: string | null; last_error: string | null; failures: number } };
  /** tests inject a fake; default spawns tools/graph-login */
  startLogin?: StartLogin;
  /** tests inject a fake; default runs tools/graph-mail whoami */
  checkMailbox?: (id: string) => Promise<{ ok: boolean; unread?: number; error?: string }>;
  /** tests inject a fake Facebook; default is fetch */
  graphFetch?: GraphFetch;
  /** Google Photos (photos.ts), for the overview */
  photos?: { status(): unknown };
}

const MAILBOX_ID = /^[a-z0-9][a-z0-9_-]*$/;
const META_APP_ID = /^\d{5,20}$/;
const META_APP_SECRET = /^[0-9a-f]{32}$/i;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Free mail providers: their domain is never "one of the owner's own". */
const PERSONAL_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com", "gmail.com", "icloud.com", "yahoo.com"]);
/** One-time GitHub flow states live this long (creating or installing the App takes a minute or two). */
const GITHUB_STATE_TTL_MS = 15 * 60_000;

function defaultStartLogin(args: string[], env: NodeJS.ProcessEnv): LoginProcess {
  const child = spawn(path.join(TOOLS_DIR, "graph-login"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout! });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-2000)));
  return {
    onLine: (cb) => lines.on("line", cb),
    onExit: (cb) =>
      child.on("exit", (code) => {
        if (code && stderr.trim()) console.error(`[connectors] graph-login: ${stderr.trim()}`);
        cb(code);
      }),
    kill: () => child.kill("SIGTERM"),
  };
}

const defaultGraphFetch: GraphFetch = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) });

function defaultCheckMailbox(home: string): (id: string) => Promise<{ ok: boolean; unread?: number; error?: string }> {
  return (id) =>
    new Promise((resolve) => {
      const child = spawn(path.join(TOOLS_DIR, "graph-mail"), ["--mailbox", id, "whoami"], {
        env: { ...process.env, INTERNS_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (c) => (out += String(c)));
      const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.on("exit", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out) as { error?: string; inbox_unread?: number };
          resolve(parsed.error ? { ok: false, error: parsed.error } : { ok: true, unread: parsed.inbox_unread });
        } catch {
          resolve({ ok: false, error: out.trim().slice(0, 300) || "graph-mail gave no answer" });
        }
      });
    });
}

/** "Work" → "work"; "Willowbrook Vet" → "willowbrook-vet"; unique against `taken`. */
export function mailboxIdFor(label: string, taken: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "mailbox";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// --------------------------------------------------------------- service

export class ConnectorService {
  private sessions = new Map<string, LoginSession & { proc?: LoginProcess }>();
  /** state → the step it was issued for, by an authenticated API call; single use */
  private githubStates = new Map<string, { step: "create" | "install"; origin: string; expires: number }>();
  private appCache: { at: number; app: Awaited<ReturnType<GithubClient["getApp"]>> } | null = null;
  private checks = new Map<string, { at: string; ok: boolean; unread?: number; error?: string }>();
  private instagramCheck: { at: string; ok: boolean; followers?: number; error?: string } | null = null;
  private readonly startLogin: StartLogin;
  private readonly checkMailboxFn: (id: string) => Promise<{ ok: boolean; unread?: number; error?: string }>;
  private readonly graphFetch: GraphFetch;

  constructor(private deps: ConnectorDeps) {
    this.startLogin = deps.startLogin ?? defaultStartLogin;
    this.checkMailboxFn = deps.checkMailbox ?? defaultCheckMailbox(deps.home);
    this.graphFetch = deps.graphFetch ?? defaultGraphFetch;
  }

  private save(): void {
    saveConfig(this.deps.config, this.deps.home);
  }

  // --------------------------------------------------------- overview

  async overview() {
    return { outlook: this.outlook(), github: await this.githubStatus(), instagram: this.instagramStatus(), google_photos: this.deps.photos?.status() ?? null };
  }

  // ----------------------------------------------------------- Outlook

  outlook() {
    const { config, registry, home } = this.deps;
    const interns = registry.list();
    return {
      /** an Entra app registration is needed before the first sign-in */
      app: { client_id: config.graph.client_id || null, authority: config.graph.authority },
      calendar_mailbox: config.calendar_mailbox || config.mailboxes[0] || null,
      mailboxes: listMailboxes(home, config).map((m, i) => ({
        ...m,
        default: i === 0,
        health: this.deps.mailwatch?.health(m.id) ?? null,
        check: this.checks.get(m.id) ?? null,
        used_by: interns
          .filter(({ manifest }) => usesOutlook(manifest) && mailboxesFor(manifest, config).includes(m.id))
          .map(({ slug, manifest }) => ({ slug, name: manifest.name })),
      })),
      sessions: [...this.sessions.values()].filter((s) => s.state === "waiting").map(({ proc: _p, ...s }) => s),
    };
  }

  setOutlookApp(input: { client_id: string; authority?: string }): void {
    if (!CLIENT_ID.test(input.client_id.trim())) throw new ConnectorError(400, "That doesn't look like an Application (client) ID — it's a GUID like 00000000-0000-0000-0000-000000000000.");
    const authority = (input.authority ?? this.deps.config.graph.authority ?? "organizations").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(authority)) throw new ConnectorError(400, "Unknown sign-in audience.");
    this.deps.config.graph.client_id = input.client_id.trim();
    this.deps.config.graph.authority = authority;
    this.save();
  }

  /** Start Microsoft sign-in for a new (or existing, to reconnect) mailbox; resolves once there is a code to show. */
  startOutlookLogin(input: { label: string; mailbox?: string }): Promise<LoginSession> {
    const { config, home } = this.deps;
    if (!config.graph.client_id) throw new ConnectorError(409, "Add your Microsoft app's client ID first.");
    const label = input.label.trim() || "Outlook";
    const mailbox = input.mailbox ?? mailboxIdFor(label, [...config.mailboxes, ...[...this.sessions.values()].filter((s) => s.state === "waiting").map((s) => s.mailbox)]);
    if (!MAILBOX_ID.test(mailbox)) throw new ConnectorError(400, "Mailbox ids are lowercase letters, digits, - or _.");
    for (const s of this.sessions.values()) if (s.mailbox === mailbox && s.state === "waiting") this.cancelOutlookLogin(s.id);

    const session: LoginSession & { proc?: LoginProcess } = {
      id: randomUUID(),
      mailbox,
      label,
      state: "waiting",
      user_code: "",
      verification_uri: "",
      expires_at: "",
      account: null,
      error: null,
    };
    const proc = this.startLogin(["--mailbox", mailbox, "--label", label, "--json", "--no-config"], { ...process.env, INTERNS_HOME: home });
    session.proc = proc;
    this.sessions.set(session.id, session);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        session.state = "failed";
        session.error = "Microsoft sign-in didn't start in time.";
        reject(new ConnectorError(502, session.error));
      }, 30_000);
      proc.onLine((line) => {
        let event: { event?: string; user_code?: string; verification_uri?: string; expires_in?: number; account?: string | null; error?: string };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.event === "code" && event.user_code) {
          session.user_code = event.user_code;
          session.verification_uri = event.verification_uri ?? "https://microsoft.com/devicelogin";
          session.expires_at = new Date(Date.now() + (event.expires_in ?? 900) * 1000).toISOString();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const { proc: _p, ...shown } = session;
            resolve(shown);
          }
        } else if (event.event === "done") {
          session.account = event.account ?? null;
          this.addMailbox(mailbox, session.account);
          session.state = "connected";
        } else if (event.error) {
          session.error = event.error;
          if (session.state === "waiting") session.state = "failed";
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new ConnectorError(502, event.error));
          }
        }
      });
      proc.onExit((code) => {
        if (session.state === "waiting") {
          session.state = "failed";
          session.error ??= code === 0 ? "Sign-in ended without a mailbox." : "Sign-in didn't finish (the code may have expired).";
        }
        delete session.proc;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new ConnectorError(502, session.error ?? "Sign-in failed."));
        }
      });
    });
  }

  loginSession(id: string): LoginSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const { proc: _p, ...shown } = s;
    return shown;
  }

  cancelOutlookLogin(id: string): void {
    const s = this.sessions.get(id);
    if (!s || s.state !== "waiting") return;
    s.state = "cancelled";
    s.proc?.kill();
  }

  /** Signed in: start using the mailbox (first one becomes the calendar; a work domain becomes one of the owner's). */
  private addMailbox(id: string, account: string | null): void {
    const { config } = this.deps;
    if (!config.mailboxes.includes(id)) config.mailboxes.push(id);
    if (!config.calendar_mailbox) config.calendar_mailbox = config.mailboxes[0]!;
    const domain = account?.split("@")[1]?.toLowerCase();
    if (domain && !PERSONAL_DOMAINS.has(domain) && !config.own_domains.map((d) => d.toLowerCase()).includes(domain)) config.own_domains.push(domain);
    this.checks.delete(id);
    this.save();
  }

  updateMailbox(id: string, patch: { label?: string; calendar?: boolean; default?: boolean }): void {
    const { config, home } = this.deps;
    if (!config.mailboxes.includes(id)) throw new ConnectorError(404, "No such mailbox.");
    if (patch.label !== undefined) {
      const file = path.join(mailboxesDir(home), id, "config.json");
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // first label for a mailbox connected by hand
      }
      cfg.mailbox_label = patch.label.trim() || id;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }
    if (patch.calendar) config.calendar_mailbox = id;
    if (patch.default) config.mailboxes.splice(0, config.mailboxes.length, id, ...config.mailboxes.filter((m) => m !== id));
    if (patch.calendar || patch.default) this.save();
  }

  /** Disconnect: stop polling it, forget its sign-in, keep its labels/ledger under mailboxes/_removed/. */
  removeMailbox(id: string): void {
    const { config, home } = this.deps;
    if (!config.mailboxes.includes(id)) throw new ConnectorError(404, "No such mailbox.");
    config.mailboxes.splice(config.mailboxes.indexOf(id), 1);
    if (config.calendar_mailbox === id) config.calendar_mailbox = config.mailboxes[0] ?? "";
    this.save();
    const dir = path.join(mailboxesDir(home), id);
    if (fs.existsSync(dir)) {
      fs.rmSync(path.join(dir, "token.json"), { force: true });
      const removed = path.join(mailboxesDir(home), "_removed");
      fs.mkdirSync(removed, { recursive: true, mode: 0o700 });
      fs.renameSync(dir, path.join(removed, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
    }
    // interns limited to it lose only that mailbox
    for (const { slug, manifest } of this.deps.registry.list()) {
      if (manifest.mailboxes?.includes(id)) this.deps.registry.save({ ...manifest, mailboxes: manifest.mailboxes.filter((m) => m !== id) }, slug);
    }
    this.checks.delete(id);
  }

  async checkMailbox(id: string) {
    if (!this.deps.config.mailboxes.includes(id)) throw new ConnectorError(404, "No such mailbox.");
    const result = { at: new Date().toISOString(), ...(await this.checkMailboxFn(id)) };
    this.checks.set(id, result);
    return result;
  }

  // ------------------------------------------------------------ GitHub

  async githubStatus() {
    const { config, registry, github } = this.deps;
    const appSet = Boolean(config.github.app_id && config.github.private_key_path && fs.existsSync(config.github.private_key_path));
    const reviewer = registry.get(config.github.reviewer_slug);
    const base = {
      connected: appSet,
      app: null as null | { name: string; slug: string; html_url: string; owner: string | null },
      installations: [] as { login: string; type: string | null; all_repositories: boolean; suspended: boolean; enabled: boolean }[],
      reviewer: reviewer ? { slug: config.github.reviewer_slug, name: reviewer.name, has_tool: reviewer.tools.includes("github") } : null,
      polling: github.configured && config.github.repositories.length > 0,
      error: null as string | null,
    };
    if (!appSet) return base;
    try {
      const app = await this.cachedApp();
      base.app = { name: app.name, slug: app.slug, html_url: app.html_url, owner: app.owner?.login ?? null };
      const enabled = new Set(config.github.repositories.filter((r) => r.endsWith("/*")).map((r) => r.slice(0, -2).toLowerCase()));
      base.installations = (await github.listInstallations()).map((i: GithubInstallation) => ({
        login: i.account?.login ?? String(i.id),
        type: i.account?.type ?? null,
        all_repositories: i.repository_selection === "all",
        suspended: Boolean(i.suspended_at),
        enabled: enabled.has((i.account?.login ?? "").toLowerCase()),
      }));
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  }

  /** Step 1: the manifest the app posts to github.com, and where to post it. */
  async githubSetup(input: { login: string; origin: string }): Promise<{ action: string; manifest: Record<string, unknown> }> {
    const login = input.login.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new ConnectorError(400, "That isn't a GitHub username or organization.");
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      throw new ConnectorError(400, "Unknown app address.");
    }
    if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new ConnectorError(400, "Unknown app address.");
    const type = await this.deps.github.accountType(login);
    if (!type) throw new ConnectorError(404, `GitHub has no account called ${login}.`);
    const state = this.issueState("create", origin.origin);
    const base = origin.origin;
    const manifest = {
      name: `Interns for ${login}`.slice(0, 34),
      url: base,
      description: "Pull request reviews prepared by your interns. Nothing is published until you approve it in the app.",
      redirect_url: `${base}/oauth/github/callback`,
      setup_url: `${base}/oauth/github/installed`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: false,
      hook_attributes: { url: `${base}/webhooks/github`, active: false },
      default_permissions: { metadata: "read", contents: "read", checks: "read", pull_requests: "write" },
      default_events: ["pull_request"],
    };
    const action =
      type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/apps/new?state=${encodeURIComponent(state)}`
        : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return { action, manifest };
  }

  private issueState(step: "create" | "install", origin: string): string {
    const now = Date.now();
    for (const [key, value] of this.githubStates) if (value.expires < now) this.githubStates.delete(key);
    const state = randomBytes(24).toString("base64url");
    this.githubStates.set(state, { step, origin, expires: now + GITHUB_STATE_TTL_MS });
    return state;
  }

  /** A browser came back from GitHub: its state must be one we issued for this step, unexpired, and it is used up. */
  private takeState(state: string | undefined, step: "create" | "install"): { origin: string } {
    const pending = state ? this.githubStates.get(state) : undefined;
    if (state) this.githubStates.delete(state);
    if (!pending || pending.step !== step || pending.expires < Date.now()) {
      throw new ConnectorError(403, "This GitHub link has expired or was already used. Start again from Connectors in the app.");
    }
    return pending;
  }

  /** "Add an account or organization": a fresh install link for the App. */
  async githubInstallUrl(origin: string): Promise<string> {
    if (!this.deps.config.github.app_id) throw new ConnectorError(409, "Connect GitHub first.");
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConnectorError(400, "Unknown app address.");
    }
    const app = await this.cachedApp();
    return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(this.issueState("install", parsed.origin))}`;
  }

  private async cachedApp() {
    if (!this.appCache || Date.now() - this.appCache.at > 10 * 60_000) this.appCache = { at: Date.now(), app: await this.deps.github.getApp() };
    return this.appCache.app;
  }

  /** Step 2 (browser, from GitHub): store the new App, then send the browser on to install it. */
  async githubCallback(code: string, state: string): Promise<string> {
    const pending = this.takeState(state, "create");
    if (!code) throw new ConnectorError(400, "GitHub didn't send the App back.");
    const app = await this.deps.github.convertManifest(code);
    const { config, home } = this.deps;
    const keyFile = path.join(home, "github-app.pem");
    fs.writeFileSync(keyFile, app.pem, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    config.github.app_id = String(app.id);
    config.github.private_key_path = keyFile;
    config.github.webhook_secret = app.webhook_secret ?? "";
    config.github.installation_id = "";
    config.github.installation_ids = {};
    config.github.repositories = [];
    this.save();
    this.deps.github.resetTokens();
    this.appCache = null;
    const install = this.issueState("install", pending.origin);
    return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(install)}`;
  }

  /**
   * Step 3 (browser, from GitHub after installing): sync, and turn reviews on
   * for the newly installed account. Only for an install the owner started
   * here — without our state (an install made on GitHub directly, perhaps by
   * someone else on a public App) nothing changes; "Refresh" picks it up,
   * switched off. Returns where to send the browser.
   */
  async githubInstalled(state: string | undefined): Promise<string> {
    const pending = this.takeState(state, "install");
    await this.syncGithub({ enableNew: true });
    return `${pending.origin}/connectors/github?connected=1`;
  }

  /** Mirror GitHub's installations into config; newly installed accounts get reviews on when `enableNew`. */
  async syncGithub(opts: { enableNew?: boolean } = {}): Promise<void> {
    const { config, github } = this.deps;
    const installations = (await github.listInstallations()).filter((i) => !i.suspended_at && i.account?.login);
    const known = new Set(Object.keys(config.github.installation_ids).map((l) => l.toLowerCase()));
    const ids: Record<string, string> = {};
    for (const i of installations) ids[i.account!.login!] = String(i.id);
    const logins = Object.keys(ids).map((l) => l.toLowerCase());
    // keep exact repos and wildcards that are still installed; add new accounts when asked
    const repositories = config.github.repositories.filter((r) => logins.includes(r.split("/")[0]!.toLowerCase()));
    if (opts.enableNew) {
      for (const login of Object.keys(ids)) {
        if (!known.has(login.toLowerCase()) && !repositories.some((r) => r.toLowerCase() === `${login.toLowerCase()}/*`)) repositories.push(`${login}/*`);
      }
    }
    config.github.installation_ids = ids;
    config.github.installation_id = "";
    config.github.repositories = repositories;
    this.save();
    this.deps.github.resetTokens();
    this.deps.githubwatch?.refresh();
  }

  /** Which accounts get reviews, and which intern reviews. */
  updateGithub(patch: { accounts?: Record<string, boolean>; reviewer?: string }): void {
    const { config, registry } = this.deps;
    if (patch.accounts) {
      let repositories = [...config.github.repositories];
      for (const [login, on] of Object.entries(patch.accounts)) {
        if (!Object.keys(config.github.installation_ids).some((l) => l.toLowerCase() === login.toLowerCase())) throw new ConnectorError(400, `The app isn't installed on ${login}.`);
        repositories = repositories.filter((r) => r.split("/")[0]!.toLowerCase() !== login.toLowerCase());
        if (on) repositories.push(`${login}/*`);
      }
      config.github.repositories = repositories;
    }
    if (patch.reviewer !== undefined) {
      const manifest = registry.get(patch.reviewer);
      if (!manifest) throw new ConnectorError(404, "No such intern.");
      // the owner choosing the reviewer here is the approval: grant the managed tool directly
      if (!manifest.tools.includes("github")) registry.save({ ...manifest, tools: [...manifest.tools, "github"] }, patch.reviewer);
      config.github.reviewer_slug = patch.reviewer;
    }
    this.save();
    this.deps.githubwatch?.refresh();
  }

  /** Forget the App here (it stays on GitHub until deleted there) and take the GitHub tool back. */
  disconnectGithub(): void {
    const { config, registry, home } = this.deps;
    const key = config.github.private_key_path;
    config.github.app_id = "";
    config.github.private_key_path = "";
    config.github.webhook_secret = "";
    config.github.installation_id = "";
    config.github.installation_ids = {};
    config.github.repositories = [];
    this.save();
    if (key && key.startsWith(home) && fs.existsSync(key)) fs.rmSync(key);
    for (const { slug, manifest } of registry.list()) {
      if (manifest.tools.includes("github")) registry.save({ ...manifest, tools: manifest.tools.filter((t) => t !== "github") }, slug);
    }
    this.deps.github.resetTokens();
    this.appCache = null;
  }

  // --------------------------------------------------------- Instagram

  instagramStatus() {
    const { registry, home } = this.deps;
    const c = readInstagram(home);
    return {
      connected: Boolean(c),
      account: c ? { username: c.ig_username, page: c.page_name || null } : null,
      app_id: c?.app_id || null,
      connected_at: c?.connected_at || null,
      /** null = doesn't expire */
      token_expires_at: c ? (c.page_token ? c.page_token_expires_at : c.user_token_expires_at) : null,
      /** permissions research needs that the token lacks */
      missing: c && c.scopes.length ? missingScopes(c.scopes) : [],
      /** permissions the token has that could act on the account (never used) */
      acting: c ? actingScopes(c.scopes) : [],
      used_by: registry
        .list()
        .filter(({ manifest }) => usesInstagram(manifest))
        .map(({ slug, manifest }) => ({ slug, name: manifest.name })),
      check: c ? this.instagramCheck : null,
    };
  }

  /**
   * Connect (or reconnect) from what the owner pasted: the Meta app's ID and
   * secret (the secret may be left out when reconnecting the same app) and a
   * user token from Graph API Explorer. `username` picks the account when
   * the token sees several.
   */
  async connectInstagram(input: { app_id: string; app_secret?: string; token: string; username?: string }) {
    const { home } = this.deps;
    const appId = input.app_id.trim();
    if (!META_APP_ID.test(appId)) throw new ConnectorError(400, "That doesn't look like an App ID. It's the long number under App settings › Basic.");
    const previous = readInstagram(home);
    const secret = input.app_secret?.trim() || (previous?.app_id === appId ? previous.app_secret : "");
    if (!META_APP_SECRET.test(secret)) throw new ConnectorError(400, "Paste the App secret from App settings › Basic (32 letters and digits).");
    const token = input.token.trim();
    if (token.length < 20 || /\s/.test(token)) throw new ConnectorError(400, "Paste the access token from Graph API Explorer.");

    const get = <T>(route: string, params: Record<string, string>) => graphGet<T>(this.graphFetch, route, params);
    let long: { access_token: string; expires_in?: number };
    try {
      long = await get("oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: token });
    } catch (err) {
      throw new ConnectorError(400, `Facebook didn't accept these: ${err instanceof Error ? err.message : String(err)} Check the App ID and secret, and generate a fresh token.`);
    }
    const appToken = `${appId}|${secret}`;
    const debug = await get<{ data: { scopes?: string[]; expires_at?: number } }>("debug_token", { input_token: long.access_token, access_token: appToken });
    const scopes = debug.data.scopes ?? [];
    if (!scopes.includes("instagram_basic") || !scopes.includes("pages_show_list")) {
      throw new ConnectorError(400, `The token is missing ${["instagram_basic", "pages_show_list"].filter((s) => !scopes.includes(s)).join(" and ")}. Add the permissions listed here in Graph API Explorer and generate it again.`);
    }
    type PageRow = { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } };
    const pages = await get<{ data: PageRow[] }>("me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100", access_token: long.access_token });
    const linked = pages.data.filter((p) => p.instagram_business_account);
    if (!linked.length) {
      throw new ConnectorError(409, "None of the Facebook Pages this token can see has an Instagram account linked. Link your Business or Creator account to a Page (Instagram › Edit profile › Page), then select that Page when you generate the token.");
    }
    const wanted = input.username?.trim().replace(/^@/, "").toLowerCase();
    const handles = linked.map((p) => `@${p.instagram_business_account!.username ?? p.instagram_business_account!.id}`).join(", ");
    const page = wanted ? linked.find((p) => p.instagram_business_account!.username?.toLowerCase() === wanted) : linked.length === 1 ? linked[0] : undefined;
    if (!page) {
      throw new ConnectorError(409, wanted ? `@${wanted} isn't linked to a Page this token can see. It can see ${handles}.` : `This token can see several Instagram accounts (${handles}). Type the one to use.`);
    }
    const pageDebug = await get<{ data: { expires_at?: number } }>("debug_token", { input_token: page.access_token, access_token: appToken });
    writeInstagram(home, {
      app_id: appId,
      app_secret: secret,
      user_token: long.access_token,
      user_token_expires_at: expiry(debug.data.expires_at) ?? (long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null),
      page_id: page.id,
      page_name: page.name,
      page_token: page.access_token,
      page_token_expires_at: expiry(pageDebug.data.expires_at),
      ig_user_id: page.instagram_business_account!.id,
      ig_username: page.instagram_business_account!.username ?? "",
      scopes,
      connected_at: new Date().toISOString(),
    });
    this.instagramCheck = null;
    return this.instagramStatus();
  }

  /** Look the connected account up the way research does: proves the token and the profile-lookup permission. */
  async checkInstagram() {
    const c = readInstagram(this.deps.home);
    if (!c) throw new ConnectorError(409, "Connect Instagram first.");
    const at = new Date().toISOString();
    try {
      const fields = c.ig_username ? `business_discovery.username(${c.ig_username}){followers_count}` : "followers_count";
      const res = await graphGet<{ followers_count?: number; business_discovery?: { followers_count?: number } }>(this.graphFetch, c.ig_user_id, { fields, access_token: c.page_token || c.user_token });
      this.instagramCheck = { at, ok: true, followers: res.business_discovery?.followers_count ?? res.followers_count };
    } catch (err) {
      const expired = err instanceof GraphError && err.code === 190;
      const denied = err instanceof GraphError && err.code === 10;
      this.instagramCheck = {
        at,
        ok: false,
        error: expired
          ? "The connection expired or was revoked. Connect again with a fresh token."
          : denied
            ? "Profile lookups aren't allowed. Generate the token again with instagram_manage_insights."
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
    return this.instagramCheck;
  }

  /** Who may research: the owner choosing here is the approval, so the tool is granted directly. */
  updateInstagram(patch: { interns: Record<string, boolean> }) {
    const { registry } = this.deps;
    for (const slug of Object.keys(patch.interns)) if (!registry.get(slug)) throw new ConnectorError(404, `No intern called ${slug}.`);
    for (const [slug, on] of Object.entries(patch.interns)) {
      const manifest = registry.get(slug)!;
      if (on && !manifest.tools.includes("instagram")) registry.save({ ...manifest, tools: [...manifest.tools, "instagram"] }, slug);
      if (!on && manifest.tools.includes("instagram")) registry.save({ ...manifest, tools: manifest.tools.filter((t) => t !== "instagram") }, slug);
    }
    return this.instagramStatus();
  }

  /** Forget the tokens. Interns keep the tool, so reconnecting gives research back to the same people. */
  disconnectInstagram() {
    removeInstagram(this.deps.home);
    this.instagramCheck = null;
    return this.instagramStatus();
  }
}

export class ConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- routes

/** The /connectors API and the GitHub browser callbacks. One call from api.ts. */
export function registerConnectorRoutes(app: FastifyInstance, connectors: ConnectorService): void {
  const fail = (err: unknown) => {
    if (err instanceof ConnectorError) return { status: err.status, body: { error: err.message } };
    return { status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
  };
  const run = async <T>(reply: { code(n: number): { send(b: unknown): unknown } }, fn: () => Promise<T> | T) => {
    try {
      return await fn();
    } catch (err) {
      const { status, body } = fail(err);
      return reply.code(status).send(body);
    }
  };

  app.get("/connectors", async () => connectors.overview());

  // Outlook
  app.put("/connectors/outlook/app", async (req, reply) => {
    const body = z.object({ client_id: z.string(), authority: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "client_id required" });
    return run(reply, () => (connectors.setOutlookApp(body.data), connectors.outlook()));
  });
  app.post("/connectors/outlook/mailboxes", async (req, reply) => {
    const body = z.object({ label: z.string().max(60).default("Outlook"), mailbox: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid mailbox" });
    return run(reply, () => connectors.startOutlookLogin(body.data));
  });
  app.get<{ Params: { id: string } }>("/connectors/outlook/sessions/:id", async (req, reply) => {
    const session = connectors.loginSession(req.params.id);
    return session ?? reply.code(404).send({ error: "no such sign-in" });
  });
  app.delete<{ Params: { id: string } }>("/connectors/outlook/sessions/:id", async (req) => {
    connectors.cancelOutlookLogin(req.params.id);
    return { ok: true };
  });
  app.patch<{ Params: { id: string } }>("/connectors/outlook/mailboxes/:id", async (req, reply) => {
    const body = z.object({ label: z.string().max(60).optional(), calendar: z.boolean().optional(), default: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid change" });
    return run(reply, () => (connectors.updateMailbox(req.params.id, body.data), connectors.outlook()));
  });
  app.post<{ Params: { id: string } }>("/connectors/outlook/mailboxes/:id/check", async (req, reply) => run(reply, () => connectors.checkMailbox(req.params.id)));
  app.delete<{ Params: { id: string } }>("/connectors/outlook/mailboxes/:id", async (req, reply) => run(reply, () => (connectors.removeMailbox(req.params.id), connectors.outlook())));

  // GitHub
  app.get("/connectors/github", async () => connectors.githubStatus());
  app.post("/connectors/github/setup", async (req, reply) => {
    const body = z.object({ login: z.string(), origin: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "login and origin required" });
    return run(reply, () => connectors.githubSetup(body.data));
  });
  app.post("/connectors/github/install", async (req, reply) => {
    const body = z.object({ origin: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "origin required" });
    return run(reply, async () => ({ url: await connectors.githubInstallUrl(body.data.origin) }));
  });
  app.post("/connectors/github/sync", async (_req, reply) => run(reply, async () => (await connectors.syncGithub(), connectors.githubStatus())));
  app.patch("/connectors/github", async (req, reply) => {
    const body = z.object({ accounts: z.record(z.string(), z.boolean()).optional(), reviewer: z.string().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid change" });
    return run(reply, async () => (connectors.updateGithub(body.data), connectors.githubStatus()));
  });
  app.delete("/connectors/github", async () => (connectors.disconnectGithub(), connectors.githubStatus()));

  // Instagram
  app.get("/connectors/instagram", async () => connectors.instagramStatus());
  app.put("/connectors/instagram", async (req, reply) => {
    const body = z.object({ app_id: z.string().max(40), app_secret: z.string().max(80).optional(), token: z.string().max(1000), username: z.string().max(40).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "app_id and token required" });
    return run(reply, () => connectors.connectInstagram(body.data));
  });
  app.post("/connectors/instagram/check", async (_req, reply) => run(reply, () => connectors.checkInstagram()));
  app.patch("/connectors/instagram", async (req, reply) => {
    const body = z.object({ interns: z.record(z.string(), z.boolean()) }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid change" });
    return run(reply, () => connectors.updateInstagram(body.data));
  });
  app.delete("/connectors/instagram", async () => connectors.disconnectInstagram());

  // Browser navigations back from github.com (no bearer token; see the module comment).
  const page = (title: string, body: string) =>
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{font:17px system-ui;margin:0;display:grid;min-height:100vh;place-items:center;background:#09090b;color:#fafafa}main{max-width:480px;padding:24px}a{color:#a5b4fc}</style>` +
    `</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  app.get<{ Querystring: { code?: string; state?: string } }>("/oauth/github/callback", async (req, reply) => {
    try {
      const next = await connectors.githubCallback(req.query.code ?? "", req.query.state ?? "");
      return reply.redirect(next);
    } catch (err) {
      const { status, body } = fail(err);
      return reply.code(status).type("text/html").send(page("GitHub setup stopped", `${String(body.error).replace(/[<>&]/g, "")} <a href="/connectors/github">Back to the app</a>`));
    }
  });
  app.get<{ Querystring: { installation_id?: string; state?: string } }>("/oauth/github/installed", async (req, reply) => {
    try {
      return reply.redirect(await connectors.githubInstalled(req.query.state));
    } catch (err) {
      if (err instanceof ConnectorError && err.status === 403) {
        // e.g. an install changed on github.com directly: nothing changes here, nothing is switched on
        return reply
          .type("text/html")
          .send(page("Back to the app", 'Nothing changed here. In the app, open Connectors › GitHub and tap <b>Refresh from GitHub</b> to see this installation. <a href="/connectors/github">Open Connectors</a>'));
      }
      const { status, body } = fail(err);
      return reply.code(status).type("text/html").send(page("Couldn't finish connecting GitHub", `${String(body.error).replace(/[<>&]/g, "")} <a href="/connectors/github">Back to the app</a>`));
    }
  });
}

/** For the manifest PATCH: mailbox ids an intern may be limited to must be connected ones. */
export function unknownMailboxes(config: Pick<Config, "mailboxes">, ids: string[]): string[] {
  return ids.filter((id) => !config.mailboxes.includes(id));
}

export { readMailbox };
