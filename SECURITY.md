# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | ✅ Active |
| 2.x     | ⚠️ Security fixes only |
| 1.x     | ❌ No longer supported |

## Privacy & Threat Model

AI Productivity Dashboard is **local-only software** — it reads files from your local machine and serves a dashboard over `localhost:3030`. It never connects to external servers, sends telemetry, or stores data in the cloud.

**Data accessed by this tool:**
- `~/.claude/projects/*/` — Claude Code session logs
- Cursor local SQLite databases (OS-specific paths)
- `~/.gemini/antigravity/` — Gemini/Antigravity logs

All data remains on your machine.

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public GitHub issue**.

Instead, report it privately:

1. **GitHub Private Vulnerability Reporting**: Use the [Security tab](https://github.com/Riko5652/ai-productivity-dashboard/security/advisories/new) on this repository to submit a private advisory.
2. **Email**: Contact the maintainer directly via GitHub profile (@Riko5652).

### What to Include
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### Response Timeline
- Acknowledgement within **48 hours**
- Assessment and fix plan within **7 days**
- Fix published within **30 days** for confirmed vulnerabilities

## Security Considerations for Self-Hosting

- The dashboard server binds to `localhost` by default — do not expose port 3030 publicly
- `.env` files may contain paths or tokens — never commit them (already in `.gitignore`)
- The SQLite database contains your session metadata — treat it like any personal data file
