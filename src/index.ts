import "dotenv/config";
import { createServer } from "node:http";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
// smee-client loaded dynamically — only used in local dev
import fs from "fs";
import { getPRFiles, postPRReview, postReviewComment } from "./github.js";
import { getAdapter, getAgentAdapter } from "./adapters/base.js";
import type { InferenceAdapter } from "./adapters/base.js";
import type { AgentAdapter } from "./agent/loop.js";
import { reviewPR } from "./review.js";
import type { OctokitClient } from "./types.js";
import { buildDepGraph } from "./indexer/depgraph.js";
import { crawlContext } from "./indexer/crawler.js";
// In-memory store kept for backwards compat — Neon is source of truth
import { agentReview } from "./agent/loop.js";
import type { ToolContext } from "./agent/tools.js";
import { loadRepoConfig, buildRulesPrompt } from "./config.js";
import { decrypt } from "./crypto.js";
import {
  initDb,
  getOrCreateRepo,
  setRepoStatus as dbSetStatus,
  storeEdges,
  deleteAllEdges,
  deleteEdgesForFiles,
  loadGraphFromDb,
  getRepoByName,
  getIndexedFiles,
  getUserByInstallationId,
  linkInstallation,
  removeInstallation,
  upsertUser,
} from "./db/index.js";
import type { DbUser } from "./db/index.js";
import { fetchFileContent, parseImports } from "./indexer/depgraph.js";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`[verix] Missing required env var: ${key}`);
  return value;
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const privateKey = fs.readFileSync(
  process.env.GITHUB_PRIVATE_KEY_PATH ?? "./private-key.pem",
  "utf-8"
);

const app = new App({
  appId: requireEnv("GITHUB_APP_ID"),
  privateKey,
  webhooks: { secret: requireEnv("GITHUB_WEBHOOK_SECRET") },
});

const provider = process.env.MODEL_PROVIDER ?? "gemini";
const adapter = getAdapter(provider);
const useAgent = process.env.VERIX_AGENT_MODE !== "false";
const agentAdapter = useAgent ? getAgentAdapter(provider) : null;
console.log(`[verix] Using model provider: ${provider} (agent mode: ${useAgent && agentAdapter ? "on" : "off"})`);

const processedPRs = new Set<string>();
const processedPushes = new Set<string>();

async function indexRepo(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string = "HEAD"
): Promise<void> {
  const fullName = `${owner}/${repo}`;

  try {
    const repoId = await getOrCreateRepo(fullName);
    await dbSetStatus(fullName, "indexing");

    console.log(`[verix] Indexing ${fullName}...`);
    const { graph, files } = await buildDepGraph(octokit, owner, repo, ref);

    // Persist to Neon
    await deleteAllEdges(repoId);
    const edges: Array<{ source: string; target: string }> = [];
    for (const [source, targets] of Object.entries(graph.forward)) {
      for (const target of targets) {
        edges.push({ source, target });
      }
    }
    await storeEdges(repoId, edges);
    await dbSetStatus(fullName, "ready", ref);

    console.log(`[verix] Index ready for ${fullName} (${files.size} files, ${edges.length} edges persisted)`);
  } catch (error) {
    console.error(`[verix] Failed to index ${fullName}:`, error);
    await dbSetStatus(fullName, "failed").catch(() => {});
  }
}

// Index repos and link user when the app is installed
app.webhooks.on("installation.created", async ({ payload, octokit }) => {
  const repos = payload.repositories ?? [];
  const sender = payload.sender;
  const installationId = payload.installation.id;

  console.log(`[verix] App installed by @${sender.login} on ${repos.length} repo(s)`);

  // Create/update user and link installation
  try {
    const user = await upsertUser(
      sender.id,
      sender.login,
      sender.avatar_url ?? null
    );
    await linkInstallation(installationId, user.id);
    console.log(`[verix] Linked installation ${installationId} to user @${sender.login}`);
  } catch (error) {
    console.error("[verix] Failed to link installation to user:", error);
  }

  for (const repo of repos) {
    const [owner, name] = repo.full_name.split("/") as [string, string];
    indexRepo(octokit, owner, name).catch(() => {});
  }
});

// Clean up when the app is uninstalled
app.webhooks.on("installation.deleted", async ({ payload }) => {
  const installationId = payload.installation.id;
  const sender = payload.sender;

  console.log(`[verix] App uninstalled by @${sender.login} (installation ${installationId})`);

  try {
    await removeInstallation(installationId);
    console.log(`[verix] Removed installation ${installationId}`);
  } catch (error) {
    console.error("[verix] Failed to clean up installation:", error);
  }
});

