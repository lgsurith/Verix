# Contributing to Verix

Thanks for your interest in contributing to Verix.

## Getting Started

1. Fork the repo
2. Clone your fork
3. Install dependencies: `pnpm install`
4. Copy `.env.example` to `.env` and fill in your values
5. Run the dev server: `pnpm dev`

## Development

- **TypeScript** — strict mode, no `any` types
- **pnpm** — do not use npm or yarn
- **ESM** — the project uses ES modules

## Pull Requests

- Keep PRs focused on a single change
- Make sure `pnpm exec tsc --noEmit` passes
- Test your changes against a real GitHub repo if possible

## Architecture

See the README for project structure. Key modules:

- `src/agent/` — agentic review loop and tool definitions
- `src/adapters/` — model provider adapters (Gemini, Claude, OpenAI, Ollama)
- `src/db/` — Postgres database layer
- `src/indexer/` — dependency graph builder and import parser
- `src/config.ts` — VERIX.md and .verix.yml loader

## Issues

Check [open issues](https://github.com/lgsurith/Verix/issues) for things to work on. Feel free to open a new issue for bugs or feature requests.
