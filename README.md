# AI Productivity Dashboard

Track and compare your AI coding tool usage across **Claude Code**, **Cursor**, and **Gemini/Antigravity** in a single local dashboard.

![Dashboard Overview](https://img.shields.io/badge/tools-3-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## What it does

- Reads local data from your AI coding tools (no cloud accounts needed)
- Unified analytics: sessions, turns, tokens, models, cache efficiency
- 7 dashboard tabs: Overview, Sessions, Token Deep Dive, Compare Tools, AI Authorship, Analytics, Optimization
- Real-time updates via file watchers + SSE
- PWA — install on your phone for mobile access
- Zero external dependencies — runs entirely local on SQLite

## What it measures

### Core Metrics (all tools)
- **Sessions & turns** — total count, duration, frequency per tool
- **Token usage** — input, output, cache read/create per session and turn
- **Cache efficiency** — cache hit % (how much context is reused)
- **Latency** — average response time per session/model
- **Model usage** — which models you use, how often, token breakdown

### Code Generation
- **Lines of code** — added/removed per session, turn, and tool
- **Files touched** — unique files modified per session
- **First-attempt success** — % of files that needed no re-edits (Claude Code)
- **Top producing sessions** — ranked by code output

### AI Quality Insights
- **Thinking depth** — average reasoning length per model (Claude Code)
- **Error count & recovery** — tool errors and how often the AI self-corrects
- **Suggestion acceptance** — code block acceptance rate (Cursor)
- **Lint improvement** — lint error reduction before/after AI edits (Cursor)

### AI Authorship (Cursor)
- **AI vs human lines** — per-commit AI authorship percentage
- **Tab vs composer attribution** — which mode generates more code
- **Daily stats** — tab/composer suggested vs accepted lines

## Quick Start

```bash
git clone https://github.com/your-username/ai-productivity-dashboard.git
cd ai-productivity-dashboard
npm install
npm start
# Open http://localhost:3030
```

The dashboard auto-discovers your installed tools on startup and shows what it found.

## Supported Tools

### Claude Code
**Auto-discovered.** Scans `~/.claude/projects/*/` for `.jsonl` session files.

Data extracted: sessions, turns, token usage (input/output/cache), model, tools used, latency.

### Cursor
**Auto-discovered.** Reads from the local Cursor databases:
- `state.vscdb` — composer sessions, agent mode data, conversation bubbles
- `ai-code-tracking.db` — AI-authored commit scores, daily stats

Cross-platform paths are auto-detected:
| OS | state.vscdb location |
|----|---------------------|
| Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

**Team usage CSV** (optional): Export your team usage from [cursor.com](https://cursor.com) admin dashboard and drop the CSV into the project root directory. This adds data from other machines under the same account.

**Multi-machine support**: Copy `state.vscdb` from another machine into `cursor-imports/` — the adapter deduplicates automatically.

### Gemini / Antigravity
**Auto-discovered.** Reads from `~/.gemini/antigravity/`:
- `annotations/*.pbtxt` — conversation timestamps
- `brain/*/metadata.json` — artifact types, summaries, versions
- `scratch/` — working documents (token estimation)
- `code_tracker/active/` — generated code files

Note: Conversation `.pb` files are encrypted by Google. The adapter extracts metadata only.

## Configuration

All paths are auto-detected by default. Override with environment variables:

```bash
# Custom paths
CLAUDE_PROJECT_DIR=~/.claude/projects/my-project npm start

# Cursor on non-standard location
CURSOR_STATE_DB=/path/to/state.vscdb npm start
CURSOR_TRACKING_DB=/path/to/ai-code-tracking.db npm start

# Antigravity
ANTIGRAVITY_DIR=/path/to/.gemini/antigravity npm start

# Server config
PORT=8080 npm start
DB_PATH=./my-data/analytics.db npm start

# Cursor CSV import directory (for team-usage-events files)
CURSOR_CSV_DIR=/path/to/csv/exports npm start
```

## Directory Structure

```
.
├── public/          # Frontend (vanilla JS + Chart.js, no build step)
│   ├── index.html   # Dashboard HTML with inline CSS
│   ├── app.js       # Frontend logic (tabs, charts, tables)
│   ├── sw.js        # Service worker for PWA/offline
│   └── manifest.json
├── src/
│   ├── config.js    # Cross-platform path detection
│   ├── server.js    # Express server + API routes + SSE
│   ├── db.js        # SQLite schema + queries
│   ├── watcher.js   # File watchers for live updates
│   ├── adapters/    # One adapter per tool
│   │   ├── claude-code.js
│   │   ├── cursor.js
│   │   ├── antigravity.js
│   │   └── types.js
│   └── engine/      # Analytics + optimization
│       ├── analytics.js
│       ├── optimizer.js
│       └── scorer.js
├── data/            # SQLite DB (auto-created, gitignored)
├── cursor-imports/  # Drop state.vscdb from other machines
└── package.json
```

## API

All data is served via REST endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/overview` | KPIs, totals per tool, today's stats |
| `GET /api/sessions?tool=cursor&limit=100` | Session list with filters |
| `GET /api/sessions/:id` | Single session with turn details |
| `GET /api/daily?days=180` | Daily stats for charts |
| `GET /api/compare` | Tool comparison metrics |
| `GET /api/models` | Model usage breakdown |
| `GET /api/commits?limit=100` | AI authorship scores |
| `GET /api/code-generation` | Code generation stats by tool, top sessions, model breakdown |
| `GET /api/insights` | Cross-tool insights: thinking depth, errors, recovery, suggestions |
| `GET /api/recommendations` | Optimization recommendations |
| `GET /api/efficiency?limit=50` | Efficiency trend data |
| `GET /api/cursor-daily` | Cursor tab/composer daily lines |
| `GET /api/live` | SSE stream for real-time updates |
| `POST /api/ingest` | Trigger manual re-ingestion |

## Adding Your Own Data Source

Create a new adapter in `src/adapters/`:

```javascript
// src/adapters/my-tool.js
import { TOOL_IDS } from './types.js';

export async function getSessions() {
  // Return array of UnifiedSession objects (see types.js)
  return [{ id: 'mt-123', tool_id: 'my-tool', ... }];
}

export async function getTurns(sessionId) {
  // Return array of UnifiedTurn objects
  return [];
}

export const adapter = {
  id: 'my-tool',
  name: 'My Tool',
  getSessions,
  getTurns,
};
```

Then register it in `src/server.js`:

```javascript
import { adapter as myToolAdapter } from './adapters/my-tool.js';
const adapters = [claudeAdapter, cursorAdapter, antigravityAdapter, myToolAdapter];
```

## Privacy

- All data stays local — nothing is sent to any server
- Reads only from your local tool installations (read-only mode)
- The SQLite database (`data/analytics.db`) is gitignored
- No telemetry, no analytics, no tracking

## License

MIT
