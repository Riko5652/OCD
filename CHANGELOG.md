# Changelog

All notable changes to OCD (Omni Coder Dashboard) are documented here.

---

## [5.1.0] — 2026-03-21

### Added — Proactive Intelligence Layer

#### **Proactive IDE Interception** (`engine/ide-interceptor.ts`)
- Background file watcher monitors `/tmp/ocd-terminal.log` (configurable via `TERMINAL_LOG_PATH`) for incoming stack traces
- Stack traces are matched against the vector store using cosine similarity
- Fires OS-level desktop notifications (`node-notifier`) when a match is found
- Pushes SSE payloads to all connected IDE clients instantly — before the user types a prompt
- New REST endpoints: `POST /api/ide/submit-trace`, `GET /api/ide/interceptions`
- New MCP tool: **`submit_ide_trace`** — manually submit a stack trace for proactive analysis
- New DB table: `ide_interceptions`

#### **Anti-Hallucination Negative Prompt Injector** (`engine/anti-pattern-graph.ts`)
- Scans sessions with low quality scores or error-heavy turns to build an Anti-Pattern Graph
- Identifies which libraries, patterns, and approaches repeatedly cause failures in your codebase
- New REST endpoint: `GET /api/anti-patterns`
- New MCP tool: **`get_negative_constraints`** — returns `DO NOT use X` clauses to inject before starting a task, blocking locally-known failure patterns before the LLM can repeat them
- New DB table: `anti_patterns`

#### **Token Arbitrage & Cost Routing** (`engine/token-arbiter.ts`)
- Classifies every incoming prompt by task type (boilerplate, debugging, migration, explanation, etc.) and complexity
- Routes to local Ollama (free) when the historical local success rate for that task type is ≥ 92%
- Logs estimated savings per request with cumulative totals
- New REST endpoints: `POST /api/arbitrage/recommend`, `POST /api/arbitrage/proxy`, `GET /api/arbitrage/summary`
- New MCP tool: **`get_arbitrage_recommendation`** — returns routing decision + savings estimate before a session starts
- New DB table: `arbitrage_log`

#### **P2P Secure Team Memory** (`engine/p2p-sync.ts`)
- UDP broadcast peer discovery on configurable port (default 41234) — finds teammates on the same LAN or Tailscale network automatically
- All sync messages authenticated with HMAC-SHA256 (`P2P_SECRET` env var)
- Syncs embeddings and session metadata only — never source code, never full prompts
- Conflict resolution via `last-write-wins` on embedding timestamps
- New REST endpoints: `GET /api/p2p/peers`, `POST /api/p2p/embeddings`, `POST /api/p2p/sync`, `POST /api/p2p/hello`
- New MCP tool: **`get_team_memory`** — searches peer-synced embeddings for solutions from teammates
- New DB table: `p2p_peers`

### Changed

- MCP server expanded from **11 tools → 15 tools**
- DB schema updated with 4 new tables: `ide_interceptions`, `anti_patterns`, `arbitrage_log`, `p2p_peers`
- `mcp-handoff.ts` — added 4 new tool handlers
- `index.ts` — registered all new engines and REST routes on server startup

### Environment Variables (new)

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_LOG_PATH` | `/tmp/ocd-terminal.log` | Path watched by the IDE interceptor |
| `P2P_SECRET` | *(required for P2P)* | HMAC-SHA256 secret for peer authentication |
| `P2P_PORT` | `41234` | UDP port for peer discovery |
| `ARBITRAGE_LOCAL_THRESHOLD` | `0.92` | Min local win rate to route to Ollama |

---

## [5.0.0] — 2026-03

### Added
- v5 full TypeScript rewrite — Fastify + React + pnpm monorepo
- PWA support: service worker, offline mode, install prompt
- Advanced dashboard tables, theme toggle, project drill-down, token visualization
- React client feature parity: Insights, Command Palette, Import, Toasts, Mobile

---

## [4.x]

- Semantic memory engine (vector embeddings + knowledge graph)
- Session import (bookmarklet, paste, webhook, API)
- MCP zero-config setup (`--setup-mcp` for Claude Code, Cursor, Windsurf)
- Savings report with dollar estimates
- Real-time SSE coaching nudges
- Prompt optimization analysis from high-quality sessions
- 7-adapter support: Claude Code, Cursor, Aider, Windsurf, Copilot, Continue.dev, Gemini
