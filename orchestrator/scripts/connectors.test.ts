/**
 * Connectors: Outlook sign-in through a fake graph-login, mailbox changes,
 * per-intern mailbox limits, and the GitHub App flow against a fake GitHub.
 * A throwaway INTERNS_HOME; never a real Microsoft or GitHub call.
 *
 *   npm run test:connectors
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Fastify from "fastify";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-connectors-"));
process.env.INTERNS_HOME = home;

const { loadConfig } = await import("../src/config.js");
const { EventBus } = await import("../src/events.js");
const { Db } = await import("../src/db.js");
const { Registry } = await import("../src/registry.js");
const { InternManifestSchema } = await import("../src/types.js");
const { ConnectorService, registerConnectorRoutes, mailboxIdFor } = await import("../src/connectors.js");
const { mailboxPrompt, mailboxEnv, mailboxesFor } = await import("../src/mailboxes.js");
import type { LoginProcess } from "../src/connectors.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err instanceof Error ? err.stack?.split("\n").slice(0, 8).join("\n      ") : err}`);
  }
}

const config = loadConfig(home);
const db = new Db(new EventBus(), home);
const registry = new Registry(home);
const hire = (slug: string, name: string, extra: Record<string, unknown> = {}) =>
  registry.save(InternManifestSchema.parse({ name, role: "Test", system_prompt: `You are ${name}.`, ...extra }), slug);
hire("sam", "Sam", { tools: ["mail", "calendar"] });
hire("ada", "Ada", { tools: ["mail"], mailboxes: [] });
hire("max", "Max", { tools: ["fs.read"] });

/** A scripted graph-login: emits the lines we push, exits when told. */
class FakeLogin implements LoginProcess {
  static last: FakeLogin | null = null;
  args: string[];
  private lineCbs: ((l: string) => void)[] = [];
  private exitCbs: ((c: number | null) => void)[] = [];
  killed = false;
  constructor(args: string[]) {
    this.args = args;
    FakeLogin.last = this;
  }
  onLine(cb: (l: string) => void) {
    this.lineCbs.push(cb);
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCbs.push(cb);
  }
  kill() {
    this.killed = true;
    this.exit(143);
  }
  emit(obj: unknown) {
    for (const cb of this.lineCbs) cb(JSON.stringify(obj));
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb(code);
  }
}

/** graph-login writes the mailbox dir; the fake does too, like the real tool. */
function signIn(proc: FakeLogin, account: string) {
  const mailbox = proc.args[proc.args.indexOf("--mailbox") + 1]!;
  const dir = path.join(home, "mailboxes", mailbox);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token.json"), "{}");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ mailbox_label: proc.args[proc.args.indexOf("--label") + 1], account }));
  proc.emit({ event: "done", mailbox, account });
  proc.exit(0);
}

const githubCalls: string[] = [];
const fakeGithub = {
  get configured() {
    return Boolean(config.github.app_id && config.github.private_key_path && Object.keys(config.github.installation_ids).length);
  },
  installations: [] as { id: number; account: { login: string; type: string }; repository_selection: string; suspended_at: null }[],
  async getApp() {
    githubCalls.push("getApp");
    return { id: 42, slug: "interns-for-northwind", name: "Interns for northwind", html_url: "https://github.com/apps/interns-for-northwind", owner: { login: "northwind", type: "Organization" } };
  },
  async convertManifest(code: string) {
    githubCalls.push(`convert:${code}`);
    return { id: 42, slug: "interns-for-northwind", name: "Interns for northwind", html_url: "https://github.com/apps/x", pem: "-----BEGIN KEY-----\nfake\n-----END KEY-----\n", webhook_secret: "whsec", owner: { login: "northwind" } };
  },
  async accountType(login: string) {
    return login === "northwind" ? ("Organization" as const) : login === "nobody-here" ? null : ("User" as const);
  },
  async listInstallations() {
    return fakeGithub.installations;
  },
  resetTokens() {
    githubCalls.push("reset");
  },
};
let refreshed = 0;
const connectors = new ConnectorService({
  db,
  registry,
  config,
  home,
  github: fakeGithub,
  githubwatch: { refresh: () => void refreshed++ },
  startLogin: (args) => new FakeLogin(args),
  checkMailbox: async (id) => (id === "work" ? { ok: true, unread: 3 } : { ok: false, error: "token expired" }),
});
const app = Fastify();
registerConnectorRoutes(app, connectors);
await app.ready();
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as "GET", url, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.body ? (res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body) : null, headers: res.headers };
};

