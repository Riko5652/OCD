#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

console.log('\n🩺 AI Productivity Dashboard — Health Check\n');

let allPassed = true;
let warnings = 0;

// 1. Node.js version
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split('.')[0], 10);
if (major >= 18) {
  console.log(`  ✅ Node.js: v${nodeVersion}`);
} else {
  console.log(`  ❌ Node.js: v${nodeVersion} (requires >= 18)`);
  allPassed = false;
}

// 2. Docker
try {
  execSync('docker info', { stdio: 'ignore' });
  console.log('  ✅ Docker: running');
} catch {
  console.log('  ⚠️  Docker: not running (optional — needed for docker compose)');
  warnings++;
}

// 3. Ollama (optional, for embeddings)
try {
  execSync('ollama --version', { stdio: 'ignore' });
  console.log('  ✅ Ollama: installed (used for vector embeddings)');
} catch {
  console.log('  ⚠️  Ollama: not found (optional — embeddings fall back to built-in hashing)');
  warnings++;
}

// 4. System RAM
const totalGB = os.totalmem() / 1024 / 1024 / 1024;
if (totalGB >= 8) {
  console.log(`  ✅ System RAM: ${totalGB.toFixed(1)} GB`);
} else {
  console.log(`  ⚠️  System RAM: ${totalGB.toFixed(1)} GB (8+ GB recommended)`);
  warnings++;
}

// 5. .env file
if (existsSync(join(ROOT, '.env'))) {
  console.log('  ✅ .env: found');
} else {
  console.log('  ⚠️  .env: not found (copy .env.example to .env for custom config)');
  warnings++;
}

// 6. Database
const dbPaths = [
  join(ROOT, 'data', 'analytics.db'),
  join(ROOT, '.data', 'ai-productivity.db'),
  join(os.homedir(), '.ai-productivity-dashboard', 'ai-productivity.db'),
];
const dbFound = dbPaths.find(p => existsSync(p));
if (dbFound) {
  console.log(`  ✅ Database: ${dbFound}`);
} else {
  console.log('  ℹ️  Database: will be created on first run');
}

// 7. AI tool detection
const tools = [
  { name: 'Claude Code', check: () => existsSync(join(os.homedir(), '.claude', 'projects')) },
  { name: 'Cursor', check: () => {
    const base = process.platform === 'win32'
      ? join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage')
      : process.platform === 'darwin'
        ? join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
        : join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage');
    return existsSync(base);
  }},
  { name: 'Aider', check: () => existsSync(join(os.homedir(), '.aider.chat.history.md')) },
  { name: 'Antigravity (Gemini)', check: () => existsSync(join(os.homedir(), '.gemini', 'antigravity')) },
  { name: 'Windsurf', check: () => {
    const base = process.platform === 'win32'
      ? join(os.homedir(), 'AppData', 'Roaming', 'Windsurf')
      : process.platform === 'darwin'
        ? join(os.homedir(), 'Library', 'Application Support', 'Windsurf')
        : join(os.homedir(), '.config', 'Windsurf');
    return existsSync(base);
  }},
  { name: 'GitHub Copilot', check: () => {
    const base = process.platform === 'win32'
      ? join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'github.copilot')
      : process.platform === 'darwin'
        ? join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot')
        : join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'github.copilot');
    return existsSync(base);
  }},
  { name: 'Continue.dev', check: () => existsSync(join(os.homedir(), '.continue', 'sessions')) },
];

console.log('\n  AI Tools detected:');
let toolCount = 0;
for (const t of tools) {
  try {
    if (t.check()) { console.log(`    ✅ ${t.name}`); toolCount++; }
  } catch { /* skip */ }
}
if (toolCount === 0) console.log('    ℹ️  None found yet — they will be detected on first run');

// Summary
console.log('\n────────────────────────────────────────');
if (!allPassed) {
  console.log('❌ Fix the errors above before starting.');
  process.exit(1);
} else if (warnings > 0) {
  console.log(`✅ Ready to run! (${warnings} optional warning${warnings > 1 ? 's' : ''})`);
  console.log('   Start with: npm start');
} else {
  console.log('🎉 Everything looks great! Run: npm start');
}
console.log('');
