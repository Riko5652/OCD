# Changelog

All notable changes to OCD (Omni Coder Dashboard) are documented here.

---

## [5.2.1] — 2026-03-22

### Added — Platform Parity & Single-Tool Optimization

#### **Adapter Equalization** (`adapters/windsurf.ts`, `continue.ts`, `copilot.ts`, `aider.ts`)
- All four non-Claude adapters now match Claude Code's parsing depth:
  - **Windsurf**: turn-level parsing from `chat_messages`, code metrics extraction, tool detection, error tracking (64→200 lines)
  - **Continue.dev**: full `getTurns()` implementation, code block extraction, slash command/tool tracking, context item support (72→200 lines)
  - **Copilot**: code metrics from chat content, tool/agent detection, slash command tracking, per-language suggestion stats (160→250 lines)
  - **Aider**: `getTurns()` with edit block parsing (search/replace, diff), error detection, edit format tracking, first-attempt success % (124→270 lines)

#### **Single-Tool User Optimization** (`engine/cross-tool-router.ts`, `engine/token-budget.ts`, `mcp-handoff.ts`)
- Cross-tool router detects single-tool users and provides model-level recommendations, workflow pattern analysis, and tool-specific tips instead of cross-tool routing
- Token budget adds model cost-efficiency comparison and tool-specific quick wins for single-tool users
- MCP `get_routing_recommendation` returns model comparison, workflow patterns (high vs low quality sessions), and actionable tips specific to the user's tool

---

## [5.2.0] — 2026-03-21

### Added — Session Self-Awareness & Efficiency

#### **Session Health Check** (`engine/session-coach.ts`, `mcp-handoff.ts`)
- Cross-session pattern analysis: average turns before quality drops, historical cache hit baselines, daily token averages
- Structured health signals: `status` (healthy/degrading/critical) + `suggested_action` (continue/compact/new_session)
- Context-aware nudges comparing current session to 30-day historical patterns
- Daily token budget monitoring with 14-day average comparison
- New MCP tool: **`get_session_health_check`** — agents call this periodically for self-awareness they can't have on their own

#### **Token Efficiency Tips** (`engine/token-budget.ts`, `mcp-handoff.ts`)
- Daily burn rate tracking: today's usage, 7-day average, weekly cost forecast
- Per-tool efficiency ranking (tokens per quality point)
- Actionable quick wins to reduce waste
- New MCP tool: **`get_efficiency_tips`**

#### **Architecture Decision Record**
- ADR: Reject session intervention — OCD stays read-only (`docs/architecture-blueprint-review.md`)
- Formal documentation of the design principle: OCD informs, the agent decides, the user stays in control

### Improved
- Onboarding flow with token efficiency value proposition
- Actionable takeaways to reduce dashboard fatigue
- Prompt science grounded in effect sizes and confidence levels
- Added index on `session_embeddings.created_at` for ORDER BY performance

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