// Partial re-index on push to default branch
app.webhooks.on("push", async ({ payload, octokit }) => {
  const { repository, ref, commits } = payload;
  const defaultBranch = repository.default_branch;

  if (ref !== `refs/heads/${defaultBranch}`) return;

  const owner = repository.owner?.login ?? repository.owner?.name;
  if (!owner) return;
  const repo = repository.name;
  const fullName = `${owner}/${repo}`;

  const pushKey = `${fullName}@${payload.after}`;
  if (processedPushes.has(pushKey)) return;
  processedPushes.add(pushKey);

  // Collect all changed files across all commits in this push
  const added = new Set<string>();
  const modified = new Set<string>();
  const removed = new Set<string>();

  for (const commit of commits) {
    for (const f of commit.added ?? []) added.add(f);
    for (const f of commit.modified ?? []) modified.add(f);
    for (const f of commit.removed ?? []) removed.add(f);
  }

  const changedFiles = [...added, ...modified, ...removed];

  console.log(
    `[verix] Push to ${defaultBranch} on ${fullName}: ` +
    `${added.size} added, ${modified.size} modified, ${removed.size} removed`
  );

  try {
    const dbRepo = await getRepoByName(fullName);

    // No repo in DB yet — full index
    if (!dbRepo) {
      console.log(`[verix] No existing index for ${fullName}, running full index...`);
      indexRepo(octokit, owner, repo).catch(() => {});
      return;
    }

    const repoId = dbRepo.id;

    // 1. Delete old edges for changed/removed files
    await deleteEdgesForFiles(repoId, changedFiles);

    // 2. Fetch + parse only files that still exist (added + modified)
    const filesToParse = [...added, ...modified].filter(
      (f) => /\.(ts|tsx|js|jsx|py)$/.test(f)
    );

    // Get known files from DB for import resolution
    const knownFiles = await getIndexedFiles(repoId);
    for (const f of added) knownFiles.add(f);

    const newEdges: Array<{ source: string; target: string }> = [];

    for (const filePath of filesToParse) {
      try {
        const content = await fetchFileContent(octokit, owner, repo, filePath, defaultBranch);
        const imports = parseImports(content, filePath, knownFiles);
        for (const dep of imports) {
          newEdges.push({ source: filePath, target: dep });
        }
      } catch {
        console.warn(`[verix] Failed to fetch ${filePath}, skipping`);
      }
    }

    // 3. Persist new edges to Neon
    await storeEdges(repoId, newEdges);
    await dbSetStatus(fullName, "ready", payload.after);

    console.log(
      `[verix] Partial re-index done for ${fullName}: ` +
      `${filesToParse.length} file(s) re-parsed, ${newEdges.length} edge(s) updated`
    );
  } catch (error) {
    console.error(`[verix] Partial re-index failed for ${fullName}:`, error);
    console.log(`[verix] Falling back to full re-index...`);
    indexRepo(octokit, owner, repo).catch(() => {});
  }
});

// --- Core review logic (shared by PR events and /verix review command) ---

interface UserConfig {
  userProvider: string;
  userAdapter: InferenceAdapter;
  userAgentAdapter: AgentAdapter | null;
  userReviewRules: string | null;
}

async function resolveUserConfig(installationId?: number): Promise<UserConfig | null> {
  if (!installationId) {
    console.log("[verix] No installation ID — cannot identify user");
    return null;
  }

  try {
    const user = await getUserByInstallationId(installationId);

    if (!user) {
      console.log("[verix] No user found for this installation");
      return null;
    }

    if (!user.model_provider || !user.api_key_encrypted) {
      console.log(`[verix] @${user.login} has no API key configured`);
      return null;
    }

    const userProvider = user.model_provider;
    const userKey = decrypt(user.api_key_encrypted);
    const useAgentMode = process.env.VERIX_AGENT_MODE !== "false";

    console.log(`[verix] Using @${user.login}'s ${userProvider} key`);

    return {
      userProvider,
      userAdapter: getAdapter(userProvider, { apiKey: userKey }),
      userAgentAdapter: useAgentMode ? getAgentAdapter(userProvider, { apiKey: userKey }) : null,
      userReviewRules: user.review_rules,
    };
  } catch (error) {
    console.error("[verix] Failed to resolve user config:", error);
    return null;
  }
}

