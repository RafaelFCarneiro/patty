# FinTrack v2

AI-first personal finance manager. Talk to it from Claude — "paguei 32,50 de Uber ontem" — and it creates, classifies, and analyzes your transactions. The backend exposes an **MCP server** as its primary interface, with REST as a secondary surface.

Stack: TypeScript · Fastify · zod · Neo4j · diplomat architecture · FP.

## Quick start

```bash
npm install
npm run infra:up:db   # Neo4j via docker
npm run dev           # REST + MCP on :3001
```

Run `npx ntl` for an interactive list of all scripts (infra, tests, MCP inspector).

- MCP endpoint: `http://localhost:3001/mcp` (streamable HTTP — add it to Claude as a custom connector)
- REST API: `http://localhost:3001/api`
- Neo4j browser: `http://localhost:7474` (neo4j / fintrack123)

Or fully containerized: `npm run infra:up`.

## Docs

- `docs/PLAN.md` — architecture plan and roadmap
- `docs/adr/` — architecture decision records
- `CLAUDE.md` — conventions and layer rules (for AI agents and humans alike)
- `../fintrack-legacy` — archived v1 (NestJS + MongoDB + React), reference only

## License

[MIT](LICENSE)
