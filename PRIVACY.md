# Privacy Policy

## Summary

This tool collects nothing, phones home to nothing, and stores everything locally. Your data stays on your machine.

---

## Zero Telemetry

There is no analytics server. There is no usage tracking. There are no crash reports sent to a remote service. No identifiers, device fingerprints, session counts, or behavioral signals are transmitted anywhere by default.

This tool contains no telemetry SDK, no beacon calls, no periodic ping to a remote endpoint, and no opt-out toggle — because there is nothing to opt out of.

---

## What Data Is Read

The tool reads local session log files produced by AI coding tools you have installed on your machine:

- **Claude Code** — session JSONL files at `~/.claude/projects/`
- **Cursor** — SQLite databases at `~/.cursor/` and platform-specific app data directories
- **Aider** — conversation history files in project directories
- **Windsurf, Copilot, Continue, and other adapters** — as described in the adapter source files under `apps/server/src/adapters/`

All file access is read-only. The tool does not write to, modify, or delete any source log files. These files already exist on your machine as a result of your normal use of those AI tools.

---

## What Is Stored

The tool writes a single SQLite database file (default: `~/.ai-dashboard/dashboard.db`) containing:

- Aggregated session statistics (turn counts, token counts, quality scores, dates, tool IDs)
- Inferred metadata (task classifications, topic labels, model performance rows)
- Cached LLM-generated summaries (stored locally, not re-sent on subsequent requests)

This database is never transmitted anywhere. It exists solely to make the dashboard fast and to preserve computed results between restarts.

---

## Optional LLM Features

Some features (deep analysis, daily pick, topic summaries) optionally send data to a locally-configured LLM provider. You configure this provider yourself via environment variables (`OLLAMA_HOST`, `OPENAI_API_KEY`, `AZURE_OPENAI_*`, `ANTHROPIC_API_KEY`).

When these features are used, the data sent to your chosen provider consists only of:

- Aggregated statistics (dates, turn counts, quality scores, token totals)
- The first 200 characters of a session label or title
- Inferred task classifications (e.g. "refactoring", "debugging")

Raw code, full prompt transcripts, file contents, and secrets are never included in LLM requests. If you do not configure an LLM provider, these features produce no output and send nothing.

---

## Your Data on Your Machine

The session log files this tool reads were written by AI tools you chose to install and run. They are your own files, on your own machine, produced by your own activity. Reading them for personal analysis is no different from reading your own shell history or browser bookmarks.

The tool accesses these files read-only and processes them locally. No third party is involved unless you explicitly configure an external LLM provider.

---

## Network Exposure

By default, the dashboard server binds only to `127.0.0.1` (localhost). It is not accessible from other machines on your network or the internet.

If you set the `BIND` environment variable to `0.0.0.0` or any non-loopback address, the server will print a prominent warning at startup. In that configuration, you are responsible for restricting access. Setting the `AUTH_TOKEN` environment variable is strongly recommended — all API routes will then require a `Bearer` token, preventing unauthorized access to your session data.

---

## Changes to This Policy

If this policy changes in a future version, the change will be described in the project changelog and the updated file will be committed to the repository. You can review the full history at any time via `git log PRIVACY.md`.
