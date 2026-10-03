/** Polling fallback for installations that cannot expose a public webhook URL. */
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { pullRequestLinks, type GithubClient } from "./github.js";
import type { Registry } from "./registry.js";

interface PullRow {
  number?: number;
  title?: string;
  html_url?: string;
  draft?: boolean;
  updated_at?: string;
  user?: { login?: string };
  head?: { sha?: string };
  base?: { sha?: string };
}

export class GithubWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Db,
    private registry: Registry,
    private config: Config,
    private github: Pick<GithubClient, "configured" | "listPullRequests" | "listInstallationRepositories">,
  ) {}

  start(): void {
    if (!this.github.configured || this.config.github.repositories.length === 0) {
      console.log("[githubwatch] disabled — configure the GitHub App and repository allowlist to enable");
      return;
    }
    this.timer = setInterval(() => void this.poll(), this.config.github.poll_minutes * 60_000);
    void this.poll();
  }

  /** Start polling once GitHub is connected (Connectors); a no-op while it already polls. poll() re-reads config each time. */
  refresh(): void {
    if (!this.timer) this.start();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // disconnected or no accounts enabled since start: nothing to watch
      if (!this.github.configured || this.config.github.repositories.length === 0) return;
      const reviewer = this.config.github.reviewer_slug;
      // paused: leave PRs unrecorded so they are picked up on resume
      if (!this.registry.get(reviewer) || this.registry.get(reviewer)?.paused) return;
      const configured = this.config.github.repositories;
      const exact = configured.filter((repository) => !repository.endsWith("/*"));
      const wildcardOwners = configured
        .filter((repository) => repository.endsWith("/*"))
        .map((repository) => repository.slice(0, -2));
      const installed = (
        await Promise.all(wildcardOwners.map((owner) => this.github.listInstallationRepositories(owner)))
      ).flat();
      for (const repository of [...new Set([...exact, ...installed])]) {
        const [owner, repo] = repository.split("/");
        if (!owner || !repo) {
          console.error(`[githubwatch] invalid repository allowlist entry: ${repository}`);
          continue;
        }
        try {
          const rows = (await this.github.listPullRequests(owner, repo)) as PullRow[];
          for (const pr of rows) {
            const number = pr.number;
            const headSha = pr.head?.sha;
            if (!number || !headSha || pr.draft) continue;
            if (!this.db.recordGithubPullRequest(repository, number, headSha)) continue;
            const links = pullRequestLinks(this.config.github, repository, number, pr.html_url);
            this.db.enqueueTask(reviewer, "trigger", {
              type: "github_pull_request",
              action: "polled_new_or_updated",
              repository,
              owner,
              pull_number: number,
              title: pr.title,
              author: pr.user?.login,
              head_sha: headSha,
              base_sha: pr.base?.sha,
              url: links.primary_url,
              links,
            });
          }
        } catch (err) {
          console.error(`[githubwatch] ${repository}:`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
