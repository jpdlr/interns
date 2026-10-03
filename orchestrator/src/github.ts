/** GitHub App client and webhook verification. No long-lived access token is stored. */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import type { Config } from "./config.js";

export interface GithubReviewProposal {
  owner: string;
  repo: string;
  pull_number: number;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments?: { path: string; line?: number; side?: "LEFT" | "RIGHT"; body: string }[];
  head_sha?: string;
}

export interface PullRequestLinks {
  github_url: string;
  codeops_url: string | null;
  primary_url: string;
  /** `github.codeops_label` when the CodeOps link leads, else "GitHub" */
  primary_label: string;
}

/**
 * GitHub is always the source of truth for review reads/writes. For configured
 * owners (`github.codeops_owners`), the human-facing link opens the same PR in
 * a second viewer first, e.g. an internal dashboard with deployment context.
 */
export function pullRequestLinks(
  config: Pick<Config["github"], "codeops_base_url" | "codeops_owners"> & Partial<Pick<Config["github"], "codeops_label">>,
  fullName: string,
  number: number,
  githubUrl = `https://github.com/${fullName}/pull/${number}`,
): PullRequestLinks {
  const owner = fullName.split("/")[0] ?? "";
  const usesCodeOps = Boolean(config.codeops_base_url) && config.codeops_owners.some((candidate) => candidate.toLowerCase() === owner.toLowerCase());
  const codeopsUrl = usesCodeOps
    ? `${config.codeops_base_url.replace(/\/$/, "")}/PullRequests/Open?repository=${encodeURIComponent(fullName)}&number=${number}`
    : null;
  return {
    github_url: githubUrl,
    codeops_url: codeopsUrl,
    primary_url: codeopsUrl ?? githubUrl,
    primary_label: codeopsUrl ? config.codeops_label || "CodeOps" : "GitHub",
  };
}

export interface GithubInstallation {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  suspended_at?: string | null;
}

interface InstallationToken {
  token: string;
  expiresAt: number;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Exact repositories and owner-wide entries such as `your-org/*` are allowed. */
export function githubRepositoryAllowed(allowlist: string[], fullName: string): boolean {
  const normalized = fullName.toLowerCase();
  const slash = normalized.indexOf("/");
  if (slash < 1 || slash === normalized.length - 1) return false;
  const ownerWildcard = `${normalized.slice(0, slash)}/*`;
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed === normalized || allowed === ownerWildcard;
  });
}

