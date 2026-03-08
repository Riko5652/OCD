# AI Productivity Dashboard

> **It's not just a dashboard. It's a feedback loop that makes every future prompt smarter.**

Track, compare, and improve your AI coding sessions across **Claude Code**, **Cursor**, and **Gemini/Antigravity** — all local, all private, zero cloud.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green) ![Tools](https://img.shields.io/badge/tools-3-blue) ![Local](https://img.shields.io/badge/storage-local%20SQLite-orange)

---

## Why This Exists

Most AI tools tell you nothing about how you use them. You don't know:

- Which prompts consistently produce working code on the first try
- Whether you're burning tokens on back-and-forth that better phrasing would eliminate
- Which AI tool is actually faster for your workflow (vs. which *feels* faster)
- How your prompting style has evolved — and where it still breaks down

This dashboard reads your local session data, surfaces those patterns, and tells you **exactly what to change** to get better results from every prompt you write.

---

## What Makes You Better

### Personal Insights Tab *(coming in v2.1)*
The core of the improvement loop. Three panels built on your real session history:

**Your Profile** — who you are as an AI user
- Prompt complexity score, average turns-to-resolution, first-attempt success rate
- Token efficiency percentile vs. your own baseline
- Dominant prompting patterns: do you clarify upfront, iterate heavily, or rely on retries?
- Session start habits: time-of-day focus patterns, session length trends

**Trends Over Time** — see yourself improving (or not)
- Rolling 7/14/30-day charts: efficiency, cache hit rate, first-attempt success, avg turns
- Identify when your prompting improved after changing habits — backed by data
- Catch regressions before they become habits

**Actions** — specific, ranked things to do differently
- Prompt signals correlated with success: length, structure keywords, specificity markers
- Cards that show: *"When your prompts contain X, your success rate is 73% higher"*
- Deep Analyze: stream an LLM-powered narrative of your patterns (Ollama → OpenAI → Anthropic — or structural-only with no LLM)
- Live issues banner: surface problems across all tabs without extra requests

---

## Install

### Option 1 — npx (no install, always latest)
```bash
npx ai-productivity-dashboard
```

### Option 2 — Global install
```bash
npm install -g ai-productivity-dashboard
ai-dashboard
```

### Option 3 — Clone & run (for development or customization)
```bash
git clone https://github.com/Riko5652/ai-productivity-dashboard.git
cd ai-productivity-dashboard
npm install
npm start
```

Open **http://localhost:3030** — the dashboard auto-detects your installed tools on startup.

> **Data location:**
> - `npx` / global install → `~/.ai-productivity-dashboard/` (persists across updates)
> - Local clone → `./data/` (unchanged)

To explore with mock data before connecting real tools:
```bash
node seed-mock.mjs
npm start
```

---

## Screenshots

**Overview** — hero KPIs, daily turns & token charts, tool distribution
![Overview](screenshots/01-overview.png)

**Personal** — XP level, achievements, activity heatmap
![Personal](screenshots/02-personal.png)

**Compare Tools** — session distribution, donut chart, metrics table
![Compare Tools](screenshots/03-compare-tools.png)

**Sessions** — searchable table with tool badges, turns, tokens, models
![Sessions](screenshots/04-sessions.png)

---

## Dashboard Tabs

| Tab | What it shows |
|-----|--------------|
| **Overview** | Hero KPIs, daily activity charts, tool distribution |
| **Personal** | XP level, achievements, activity heatmap |
| **Compare Tools** | Side-by-side session metrics, donut chart |
| **Sessions** | Searchable table: turns, tokens, models, top tools |
| **Token Deep Dive** | Cache efficiency, input/output breakdown, cost |
| **AI Authorship** | AI vs human lines per commit, tab vs composer |
| **Optimization** | Ranked recommendations based on your patterns |
| **Insights** *(v2.1)* | Prompt profile, trends, actionable improvements, LLM deep analysis |

---

## What It Measures

### Core (all tools)
- Sessions, turns, duration, frequency per tool
- Token usage — input, output, cache read/create
- Cache hit % — how much context is being reused
- Latency — average response time per session and model
- Model usage — which models, how often, token breakdown

### Code Generation
- Lines added/removed per session, turn, tool
- Files touched per session
- First-attempt success — % of files that needed no re-edits (Claude Code)
- Top producing sessions ranked by code output

### AI Quality
- Thinking depth — average reasoning length per model
- Error count and recovery rate — how often the AI self-corrects
- Suggestion acceptance rate (Cursor)
- Lint improvement — error reduction before/after AI edits (Cursor)

### AI Authorship (Cursor)
- AI vs human line percentages per commit
- Tab vs Composer attribution
- Daily suggested vs accepted lines

### Prompt Intelligence *(v2.1)*
- Structural signals per prompt: length, question count, specificity markers
- Correlation between prompt patterns and first-attempt success
- Rolling efficiency trends across 7 / 14 / 30-day windows
- LLM-powered narrative analysis (streamed, cached 24h)

---

## Supported Tools

### Claude Code
Auto-discovers from `~/.claude/projects/*/`. Extracts sessions, turns, token usage, model, tools used, latency, thinking depth, errors.

### Cursor
Auto-discovers from local databases:

| OS | Path |
|----|------|
| Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

**Multi-machine:** Copy `state.vscdb` from another machine into `~/.ai-productivity-dashboard/cursor-imports/` — deduplicated automatically.

**Team CSV:** Export usage from [cursor.com](https://cursor.com) admin and place the `.csv` in your data dir.

### Gemini / Antigravity
Auto-discovers from `~/.gemini/antigravity/`. Extracts session metadata, artifact types, summaries, generated code files. (`.pb` conversation files are encrypted by Google — metadata only.)

---

## LLM Provider Setup *(for Insights Deep Analyze — optional)*

The Insights tab's Deep Analyze feature streams an AI-written narrative of your prompting patterns. Auto-detects in priority order:

| Priority | Provider | Setup |
|----------|----------|-------|
| 1 | **Local Ollama** | Install [Ollama](https://ollama.ai), run any model — zero cost, fully private |
| 2 | **OpenAI-compatible** | Set `OPENAI_API_KEY` — works with OpenAI, Together, Groq, etc. |
| 3 | **Anthropic** | Set `ANTHROPIC_API_KEY` |
| 4 | **None** | Full Profile + Trends + Prompt Signals — just no narrative text |

No LLM required. All structural analysis runs entirely on your local data.

---

## Configuration

All paths are auto-detected. Override with environment variables:

```bash
# Custom data directory
DB_PATH=~/my-data/analytics.db npx ai-productivity-dashboard

# Override tool paths
CLAUDE_PROJECT_DIR=~/.claude/projects/my-project npm start
CURSOR_STATE_DB=/path/to/state.vscdb npm start
CURSOR_TRACKING_DB=/path/to/ai-code-tracking.db npm start
ANTIGRAVITY_DIR=/path/to/.gemini/antigravity npm start

# LLM providers (for Insights Deep Analyze)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Server
PORT=8080 npm start
```

---

## Directory Structure

```
.
├── bin/
│   └── ai-dashboard.js    # CLI entrypoint (npx / global install)
├── public/                # Frontend — vanilla JS + Chart.js, no build step
│   ├── index.html
│   ├── app.js
│   ├── sw.js              # Service worker (PWA/offline)
│   └── manifest.json
├── src/
│   ├── config.js          # Cross-platform path detection
│   ├── server.js          # Express server, API routes, SSE
│   ├── db.js              # SQLite schema + queries
│   ├── watcher.js         # File watchers for live updates
│   ├── adapters/          # One adapter per tool
│   │   ├── claude-code.js
│   │   ├── cursor.js
│   │   ├── antigravity.js
│   │   └── types.js
│   └── engine/            # Analytics, optimizer, scorer
├── seed-mock.mjs          # Populate mock data for testing
└── package.json
```

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/overview` | KPIs, totals per tool, today's stats |
| `GET /api/sessions` | Session list (`?tool=cursor&limit=100`) |
| `GET /api/sessions/:id` | Single session with turn details |
| `GET /api/daily?days=180` | Daily stats for charts |
| `GET /api/compare` | Tool comparison metrics |
| `GET /api/models` | Model usage breakdown |
| `GET /api/commits` | AI authorship scores |
| `GET /api/code-generation` | Code stats by tool, top sessions, model breakdown |
| `GET /api/insights` | Cross-tool insights: thinking depth, errors, recovery |
| `GET /api/recommendations` | Optimization recommendations |
| `GET /api/efficiency` | Efficiency trend data |
| `GET /api/cursor-daily` | Cursor tab/composer daily lines |
| `GET /api/prompt-profile` | *(v2.1)* Your prompt pattern profile |
| `GET /api/prompt-trends` | *(v2.1)* Rolling efficiency trends |
| `GET /api/prompt-signals` | *(v2.1)* Structural signal correlations |
| `GET /api/live-issues` | *(v2.1)* Active issues banner data |
| `GET /api/analyze/stream` | *(v2.1)* SSE — LLM narrative analysis (cached 24h) |
| `GET /api/live` | SSE stream for real-time updates |
| `POST /api/ingest` | Trigger manual re-ingestion |

---

## Adding Your Own Tool

Create a new adapter in `src/adapters/`:

```javascript
// src/adapters/my-tool.js
export async function getSessions() {
  return [{ id: 'mt-123', tool_id: 'my-tool', /* ... */ }];
}
export async function getTurns(sessionId) { return []; }
export const adapter = { id: 'my-tool', name: 'My Tool', getSessions, getTurns };
```

Register in `src/server.js`:
```javascript
import { adapter as myToolAdapter } from './adapters/my-tool.js';
const adapters = [claudeAdapter, cursorAdapter, antigravityAdapter, myToolAdapter];
```

---

## Privacy

- **Everything stays local** — no data leaves your machine, ever
- Reads tool data in read-only mode
- SQLite database stored in `~/.ai-productivity-dashboard/` (or `./data/` for local clones)
- No telemetry, no analytics, no tracking of any kind

---

## Author

Built by **[Dor Lipetz](https://github.com/Riko5652)**.

If this tool saves you time, a ⭐ on GitHub is appreciated.

## License

MIT © [Dor Lipetz](https://github.com/Riko5652)
