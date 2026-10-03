#!/usr/bin/env tsx
/** Forge's lifecycle helper. It cannot activate or deploy a capability. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, internsHome, repoRoot } from "../src/config.ts";

const config = loadConfig();
const [command, requestId, ...args] = process.argv.slice(2);
const repo = repoRoot();

function die(message: string): never {
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

async function api(route: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${config.port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) die(`${route}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

if (!requestId) die("request id is required");
let output: unknown;
switch (command) {
  case "status": {
    const requests = await api("/capabilities");
    output = requests.find((r: any) => r.id === requestId) ?? die(`no capability request: ${requestId}`);
    break;
  }
  case "prepare": {
    const requests = await api("/capabilities");
    const request = requests.find((r: any) => r.id === requestId);
    if (!request) die(`no capability request: ${requestId}`);
    const buildRoot = path.join(internsHome(), "builds", requestId);
    const worktree = path.join(buildRoot, "worktree");
    fs.mkdirSync(buildRoot, { recursive: true });
    if (!fs.existsSync(worktree)) {
      const branch = `capability/${String(request.capability).replace(/[^a-z0-9._-]/gi, "-")}-${requestId.slice(0, 8)}`;
      execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: repo, stdio: "pipe" });
      fs.writeFileSync(path.join(buildRoot, "branch"), branch + "\n", { mode: 0o600 });
    }
    output = { request_id: requestId, worktree, branch: fs.readFileSync(path.join(buildRoot, "branch"), "utf8").trim() };
    break;
  }
  case "ready": {
    const summaryFile = args[args.indexOf("--summary-file") + 1];
    const testsFile = args[args.indexOf("--tests-file") + 1];
    if (!summaryFile || !testsFile) die("ready requires --summary-file FILE --tests-file FILE");
    const branchFile = path.join(internsHome(), "builds", requestId, "branch");
    output = await api(`/capabilities/${encodeURIComponent(requestId)}/ready`, {
      method: "POST",
      body: JSON.stringify({
        summary: fs.readFileSync(summaryFile, "utf8").trim(),
        tests: fs.readFileSync(testsFile, "utf8").split("\n").map((x) => x.trim()).filter(Boolean),
        ...(fs.existsSync(branchFile) ? { branch: fs.readFileSync(branchFile, "utf8").trim() } : {}),
      }),
    });
    break;
  }
  default:
    die("usage: integration-work status REQUEST_ID | prepare REQUEST_ID | ready REQUEST_ID --summary-file FILE --tests-file FILE");
}

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
