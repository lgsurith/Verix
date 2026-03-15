# Verix

AI code reviews that understand your entire codebase, not just the diff.

Verix is an open-source GitHub bot that reviews pull requests using an agentic AI system. Instead of blindly reviewing a diff, it explores your dependency graph to understand how changes affect the rest of your code — then posts inline suggestions directly on the PR.

## How it works

1. You open a pull request
2. Verix reads the diff and uses the dependency graph to find related files
3. An AI agent explores your codebase through tool calls — fetching imports, checking dependents, reading source files
4. It posts inline review comments with actionable suggestions

```
PR changes auth.ts
  → Agent checks: what does auth.ts import? (helpers.ts)
  → Agent checks: what depends on auth.ts? (middleware.ts)
  → Agent reads helpers.ts, sees sanitizeInput() only strips HTML, not SQL
  → Posts: "Critical: SQL injection — sanitizeInput doesn't handle SQL escaping"
```

## Features

- **Agentic review** — AI decides what context it needs, not a fixed crawl
- **Dependency-aware** — understands how files connect via imports
- **Inline suggestions** — posts directly on PR lines with apply-ready fixes
- **Pluggable models** — Gemini, Claude, OpenAI, or local via Ollama
- **Configurable** — drop a `VERIX.md` in your repo to set team review rules
- **Self-hostable** — Docker image, bring your own database and model

## Quick start

### 1. Create a GitHub App

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new) and create an app with:

**Permissions:**
- Repository → Contents: Read
- Repository → Pull requests: Read & Write
- Repository → Metadata: Read

**Subscribe to events:**
- Pull request
- Push

Download the private key (`.pem` file).

### 2. Set up the environment

```bash
git clone https://github.com/lgsurith/Verix.git
cd Verix
cp .env.example .env
```

Edit `.env` with your GitHub App credentials and model provider:

```env
GITHUB_APP_ID=your-app-id
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_PRIVATE_KEY_PATH=./private-key.pem

DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require

MODEL_PROVIDER=gemini
GEMINI_API_KEY=your-key
```

### 3. Run

```bash
docker compose up -d
```

Or for local development:

```bash
pnpm install
pnpm dev
```

### 4. Install the app

Install your GitHub App on your repos. Verix will automatically review new PRs.

## Configuration

### VERIX.md

Drop a `VERIX.md` in your repo root to set custom review rules:

```markdown
# Review Guidelines

We use NestJS with TypeORM.
Always check for N+1 query patterns.
Never use `any` type.
All endpoints must have auth guards.
Don't flag console.log — we use a custom logger that wraps it.
```

Verix reads this on every PR and follows your team's conventions. Falls back to `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` if no `VERIX.md` is found.

### .verix.yml

```yaml
# Model provider override
model: gemini

# Files to ignore during review
ignore:
  - "*.test.ts"
  - "*.spec.ts"
  - "dist/**"

# Minimum severity to report (critical, high, medium, low)
min_severity: medium

# Primary language hint
language: typescript
```

## Model providers

| Provider | Config | Notes |
|----------|--------|-------|
| Gemini | `MODEL_PROVIDER=gemini` + `GEMINI_API_KEY` | Free tier available |
| Claude | `MODEL_PROVIDER=claude` + `ANTHROPIC_API_KEY` | |
| OpenAI | `MODEL_PROVIDER=openai` + `OPENAI_API_KEY` | |
| Ollama | `MODEL_PROVIDER=ollama` + `OLLAMA_URL` | Free, local, no API key |

All providers support agentic mode with tool calling.

## Self-hosting

### With Neon (managed Postgres)

1. Create a free database at [neon.tech](https://neon.tech)
2. Set `DATABASE_URL` in `.env`
3. `docker compose up -d`

### Fully self-hosted

Uncomment the Postgres and Ollama services in `docker-compose.yml`:

```yaml
services:
  verix:
    build: .
    # ...

  postgres:
    image: postgres:17-alpine
    # ...

  ollama:
    image: ollama/ollama
    # ...
```

Set in `.env`:
```env
DATABASE_URL=postgresql://verix:verix@postgres:5432/verix
MODEL_PROVIDER=ollama
OLLAMA_URL=http://ollama:11434
```

Zero external dependencies. Everything runs on your infra.

## Architecture

```
GitHub webhook → Verix server → Agent loop
                                    ↓
                            ┌───────┴───────┐
                            ↓               ↓
                     Dep graph (Neon)   AI model
                            ↓               ↓
                     Related files    Review JSON
                            ↓               ↓
                            └───────┬───────┘
                                    ↓
                           PR inline comments
```

The agent loop:
1. Receives the diff
2. Calls `get_imports` / `get_dependents` to query the dependency graph
3. Calls `get_file_content` to read related files via GitHub API
4. Calls `submit_review` when it has enough context

## Project structure

```
src/
├── index.ts              Server + webhook handlers
├── github.ts             GitHub API helpers
├── review.ts             One-shot review (fallback)
├── config.ts             VERIX.md + .verix.yml loader
├── types.ts              Shared types
├── adapters/
│   ├── base.ts           Adapter interface + factory
│   ├── gemini.ts         Gemini (function calling)
│   ├── claude.ts         Claude (tool use)
│   ├── openai.ts         OpenAI (tool calling)
│   └── ollama.ts         Ollama (local models)
├── agent/
│   ├── tools.ts          Tool definitions + executor
│   └── loop.ts           Agent loop with guardrails
├── db/
│   └── index.ts          Neon/Postgres schema + queries
└── indexer/
    ├── depgraph.ts       Import parser + graph builder
    ├── crawler.ts         BFS context crawler
    └── store.ts          In-memory cache
```

## License

MIT