try {
  await check("mailbox ids come from labels and stay unique", () => {
    assert.equal(mailboxIdFor("Work", []), "work");
    assert.equal(mailboxIdFor("Willowbrook Vet!", []), "willowbrook-vet");
    assert.equal(mailboxIdFor("Work", ["work", "work-2"]), "work-3");
    assert.equal(mailboxIdFor("***", []), "mailbox");
  });

  await check("outlook: the Microsoft app comes first, and only a client id is accepted", async () => {
    assert.equal((await call("POST", "/connectors/outlook/mailboxes", { label: "Work" })).status, 409);
    assert.equal((await call("PUT", "/connectors/outlook/app", { client_id: "nope" })).status, 400);
    const ok = await call("PUT", "/connectors/outlook/app", { client_id: "11111111-2222-3333-4444-555555555555" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(config.graph.client_id, "11111111-2222-3333-4444-555555555555");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).graph.client_id, "11111111-2222-3333-4444-555555555555", "saved");
  });

  await check("outlook: connect shows the code, sign-in adds the mailbox (calendar, own domain), no restart", async () => {
    const started = call("POST", "/connectors/outlook/mailboxes", { label: "Work" });
    await new Promise((r) => setTimeout(r, 10));
    const proc = FakeLogin.last!;
    assert.deepEqual(proc.args, ["--mailbox", "work", "--label", "Work", "--json", "--no-config"]);
    proc.emit({ event: "code", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900 });
    const res = await started;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user_code, "ABCD-1234");
    assert.equal(res.body.state, "waiting");
    assert.equal((await call("GET", "/connectors")).body.outlook.sessions.length, 1, "shown while waiting");

    signIn(proc, "sam@northwind.example.com");
    const session = (await call("GET", `/connectors/outlook/sessions/${res.body.id}`)).body;
    assert.equal(session.state, "connected");
    assert.equal(session.account, "sam@northwind.example.com");
    assert.deepEqual(config.mailboxes, ["work"]);
    assert.equal(config.calendar_mailbox, "work");
    assert.ok(config.own_domains.includes("northwind.example.com"));
    const outlook = (await call("GET", "/connectors")).body.outlook;
    assert.equal(outlook.mailboxes[0].label, "Work");
    assert.equal(outlook.mailboxes[0].account, "sam@northwind.example.com");
    assert.equal(outlook.mailboxes[0].default, true);
    assert.deepEqual(outlook.mailboxes[0].used_by.map((u: { slug: string }) => u.slug), ["sam"], "Ada is limited to none; Max has no Outlook");
  });

  await check("outlook: a second mailbox, a personal address adds no domain; failures and cancels are reported", async () => {
    const started = call("POST", "/connectors/outlook/mailboxes", { label: "Home" });
    await new Promise((r) => setTimeout(r, 10));
    FakeLogin.last!.emit({ event: "code", user_code: "WXYZ-9876", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900 });
    const res = await started;
    const domains = config.own_domains.length;
    signIn(FakeLogin.last!, "sam@outlook.com");
    assert.deepEqual(config.mailboxes, ["work", "home"]);
    assert.equal(config.own_domains.length, domains, "outlook.com is not one of yours");
    assert.equal((await call("GET", `/connectors/outlook/sessions/${res.body.id}`)).body.state, "connected");

    // the code never comes: the tool errors
    const failing = call("POST", "/connectors/outlook/mailboxes", { label: "Broken" });
    await new Promise((r) => setTimeout(r, 10));
    FakeLogin.last!.emit({ error: "AADSTS700016: application not found" });
    const failed = await failing;
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /AADSTS700016/);

    // cancel while waiting
    const waiting = call("POST", "/connectors/outlook/mailboxes", { label: "Later" });
    await new Promise((r) => setTimeout(r, 10));
    const proc = FakeLogin.last!;
    proc.emit({ event: "code", user_code: "LATE-0000", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900 });
    const pending = (await waiting).body;
    await call("DELETE", `/connectors/outlook/sessions/${pending.id}`);
    assert.equal(proc.killed, true);
    assert.equal((await call("GET", `/connectors/outlook/sessions/${pending.id}`)).body.state, "cancelled");
    assert.deepEqual(config.mailboxes, ["work", "home"]);
  });

  await check("outlook: rename, make default / calendar, check, remove", async () => {
    let outlook = (await call("PATCH", "/connectors/outlook/mailboxes/home", { label: "Personal", default: true, calendar: true })).body;
    assert.deepEqual(config.mailboxes, ["home", "work"]);
    assert.equal(config.calendar_mailbox, "home");
    assert.equal(outlook.mailboxes[0].label, "Personal");
    assert.equal((await call("POST", "/connectors/outlook/mailboxes/work/check")).body.unread, 3);
    assert.equal((await call("POST", "/connectors/outlook/mailboxes/home/check")).body.error, "token expired");
    assert.equal((await call("GET", "/connectors")).body.outlook.mailboxes[0].check.ok, false);

    hire("lea", "Lea", { tools: ["mail"], mailboxes: ["home", "work"] });
    outlook = (await call("DELETE", "/connectors/outlook/mailboxes/home")).body;
    assert.deepEqual(config.mailboxes, ["work"]);
    assert.equal(config.calendar_mailbox, "work", "the calendar moves to what's left");
    assert.ok(!fs.existsSync(path.join(home, "mailboxes", "home")), "moved aside");
    assert.ok(fs.readdirSync(path.join(home, "mailboxes", "_removed")).some((d) => d.startsWith("home-")));
    assert.ok(!fs.readdirSync(path.join(home, "mailboxes", "_removed")).some((d) => fs.existsSync(path.join(home, "mailboxes", "_removed", d, "token.json"))), "sign-in forgotten");
    assert.deepEqual(registry.get("lea")!.mailboxes, ["work"], "interns lose only that mailbox");
    assert.equal((await call("DELETE", "/connectors/outlook/mailboxes/nope")).status, 404);
  });

  await check("mailboxes per intern: prompt, env limit, unset = all", () => {
    config.mailboxes.push("billing");
    const sam = registry.get("sam")!;
    const ada = registry.get("ada")!;
    const lea = registry.get("lea")!;
    assert.deepEqual(mailboxesFor(sam, config), ["work", "billing"]);
    assert.deepEqual(mailboxEnv(sam, config), {}, "no limit, no env");
    assert.deepEqual(mailboxEnv(lea, config), { INTERNS_MAILBOXES: "work" });
    assert.deepEqual(mailboxEnv(ada, config), { INTERNS_MAILBOXES: "" });
    assert.match(mailboxPrompt(sam, config, home), /`work`: Work \(sam@northwind\.example\.com\)\n- `billing`: billing/);
    assert.match(mailboxPrompt(ada, config, home), /No Outlook mailbox is connected for you/);
    assert.equal(mailboxPrompt(registry.get("max")!, config, home), "");
    config.mailboxes.pop();
  });

  await check("github: setup builds the manifest on this origin, for a user or an organization", async () => {
    assert.equal((await call("POST", "/connectors/github/setup", { login: "nobody-here", origin: "https://interns.example.com" })).status, 404);
    assert.equal((await call("POST", "/connectors/github/setup", { login: "bad login", origin: "https://interns.example.com" })).status, 400);
    const res = await call("POST", "/connectors/github/setup", { login: "northwind", origin: "https://interns.example.com/settings" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.action, /^https:\/\/github\.com\/organizations\/northwind\/settings\/apps\/new\?state=/);
    assert.equal(res.body.manifest.redirect_url, "https://interns.example.com/oauth/github/callback");
    assert.equal(res.body.manifest.setup_url, "https://interns.example.com/oauth/github/installed");
    assert.equal(res.body.manifest.public, false);
    assert.deepEqual(res.body.manifest.default_permissions, { metadata: "read", contents: "read", checks: "read", pull_requests: "write" });
    const user = await call("POST", "/connectors/github/setup", { login: "sam", origin: "http://100.64.0.1:7810" });
    assert.match(user.body.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    (globalThis as { state?: string }).state = new URL(res.body.action).searchParams.get("state")!;
  });

  await check("github: callback stores the App and sends the browser to install it; a bad state is refused", async () => {
    const bad = await call("GET", "/oauth/github/callback?code=abc&state=forged");
    assert.equal(bad.status, 403);
    assert.match(String(bad.body), /expired/);
    const state = (globalThis as { state?: string }).state!;
    const res = await call("GET", `/oauth/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `https://github.com/apps/interns-for-northwind/installations/new?state=${encodeURIComponent(state)}`);
    assert.equal(config.github.app_id, "42");
    assert.equal(fs.statSync(config.github.private_key_path).mode & 0o777, 0o600);
    assert.equal(config.github.webhook_secret, "whsec");
    assert.equal((await call("GET", `/oauth/github/callback?code=abc&state=forged2`)).status, 403);
  });

  await check("github: installed → installations synced, new account on, back to the app", async () => {
    fakeGithub.installations = [{ id: 7, account: { login: "northwind", type: "Organization" }, repository_selection: "all", suspended_at: null }];
    const state = (globalThis as { state?: string }).state!;
    const res = await call("GET", `/oauth/github/installed?installation_id=7&setup_action=install&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "https://interns.example.com/connectors/github?connected=1");
    assert.deepEqual(config.github.installation_ids, { northwind: "7" });
    assert.deepEqual(config.github.repositories, ["northwind/*"]);
    assert.ok(refreshed > 0, "polling starts without a restart");
    const status = (await call("GET", "/connectors/github")).body;
    assert.equal(status.connected, true);
    assert.equal(status.app.slug, "interns-for-northwind");
    assert.deepEqual(status.installations, [{ login: "northwind", type: "Organization", all_repositories: true, suspended: false, enabled: true }]);
  });

  await check("github: accounts on/off, reviewer gets the tool, a re-sync keeps choices, disconnect cleans up", async () => {
    fakeGithub.installations.push({ id: 8, account: { login: "sam", type: "User" }, repository_selection: "selected", suspended_at: null });
    await call("POST", "/connectors/github/sync");
    assert.deepEqual(config.github.repositories, ["northwind/*"], "a manual sync doesn't switch new accounts on");
    let status = (await call("PATCH", "/connectors/github", { accounts: { sam: true, northwind: false }, reviewer: "max" })).body;
    assert.deepEqual(config.github.repositories, ["sam/*"]);
    assert.equal(config.github.reviewer_slug, "max");
    assert.ok(registry.get("max")!.tools.includes("github"), "choosing the reviewer here grants the tool");
    assert.deepEqual(status.reviewer, { slug: "max", name: "Max", has_tool: true });
    assert.equal((await call("PATCH", "/connectors/github", { accounts: { stranger: true } })).status, 400);
    assert.equal((await call("PATCH", "/connectors/github", { reviewer: "nobody" })).status, 404);

    fakeGithub.installations = fakeGithub.installations.filter((i) => i.account.login !== "sam");
    await call("POST", "/connectors/github/sync");
    assert.deepEqual(config.github.repositories, [], "an uninstalled account drops out");

    const key = config.github.private_key_path;
    status = (await call("DELETE", "/connectors/github")).body;
    assert.equal(status.connected, false);
    assert.equal(config.github.app_id, "");
    assert.ok(!fs.existsSync(key), "private key deleted");
    assert.ok(!registry.get("max")!.tools.includes("github"), "tool taken back");
  });
} finally {
  await app.close();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall connector checks passed" : `\n${failures} connector check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
