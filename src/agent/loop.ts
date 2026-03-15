import type { PRFile } from "../github.js";
import type { ReviewComment } from "../review.js";
import { TOOLS, executeTool } from "./tools.js";
import type { ToolContext, ToolCall } from "./tools.js";

// --- Glob pattern matching ---

function matchesAnyPattern(filepath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchGlob(filepath, pattern));
}

function matchGlob(filepath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(filepath) ||
    new RegExp(`(^|/)${regex}$`).test(filepath);
}

// --- Message types for the conversation ---

interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

interface ToolResultMessage {
  role: "tool";
  tool_call_id?: string;
  name: string;
  content: string;
}

export type AgentMessage = TextMessage | ToolCallMessage | ToolResultMessage;

// --- Adapter interface for agentic chat ---

export interface AgentAdapter {
  chat(
    messages: AgentMessage[],
    tools: typeof TOOLS
  ): Promise<{
    message: string | null;
    toolCalls: ToolCall[] | null;
  }>;
}

// --- Review result types ---


type Severity = "critical" | "high" | "medium" | "low";
type FixType = "applyable" | "recommendation" | "warning";

interface ModelReview {
  filename: string;
  severity: Severity;
  start_line: number;
  end_line: number;
  issue: string;
  fix_type: FixType;
  suggested_code: string | null;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "\u{1F534}",
  high: "\u{1F7E0}",
  medium: "\u{1F7E1}",
  low: "\u{1F535}",
};

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", go: "go", rs: "rust", java: "java", rb: "ruby",
  yml: "yaml", yaml: "yaml", json: "json",
};

function getLanguage(filename: string): string {
  const ext = filename.split(".").pop() ?? "";
  return LANGUAGE_MAP[ext] ?? ext;
}

function formatCommentBody(review: ModelReview): string {
  const emoji = SEVERITY_EMOJI[review.severity];
  const label = review.severity.charAt(0).toUpperCase() + review.severity.slice(1);
  let body = `${emoji} **${label}**\n\n${review.issue}`;

  if (review.fix_type === "applyable" && review.suggested_code) {
    body += "\n\n```suggestion\n" + review.suggested_code + "\n```";
  } else if (review.fix_type === "recommendation" && review.suggested_code) {
    const lang = getLanguage(review.filename);
    body += "\n\n**How to improve:**\n```" + lang + "\n" + review.suggested_code + "\n```";
  }

  return body;
}

// --- Prompt builder ---

function annotatePatch(patch: string): string {
  const lines = patch.split("\n");
  let lineNum = 0;

  return lines
    .map((line) => {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        lineNum = parseInt(hunkMatch[1]!, 10) - 1;
        return line;
      }
      if (line.startsWith("-")) return line;
      lineNum++;
      return line.startsWith("+") ? `[L${lineNum}] ${line}` : `[L${lineNum}] ${line}`;
    })
    .join("\n");
}

function buildSystemPrompt(customRules?: string): string {
  let prompt = `You are a senior software engineer reviewing a pull request.

You have tools to explore the codebase. Use them to understand the full context before submitting your review.

Strategy:
1. Read the diff carefully
2. Use get_imports to see what the changed files depend on
3. Use get_dependents to see what depends on the changed files (blast radius)
4. Use get_file_content to read important related files
5. When you have enough context, call submit_review

Rules for the review:
- Only flag real issues (bugs, security holes, missing error handling)
- Skip style nitpicks
- For each issue, specify fix_type:
  - "applyable": direct code fix (provide exact replacement code for lines start_line to end_line)
  - "recommendation": better approach (provide code example as reference)
  - "warning": text observation only (set suggested_code to null)
- Severity: "critical" (security/data loss), "high" (bugs), "medium" (logic issues), "low" (minor improvements)
- Line numbers must be NEW file line numbers (marked as [L1], [L2] in the diff)
- Only suggest changes to added lines (lines with +)
- If everything looks good, submit with an empty reviews array`;

  if (customRules) {
    prompt += customRules;
  }

  return prompt;
}

function buildUserPrompt(files: PRFile[]): string {
  const fileSections = files
    .filter((f): f is PRFile & { patch: string } => !!f.patch)
    .map((f) => `### ${f.filename}\n\`\`\`diff\n${annotatePatch(f.patch)}\n\`\`\``)
    .join("\n\n");

  return `Review this pull request:\n\n${fileSections}\n\nUse the tools to explore related files before submitting your review.`;
}

// --- The agent loop ---

const MAX_TURNS = 10;
const MAX_FILE_FETCHES = 12;
const TIMEOUT_MS = 60_000; // 60 seconds wall clock

