# Contributing to AI Productivity Dashboard

> **Note:** This is a personal plugin maintained by [@Riko5652](https://github.com/Riko5652).
> It is shared as a **downloadable, self-hosted tool** — not an open-contribution project.
> The `main` branch is protected and only the maintainer can merge changes.

---

## Using the Dashboard (for everyone)

### Prerequisites
- Node.js >= 18.0.0
- npm
- At least one of: Claude Code, Cursor, or Gemini/Antigravity installed locally

### Install & Run

```bash
git clone https://github.com/Riko5652/ai-productivity-dashboard.git
cd ai-productivity-dashboard
npm install
npm start
# Dashboard available at http://localhost:3030
```

To explore with mock data before connecting your real tools:
```bash
node seed-mock.mjs
npm start
```

The dashboard auto-detects your installed AI tools on startup. No configuration needed.

---

## Bug Reports & Feature Requests

Found a bug or have an idea? Open an issue using the provided templates:

- [Report a bug](.github/ISSUE_TEMPLATE/bug_report.md)
- [Request a feature](.github/ISSUE_TEMPLATE/feature_request.md)

Issues are reviewed by the maintainer. There is no guarantee of a response timeline.

---

## Pull Requests

PRs are not actively solicited, but well-scoped fixes may be considered.

If you do open a PR:
- Keep it focused — one fix or one feature
- Test with `npm start` and verify the dashboard loads at `http://localhost:3030`
- Do not add external dependencies or cloud connections
- All PRs require approval from @Riko5652 (CODEOWNERS) before merging

**PRs that will not be merged:** telemetry, cloud sync, new dependencies without strong justification, scope creep.

---

## Privacy Commitment

This tool is local-only by design. Any contribution must preserve:
- Zero external API calls
- Zero telemetry or data transmission
- All data stays on the user's machine
