import type { OctokitClient } from "../types.js";

export interface DepGraph {
  forward: Record<string, string[]>;  // file → what it imports
  reverse: Record<string, string[]>;  // file → what depends on it
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const SUPPORTED_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "py"]);

// Regex patterns for import parsing
const TS_IMPORT_PATTERNS = [
  /import\s+.*?\s+from\s+['"](.+?)['"]/g,           // import x from './foo'
  /import\s*\(\s*['"](.+?)['"]\s*\)/g,               // import('./foo')
  /require\s*\(\s*['"](.+?)['"]\s*\)/g,              // require('./foo')
  /export\s+.*?\s+from\s+['"](.+?)['"]/g,            // export { x } from './foo'
];

const PY_IMPORT_PATTERNS = [
  /^import\s+([\w.]+)/gm,                             // import foo.bar
  /^from\s+([\w.]+)\s+import/gm,                      // from foo.bar import x
];

function getExtension(filepath: string): string {
  return filepath.split(".").pop() ?? "";
}

function isSupported(filepath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(getExtension(filepath));
}

function resolveImportPath(importPath: string, currentFile: string, allFiles: Set<string>): string | null {
  // Skip external packages (no relative path indicator)
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;

  // Get the directory of the current file
  const parts = currentFile.split("/");
  parts.pop();
  const currentDir = parts.join("/");

  // Resolve relative path
  const segments = (currentDir ? currentDir + "/" + importPath : importPath).split("/");
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === "..") resolved.pop();
    else if (seg !== ".") resolved.push(seg);
  }

  const basePath = resolved.join("/");

  // Try exact match, then with extensions
  const candidates = [
    basePath,
    basePath + ".ts",
    basePath + ".tsx",
    basePath + ".js",
    basePath + ".jsx",
    basePath + "/index.ts",
    basePath + "/index.tsx",
    basePath + "/index.js",
    basePath + "/index.jsx",
  ];

  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolvePythonImport(importPath: string, allFiles: Set<string>): string | null {
  const asPath = importPath.replace(/\./g, "/");
  const candidates = [
    asPath + ".py",
    asPath + "/__init__.py",
  ];
  return candidates.find((c) => allFiles.has(c)) ?? null;
}

export function parseImports(content: string, filepath: string, allFiles: Set<string>): string[] {
  const ext = getExtension(filepath);
  const imports: string[] = [];

  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    for (const pattern of TS_IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const resolved = resolveImportPath(match[1]!, filepath, allFiles);
        if (resolved) imports.push(resolved);
      }
    }
  } else if (ext === "py") {
    for (const pattern of PY_IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const resolved = resolvePythonImport(match[1]!, allFiles);
        if (resolved) imports.push(resolved);
      }
    }
  }

  return [...new Set(imports)];
}

export async function fetchRepoTree(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string = "HEAD"
): Promise<TreeEntry[]> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: ref,
    recursive: "1",
  });

  return ((data as { tree: TreeEntry[] }).tree).filter(
    (entry) => entry.type === "blob" && isSupported(entry.path)
  );
}

export async function fetchFileContent(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner,
    repo,
    path,
    ref,
    mediaType: { format: "raw" },
  });

  return data as unknown as string;
}

export async function buildDepGraph(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string = "HEAD"
): Promise<{ graph: DepGraph; files: Set<string> }> {
  console.log(`[verix] Fetching repo tree for ${owner}/${repo}...`);
  const tree = await fetchRepoTree(octokit, owner, repo, ref);
  const allFiles = new Set(tree.map((t) => t.path));

  console.log(`[verix] Found ${allFiles.size} supported files, parsing imports...`);

  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};

  // Initialize reverse map for all files
  for (const file of allFiles) {
    reverse[file] = [];
  }

  // Fetch and parse each file
  const batchSize = 10;
  const entries = [...allFiles];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filepath) => {
        try {
          const content = await fetchFileContent(octokit, owner, repo, filepath, ref);
          const imports = parseImports(content, filepath, allFiles);
          return { filepath, imports };
        } catch {
          return { filepath, imports: [] };
        }
      })
    );

    for (const { filepath, imports } of results) {
      forward[filepath] = imports;
      for (const dep of imports) {
        if (!reverse[dep]) reverse[dep] = [];
        reverse[dep]!.push(filepath);
      }
    }
  }

  console.log(`[verix] Dep graph built: ${Object.keys(forward).length} files indexed`);

  return {
    graph: { forward, reverse },
    files: allFiles,
  };
}
