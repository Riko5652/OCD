# Contributing to AI Productivity Dashboard

Thank you for your interest in contributing! This is a local-first, privacy-focused tool for tracking AI coding assistant usage across Claude Code, Cursor, and Gemini/Antigravity.

## Getting Started

### Prerequisites
- Node.js >= 18.0.0
- npm

### Local Setup

```bash
git clone https://github.com/Riko5652/ai-productivity-dashboard.git
cd ai-productivity-dashboard
npm install
cp .env.example .env
npm start
# Dashboard available at http://localhost:3030
```

To test with mock data:
```bash
node seed-mock.mjs
```

## How to Contribute

### Reporting Bugs
Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) issue template. Include:
- Your OS and Node.js version
- Which AI tools you have installed (Claude Code, Cursor, Gemini/Antigravity)
- Steps to reproduce
- Expected vs. actual behavior

### Suggesting Features
Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) issue template. Describe the problem you're solving, not just the solution.

### Adding a New AI Tool Adapter

The dashboard is built to be extensible. To add support for a new AI coding tool:

1. Create a new adapter in `src/adapters/` following the existing pattern
2. Register it in `src/server.js`
3. Add a seeder function to `seed-mock.mjs` for testing
4. Document the data source path in your PR description

### Code Style

- **ES Modules**: This project uses `"type": "module"` — use `import`/`export`, not `require()`
- **No build step**: Vanilla JS on the frontend, no bundler — keep it simple
- **Privacy first**: No external API calls, no telemetry — all data stays local
- **SQLite**: All persistence via `better-sqlite3` — no cloud databases

### Submitting a Pull Request

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Test manually: `npm start` and verify the dashboard works
5. Open a PR against `main` using the PR template

### What Makes a Good PR

- Single focused change (one feature, one fix)
- Tested with at least one real tool install or `seed-mock.mjs`
- Clear description of what changed and why
- No new external dependencies unless absolutely necessary

## Privacy Commitment

All contributions must maintain the project's zero-cloud, zero-telemetry design. Do not introduce:
- External API calls for analytics or error reporting
- Cloud database connections
- Any code that transmits user data externally

## Questions?

Open a [GitHub Discussion](https://github.com/Riko5652/ai-productivity-dashboard/issues) or file an issue with the `question` label.
