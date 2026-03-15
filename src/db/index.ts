import { neon } from "@neondatabase/serverless";

function getDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[verix] DATABASE_URL is not set in .env");
  return url;
}

const sql = neon(getDbUrl());

// --- Schema setup ---

export async function initDb(): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

  await sql`
    CREATE TABLE IF NOT EXISTS repos (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name   TEXT UNIQUE NOT NULL,
      head_sha    TEXT,
      status      TEXT DEFAULT 'pending',
      indexed_at  TIMESTAMPTZ
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS file_edges (
      repo_id   UUID REFERENCES repos(id) ON DELETE CASCADE,
      source    TEXT NOT NULL,
      target    TEXT NOT NULL,
      PRIMARY KEY (repo_id, source, target)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_edges_target ON file_edges(repo_id, target)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_edges_source ON file_edges(repo_id, source)
  `;

  console.log("[verix] Database initialized");
}

// --- Repo operations ---

export async function getOrCreateRepo(fullName: string): Promise<string> {
  const rows = await sql`
    INSERT INTO repos (full_name)
    VALUES (${fullName})
    ON CONFLICT (full_name) DO UPDATE SET full_name = EXCLUDED.full_name
    RETURNING id
  `;
  return rows[0].id as string;
}

export async function setRepoStatus(
  fullName: string,
  status: string,
  headSha?: string
): Promise<void> {
  if (headSha) {
    await sql`
      UPDATE repos SET status = ${status}, head_sha = ${headSha}, indexed_at = NOW()
      WHERE full_name = ${fullName}
    `;
  } else {
    await sql`
      UPDATE repos SET status = ${status}
      WHERE full_name = ${fullName}
    `;
  }
}

export async function getRepoStatus(fullName: string): Promise<string | null> {
  const rows = await sql`
    SELECT status FROM repos WHERE full_name = ${fullName}
  `;
  return rows.length > 0 ? (rows[0].status as string) : null;
}

// --- Edge operations ---

export async function storeEdges(
  repoId: string,
  edges: Array<{ source: string; target: string }>
): Promise<void> {
  if (edges.length === 0) return;

  // Insert one by one using parameterized queries (safe from SQL injection)
  // Neon's serverless driver is fast enough for this
  for (const edge of edges) {
    await sql`
      INSERT INTO file_edges (repo_id, source, target)
      VALUES (${repoId}, ${edge.source}, ${edge.target})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function deleteEdgesForFiles(
  repoId: string,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;
  await sql`
    DELETE FROM file_edges
    WHERE repo_id = ${repoId} AND source = ANY(${files})
  `;
}

export async function deleteAllEdges(repoId: string): Promise<void> {
  await sql`DELETE FROM file_edges WHERE repo_id = ${repoId}`;
}

export async function getImports(repoId: string, filePath: string): Promise<string[]> {
  const rows = await sql`
    SELECT target FROM file_edges WHERE repo_id = ${repoId} AND source = ${filePath}
  `;
  return rows.map((r) => r.target as string);
}

export async function getDependents(repoId: string, filePath: string): Promise<string[]> {
  const rows = await sql`
    SELECT source FROM file_edges WHERE repo_id = ${repoId} AND target = ${filePath}
  `;
  return rows.map((r) => r.source as string);
}

// --- Load full graph from DB ---

export interface DbDepGraph {
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
}

export async function loadGraphFromDb(repoId: string): Promise<DbDepGraph> {
  const rows = await sql`
    SELECT source, target FROM file_edges WHERE repo_id = ${repoId}
  `;

  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};

  for (const row of rows) {
    const source = row.source as string;
    const target = row.target as string;

    if (!forward[source]) forward[source] = [];
    forward[source]!.push(target);

    if (!reverse[target]) reverse[target] = [];
    reverse[target]!.push(source);
  }

  return { forward, reverse };
}

export async function getRepoByName(fullName: string): Promise<{ id: string; status: string } | null> {
  const rows = await sql`
    SELECT id, status FROM repos WHERE full_name = ${fullName}
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id as string, status: rows[0].status as string };
}

export async function getIndexedFiles(repoId: string): Promise<Set<string>> {
  const rows = await sql`
    SELECT DISTINCT source FROM file_edges WHERE repo_id = ${repoId}
    UNION
    SELECT DISTINCT target FROM file_edges WHERE repo_id = ${repoId}
  `;
  return new Set(rows.map((r) => r.source as string));
}
