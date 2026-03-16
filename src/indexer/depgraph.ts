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

const SUPPORTED_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx",  // TypeScript / JavaScript
  "py",                       // Python
  "go",                       // Go
  "rs",                       // Rust
  "java",                     // Java
  "rb",                       // Ruby
]);

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

const PY_RELATIVE_IMPORT_PATTERN = /^from\s+(\.+[\w.]*)\s+import/gm;  // from . import foo, from .module import bar

const GO_IMPORT_PATTERNS = [
  /^\s*"(.+?)"/gm,                                    // "fmt" or "github.com/pkg/errors"
  /^\s*\w+\s+"(.+?)"/gm,                              // alias "github.com/pkg/errors"
];

const RUST_IMPORT_PATTERNS = [
  /^use\s+(crate::[\w:]+)/gm,                         // use crate::module::item
  /^mod\s+(\w+)/gm,                                   // mod module_name
];

const JAVA_IMPORT_PATTERNS = [
  /^import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?;/gm,   // import com.example.Foo; import static com.example.Foo.BAR; import com.example.*;
];

const RUBY_IMPORT_PATTERNS = [
  /^require\s+['"](.+?)['"]/gm,                       // require 'foo'
  /^require_relative\s+['"](.+?)['"]/gm,              // require_relative './foo'
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

  // Try exact match, extension swaps, and index files
  const candidates = [basePath];

  // If import has .js/.jsx extension, also try .ts/.tsx (ESM TypeScript convention)
  if (basePath.endsWith(".js")) {
    candidates.push(basePath.replace(/\.js$/, ".ts"), basePath.replace(/\.js$/, ".tsx"));
  } else if (basePath.endsWith(".jsx")) {
    candidates.push(basePath.replace(/\.jsx$/, ".tsx"), basePath.replace(/\.jsx$/, ".ts"));
  }

  // Try adding extensions
  candidates.push(
    basePath + ".ts", basePath + ".tsx",
    basePath + ".js", basePath + ".jsx",
    basePath + "/index.ts", basePath + "/index.tsx",
    basePath + "/index.js", basePath + "/index.jsx",
  );

  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolvePythonImport(importPath: string, allFiles: Set<string>): string | null {
  const asPath = importPath.replace(/\./g, "/");
  const candidates = [
    asPath + ".py",
    asPath + "/__init__.py",
    "src/" + asPath + ".py",
    "src/" + asPath + "/__init__.py",
  ];
  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolvePythonRelativeImport(
  importPath: string,
  currentFile: string,
  allFiles: Set<string>
): string | null {
  // Count leading dots for parent directory levels
  const dotMatch = importPath.match(/^(\.+)(.*)/);
  if (!dotMatch) return null;

  const dots = dotMatch[1]!.length;
  const modulePart = dotMatch[2]!.replace(/\./g, "/");

  // Get current file's directory
  const parts = currentFile.split("/");
  parts.pop(); // remove filename

  // Go up (dots - 1) directories (one dot = current package)
  for (let i = 0; i < dots - 1; i++) {
    parts.pop();
  }

  const basePath = parts.length > 0 ? parts.join("/") + "/" : "";
  const fullPath = basePath + modulePart;

  const candidates = [
    fullPath + ".py",
    fullPath + "/__init__.py",
    fullPath,  // might be a directory with __init__.py
  ];

  // If modulePart is empty (from . import foo), try the current package's __init__.py
  if (!modulePart) {
    candidates.push(basePath + "__init__.py");
  }

  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolveGoImport(importPath: string, allFiles: Set<string>): string | null {
  // Skip standard library and external packages
  if (!importPath.includes("/") || importPath.includes(".")) return null;
  const candidates = allFiles;
  // Go imports are package-based, try to match directory
  for (const file of candidates) {
    if (file.endsWith(".go") && file.includes(importPath)) return file;
  }
  return null;
}

function resolveRustImport(importPath: string, allFiles: Set<string>): string | null {
  // crate::foo::bar → src/foo/bar.rs or src/foo/bar/mod.rs
  const parts = importPath.replace("crate::", "").replace(/::/g, "/");
  const candidates = [
    `src/${parts}.rs`,
    `src/${parts}/mod.rs`,
    `${parts}.rs`,
    `${parts}/mod.rs`,
  ];
  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolveJavaImport(importPath: string, allFiles: Set<string>): string | null {
  const asPath = importPath.replace(/\./g, "/");
  const candidates = [
    `src/main/java/${asPath}.java`,
    `src/${asPath}.java`,
    `${asPath}.java`,
  ];
  return candidates.find((c) => allFiles.has(c)) ?? null;
}

function resolveRubyImport(importPath: string, currentFile: string, allFiles: Set<string>): string | null {
  // require_relative resolves relative to current file
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    // require 'foo' → lib/foo.rb or foo.rb
    const candidates = [
      `lib/${importPath}.rb`,
      `${importPath}.rb`,
    ];
    return candidates.find((c) => allFiles.has(c)) ?? null;
  }
  // Relative path
  const resolved = resolveImportPath(importPath, currentFile, allFiles);
  return resolved;
}

export function parseImports(content: string, filepath: string, allFiles: Set<string>): string[] {
  const ext = getExtension(filepath);
  const imports: string[] = [];

  const langConfig: Record<string, { patterns: RegExp[]; resolver: (match: string) => string | null }> = {
    ts: { patterns: TS_IMPORT_PATTERNS, resolver: (m) => resolveImportPath(m, filepath, allFiles) },
    tsx: { patterns: TS_IMPORT_PATTERNS, resolver: (m) => resolveImportPath(m, filepath, allFiles) },
    js: { patterns: TS_IMPORT_PATTERNS, resolver: (m) => resolveImportPath(m, filepath, allFiles) },
    jsx: { patterns: TS_IMPORT_PATTERNS, resolver: (m) => resolveImportPath(m, filepath, allFiles) },
    py: { patterns: PY_IMPORT_PATTERNS, resolver: (m) => resolvePythonImport(m, allFiles) },
    go: { patterns: GO_IMPORT_PATTERNS, resolver: (m) => resolveGoImport(m, allFiles) },
    rs: { patterns: RUST_IMPORT_PATTERNS, resolver: (m) => resolveRustImport(m, allFiles) },
    java: { patterns: JAVA_IMPORT_PATTERNS, resolver: (m) => resolveJavaImport(m, allFiles) },
    rb: { patterns: RUBY_IMPORT_PATTERNS, resolver: (m) => resolveRubyImport(m, filepath, allFiles) },
  };

  const config = langConfig[ext];
  if (config) {
    for (const pattern of config.patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const resolved = config.resolver(match[1]!);
        if (resolved) imports.push(resolved);
      }
    }
  }

  // Python relative imports (from . import foo, from ..module import bar)
  if (ext === "py") {
    const regex = new RegExp(PY_RELATIVE_IMPORT_PATTERN.source, PY_RELATIVE_IMPORT_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const resolved = resolvePythonRelativeImport(match[1]!, filepath, allFiles);
      if (resolved) imports.push(resolved);
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