export function verifyGithubWebhook(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class GithubClient {
  private installationTokens = new Map<string, InstallationToken>();

  constructor(
    private config: Config["github"],
    private fetchFn: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(
        this.config.app_id &&
        (this.config.installation_id || Object.values(this.config.installation_ids).some(Boolean)) &&
        this.config.private_key_path &&
        fs.existsSync(this.config.private_key_path),
    );
  }

  private appJwt(): string {
    if (!this.config.app_id || !this.config.private_key_path) throw new Error("GitHub App is not configured");
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: this.config.app_id }));
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(fs.readFileSync(this.config.private_key_path)).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  private installationId(owner: string): string {
    const match = Object.entries(this.config.installation_ids).find(
      ([account]) => account.toLowerCase() === owner.toLowerCase(),
    )?.[1];
    if (match) return match;
    if (Object.keys(this.config.installation_ids).length === 0 && this.config.installation_id) {
      return this.config.installation_id;
    }
    throw new Error(`GitHub App is not installed for repository owner: ${owner}`);
  }

  private async token(owner: string): Promise<string> {
    const installationId = this.installationId(owner);
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const res = await this.fetchFn(
      `${this.config.api_base_url}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.appJwt()}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub installation token: HTTP ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { token: string; expires_at: string };
    this.installationTokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  private assertAllowed(owner: string, repo: string): void {
    const full = `${owner}/${repo}`;
    if (!githubRepositoryAllowed(this.config.repositories, full)) {
      throw new Error(`GitHub repository is not allowlisted: ${full}`);
    }
  }

  private async request<T>(
    owner: string,
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<T> {
    if (!this.configured) throw new Error("GitHub App is not configured");
    const res = await this.fetchFn(`${this.config.api_base_url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: init.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${await this.token(owner)}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    if ((init.accept ?? "").includes("diff")) return (await res.text()) as T;
    return (await res.json()) as T;
  }

  async listPullRequests(owner: string, repo: string): Promise<unknown> {
    this.assertAllowed(owner, repo);
    return this.request(owner, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=50`);
  }

  /** Resolve owner-wide allowlists from the App installation itself. */
  async listInstallationRepositories(owner: string): Promise<string[]> {
    const repositories: string[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{
        total_count: number;
        repositories: { full_name: string }[];
      }>(owner, `/installation/repositories?per_page=100&page=${page}`);
      repositories.push(...result.repositories.map((repository) => repository.full_name));
      if (repositories.length >= result.total_count || result.repositories.length === 0) break;
    }
    return repositories;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<unknown> {
    this.assertAllowed(owner, repo);
    return this.request(owner, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
  }

  async getDiff(owner: string, repo: string, number: number): Promise<string> {
    this.assertAllowed(owner, repo);
    return this.request(owner, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, {
      accept: "application/vnd.github.v3.diff",
    });
  }

  async getChecks(owner: string, repo: string, ref: string): Promise<unknown> {
    this.assertAllowed(owner, repo);
    return this.request(owner, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`);
  }

  async getReviewContext(owner: string, repo: string, number: number): Promise<unknown> {
    this.assertAllowed(owner, repo);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
    const [reviews, comments] = await Promise.all([
      this.request(owner, `${base}/reviews?per_page=100`),
      this.request(owner, `${base}/comments?per_page=100`),
    ]);
    return { reviews, comments };
  }

  async publishReview(proposal: GithubReviewProposal): Promise<Record<string, unknown>> {
    // Re-check at execution time: an approval job may outlive a configuration
    // change, and a stale proposal must not escape the current allowlist.
    this.assertAllowed(proposal.owner, proposal.repo);
    const result = await this.request<Record<string, unknown>>(
      proposal.owner,
      `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.repo)}/pulls/${proposal.pull_number}/reviews`,
      {
        method: "POST",
        body: {
          event: proposal.event,
          body: proposal.body,
          ...(proposal.comments?.length ? { comments: proposal.comments } : {}),
          ...(proposal.head_sha ? { commit_id: proposal.head_sha } : {}),
        },
      },
    );
    return result;
  }

  /** The App itself (name, slug, owner, link), app-authenticated. */
  async getApp(): Promise<{ id: number; slug: string; name: string; html_url: string; owner?: { login?: string; type?: string } }> {
    if (!this.config.app_id || !this.config.private_key_path) throw new Error("GitHub App is not configured");
    const response = await this.fetchFn(`${this.config.api_base_url}/app`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.appJwt()}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub App: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as Awaited<ReturnType<GithubClient["getApp"]>>;
  }

  /** Finish GitHub's App manifest flow: trade the one-time code for the new App's id, slug and private key. */
  async convertManifest(code: string): Promise<{ id: number; slug: string; name: string; html_url: string; pem: string; webhook_secret?: string | null; owner?: { login?: string; type?: string } }> {
    const response = await this.fetchFn(`${this.config.api_base_url}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub manifest conversion: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as Awaited<ReturnType<GithubClient["convertManifest"]>>;
  }

  /** Whether a GitHub login is a user or an organization (public, unauthenticated). */
  async accountType(login: string): Promise<"User" | "Organization" | null> {
    const response = await this.fetchFn(`${this.config.api_base_url}/users/${encodeURIComponent(login)}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub account lookup: HTTP ${response.status}`);
    const user = (await response.json()) as { type?: string };
    return user.type === "Organization" ? "Organization" : "User";
  }

  /** Forget cached installation tokens (after a disconnect or a new App). */
  resetTokens(): void {
    this.installationTokens.clear();
  }

  /** App-authenticated inventory used to validate/sync account installations. */
  async listInstallations(): Promise<GithubInstallation[]> {
    if (!this.config.app_id || !this.config.private_key_path) throw new Error("GitHub App is not configured");
    const installations: GithubInstallation[] = [];
    for (let page = 1; ; page++) {
      const response = await this.fetchFn(`${this.config.api_base_url}/app/installations?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.appJwt()}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error(`GitHub App installations: HTTP ${response.status} ${await response.text()}`);
      const pageRows = (await response.json()) as typeof installations;
      installations.push(...pageRows);
      if (pageRows.length < 100) break;
    }
    return installations;
  }
}
