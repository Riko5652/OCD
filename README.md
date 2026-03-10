# AI Productivity Dashboard v4.0

> An AI memory engine that learns from your coding sessions, recommends the right tool for every task, and injects proven solutions into your workflow — all local, no API keys required.

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-green)](LICENSE)
[![Tools](https://img.shields.io/badge/tools-7-blue)](#what-gets-tracked)
[![MCP](https://img.shields.io/badge/MCP-11%20tools-purple)](#mcp-universal-brain)
[![Docker](https://img.shields.io/badge/docker-supported-blue)](docker-compose.yml)
[![PWA](https://img.shields.io/badge/PWA-offline%20ready-blueviolet)](#pwa-support)
[![npm](https://img.shields.io/npm/v/ai-productivity-dashboard)](https://www.npmjs.com/package/ai-productivity-dashboard)

---

## What it actively does for you

This is not a passive analytics dashboard. It's a system that makes you faster:

**Semantic Memory** — When Claude Code solves a complex migration in 15 turns, the system vectorizes the solution, the context, and the error logs. Two weeks later, when you hit a similar error in Cursor, the MCP server bypasses the LLM's knowledge cutoff and injects the exact, locally-proven solution into your prompt context. It's a self-building brain across all your AI tools.

**Routing Recommendations** — "For postgres migrations, use Claude Code + claude-sonnet-4-6 (resolves in 4 turns, 87% win rate). Cursor + gpt-4o takes 11 turns." Based on your actual session history, not benchmarks.

**Real-time Coaching** — SSE-pushed nudges every 60 seconds: alerts when sessions run too long, cache hit rate drops, error spikes occur, or you're idle. Dismissible, actionable, and based on your patterns.

**Prompt Optimization** — Extracts high-quality prompt patterns from your best sessions (quality > 75), grouped by task type. Shows you what works and what doesn't.

**Savings Report** — Concrete metrics on what the system saves you: cache hit savings ($), turns saved vs baseline, time estimates. Toggle between relative metrics and dollar estimates.

---

## MCP Setup (30 seconds, no API key)

The dashboard exposes an MCP server with 11 tools that any AI agent can call mid-session. Zero API keys needed.

```bash
# Auto-setup for all detected MCP clients
npx ai-productivity-dashboard --setup-mcp

# Or add to a specific project
npx ai-productivity-dashboard --setup-mcp --project
```

This writes the correct config to Claude Code, Cursor, and Windsurf automatically. Or manually add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-brain": {
      "command": "npx",
      "args": ["ai-productivity-dashboard", "--mcp"]
    }
  }
}
```

**Available MCP tools:**

| Tool | What it does |
|------|-------------|
| `get_similar_solutions` | **Find proven solutions** from past sessions matching your current error or task context |
| `get_knowledge_context` | **Inject relevant context** — returns the knowledge graph neighborhood for your current work |
| `get_last_session_context` | Pick up where a different tool left off |
| `get_routing_recommendation` | Which tool + model to use for this task |
| `get_efficiency_snapshot` | Cache hit rate, first-attempt %, error recovery |
| `get_active_recommendations` | Open optimization nudges |
| `get_project_stats` | Token/session/model breakdown for a project |
| `get_model_comparison` | claude-sonnet vs gpt-4o vs gemini on your actual sessions |
| `push_handoff_note` | Save a note before switching tools |
| `get_optimal_prompt_structure` | Prompt patterns from your highest-quality sessions |
| `get_topic_summary` | Executive summary of work on a topic within a project |

---

## Import online sessions

Not everything lives in local files. Import sessions from web-based AI tools:

**Bookmarklet** — One-click capture from ChatGPT, Claude.ai, or Gemini. Visit `http://localhost:3030/api/bookmarklet` for setup instructions.

**Paste/Upload** — Open the Import modal in the dashboard, paste a transcript or upload a JSON/CSV file.

**Webhook** — Push session data from CI/CD or automation:
```bash
curl -X POST http://localhost:3030/api/webhook/session \
  -H "Content-Type: application/json" \
  -d '{"tool":"chatgpt","title":"Debug API","turns":[{"role":"user","content":"..."}]}'
```

**API** — `POST /api/sessions/import` accepts the [import schema](http://localhost:3030/api/sessions/import/schema).

---

## Quick start

```bash
# No install — just run (zero config)
npx ai-productivity-dashboard

# Or install globally
npm install -g ai-productivity-dashboard
ai-dashboard

# Clone and run
git clone https://github.com/Riko5652/ai-productivity-dashboard
cd ai-productivity-dashboard
npm install
npm start

# Docker
docker compose up

# GitHub Codespaces — one-click dev environment
# Click "Code" → "Codespaces" → "Create codespace on main"
```

Open **http://localhost:3030**. The terminal shows a discovery report: which tools were found, which weren't, and exact paths for anything missing.

**Zero config required.** All tool data paths are auto-detected. See [SETUP.md](SETUP.md) for overrides.

---

## What gets tracked

All data is read-only. Nothing is ever written to your AI tools' files.

| Tool | How |
|------|-----|
| **Claude Code** | Reads `~/.claude/projects/*/` JSONL session files |
| **Cursor** | Reads local SQLite DB (chat history, composer sessions, code authorship stats) |
| **Aider** | Reads `.aider.chat.history.md` files in your project directories |
| **Windsurf** | Reads Codeium's local SQLite DB (chat sessions, token counts) |
| **GitHub Copilot** | Reads VS Code extension telemetry + Copilot Chat conversation history |
| **Continue.dev** | Reads `~/.continue/sessions/*.json` |
| **Gemini/Antigravity** | Reads `~/.gemini/antigravity/` session logs |

---

## Semantic Memory Engine

The dashboard doesn't just track sessions — it learns from them.

**Vector Embeddings** — Every high-quality session (quality > 50) is vectorized: the solution approach, error logs, codebase context, and tool+model combo. Stored in SQLite, searched via cosine similarity.

**Knowledge Graph** — An in-memory graph connects sessions through shared files, projects, error patterns, tool chains, and task types. When you ask "what solved this before?", the system traverses the graph to find related solutions across all tools.

**How it helps mid-session:**
1. You hit an error in Cursor
2. The MCP tool `get_similar_solutions` fires
3. The system finds that Claude Code resolved a similar error last week
4. It injects the proven solution, context, and approach into your current prompt

Embeddings use Ollama (nomic-embed-text) when available, falling back to a built-in text hashing approach that works with zero external dependencies.

---

## Dashboard navigation

### 4-pillar layout

**Command Center** — KPI cards, daily activity, savings report, quick actions, command palette (Cmd+K).

**Workspaces** — Per-project rollup: tokens, lines added, dominant tool/model, drill-down.

**Performance** — Token breakdowns, tool comparisons, model benchmarks, cost tracking.

**Profile** — Gamified: level, XP, streak, achievements, activity heatmap, flow state.

---

## Privacy

- **All data stays on your machine.** Nothing is sent anywhere unless you configure an LLM provider for optional Deep Analyze.
- **Server binds to 127.0.0.1 by default.**
- **Read-only access** to all AI tool databases.
- **Prompt injection protection** — all session text is sanitized.
- **No telemetry. No analytics. No tracking.**

See [PRIVACY.md](PRIVACY.md) for the full policy.

---

## Monetization model

**Free forever (local-first, open source):**
- All adapters, analytics, MCP server, coaching, routing
- Semantic memory (vector search, knowledge graph, solution injection)
- Session import (paste, upload, bookmarklet, webhook)
- Savings report, prompt coaching, all single-user features

**Paid (future — cloud/team tier):**
- Cloud sync between machines (encrypted, anonymized)
- Team aggregation and cross-regional benchmarking
- Enterprise SSO/RBAC, audit logs
- PM tool integrations (Jira, Linear, GitHub Issues)
- Velocity correlation dashboards

---

## LLM provider (optional)

The core dashboard works without any LLM. Optional providers are used for: Deep Analyze, Daily Pick, Topic Summaries, and higher-quality embeddings.

```env
# Free, local — recommended
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma2:2b

# Cloud (any one)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
AZURE_OPENAI_API_KEY=...
```

---

## Tech

- **Node.js 18+ ESM** — no build step
- **Express 4** — API server with SSE
- **SQLite (sql.js)** — local database + vector storage
- **In-memory knowledge graph** — session relationship traversal
- **Chart.js** (CDN) — browser-rendered charts
- **@modelcontextprotocol/sdk** — MCP stdio server
- **chokidar** — file watching for live updates
- **Service Worker** — offline-capable PWA

No React. No Webpack. No TypeScript compilation.

---

## Project structure

```
src/
  adapters/        # One file per AI tool (claude-code, cursor, aider, ...)
  engine/          # Analytics + intelligence engines
    cross-tool-router.js   # Task classification + win-rate routing
    savings-report.js      # Cost/time savings calculations
    agentic-scorer.js      # Autonomy scoring
    session-coach.js       # Real-time SSE nudges
    prompt-coach.js        # Prompt patterns from best sessions
    topic-segmenter.js     # Topic detection + project relevance
  lib/
    vector-store.js  # SQLite-based vector embeddings
    knowledge-graph.js # In-memory session relationship graph
    sanitize.js      # Prompt injection protection
  mcp-handoff.js   # MCP Universal Brain server (11 tools)
  server.js        # Express app + all API routes
  db.js            # SQLite schema + migration
  config.js        # Auto-detected paths + discovery report
public/            # Static frontend (HTML + vanilla JS)
bin/
  ai-dashboard.js  # CLI entrypoint
  setup-mcp.js     # MCP auto-setup for Claude Code / Cursor / Windsurf
```

---

## Adding a new AI tool

1. Create `src/adapters/your-tool.js` with `id`, `name`, and `getSessions()`
2. Call `register(adapter)` at the bottom
3. Import it in `src/server.js`
4. Add a seed row in `src/db.js`

---

## Roadmap

- [ ] Enterprise: secure team sync with anonymized aggregation
- [ ] PM integration: Jira/Linear/GitHub Issues velocity correlation
- [ ] Cross-regional benchmarking (EMEA vs APAC tool effectiveness)
- [ ] Devin / OpenHands adapter
- [x] Semantic memory engine (vector embeddings + knowledge graph)
- [x] Session import (bookmarklet, paste, webhook)
- [x] MCP zero-config setup
- [x] Savings report

---

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE). Built and maintained by [Dor Lipetz](https://github.com/Riko5652).
