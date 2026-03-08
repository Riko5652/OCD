#!/usr/bin/env node
// CLI entrypoint — installed as `ai-dashboard` when using npm install -g
// or invoked via `npx ai-productivity-dashboard`

// Node version check
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`\x1b[31m✖ Node.js v${process.versions.node} is too old. AI Productivity Dashboard requires Node.js 18 or later.\x1b[0m`);
  console.error(`  Download: https://nodejs.org`);
  process.exit(1);
}

import '../src/server.js';