async function runReview(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  ref: string,
  installationId?: number
): Promise<void> {
  const fullName = `${owner}/${repo}`;
  const files = await getPRFiles(octokit, owner, repo, prNumber);

  if (!files.some((f) => f.patch)) {
    console.log("[verix] No reviewable changes found");
    return;
  }

  // Resolve user's BYOK config — no key means no review
  const userConfig = await resolveUserConfig(installationId);
  if (!userConfig) {
    await postReviewComment(
      octokit, owner, repo, prNumber,
      "**Verix** — No API key configured. Please go to your [Verix dashboard](https://verix.in/dashboard/settings) to set up your model provider and API key."
    );
    console.log(`[verix] Skipped PR #${prNumber} — no API key configured`);
    return;
  }
  const { userProvider, userAdapter, userAgentAdapter, userReviewRules } = userConfig;

  // Load graph from Neon (source of truth)
  let repoId: string | null = null;
  let graph: import("./indexer/depgraph.js").DepGraph | null = null;
  let indexedFiles: Set<string> | null = null;

  try {
    const dbRepo = await getRepoByName(fullName);
    if (dbRepo && dbRepo.status === "ready") {
      repoId = dbRepo.id;
      graph = await loadGraphFromDb(dbRepo.id);
      indexedFiles = await getIndexedFiles(dbRepo.id);
      const edgeCount = Object.values(graph.forward).reduce((sum, deps) => sum + deps.length, 0);
      console.log(`[verix] Loaded dep graph from DB (${edgeCount} edges)`);
    } else {
      console.log(`[verix] No index in DB for ${fullName}, reviewing without dep context`);
    }
  } catch (error) {
    console.error(`[verix] Failed to load graph from DB:`, error);
  }

  // Load repo-specific config (VERIX.md, .verix.yml)
  // Priority: repo VERIX.md > user DB rules > defaults
  const config = await loadRepoConfig(octokit, owner, repo, ref);
  if (!config.reviewRules && userReviewRules) {
    config.reviewRules = userReviewRules;
    config.rulesSource = "user settings";
    console.log("[verix] Using review rules from user settings");
  }
  const customRules = buildRulesPrompt(config);

  let summary: string;
  let comments: import("./review.js").ReviewComment[];

  if (userAgentAdapter) {
    const toolCtx: ToolContext = { octokit, owner, repo, ref, graph, repoId };
    console.log(`[verix] Agent reviewing ${files.length} file(s) with ${userProvider}...`);
    ({ summary, comments } = await agentReview(
      userAgentAdapter,
      files,
      toolCtx,
      customRules || undefined,
      config.settings.ignore
    ));
  } else {
    let contextFiles;
    if (graph && indexedFiles) {
      const changedPaths = files.map((f) => f.filename);
      contextFiles = await crawlContext(octokit, owner, repo, ref, changedPaths, graph, indexedFiles);
      console.log(`[verix] Found ${contextFiles.length} related file(s) for context`);
    }
    console.log(`[verix] Reviewing ${files.length} file(s) with ${userProvider}...`);
    ({ summary, comments } = await reviewPR(userAdapter, files, contextFiles));
  }

  if (comments.length > 0) {
    await postPRReview(octokit, owner, repo, prNumber, summary, comments);
  } else {
    await postReviewComment(octokit, owner, repo, prNumber, summary);
  }

  console.log(`[verix] Review posted on PR #${prNumber} (${comments.length} issue(s))`);
}

// --- PR events ---

app.webhooks.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async ({ payload, octokit }) => {
  const { repository, pull_request } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const headSha = pull_request.head.sha;
  const fullName = `${owner}/${repo}`;

  const dedupKey = `${fullName}#${prNumber}@${headSha}`;
  if (processedPRs.has(dedupKey)) {
    console.log(`[verix] Skipping duplicate event for PR #${prNumber}`);
    return;
  }
  processedPRs.add(dedupKey);

  console.log(`[verix] PR #${prNumber} opened on ${fullName}`);

  try {
    await runReview(octokit, owner, repo, prNumber, pull_request.head.ref, payload.installation?.id);
  } catch (error) {
    console.error(`[verix] Error reviewing PR #${prNumber}:`, error);
  }
});

// --- /verix review command via PR comment ---

app.webhooks.on("issue_comment.created", async ({ payload, octokit }) => {
  const { comment, issue, repository } = payload;

  // Only respond to /verix review on pull requests
  if (!issue.pull_request) return;
  const body = comment.body.trim().toLowerCase();
  if (body !== "/verix review" && body !== "/verix") return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = issue.number;
  const fullName = `${owner}/${repo}`;

  console.log(`[verix] /verix review requested on PR #${prNumber} by @${comment.user?.login ?? "unknown"}`);

  try {
    // Get PR head ref
    const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
    });

    const ref = (pr as { head: { ref: string } }).head.ref;
    await runReview(octokit, owner, repo, prNumber, ref, payload.installation?.id);
  } catch (error) {
    console.error(`[verix] Error reviewing PR #${prNumber} from comment:`, error);
    // Post error as comment so user knows
    await postReviewComment(
      octokit, owner, repo, prNumber,
      "Verix encountered an error while reviewing. Please try again."
    ).catch(() => {});
  }
});

app.webhooks.onError((error) => {
  console.error("[verix] Webhook error:", error);
});

const middleware = createNodeMiddleware(app.webhooks, { path: "/api/webhook" });
const server = createServer(middleware);

server.listen(PORT, async () => {
  console.log(`[verix] Server running on http://localhost:${PORT}`);

  try {
    await initDb();
  } catch (error) {
    console.error("[verix] Failed to initialize database:", error);
  }

  if (process.env.WEBHOOK_PROXY_URL) {
    const { default: SmeeClient } = await import("smee-client");
    const smee = new SmeeClient({
      source: process.env.WEBHOOK_PROXY_URL,
      target: `http://localhost:${PORT}/api/webhook`,
      logger: console,
    });
    smee.start();
    console.log(`[verix] Smee proxy connected: ${process.env.WEBHOOK_PROXY_URL}`);
  }
});
