/** One-time, tailnet-only GitHub App manifest registration and installation flow. */
import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as path from "node:path";
import { loadConfig, internsHome, saveConfig } from "../src/config.js";
import { GithubClient } from "../src/github.js";

interface SetupState {
  state: string;
  account: string;
  public_base: string;
  expires_at: string;
  phase: "started" | "registered" | "complete";
  app_id?: string;
  app_slug?: string;
  installation_id?: string;
  installed_repositories?: number;
}

const home = internsHome();
const stateFile = path.join(home, "github-setup.json");
const keyFile = path.join(home, "github-app.pem");
const port = 7799;
const suppliedBase = process.argv[2];
/** The GitHub user that will own the App (and whose repositories it reviews). */
const account = (process.argv[3] ?? "").toLowerCase();
if (!suppliedBase?.startsWith("https://") || !/^[a-z0-9-]+$/.test(account)) {
  throw new Error("usage: tsx scripts/github-setup.ts https://HOST/github-setup YOUR_GITHUB_LOGIN");
}
const publicBase = suppliedBase.replace(/\/$/, "");
const routePrefix = new URL(publicBase).pathname.replace(/\/$/, "");

function writeState(value: SetupState): void {
  fs.writeFileSync(stateFile, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
}

function readState(): SetupState {
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as SetupState;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<title>${htmlEscape(title)}</title><style>` +
    `body{margin:0;background:#0d1017;color:#f2f4f8;font:17px system-ui;display:grid;min-height:100vh;place-items:center}` +
    `main{width:min(560px,calc(100% - 40px));background:#151a24;border:1px solid #262e3d;border-radius:18px;padding:28px}` +
    `h1{margin:0 0 12px;font-size:28px}p{color:#a8b1c2;line-height:1.5}button,a.button{display:block;box-sizing:border-box;width:100%;` +
    `border:0;border-radius:12px;background:#8b5cf6;color:white;padding:15px;text-align:center;text-decoration:none;font-weight:700;font-size:17px}` +
    `code{color:#c4b5fd}</style></head><body><main><h1>${htmlEscape(title)}</h1>${body}</main></body></html>`;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function appJwt(appId: string, privateKeyPath: string): string {
  const b64 = (value: string) => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({
    iat: now - 30,
    exp: now + 540,
    iss: appId,
  }))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(fs.readFileSync(privateKeyPath)).toString("base64url")}`;
}

async function waitForApi(token: string, apiPort: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/interns`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // The service is between stop/start; retry briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("orchestrator did not become ready after restart");
}

const setup: SetupState = {
  state: randomBytes(24).toString("base64url"),
  account,
  public_base: publicBase,
  expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
  phase: "started",
};
writeState(setup);

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = requestUrl.pathname.replace(/\/$/, "") || "/";
    if (routePrefix && pathname.startsWith(routePrefix)) pathname = pathname.slice(routePrefix.length) || "/";
    const current = readState();
    const state = requestUrl.searchParams.get("state") ?? "";
    if (state !== current.state || Date.now() > Date.parse(current.expires_at)) {
      return send(res, 403, page("Setup link expired", "<p>Ask Codex to generate a fresh one-time setup link.</p>"));
    }

    if (pathname === "/start") {
      if (current.phase !== "started") {
        const next = current.phase === "registered" && current.app_slug
          ? `https://github.com/apps/${encodeURIComponent(current.app_slug)}/installations/new?state=${encodeURIComponent(current.state)}`
          : "/";
        return send(res, 200, page("Continue setup", `<a class="button" href="${htmlEscape(next)}">Continue</a>`));
      }
      const manifest = {
        name: `Interns Reviewer ${account}`,
        url: `https://github.com/${account}`,
        description: "Approval-gated pull request reviews prepared by Rhea in the Interns app.",
        redirect_url: `${publicBase}/callback`,
        setup_url: `${publicBase}/installed?state=${encodeURIComponent(current.state)}`,
        setup_on_update: true,
        public: false,
        request_oauth_on_install: false,
        hook_attributes: { url: `${publicBase}/webhook-disabled`, active: false },
        default_permissions: {
          metadata: "read",
          contents: "read",
          checks: "read",
          pull_requests: "write",
        },
        default_events: ["pull_request"],
      };
      return send(
        res,
        200,
        page(
          "Create Rhea's GitHub App",
          `<p>The permissions and callback are prefilled. Continue, review them on GitHub, then press <b>Create GitHub App</b>.</p>` +
          `<form method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(current.state)}">` +
          `<input type="hidden" name="manifest" value="${htmlEscape(JSON.stringify(manifest))}" />` +
          `<button type="submit">Continue to GitHub</button></form>`,
        ),
      );
    }

    if (pathname === "/callback") {
      if (current.phase === "registered" && current.app_slug) {
        const installUrl = `https://github.com/apps/${encodeURIComponent(current.app_slug)}/installations/new?state=${encodeURIComponent(current.state)}`;
        return send(res, 200, page("App created", `<p>The private key is stored securely. Install it for <b>All repositories</b>.</p><a class="button" href="${htmlEscape(installUrl)}">Install on ${htmlEscape(account)}</a>`));
      }
      const code = requestUrl.searchParams.get("code");
      if (!code || current.phase !== "started") throw new Error("missing or stale GitHub manifest code");
      const conversion = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!conversion.ok) throw new Error(`manifest conversion failed: HTTP ${conversion.status}`);
      const app = (await conversion.json()) as {
        id: number;
        slug: string;
        pem: string;
        webhook_secret?: string;
        owner?: { login?: string };
      };
      if (app.owner?.login?.toLowerCase() !== account) throw new Error(`GitHub App owner is not ${account}`);
      fs.writeFileSync(keyFile, app.pem, { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600);
      const config = loadConfig(home);
      config.github.app_id = String(app.id);
      config.github.installation_id = "";
      config.github.installation_ids = {};
      config.github.private_key_path = keyFile;
      config.github.webhook_secret = app.webhook_secret ?? "";
      config.github.repositories = [`${account}/*`];
      saveConfig(config, home);
      writeState({ ...current, phase: "registered", app_id: String(app.id), app_slug: app.slug });
      const installUrl = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(current.state)}`;
      return send(res, 200, page("App created", `<p>The private key is stored securely. Choose <b>All repositories</b>, then install.</p><a class="button" href="${htmlEscape(installUrl)}">Install on ${htmlEscape(account)}</a>`));
    }

    if (pathname === "/installed") {
      if (current.phase === "complete") {
        return send(res, 200, page("Rhea is active", `<p>GitHub is configured for <code>${htmlEscape(account)}/*</code>. You can close this page.</p>`));
      }
      const installationId = requestUrl.searchParams.get("installation_id") ?? "";
      if (!/^\d+$/.test(installationId) || current.phase !== "registered") throw new Error("invalid installation callback");
      const config = loadConfig(home);
      const verification = await fetch(`${config.github.api_base_url}/app/installations/${installationId}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt(config.github.app_id, config.github.private_key_path)}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!verification.ok) throw new Error(`installation verification failed: HTTP ${verification.status}`);
      const installation = (await verification.json()) as {
        app_id: number;
        account?: { login?: string };
        repository_selection?: string;
        suspended_at?: string | null;
      };
      if (String(installation.app_id) !== config.github.app_id) throw new Error("installation belongs to another App");
      if (installation.account?.login?.toLowerCase() !== account) throw new Error(`installation does not belong to ${account}`);
      if (installation.repository_selection !== "all") throw new Error("installation must use All repositories");
      if (installation.suspended_at) throw new Error("installation is suspended");
      config.github.installation_id = installationId;
      config.github.installation_ids[account] = installationId;
      config.github.repositories = [`${account}/*`];
      saveConfig(config, home);

      execFileSync("systemctl", ["--user", "restart", "interns-orchestrator.service"], { stdio: "ignore" });
      await waitForApi(config.api_token, config.port);
      const headers = { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" };
      const capabilitiesResponse = await fetch(`http://127.0.0.1:${config.port}/capabilities`, { headers });
      if (!capabilitiesResponse.ok) throw new Error("could not read capability state after restart");
      const capabilities = (await capabilitiesResponse.json()) as { id: string; intern: string; capability: string; status: string; card_id?: string }[];
      const capability = capabilities.find((item) => item.intern === "rhea" && item.capability === "github");
      if (!capability) throw new Error("Rhea's GitHub capability request was not found");
      if (capability.status === "ready" && capability.card_id) {
        const activated = await fetch(
          `http://127.0.0.1:${config.port}/cards/${encodeURIComponent(capability.card_id)}/actions/activate`,
          { method: "POST", headers, body: "{}" },
        );
        if (!activated.ok) throw new Error(`Rhea activation failed: HTTP ${activated.status} ${await activated.text()}`);
      } else if (capability.status !== "active") {
        throw new Error(`Rhea's GitHub capability is ${capability.status}, not ready`);
      }

      const liveConfig = loadConfig(home);
      const github = new GithubClient(liveConfig.github);
      const repositories = await github.listInstallationRepositories(account);
      if (!repositories.length || repositories.some((repository) => !repository.toLowerCase().startsWith(`${account}/`))) {
        throw new Error("installation repository verification failed");
      }
      const [sampleOwner, sampleRepo] = repositories[0]!.split("/");
      const pulls = await github.listPullRequests(sampleOwner!, sampleRepo!) as unknown[];
      writeState({
        ...current,
        phase: "complete",
        installation_id: installationId,
        installed_repositories: repositories.length,
      });
      setTimeout(() => server.close(), 60_000);
      return send(
        res,
        200,
        page(
          "Rhea is active",
          `<p>Verified <b>${repositories.length}</b> repositories and a live pull-request read on <code>${htmlEscape(repositories[0]!)}</code> (${pulls.length} open). Rhea is activated.</p>`,
        ),
      );
    }

    return send(res, 404, page("Not found", "<p>This one-time setup route does not exist.</p>"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[github-setup] ${message}`);
    return send(res, 500, page("Setup stopped safely", `<p>${htmlEscape(message)}</p><p>No unverified installation was activated.</p>`));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[github-setup] ready ${publicBase}/start?state=${setup.state}`);
});
