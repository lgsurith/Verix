import type { OctokitClient } from "./types.js";

// --- Types ---

export interface RepoConfig {
  /** Free-form review instructions from VERIX.md or equivalent */
  reviewRules: string | null;
  /** Source file the rules were loaded from */
  rulesSource: string | null;
  /** Structured config from .verix.yml */
  settings: VerixSettings;
}

export interface VerixSettings {
  /** AI model provider override (gemini, claude, openai, ollama) */
  model: string | null;
  /** File patterns to ignore during review */
  ignore: string[];
  /** Max agent crawl depth */
  depth: number;
  /** Max files the agent can fetch per review */
  maxFiles: number;
  /** Minimum severity to report (critical, high, medium, low) */
  minSeverity: "critical" | "high" | "medium" | "low";
  /** Language hint for the AI */
  language: string | null;
}

const DEFAULT_SETTINGS: VerixSettings = {
  model: null,
  ignore: [],
  depth: 2,
  maxFiles: 12,
  minSeverity: "low",
  language: null,
};

// --- Rule file detection ---

/** Files to check for review rules, in priority order */
const RULE_FILES = [
  "VERIX.md",
  ".verix.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
];

const CONFIG_FILE = ".verix.yml";

// --- Fetching ---

async function fetchFileFromRepo(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    return data as unknown as string;
  } catch {
    return null;
  }
}

/**
 * Load repo config from VERIX.md (or fallbacks) and .verix.yml.
 * Fetched from the PR's head branch so users can test config changes in PRs.
 */
export async function loadRepoConfig(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoConfig> {
  // 1. Try to find review rules (VERIX.md, CLAUDE.md, etc.)
  let reviewRules: string | null = null;
  let rulesSource: string | null = null;

  for (const file of RULE_FILES) {
    const content = await fetchFileFromRepo(octokit, owner, repo, file, ref);
    if (content) {
      reviewRules = content.trim();
      rulesSource = file;
      break;
    }
  }

  // 2. Try to load .verix.yml
  let settings = { ...DEFAULT_SETTINGS };
  const ymlContent = await fetchFileFromRepo(octokit, owner, repo, CONFIG_FILE, ref);
  if (ymlContent) {
    settings = parseVerixYml(ymlContent, settings);
  }

  if (rulesSource) {
    console.log(`[verix] Loaded review rules from ${rulesSource}`);
  }
  if (ymlContent) {
    console.log(`[verix] Loaded config from ${CONFIG_FILE}`);
  }

  return { reviewRules, rulesSource, settings };
}

// --- YAML parser (minimal, no dependency) ---

function parseVerixYml(content: string, defaults: VerixSettings): VerixSettings {
  const settings = { ...defaults };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case "model":
        if (["gemini", "claude", "openai", "ollama"].includes(value)) {
          settings.model = value;
        }
        break;

      case "depth":
        const depth = parseInt(value, 10);
        if (!isNaN(depth) && depth >= 1 && depth <= 5) {
          settings.depth = depth;
        }
        break;

      case "max_files":
        const maxFiles = parseInt(value, 10);
        if (!isNaN(maxFiles) && maxFiles >= 1 && maxFiles <= 30) {
          settings.maxFiles = maxFiles;
        }
        break;

      case "min_severity":
        if (["critical", "high", "medium", "low"].includes(value)) {
          settings.minSeverity = value as VerixSettings["minSeverity"];
        }
        break;

      case "language":
        settings.language = value;
        break;

      case "ignore":
        // Handles both inline (ignore: ["*.test.ts"]) and multiline (- *.test.ts)
        if (value.startsWith("[")) {
          settings.ignore = value
            .replace(/[\[\]"']/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        break;

      default:
        // Check for list items under ignore
        if (trimmed.startsWith("- ") && content.includes("ignore:")) {
          const pattern = trimmed.slice(2).trim().replace(/["']/g, "");
          if (pattern) settings.ignore.push(pattern);
        }
        break;
    }
  }

  return settings;
}

// --- Prompt injection ---

/**
 * Build the custom rules section to inject into the agent's system prompt.
 */
export function buildRulesPrompt(config: RepoConfig): string {
  const parts: string[] = [];

  if (config.reviewRules) {
    parts.push(
      `## Team Review Guidelines (from ${config.rulesSource})\n\n` +
      `The repository maintainers have provided these review instructions. ` +
      `Follow them carefully — they override default behavior where applicable.\n\n` +
      config.reviewRules
    );
  }

  if (config.settings.ignore.length > 0) {
    parts.push(
      `## Ignored Patterns\n\n` +
      `Do NOT review files matching these patterns:\n` +
      config.settings.ignore.map((p) => `- \`${p}\``).join("\n")
    );
  }

  if (config.settings.minSeverity !== "low") {
    const severityOrder = ["critical", "high", "medium", "low"];
    const minIdx = severityOrder.indexOf(config.settings.minSeverity);
    const allowed = severityOrder.slice(0, minIdx + 1);
    parts.push(
      `## Severity Filter\n\n` +
      `Only report issues with severity: ${allowed.join(", ")}. ` +
      `Skip anything below ${config.settings.minSeverity}.`
    );
  }

  if (config.settings.language) {
    parts.push(
      `## Language\n\n` +
      `This codebase primarily uses ${config.settings.language}. ` +
      `Tailor your suggestions accordingly.`
    );
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
}
