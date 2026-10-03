/** Tailnet-only continuation for installing the existing App on approved organizations. */
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, internsHome, saveConfig } from "../src/config.js";
import { GithubClient } from "../src/github.js";

const publicBase = (process.argv[2] ?? "").replace(/\/$/, "");
/** Your own account first, then the organizations the App may be installed on. */
const owners = process.argv.slice(3);
if (!publicBase.startsWith("https://") || owners.length === 0) {
  throw new Error("usage: tsx scripts/github-org-setup.ts https://HOST/github-setup YOUR_LOGIN [ORG ...]");
}
/** The App created by github-setup.ts (its slug is recorded in ~/.interns/github-setup.json). */
const appSlug: string =
  process.env.GITHUB_APP_SLUG ??
  (JSON.parse(fs.readFileSync(path.join(internsHome(), "github-setup.json"), "utf8")) as { app_slug?: string }).app_slug ??
  "";
if (!appSlug) throw new Error("no app_slug in ~/.interns/github-setup.json — run github-setup.ts first or set GITHUB_APP_SLUG");
const routePrefix = new URL(publicBase).pathname.replace(/\/$/, "");

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
    `<style>body{margin:0;background:#0d1017;color:#f2f4f8;font:17px system-ui;display:grid;min-height:100vh;place-items:center}` +
    `main{width:min(560px,calc(100% - 40px));background:#151a24;border:1px solid #262e3d;border-radius:18px;padding:28px}` +
    `h1{margin:0 0 12px;font-size:28px}p,li{color:#a8b1c2;line-height:1.5}a{display:block;margin-top:14px;border-radius:12px;` +
    `background:#8b5cf6;color:white;padding:15px;text-align:center;text-decoration:none;font-weight:700}</style></head>` +
    `<body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

async function waitForApi(token: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/interns`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // Expected briefly during the controlled restart.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("orchestrator did not become ready after restart");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = url.pathname.replace(/\/$/, "") || "/";
    if (routePrefix && pathname.startsWith(routePrefix)) pathname = pathname.slice(routePrefix.length) || "/";
    const installUrl = `https://github.com/apps/${appSlug}/installations/new`;

    if (pathname === "/start") {
      return send(res, 200, page(
        "Add organization access",
        `<p>First make the App public under <b>Advanced</b>. Then install it twice, selecting <b>All repositories</b> for each organization.</p>` +
        `<a href="https://github.com/settings/apps/${appSlug}/advanced">1. Open Advanced settings</a>` +
        `<a href="${installUrl}">2. Install on an organization</a>`,
      ));
    }

    if (pathname === "/installed") {
      const installationId = url.searchParams.get("installation_id") ?? "";
      if (!/^\d+$/.test(installationId)) throw new Error("GitHub did not provide a valid installation id");
      const config = loadConfig(internsHome());
      const github = new GithubClient(config.github);
      const installations = await github.listInstallations();
      const returned = installations.find((installation) => String(installation.id) === installationId);
      const returnedOwner = returned?.account?.login;
      if (!returned || !returnedOwner || !owners.some((owner) => owner.toLowerCase() === returnedOwner.toLowerCase())) {
        throw new Error("the returned installation is not one of the approved accounts");
      }
      if (returned.repository_selection !== "all") throw new Error(`${returnedOwner} must use All repositories`);
      if (returned.suspended_at) throw new Error(`${returnedOwner} installation is suspended`);

      const installedOwners = installations.flatMap((installation) => {
        const expected = owners.find((owner) => owner.toLowerCase() === installation.account?.login?.toLowerCase());
        return expected && installation.repository_selection === "all" && !installation.suspended_at ? [expected] : [];
      });
      const missing = owners.filter((owner) => !installedOwners.includes(owner));
      if (missing.length) {
        return send(res, 200, page(
          `${returnedOwner} connected`,
          `<p>Still needed: <b>${missing.map(escape).join(", ")}</b>.</p>` +
          `<a href="${installUrl}">Install on the next organization</a>`,
        ));
      }

      config.github.installation_ids = Object.fromEntries(owners.map((owner) => {
        const installation = installations.find(
          (candidate) => candidate.account?.login?.toLowerCase() === owner.toLowerCase(),
        )!;
        return [owner, String(installation.id)];
      }));
      config.github.installation_id = config.github.installation_ids[owners[0]!]!;
      config.github.repositories = owners.map((owner) => `${owner}/*`);
      saveConfig(config, internsHome());

      const verified: { owner: string; repositories: number }[] = [];
      for (const owner of owners) {
        const repositories = await github.listInstallationRepositories(owner);
        if (repositories.some((repository) => !repository.toLowerCase().startsWith(`${owner.toLowerCase()}/`))) {
          throw new Error(`${owner} installation returned another owner's repository`);
        }
        verified.push({ owner, repositories: repositories.length });
      }
      execFileSync("systemctl", ["--user", "restart", "interns-orchestrator.service"], { stdio: "ignore" });
      await waitForApi(config.api_token, config.port);
      setTimeout(() => server.close(), 60_000);
      return send(res, 200, page(
        "All GitHub accounts connected",
        `<p>Rhea can now watch:</p><ul>${verified.map((item) => `<li>${escape(item.owner)}: ${item.repositories} repositories</li>`).join("")}</ul>` +
        `<p>You can close this page.</p>`,
      ));
    }

    return send(res, 404, page("Not found", "<p>This one-time setup route does not exist.</p>"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[github-org-setup] ${message}`);
    return send(res, 500, page("Setup stopped safely", `<p>${escape(message)}</p><p>No unverified access was enabled.</p>`));
  }
});

server.listen(7799, "127.0.0.1", () => {
  console.log(`[github-org-setup] ready ${publicBase}/start`);
});

