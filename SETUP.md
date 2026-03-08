# Setup Guide

This guide covers installation on **Windows**, **macOS**, and **Linux**, and explains how to tell the dashboard which AI tools to track and where their data lives.

---

## Quick start (any OS)

```bash
# Option A: npx — no install needed
npx ai-productivity-dashboard

# Option B: global install
npm install -g ai-productivity-dashboard
ai-dashboard

# Option C: clone and run
git clone https://github.com/Riko5652/ai-productivity-dashboard
cd ai-productivity-dashboard
cp .env.example .env
npm install
npm start

# Option D: Docker
docker compose up
```

The dashboard auto-detects all supported tools. Open **http://localhost:3030** — that's it.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) — LTS recommended |
| npm | ≥ 9 | Comes with Node.js |
| Docker *(optional)* | ≥ 24 | Only for Docker install path |

**Check your version:**
```bash
node --version   # should be v18.x or higher
npm --version
```

---

## Platform notes

### Windows

- Install Node.js from [nodejs.org](https://nodejs.org) (the `.msi` installer)
- Run in **PowerShell** or **Git Bash** (not CMD — `--env-file` flag requires a POSIX shell on some npm versions)
- Paths are auto-detected from `%APPDATA%` and `%USERPROFILE%` — no manual config needed for Claude Code, Cursor, or Windsurf on Windows
- If you see `ENOENT` errors on startup, check that your tool is actually installed at the standard path (or set the override env var in `.env`)

### macOS

- Node.js via Homebrew: `brew install node`
- All tool data paths are auto-detected from `~/Library/Application Support/` and `~/.claude/`
- On first run, macOS may prompt for permission to access other apps' data directories — allow it

### Linux

- Node.js via your distro package manager or [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts`
- Tool data is auto-detected from `~/.config/` and `~/.claude/`
- `better-sqlite3` requires build tools: `sudo apt install build-essential python3` (Debian/Ubuntu) or `sudo dnf install make gcc python3` (Fedora)

---

## What gets tracked automatically

The dashboard reads your existing tool data — it never modifies any AI tool's files, and all reads are read-only.

| Tool | Auto-detected location | What's read |
|------|----------------------|-------------|
| **Claude Code** | `~/.claude/projects/*/` | JSONL session files, turn history, token usage |
| **Cursor** | `~/.cursor/` (macOS/Linux) or `%APPDATA%/Cursor/` (Windows) | SQLite DB with chat history and code stats |
| **Aider** | `.aider.chat.history.md` in any project directory | Chat history, files edited, cost |
| **Windsurf** | Codeium globalStorage DB (platform-specific) | Chat sessions, token counts |
| **GitHub Copilot** | VS Code globalStorage (platform-specific) | Suggestion acceptance, inline completions |
| **Continue.dev** | `~/.continue/sessions/` | Session JSON files |
| **Gemini/Antigravity** | `~/.gemini/antigravity/` | Session logs |

---

## Configuring scope — which projects to track

By default, the dashboard tracks **all projects** it can find. You can narrow the scope:

### Track only one Claude Code project

```env
# .env
CLAUDE_PROJECT_DIR=~/.claude/projects/C--Projects-my-project
```

### Track only sessions from a specific date
Not yet supported as a config option — filter via the Sessions tab in the UI.

### Exclude a tool entirely
Simply don't install/configure that tool, or point its path to a non-existent directory. The dashboard gracefully skips tools with 0 sessions.

---

## Path overrides (when auto-detection fails)

Create a `.env` file in the project root (copy from `.env.example`):

```env
# Windows example — override Cursor DB path
CURSOR_STATE_DB=C:\Users\YourName\AppData\Roaming\Cursor\User\workspaceStorage\abc123\state.vscdb

# macOS example — Cursor at non-default location
CURSOR_STATE_DB=/Users/yourname/Library/Application Support/Cursor/User/workspaceStorage/abc123/state.vscdb

# Linux example — Aider logs in custom location
AIDER_LOGS_DIR=/home/yourname/projects/aider-history

# Continue.dev at non-default location
CONTINUE_SESSIONS_DIR=/home/yourname/.config/continue/sessions
```

---

## History window — how much data to show

By default the dashboard shows **all available history** (up to 1 year in charts, all sessions in analytics). You can tune this:

```env
# Show everything from the past 90 days only
HISTORY_DAYS=90

# Show all time (default)
HISTORY_DAYS=365

# Any API endpoint also accepts ?days=N to override per request:
# http://localhost:3030/api/daily?days=30
# http://localhost:3030/api/models/performance?days=90
```

The first time you run the dashboard it will scan **all** your existing session history — not just recent sessions. If you have years of Claude Code sessions, they all get imported. Subsequent runs only process new or changed files.

---

## MCP Server setup (connect to Claude Code, Cursor, etc.)

The dashboard includes an MCP server that lets any AI agent query your live productivity data.

**Register with Claude Code** — add to `.mcp.json` in your project root:

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

Or if installed globally:
```json
{
  "mcpServers": {
    "ai-brain": {
      "command": "ai-dashboard-mcp"
    }
  }
}
```

**Available MCP tools:**
- `get_last_session_context` — pick up context when switching tools
- `get_routing_recommendation` — "which tool should I use for this task?"
- `get_efficiency_snapshot` — current week's metrics
- `get_active_recommendations` — open optimization suggestions
- `get_project_stats` — token/session stats per project
- `get_model_comparison` — claude-sonnet vs gpt-4o vs gemini on your data
- `push_handoff_note` — save a note before switching tools
- `get_optimal_prompt_structure` — prompt templates from your best sessions
- `get_topic_summary` — executive summary of what was worked on by topic

---

## Docker setup

```bash
# Clone the repo
git clone https://github.com/Riko5652/ai-productivity-dashboard
cd ai-productivity-dashboard

# Start (builds image automatically)
docker compose up

# Background mode
docker compose up -d

# Stop
docker compose down
```

The `docker-compose.yml` mounts your `~/.claude`, `~/.cursor`, and `~/.gemini` directories as read-only volumes. Your database is persisted in `./data/`.

**Custom paths in Docker:**
```bash
CLAUDE_DIR=/custom/path/to/claude docker compose up
```

---

## LLM provider setup (optional)

The LLM provider is only needed for the **Deep Analyze**, **Daily Automation Pick**, and **Project AI Suggestions** features. The rest of the dashboard works without any LLM.

**Free option — local Ollama:**
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull gemma2:2b

# .env
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma2:2b
```

**Cloud option:**
```env
# Pick one
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
AZURE_OPENAI_API_KEY=...
```

---

## Troubleshooting

**Port 3030 already in use:**
```bash
PORT=3031 npm start
# or
ai-dashboard --port 3031
```

**`better-sqlite3` build error on first install:**
```bash
# Linux/macOS
sudo apt install build-essential python3   # Debian/Ubuntu
brew install python3                        # macOS

# Windows: install Visual Studio Build Tools
npm install --global windows-build-tools   # or install VS Build Tools manually
```

**Claude Code sessions not showing up:**
The JSONL files are in `~/.claude/projects/<project-key>/`. The project key is the project path with `/` replaced by `-`. If your project is at `C:\Projects\my-app`, the key is `C--Projects-my-app`.

**Cursor DB locked:**
Cursor holds an exclusive lock on its DB while running. The dashboard uses read-only access and handles this gracefully — sessions update after Cursor closes or after the 30-second polling interval.

**Tool shows 0 sessions:**
Check the startup log — the dashboard prints `[ingest:toolname] N sessions` for each tool. If it says 0, either the tool isn't installed or its data path wasn't found. Use the path override env vars above.

---

## Resetting data

To start fresh:
```bash
rm data/analytics.db
npm start
```

The database is rebuilt from your tool data files on next startup.
