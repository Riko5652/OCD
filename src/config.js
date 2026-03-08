// Configuration — auto-detects OS paths, supports env var overrides
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const platform = process.platform; // 'win32', 'darwin', 'linux'
const home = os.homedir();

// User data dir: auto-detected based on context.
// - Local clone (`.git` present): uses `./data/` — same as before, no disruption
// - npm global install / npx: uses `~/.ai-productivity-dashboard/` so data persists across updates
const isLocalDev = existsSync(join(ROOT, '.git'));
const DATA_DIR = process.env.DB_PATH
  ? dirname(process.env.DB_PATH)
  : isLocalDev
    ? join(ROOT, 'data')
    : join(home, '.ai-productivity-dashboard');

// ---- Cursor paths per OS ----
function getCursorStatePath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const paths = {
    win32: join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    darwin: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    linux: join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  };
  return paths[platform] || paths.linux;
}

function getCursorTrackingPath() {
  if (process.env.CURSOR_TRACKING_DB) return process.env.CURSOR_TRACKING_DB;
  return join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

// ---- Claude Code paths ----
function getClaudeCodeDirs() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return [process.env.CLAUDE_PROJECT_DIR];
  }

  // Auto-discover: scan all project directories under ~/.claude/projects/
  const projectsRoot = join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) return [];

  const dirs = [];
  try {
    for (const dir of readdirSync(projectsRoot)) {
      const fullPath = join(projectsRoot, dir);
      // Check if it contains .jsonl files
      try {
        const files = readdirSync(fullPath);
        if (files.some(f => f.endsWith('.jsonl'))) {
          dirs.push(fullPath);
        }
      } catch { /* not a readable directory */ }
    }
  } catch { /* projects dir not readable */ }
  return dirs;
}

// ---- Antigravity (Google Gemini) paths ----
function getAntigravityDir() {
  if (process.env.ANTIGRAVITY_DIR) return process.env.ANTIGRAVITY_DIR;
  return join(home, '.gemini', 'antigravity');
}

// Scan cursor-imports/ subfolders for additional Antigravity data directories
// Handles Drive-imported structure: cursor-imports/*/Antigravity/antigravity/
function getImportedAntigravityDirs() {
  const importDir = process.env.CURSOR_IMPORT_DIR || join(DATA_DIR, 'cursor-imports');
  const dirs = [];
  if (!existsSync(importDir)) return dirs;
  try {
    for (const sub of readdirSync(importDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      // Check common patterns: sub/Antigravity/antigravity or sub/antigravity
      const candidates = [
        join(importDir, sub.name, 'Antigravity', 'antigravity'),
        join(importDir, sub.name, 'antigravity'),
        join(importDir, sub.name),
      ];
      for (const c of candidates) {
        if (existsSync(join(c, 'brain')) || existsSync(join(c, 'annotations'))) {
          dirs.push(c);
          break;
        }
      }
    }
  } catch { /* not readable */ }
  return dirs;
}

// ---- App config ----
export const config = {
  port: parseInt(process.env.PORT || '3030', 10),
  dbPath: process.env.DB_PATH || join(DATA_DIR, 'analytics.db'),

  cursor: {
    stateDb: getCursorStatePath(),
    trackingDb: getCursorTrackingPath(),
    importDir: process.env.CURSOR_IMPORT_DIR || join(DATA_DIR, 'cursor-imports'),
    csvDir: process.env.CURSOR_CSV_DIR || DATA_DIR,
  },

  claudeCode: {
    dirs: getClaudeCodeDirs(),
  },

  antigravity: {
    dir: getAntigravityDir(),
    importedDirs: getImportedAntigravityDirs(),
  },

  platform,
};

// Print detected config on startup
export function printConfig() {
  console.log('\n  Configuration:');
  console.log(`  Platform:     ${platform}`);
  console.log(`  DB:           ${config.dbPath}`);
  console.log(`  Port:         ${config.port}`);
  console.log('');
  console.log('  Data sources:');

  // Claude Code
  if (config.claudeCode.dirs.length > 0) {
    console.log(`  Claude Code:  ${config.claudeCode.dirs.length} project(s) found`);
    for (const d of config.claudeCode.dirs) {
      const count = readdirSync(d).filter(f => f.endsWith('.jsonl')).length;
      console.log(`    - ${d} (${count} sessions)`);
    }
  } else {
    console.log('  Claude Code:  not found (set CLAUDE_PROJECT_DIR)');
  }

  // Cursor
  if (existsSync(config.cursor.stateDb)) {
    console.log(`  Cursor:       ${config.cursor.stateDb}`);
  } else {
    console.log(`  Cursor:       not found at ${config.cursor.stateDb}`);
  }
  if (existsSync(config.cursor.trackingDb)) {
    console.log(`  Cursor AI:    ${config.cursor.trackingDb}`);
  }

  // Antigravity
  if (existsSync(config.antigravity.dir)) {
    console.log(`  Antigravity:  ${config.antigravity.dir}`);
  } else {
    console.log('  Antigravity:  not found');
  }
  console.log('');
}
