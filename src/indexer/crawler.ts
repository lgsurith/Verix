import type { OctokitClient } from "../types.js";
import type { DepGraph } from "./depgraph.js";
import { fetchFileContent, parseImports } from "./depgraph.js";

export interface ContextFile {
  path: string;
  content: string;
  relation: "changed" | "imports" | "imported_by";
}

export async function crawlContext(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string,
  changedFiles: string[],
  graph: DepGraph,
  indexedFiles: Set<string>,
  depth: number = 1
): Promise<ContextFile[]> {
  const visited = new Set<string>();
  const contextFiles: ContextFile[] = [];

  // For new files not in the graph, parse their imports on the fly
  for (const file of changedFiles) {
    if (!graph.forward[file]) {
      try {
        const content = await fetchFileContent(octokit, owner, repo, file, ref);
        const imports = parseImports(content, file, indexedFiles);
        if (imports.length > 0) {
          graph.forward[file] = imports;
          // Also add reverse edges
          for (const dep of imports) {
            if (!graph.reverse[dep]) graph.reverse[dep] = [];
            graph.reverse[dep]!.push(file);
          }
        }
      } catch {
        // New file not fetchable, skip
      }
    }
  }

  // BFS from changed files
  let currentLevel = changedFiles.filter((f) => graph.forward[f] || graph.reverse[f]);

  for (let d = 0; d < depth; d++) {
    const nextLevel: Array<{ path: string; relation: "imports" | "imported_by" }> = [];

    for (const file of currentLevel) {
      if (visited.has(file)) continue;
      visited.add(file);

      // Forward deps: what this file imports
      const imports = graph.forward[file] ?? [];
      for (const dep of imports) {
        if (!visited.has(dep) && !changedFiles.includes(dep)) {
          nextLevel.push({ path: dep, relation: "imports" });
        }
      }

      // Reverse deps: what depends on this file
      const dependents = graph.reverse[file] ?? [];
      for (const dep of dependents) {
        if (!visited.has(dep) && !changedFiles.includes(dep)) {
          nextLevel.push({ path: dep, relation: "imported_by" });
        }
      }
    }

    // Fetch content for this level's neighbors
    const uniqueNext = nextLevel.filter(
      (entry, i, arr) => arr.findIndex((e) => e.path === entry.path) === i
    );

    const batchSize = 10;
    for (let i = 0; i < uniqueNext.length; i += batchSize) {
      const batch = uniqueNext.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async ({ path, relation }) => {
          try {
            const content = await fetchFileContent(octokit, owner, repo, path, ref);
            return { path, content, relation };
          } catch {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result) {
          contextFiles.push(result);
          visited.add(result.path);
        }
      }
    }

    // Next level becomes the files we just discovered
    currentLevel = uniqueNext.map((e) => e.path);
  }

  console.log(
    `[verix] Crawled ${contextFiles.length} related file(s) from ${changedFiles.length} changed file(s)`
  );

  return contextFiles;
}
