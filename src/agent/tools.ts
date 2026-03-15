import type { OctokitClient } from "../types.js";
import type { DepGraph } from "../indexer/depgraph.js";
import { fetchFileContent } from "../indexer/depgraph.js";
import { getImports as dbGetImports, getDependents as dbGetDependents } from "../db/index.js";

// --- Tool definitions (sent to the model) ---

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_file_content",
    description:
      "Fetch the full source code of a file from the repository. Use this to read files that are imported by or depend on the changed files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path relative to the repo root (e.g. src/utils/helpers.ts)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_imports",
    description:
      "Get the list of files that a given file imports (forward dependencies). Returns file paths.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to check imports for",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_dependents",
    description:
      "Get the list of files that import/depend on a given file (reverse dependencies). Use this to understand the blast radius of a change.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to check dependents for",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "submit_review",
    description:
      "Submit the final code review. Call this when you have finished exploring and are ready to post your review.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "1-2 sentence overall summary of the PR",
        },
        reviews: {
          type: "string",
          description:
            'JSON array of review objects. Each object: {"filename":"path","severity":"critical|high|medium|low","start_line":1,"end_line":2,"issue":"description","fix_type":"applyable|recommendation|warning","suggested_code":"code or null"}',
        },
      },
      required: ["summary", "reviews"],
    },
  },
];

// --- Tool execution ---

export interface ToolContext {
  octokit: OctokitClient;
  owner: string;
  repo: string;
  ref: string;
  graph: DepGraph | null;
  repoId: string | null; // Neon repo UUID for DB queries
}

export interface ToolCall {
  id?: string; // Preserved from API response (needed for Claude/OpenAI tool_use_id matching)
  name: string;
  args: Record<string, unknown>;
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  switch (call.name) {
    case "get_file_content":
      return executeGetFileContent(String(call.args.path ?? ""), ctx);

    case "get_imports":
      return executeGetImports(String(call.args.path ?? ""), ctx);

    case "get_dependents":
      return executeGetDependents(String(call.args.path ?? ""), ctx);

    case "submit_review":
      return JSON.stringify(call.args.reviews ?? "[]");

    default:
      return `Unknown tool: ${call.name}`;
  }
}

async function executeGetFileContent(path: string, ctx: ToolContext): Promise<string> {
  try {
    const content = await fetchFileContent(ctx.octokit, ctx.owner, ctx.repo, path, ctx.ref);
    console.log(`[verix] Agent fetched: ${path} (${content.length} chars)`);
    return content;
  } catch {
    return `Error: file not found or inaccessible: ${path}`;
  }
}

async function executeGetImports(path: string, ctx: ToolContext): Promise<string> {
  // Prefer DB, fallback to in-memory graph
  if (ctx.repoId) {
    const imports = await dbGetImports(ctx.repoId, path);
    if (imports.length === 0) return `${path} has no imports (or is not in the index).`;
    return `${path} imports:\n${imports.map((f) => `  - ${f}`).join("\n")}`;
  }
  if (!ctx.graph) return "No dependency graph available for this repo.";
  const imports = ctx.graph.forward[path];
  if (!imports || imports.length === 0) return `${path} has no imports (or is not in the index).`;
  return `${path} imports:\n${imports.map((f) => `  - ${f}`).join("\n")}`;
}

async function executeGetDependents(path: string, ctx: ToolContext): Promise<string> {
  // Prefer DB, fallback to in-memory graph
  if (ctx.repoId) {
    const dependents = await dbGetDependents(ctx.repoId, path);
    if (dependents.length === 0) return `No files depend on ${path} (or it is not in the index).`;
    return `Files that import ${path}:\n${dependents.map((f) => `  - ${f}`).join("\n")}`;
  }
  if (!ctx.graph) return "No dependency graph available for this repo.";
  const dependents = ctx.graph.reverse[path];
  if (!dependents || dependents.length === 0) return `No files depend on ${path} (or it is not in the index).`;
  return `Files that import ${path}:\n${dependents.map((f) => `  - ${f}`).join("\n")}`;
}
