#!/usr/bin/env node
// ai-dashboard CLI — npm install -g ai-productivity-dashboard
// or run without installing: npx ai-productivity-dashboard

// ── Node version check ──────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`\x1b[31m✖ Node.js ${process.versions.node} is too old.\x1b[0m`);
  console.error(`  AI Productivity Dashboard requires Node.js 18 or later.`);
  console.error(`  Download: https://nodejs.org`);
  process.exit(1);
}

// ── Parse CLI flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);

// --port <n> takes precedence over PORT env var
const portFlagIdx = args.findIndex(a => a === '--port' || a === '-p');
const PORT = portFlagIdx !== -1 && args[portFlagIdx + 1]
  ? parseInt(args[portFlagIdx + 1], 10)
  : parseInt(process.env.PORT || '3030', 10);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
\x1b[1mai-dashboard\x1b[0m — AI Productivity Dashboard v3

\x1b[1mUsage:\x1b[0m
  ai-dashboard [options]

\x1b[1mOptions:\x1b[0m
  --port <n>     Port to listen on (default: 3030, or PORT env var)
  --no-open      Don't open the browser automatically
  --help         Show this help

\x1b[1mEnvironment:\x1b[0m
  Copy .env.example to .env and customize paths/API keys.
  All tool data is auto-detected — no config needed to start.

\x1b[1mExamples:\x1b[0m
  npx ai-productivity-dashboard
  ai-dashboard --port 4000 --no-open

\x1b[1mDocs:\x1b[0m https://github.com/Riko5652/ai-productivity-dashboard
`);
  process.exit(0);
}

// ── Auto-open browser ────────────────────────────────────────────────────────
const noOpen = args.includes('--no-open');

process.env.PORT = String(PORT);

// Delay browser open until server is ready (server emits a ready signal via env)
if (!noOpen) {
  // We open after a short delay so the server has time to bind
  setTimeout(async () => {
    const url = `http://localhost:${PORT}`;
    const platform = process.platform;
    const { exec } = await import('child_process');
    const cmd = platform === 'darwin' ? `open "${url}"` :
                platform === 'win32'  ? `start "" "${url}"` :
                                        `xdg-open "${url}"`;
    exec(cmd);
  }, 2000);
}

// ── Start the server ─────────────────────────────────────────────────────────
import '../src/server.js';
