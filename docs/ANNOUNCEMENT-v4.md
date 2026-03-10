# v4.0 — Semantic Memory, Knowledge Graph & MCP Solution Injection

## What's New

**AI Productivity Dashboard** now goes beyond analytics — it learns from your sessions and actively helps you code better.

### Highlights

- **Semantic Memory Engine** — vector embeddings + knowledge graph find solutions from your past sessions
- **MCP "Inject Proven Solution"** — when you hit an error in Cursor, it finds that Claude Code solved it last week
- **Session Import** — paste JSON, upload files, or use the bookmarklet to capture ChatGPT / Claude.ai / Gemini sessions
- **Savings Report** — see cache hit rates, error recovery, routing adherence, and estimated hours saved
- **Copilot Chat adapter** — now ingests VS Code Copilot Chat sessions
- **Zero-config MCP setup** — `npx ai-productivity-dashboard setup-mcp` registers in Claude Code / Cursor / Windsurf automatically
- **Gamification** — Level, XP, streak tracking, 21+ achievements, personal records
- **Profile & Costs tabs** — per-model cost breakdown, prompt signal analysis, optimization recommendations

### Screenshots

![Command Center](docs/screenshots/command-center.png)
![Workspaces](docs/screenshots/workspaces.png)
![Profile](docs/screenshots/profile.png)
![Costs](docs/screenshots/costs.png)

### Upgrade

```bash
npm install -g ai-productivity-dashboard@latest
```

Or download standalone binaries from the [Releases page](https://github.com/Riko5652/ai-productivity-dashboard/releases).

### Auto-Update Notice

If you're already running the dashboard, you'll see a **purple update banner** next time you open it — the server checks npm for new versions automatically.

### Full Changelog

See the [README](https://github.com/Riko5652/ai-productivity-dashboard#readme) for complete documentation.
