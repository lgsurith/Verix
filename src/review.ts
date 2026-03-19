import type { PRFile } from "./github.js";
import type { InferenceAdapter } from "./adapters/base.js";
import type { ContextFile } from "./indexer/crawler.js";

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

interface ModelResponse {
  summary: string;
  reviews: ModelReview[];
}

export interface ReviewComment {
  path: string;
  start_line: number;
  line: number;
  side: "RIGHT";
  body: string;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
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

export function buildPrompt(files: PRFile[], contextFiles?: ContextFile[]): string {
  const fileSections = files
    .filter((f): f is PRFile & { patch: string } => !!f.patch)
    .map((f) => `### ${f.filename}\n\`\`\`diff\n${annotatePatch(f.patch)}\n\`\`\``)
    .join("\n\n");

  let contextSection = "";
  if (contextFiles && contextFiles.length > 0) {
    const contextParts = contextFiles.map((cf) => {
      const lang = getLanguage(cf.path);
      const relationLabel = cf.relation === "imports" ? "imported by changed files" : "depends on changed files";
      return `### ${cf.path} (${relationLabel})\n\`\`\`${lang}\n${cf.content}\n\`\`\``;
    });
    contextSection = `\n\n## Related Files (for context only — do NOT review these)\n\nThese files are connected to the changed files via imports. Use them to understand how the changes affect the broader codebase, but only review the changed files above.\n\n${contextParts.join("\n\n")}`;
  }

  return `You are a senior software engineer reviewing a pull request.

You MUST respond with ONLY valid JSON — no markdown, no explanation, no text outside the JSON.

Return a JSON object with this exact structure:
{
  "summary": "1-2 sentence overall summary of the PR",
  "reviews": [
    {
      "filename": "exact/filename.ts",
      "severity": "critical",
      "start_line": 4,
      "end_line": 6,
      "issue": "What the problem is in 1-2 sentences",
      "fix_type": "applyable | recommendation | warning",
      "suggested_code": "the code (for applyable and recommendation types) OR null (for warning type)"
    }
  ]
}

IMPORTANT rules for line numbers and code:
- start_line and end_line are the NEW file line numbers (shown as [L1], [L2], etc. in the diff)
- Only use lines marked with + (added lines) since suggestions can only modify new code
- You can have multiple reviews per file if there are multiple issues
- "fix_type" determines how the code is shown:
  - "applyable": a direct code fix the user can apply with one click (e.g. SQL injection → parameterized query). Include "suggested_code" with the exact replacement for lines start_line to end_line.
  - "recommendation": a code example showing a better approach, but not a direct replacement (e.g. "consider using a switch statement instead"). Include "suggested_code" with the improved code as a reference.
  - "warning": no code, just a text observation (e.g. "this function has no retry logic for failed payments"). Set "suggested_code" to null.

Severity levels:
- "critical": must fix (security holes, data loss, crashes)
- "high": should fix (bugs, missing error handling)
- "medium": fix soon (logic issues, edge cases)
- "low": nice to have (minor improvements)

Rules:
- Only include files that have real issues
- Skip style nitpicks
- If all files look good, return empty reviews array
- Use the related files context to catch issues like broken imports, type mismatches, or missing interface implementations

## Changes

${fileSections}${contextSection}`;
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

function parseModelResponse(raw: string): ModelResponse {
  const jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(jsonStr) as ModelResponse;
}

export async function reviewPR(
  adapter: InferenceAdapter,
  files: PRFile[],
  contextFiles?: ContextFile[],
  customRules?: string
): Promise<{ summary: string; comments: ReviewComment[] }> {
  let prompt = buildPrompt(files, contextFiles);
  if (customRules) {
    prompt += customRules;
  }

  if (contextFiles && contextFiles.length > 0) {
    console.log(`[verix] Prompt includes ${contextFiles.length} context file(s): ${contextFiles.map((f) => f.path).join(", ")}`);
  }

  const raw = await adapter.review(prompt);
  const result = parseModelResponse(raw);

  const summary = [
    "## 🔍 Verix Review",
    "",
    result.summary,
    "",
    `Reviewed **${files.length}** file(s) | Found **${result.reviews.length}** issue(s)`,
    "",
    "---",
    "*Reviewed by [Verix](https://github.com/lgsurith/verix) — AI code review bot*",
  ].join("\n");

  const comments: ReviewComment[] = result.reviews.map((review) => ({
    path: review.filename,
    start_line: review.start_line,
    line: review.end_line,
    side: "RIGHT" as const,
    body: formatCommentBody(review),
  }));

  return { summary, comments };
}
