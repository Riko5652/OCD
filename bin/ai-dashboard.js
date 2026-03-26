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

// install-hook: run shell hook installer
if (args.includes('install-hook')) {
  import('./install-hook.js');
}

// --setup-mcp: run MCP auto-setup instead of starting server
if (args.includes('--setup-mcp')) {
  const setupArgs = [];
  if (args.includes('--project')) setupArgs.push('--project');
  if (args.includes('--remove')) setupArgs.push('--remove');
  import('./setup-mcp.js');
  // setup-mcp.js handles its own process.exit
}

// --mcp: start MCP stdio server (used by Claude Code / Cursor / Windsurf)
if (args.includes('--mcp')) {
  const { existsSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath, pathToFileURL } = await import('url');
  const __bindir = dirname(fileURLToPath(import.meta.url));
  const mcpDist = join(__bindir, '..', 'apps', 'server', 'dist', 'mcp-handoff.js');
  if (existsSync(mcpDist)) {
    await import(pathToFileURL(mcpDist).href);
  } else {
    try {
      await import('tsx');
      await import('../apps/server/src/mcp-handoff.ts');
    } catch {
      console.error('\x1b[31m✖ MCP server not built.\x1b[0m');
      console.error('  Run: pnpm run build');
      process.exit(1);
    }
  }
  // MCP server runs until the transport closes — prevent falling through to HTTP server
  await new Promise(() => {});
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
\x1b[1mai-dashboard\x1b[0m — OCD (Omni Coder Dashboard) v5.4.0

  AI memory engine with real semantic embeddings, 18 MCP tools,
  cross-tool routing, and proactive IDE interception.

\x1b[1mUsage:\x1b[0m
  ai-dashboard [options]

\x1b[1mOptions:\x1b[0m
  --port <n>      Port to listen on (default: 3030, or PORT env var)
  --no-open       Don't open the browser automatically
  --mcp           Start as MCP stdio server (for AI tool integration)
  --setup-mcp     Auto-register MCP server in Claude Code / Cursor / Windsurf
  install-hook    Install shell hook for proactive IDE interception
  --help          Show this help

\x1b[1mFeatures (zero config):\x1b[0m
  - Real 384-dim semantic embeddings via local ONNX model
  - 18 MCP tools for any AI agent
  - Memory dashboard with live similarity search
  - Proactive IDE interception (run: ocd install-hook)

\x1b[1mEnvironment:\x1b[0m
  Copy .env.example to .env and customize paths/API keys.
  All tool data + embeddings are auto-detected — no config needed to start.

\x1b[1mExamples:\x1b[0m
  npx omni-coder-dashboard
  ai-dashboard --port 4000 --no-open
  ocd install-hook

\x1b[1mDocs:\x1b[0m https://github.com/Riko5652/OCD
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
    const { execFile } = await import('child_process');
    const cmd = platform === 'darwin' ? 'open'
              : platform === 'win32'  ? 'cmd'
              : 'xdg-open';
    const cmdArgs = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    execFile(cmd, cmdArgs, () => {});
  }, 2000);
}

// ── Start the server ─────────────────────────────────────────────────────────
// Try compiled JS first, fall back to tsx for development
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __bindir = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__bindir, '..', 'apps', 'server', 'dist', 'index.js');

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  // Development mode: try tsx for TypeScript execution
  try {
    await import('tsx');
    await import('../apps/server/src/index.ts');
  } catch {
    console.error('\x1b[31m✖ Server not built.\x1b[0m');
    console.error('  For production:  pnpm run build && pnpm run start');
    console.error('  For development: pnpm --filter @ocd/server run dev');
    process.exit(1);
  }
}
