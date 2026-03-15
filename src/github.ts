import type { OctokitClient } from "./types.js";
import type { ReviewComment } from "./review.js";

export interface PRFile {
  filename: string;
  status: string;
  patch?: string;
}

interface GitHubFileResponse {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface ReviewAPIComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
}

export async function getPRFiles(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PRFile[]> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return (data as GitHubFileResponse[]).map((file) => ({
    filename: file.filename,
    status: file.status,
    patch: file.patch,
  }));
}

export async function postPRReview(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
  summary: string,
  comments: ReviewComment[]
): Promise<void> {
  const apiComments: ReviewAPIComment[] = comments.map((c) => {
    const comment: ReviewAPIComment = {
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    };

    if (c.start_line && c.start_line !== c.line) {
      comment.start_line = c.start_line;
      comment.start_side = c.side;
    }

    return comment;
  });

  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: pullNumber,
    event: "COMMENT",
    body: summary,
    comments: apiComments,
  });
}

export async function postReviewComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
}