export async function agentReview(
  adapter: AgentAdapter,
  files: PRFile[],
  ctx: ToolContext,
  customRules?: string,
  ignorePatterns?: string[]
): Promise<{ summary: string; comments: ReviewComment[] }> {
  // Filter out ignored files before review
  const reviewFiles = ignorePatterns && ignorePatterns.length > 0
    ? files.filter((f) => !matchesAnyPattern(f.filename, ignorePatterns))
    : files;

  if (reviewFiles.length === 0) {
    console.log("[verix] All changed files matched ignore patterns, skipping review");
    return { summary: "", comments: [] };
  }

  if (reviewFiles.length < files.length) {
    console.log(`[verix] Filtered ${files.length - reviewFiles.length} file(s) via ignore patterns`);
  }

  const messages: AgentMessage[] = [
    { role: "system", content: buildSystemPrompt(customRules) },
    { role: "user", content: buildUserPrompt(reviewFiles) },
  ];

  const fetchedFiles = new Set<string>();
  const startTime = Date.now();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Wall clock timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(`[verix] Agent timed out after ${turn} turn(s) (${TIMEOUT_MS}ms)`);
      break;
    }

    const response = await adapter.chat(messages, TOOLS);

    // No tool calls — model is done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      console.log(`[verix] Agent finished without submit_review (turn ${turn + 1})`);
      return {
        summary: "Verix review completed but no structured review was submitted.",
        comments: [],
      };
    }

    // Check if submit_review is called
    const submitCall = response.toolCalls.find((tc) => tc.name === "submit_review");
    if (submitCall) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[verix] Agent submitted review after ${turn + 1} turn(s), ${fetchedFiles.size} file(s), ${elapsed}s`);
      return parseSubmitReview(submitCall.args, files.length);
    }

    // Execute tool calls with guardrails
    const toolCallMessage: ToolCallMessage = {
      role: "assistant",
      content: response.message,
      tool_calls: response.toolCalls,
    };
    messages.push(toolCallMessage);

    for (const toolCall of response.toolCalls) {
      let result: string;

      if (toolCall.name === "get_file_content") {
        const path = String(toolCall.args.path ?? "");

        // Don't fetch the same file twice
        if (fetchedFiles.has(path)) {
          result = `You already fetched ${path}. Use the content from earlier in the conversation.`;
          console.log(`[verix] Agent re-requested: ${path} (blocked, already fetched)`);
        } else if (fetchedFiles.size >= MAX_FILE_FETCHES) {
          result = `File fetch limit reached (${MAX_FILE_FETCHES}). Submit your review with the context you have.`;
          console.log(`[verix] Agent hit file fetch limit (${MAX_FILE_FETCHES})`);
        } else {
          fetchedFiles.add(path);
          console.log(`[verix] Agent calls: ${toolCall.name}("${path}") [${fetchedFiles.size}/${MAX_FILE_FETCHES}]`);
          result = await executeTool(toolCall, ctx);
        }
      } else {
        console.log(`[verix] Agent calls: ${toolCall.name}(${JSON.stringify(toolCall.args)})`);
        result = await executeTool(toolCall, ctx);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: result,
      });
    }
  }

  console.log(`[verix] Agent hit max turns (${MAX_TURNS}), fetched ${fetchedFiles.size} file(s)`);
  return {
    summary: "Verix review timed out — too many exploration steps.",
    comments: [],
  };
}

// --- Parse the submit_review tool call into ReviewComments ---

function parseSubmitReview(
  args: Record<string, unknown>,
  fileCount: number
): { summary: string; comments: ReviewComment[] } {
  const summaryText = (args.summary as string) ?? "No summary provided.";
  let reviews: ModelReview[] = [];

  try {
    const rawReviews = args.reviews;
    if (Array.isArray(rawReviews)) {
      reviews = rawReviews;
    } else if (typeof rawReviews === "string") {
      // Clean up markdown fences or extra whitespace that models sometimes include
      const cleaned = rawReviews
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      reviews = Array.isArray(parsed) ? parsed : [];
    } else if (rawReviews && typeof rawReviews === "object") {
      // Single review object instead of array
      reviews = [rawReviews as ModelReview];
    }
  } catch {
    console.error("[verix] Failed to parse agent review JSON:", typeof args.reviews, args.reviews);
  }

  const summary = [
    "## \u{1F50D} Verix Review",
    "",
    summaryText,
    "",
    `Reviewed **${fileCount}** file(s) | Found **${reviews.length}** issue(s)`,
    "",
    "---",
    "*Reviewed by [Verix](https://github.com/lgsurith/verix) — AI code review bot*",
  ].join("\n");

  const comments: ReviewComment[] = reviews.map((review) => ({
    path: review.filename,
    start_line: review.start_line,
    line: review.end_line,
    side: "RIGHT" as const,
    body: formatCommentBody(review),
  }));

  return { summary, comments };
}
