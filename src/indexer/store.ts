import type { DepGraph } from "./depgraph.js";

type IndexStatus = "indexing" | "ready" | "failed" | "stale";

interface RepoIndex {
  fullName: string;
  headSha: string;
  graph: DepGraph;
  files: Set<string>;
  status: IndexStatus;
  indexedAt: Date;
}

// In-memory store — swap for DB later if needed
const indexes = new Map<string, RepoIndex>();

export function getRepoIndex(fullName: string): RepoIndex | undefined {
  return indexes.get(fullName);
}

export function setRepoIndex(
  fullName: string,
  headSha: string,
  graph: DepGraph,
  files: Set<string>
): void {
  indexes.set(fullName, {
    fullName,
    headSha,
    graph,
    files,
    status: "ready",
    indexedAt: new Date(),
  });
}

export function setRepoStatus(fullName: string, status: IndexStatus): void {
  const index = indexes.get(fullName);
  if (index) {
    index.status = status;
  }
}

export function markStale(fullName: string): void {
  setRepoStatus(fullName, "stale");
}

export function isReady(fullName: string): boolean {
  const index = indexes.get(fullName);
  return index?.status === "ready";
}
