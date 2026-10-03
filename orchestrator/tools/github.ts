#!/usr/bin/env tsx
/** Safe GitHub CLI for interns: reads PR data and proposes reviews; never publishes. */
import * as fs from "node:fs";
import { loadConfig } from "../src/config.ts";
import { GithubClient, githubRepositoryAllowed, pullRequestLinks } from "../src/github.ts";

const config = loadConfig();
const github = new GithubClient(config.github);
const args = process.argv.slice(2);
const command = args.shift();

function die(message: string): never {
  process.stderr.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

function repo(raw: string | undefined): [string, string] {
  const [owner, name, ...rest] = String(raw ?? "").split("/");
  if (!owner || !name || rest.length) die("repository must be OWNER/REPO");
  return [owner, name];
}

function assertAllowed(owner: string, name: string): void {
  const full = `${owner}/${name}`;
  if (!githubRepositoryAllowed(config.github.repositories, full)) {
    die(`repository is not allowlisted: ${full}`);
  }
}

function flag(name: string, required = false): string | undefined {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (required && !value) die(`--${name} is required`);
  return value;
}

async function localApi(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.api_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

let output: unknown;
switch (command) {
  case "status":
    output = {
      configured: github.configured,
      repositories: config.github.repositories,
      reviewer_slug: config.github.reviewer_slug,
      link_routing: {
        codeops_owners: config.github.codeops_owners,
        codeops_base_url: config.github.codeops_base_url,
        codeops_label: config.github.codeops_label,
        note: "Use primary_url in messages. The configured CodeOps viewer (if any) is the primary human view for its owners; GitHub remains the review API.",
      },
      note: "This CLI cannot publish a review; propose routes through an approval card.",
    };
    break;
  case "list-prs": {
    const target = args[0];
    if (target) {
      const [owner, name] = repo(target);
      assertAllowed(owner, name);
      output = await github.listPullRequests(owner, name);
    } else {
      const exact = config.github.repositories.filter((repository) => !repository.endsWith("/*"));
      const wildcardOwners = config.github.repositories
        .filter((repository) => repository.endsWith("/*"))
        .map((repository) => repository.slice(0, -2));
      const installed = (
        await Promise.all(wildcardOwners.map((owner) => github.listInstallationRepositories(owner)))
      ).flat().filter((repository) => githubRepositoryAllowed(config.github.repositories, repository));
      output = Object.fromEntries(
        await Promise.all(
          [...new Set([...exact, ...installed])].map(async (r) => {
            const [owner, name] = repo(r);
            return [r, await github.listPullRequests(owner, name)];
          }),
        ),
      );
    }
    break;
  }
  case "pr": {
    const [owner, name] = repo(args[0]);
    assertAllowed(owner, name);
    const number = Number(args[1]);
    if (!Number.isInteger(number) || number < 1) die("usage: github pr OWNER/REPO NUMBER");
    const pull = await github.getPullRequest(owner, name, number) as Record<string, unknown>;
    const fullName = `${owner}/${name}`;
    output = {
      ...pull,
      interns_links: pullRequestLinks(
        config.github,
        fullName,
        number,
        typeof pull.html_url === "string" ? pull.html_url : undefined,
      ),
    };
    break;
  }
  case "diff": {
    const [owner, name] = repo(args[0]);
    assertAllowed(owner, name);
    const number = Number(args[1]);
    if (!Number.isInteger(number) || number < 1) die("usage: github diff OWNER/REPO NUMBER");
    process.stdout.write(await github.getDiff(owner, name, number));
    process.exit(0);
  }
  case "checks": {
    const [owner, name] = repo(args[0]);
    assertAllowed(owner, name);
    const ref = args[1];
    if (!ref) die("usage: github checks OWNER/REPO REF");
    output = await github.getChecks(owner, name, ref);
    break;
  }
  case "reviews": {
    const [owner, name] = repo(args[0]);
    assertAllowed(owner, name);
    const number = Number(args[1]);
    if (!Number.isInteger(number) || number < 1) die("usage: github reviews OWNER/REPO NUMBER");
    output = await github.getReviewContext(owner, name, number);
    break;
  }
  case "propose": {
    const intern = flag("intern", true)!;
    const [owner, name] = repo(flag("repo", true));
    assertAllowed(owner, name);
    const pullNumber = Number(flag("pr", true));
    const event = flag("event", true);
    const bodyFile = flag("body-file");
    const bodyText = flag("body");
    if (!bodyFile && !bodyText) die("provide --body TEXT or --body-file FILE");
    if (!Number.isInteger(pullNumber) || pullNumber < 1) die("--pr must be a positive integer");
    if (!event || !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event)) {
      die("--event must be COMMENT, APPROVE, or REQUEST_CHANGES");
    }
    const commentsFile = flag("comments-file");
    output = await localApi("/github/reviews", {
      intern,
      owner,
      repo: name,
      pull_number: pullNumber,
      event,
      body: bodyFile ? fs.readFileSync(bodyFile, "utf8") : bodyText,
      comments: commentsFile
        ? JSON.parse(fs.readFileSync(commentsFile, "utf8"))
        : flag("comments")
          ? JSON.parse(flag("comments")!)
          : [],
      ...(flag("head-sha") ? { head_sha: flag("head-sha") } : {}),
    });
    break;
  }
  default:
    die(
      "usage: github status | list-prs [OWNER/REPO] | pr OWNER/REPO NUMBER | diff OWNER/REPO NUMBER | " +
        "checks OWNER/REPO REF | reviews OWNER/REPO NUMBER | propose --intern SLUG --repo OWNER/REPO --pr N --event EVENT --body TEXT [--comments JSON]",
    );
}

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
