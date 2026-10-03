/** Validate and persist one GitHub App installation per approved account owner. */
import { loadConfig, internsHome, saveConfig } from "../src/config.js";
import { GithubClient } from "../src/github.js";

const expectedOwners = process.argv.slice(2);
if (!expectedOwners.length) {
  throw new Error("usage: tsx scripts/github-installations.ts OWNER [OWNER ...]");
}

const home = internsHome();
const config = loadConfig(home);
const github = new GithubClient(config.github);
const installations = await github.listInstallations();
const installationIds: Record<string, string> = {};

for (const owner of expectedOwners) {
  const installation = installations.find(
    (candidate) => candidate.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (!installation) throw new Error(`GitHub App is not installed on ${owner}`);
  if (installation.suspended_at) throw new Error(`GitHub App installation on ${owner} is suspended`);
  if (installation.repository_selection !== "all") {
    throw new Error(`GitHub App installation on ${owner} must use All repositories`);
  }
  installationIds[owner] = String(installation.id);
}

config.github.installation_ids = installationIds;
config.github.installation_id = installationIds[expectedOwners[0]!] ?? config.github.installation_id;
config.github.repositories = expectedOwners.map((owner) => `${owner}/*`);
saveConfig(config, home);

const verified: { owner: string; repositories: number }[] = [];
for (const owner of expectedOwners) {
  const repositories = await github.listInstallationRepositories(owner);
  if (repositories.some((repository) => !repository.toLowerCase().startsWith(`${owner.toLowerCase()}/`))) {
    throw new Error(`installation for ${owner} returned another owner's repository`);
  }
  verified.push({ owner, repositories: repositories.length });
}

process.stdout.write(JSON.stringify({ installations: verified }, null, 2) + "\n");

