# Launch Drafts

## Hacker News — Show HN

**Title:**
> Show HN: A local AI memory engine for Cursor and Claude Code (no API keys)

**URL:** https://github.com/Riko5652/ai-productivity-dashboard

**First comment (post immediately after submitting):**

> Hey HN. I built this to solve a specific friction point: LLM knowledge cutoffs in coding sessions.
>
> The problem: Claude Code solves a complex Postgres migration on Monday. On Thursday, you hit a similar error in Cursor. The LLM has no memory of Monday's solution — you start from scratch.
>
> This tool fixes that. It reads session files from 7 AI coding tools (Claude Code, Cursor, Aider, Windsurf, Copilot, Continue, Gemini), vectorizes the solutions locally, and builds a knowledge graph connecting sessions by shared files, error patterns, and projects.
>
> The key piece: an MCP server with 11 tools. When you hit an error mid-session, the `get_similar_solutions` tool does a vector search + graph walk and injects the proven solution into your current prompt context. The LLM gets your local history as context — no fine-tuning, no cloud.
>
> Tech: Node.js ESM, Express, SQLite (sql.js in-process), Ollama for embeddings (optional — falls back to built-in text hashing). Zero external services required. All data stays on your machine.
>
> The dashboard also does: routing recommendations based on tool+model win rates from your history, real-time coaching via SSE, cost tracking across 30+ models, and gamification (because streaks work).
>
> Happy to answer questions about the vector search approach, MCP integration, or the adapter architecture.

---

## Product Hunt

**Tagline:** Give your AI coding tools a memory — local, private, zero API keys

**Description:**
AI Productivity Dashboard learns from every coding session across Claude Code, Cursor, Aider, Windsurf, and more. When you solve a bug on Monday, the MCP server injects that solution when you hit a similar error on Thursday. All local. No cloud. No API keys.

**FAQ comments to seed (post these yourself):**

**Q: How does this compare to just using Claude Code's built-in memory?**
> Claude Code's memory is per-project and text-based. This system vectorizes solutions across all your tools and projects, then does semantic similarity search. It also bridges tools — a solution from Claude Code can surface in Cursor.

**Q: Does this send my code to any cloud service?**
> No. Everything runs locally. The server binds to 127.0.0.1. Embeddings are generated via Ollama (local) or a built-in hasher. No telemetry, no analytics, no tracking. Your session data never leaves your machine.

**Q: What's the MCP integration? How does it actually work mid-session?**
> The dashboard exposes an MCP server over stdio. When Claude Code or Cursor calls `get_similar_solutions`, it does a cosine similarity search on your local vector DB + walks the knowledge graph for related sessions. The result is injected as context into your current conversation.

**Q: How much setup is required?**
> `npx ai-productivity-dashboard` — that's it. It auto-detects all AI tool data paths. For MCP, run `npx ai-productivity-dashboard --setup-mcp` and it writes the config to Claude Code, Cursor, and Windsurf automatically.

---

## Launch Timing

- **Hacker News**: Tuesday or Wednesday, 8-9am EST
- **Product Hunt**: Tuesday or Wednesday (same week or next)
- Have the GitHub Discussion announcement ready before launch
- Screenshots in README should be live before posting
