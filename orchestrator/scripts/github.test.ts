/** Fixture-only contract checks for GitHub App auth, reads, review posting, and signatures. */
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";
import { GithubClient, githubRepositoryAllowed, pullRequestLinks, verifyGithubWebhook } from "../src/github.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "interns-github-test-"));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPath = path.join(home, "github.pem");
fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const config = loadConfig(home);
config.github = {
  ...config.github,
  app_id: "1234",
  installation_id: "5678",
  private_key_path: keyPath,
  webhook_secret: "fixture-secret",
  repositories: ["acme/widget"],
  api_base_url: "https://github.invalid",
};

const calls: { url: string; method: string; authorization: string; body?: any }[] = [];
const fakeFetch: typeof fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, authorization: headers.get("authorization") ?? "", body });
  if (url.endsWith("/app/installations/5678/access_tokens")) {
    assert.match(headers.get("authorization") ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }
  assert.equal(headers.get("authorization"), "Bearer installation-token");
  if (headers.get("accept") === "application/vnd.github.v3.diff") {
    return new Response("diff --git a/a.ts b/a.ts\n+safe change\n");
  }
  if (url.endsWith("/pulls?state=open&per_page=50")) return Response.json([{ number: 42, head: { sha: "abc" } }]);
  if (url.endsWith("/pulls/42/reviews?per_page=100")) return Response.json([{ id: 1, state: "COMMENTED" }]);
  if (url.endsWith("/pulls/42/comments?per_page=100")) return Response.json([{ id: 2, body: "existing" }]);
  if (url.endsWith("/pulls/42/reviews") && method === "POST") return Response.json({ id: 99, state: body.event });
  if (url.endsWith("/pulls/42")) return Response.json({ number: 42, title: "Fixture PR" });
  if (url.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ conclusion: "success" }] });
  if (url.includes("/installation/repositories")) {
    return Response.json({ total_count: 1, repositories: [{ full_name: "acme/widget" }] });
  }
  return new Response("not found", { status: 404 });
};

const github = new GithubClient(config.github, fakeFetch);
assert.equal(github.configured, true);
assert.deepEqual(await github.listPullRequests("acme", "widget"), [{ number: 42, head: { sha: "abc" } }]);
assert.deepEqual(await github.getPullRequest("acme", "widget", 42), { number: 42, title: "Fixture PR" });
assert.match(await github.getDiff("acme", "widget", 42), /safe change/);
assert.deepEqual(await github.getReviewContext("acme", "widget", 42), {
  reviews: [{ id: 1, state: "COMMENTED" }],
  comments: [{ id: 2, body: "existing" }],
});
assert.deepEqual(
  await github.publishReview({
    owner: "acme",
    repo: "widget",
    pull_number: 42,
    event: "REQUEST_CHANGES",
    body: "Fix the null path.",
    comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Guard this." }],
    head_sha: "abc",
  }),
  { id: 99, state: "REQUEST_CHANGES" },
);
assert.equal(calls.filter((c) => c.url.includes("access_tokens")).length, 1, "installation token should be cached");
await assert.rejects(() => github.getPullRequest("other", "repo", 1), /not allowlisted/);
assert.equal(githubRepositoryAllowed(["acme/*"], "Acme/widget"), true);
assert.equal(githubRepositoryAllowed(["acme/*"], "other/widget"), false);
assert.deepEqual(await github.listInstallationRepositories("acme"), ["acme/widget"]);
assert.deepEqual(
  pullRequestLinks(
    { codeops_base_url: "https://codeops.example.com/", codeops_owners: ["Northwind"] },
    "northwind/widget",
    42,
  ),
  {
    github_url: "https://github.com/northwind/widget/pull/42",
    codeops_url: "https://codeops.example.com/PullRequests/Open?repository=northwind%2Fwidget&number=42",
    primary_url: "https://codeops.example.com/PullRequests/Open?repository=northwind%2Fwidget&number=42",
    primary_label: "CodeOps",
  },
);
assert.equal(
  pullRequestLinks(
    { codeops_base_url: "https://codeops.example.com", codeops_owners: ["northwind"] },
    "jpdlr/widget",
    7,
  ).primary_label,
  "GitHub",
);

const raw = Buffer.from('{"zen":"keep it logically awesome"}');
const signature = `sha256=${createHmac("sha256", config.github.webhook_secret).update(raw).digest("hex")}`;
assert.equal(verifyGithubWebhook(raw, signature, config.github.webhook_secret), true);
assert.equal(verifyGithubWebhook(Buffer.from("tampered"), signature, config.github.webhook_secret), false);
assert.equal(verifyGithubWebhook(raw, undefined, config.github.webhook_secret), false);

fs.rmSync(home, { recursive: true, force: true });
console.log("github fixtures: ok");
