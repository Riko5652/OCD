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

// Windsurf DB path (platform-specific)
function getWindsurfDbPath() {
  const base = {
    win32: join(home, 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
    darwin: join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
    linux: join(home, '.config', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
  }[platform] || join(home, '.windsurf');
  return process.env.WINDSURF_DB || join(base, 'ai_usage.db');
}

// Continue.dev sessions dir
function getContinueSessionsDir() {
  return process.env.CONTINUE_SESSIONS_DIR || join(home, '.continue', 'sessions');
}

// Aider history files (scanned from CWD)
function getAiderHistoryCount() {
  let count = 0;
  const scan = (dir, depth = 0) => {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') scan(join(dir, entry.name), depth + 1);
        else if (entry.name === '.aider.chat.history.md') count++;
      }
    } catch { /* skip */ }
  };
  scan(process.cwd());
  return count;
}

// Copilot telemetry DB
function getCopilotDbPath() {
  const vsBase = {
    win32: join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    darwin: join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    linux: join(home, '.config', 'Code', 'User', 'globalStorage'),
  }[platform];
  return vsBase ? join(vsBase, 'github.copilot', 'telemetry.db') : null;
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

  aider: {
    logsDir: process.env.AIDER_LOGS_DIR || join(home, '.aider', 'logs'),
  },

  windsurf: {
    dbPath: getWindsurfDbPath(),
  },

  continueDev: {
    sessionsDir: getContinueSessionsDir(),
  },

  copilot: {
    telemetryDb: getCopilotDbPath(),
  },

  platform,
};

function found(path) { return path && existsSync(path) ? '✓' : '✗'; }

// Print detected config on startup — tells user exactly what was found
export function printConfig() {
  console.log('\n  Auto-discovery results:');
  console.log(`  Platform: ${platform} | DB: ${config.dbPath}`);
  console.log('');

  // Claude Code
  if (config.claudeCode.dirs.length > 0) {
    let totalSessions = 0;
    for (const d of config.claudeCode.dirs) {
      try { totalSessions += readdirSync(d).filter(f => f.endsWith('.jsonl')).length; } catch { /* skip */ }
    }
    console.log(`  ✓ Claude Code    — ${config.claudeCode.dirs.length} project dir(s), ~${totalSessions} session files`);
  } else {
    console.log(`  ✗ Claude Code    — not found. Set CLAUDE_PROJECT_DIR=~/.claude/projects/your-project`);
  }

  // Cursor
  const cursorFound = existsSync(config.cursor.stateDb) || existsSync(config.cursor.trackingDb);
  console.log(`  ${found(config.cursor.stateDb)} Cursor           — ${cursorFound ? config.cursor.trackingDb : 'not found. Set CURSOR_TRACKING_DB=/path/to/ai-code-tracking.db'}`);

  // Antigravity / Gemini
  console.log(`  ${found(config.antigravity.dir)} Gemini/Antigrav  — ${existsSync(config.antigravity.dir) ? config.antigravity.dir : 'not found. Set ANTIGRAVITY_DIR=~/.gemini/antigravity'}`);

  // Aider
  const aiderCount = getAiderHistoryCount();
  console.log(`  ${aiderCount > 0 ? '✓' : '✗'} Aider            — ${aiderCount > 0 ? `${aiderCount} history file(s) found in workspace` : 'no .aider.chat.history.md found in current directory tree'}`);

  // Windsurf
  console.log(`  ${found(config.windsurf.dbPath)} Windsurf         — ${existsSync(config.windsurf.dbPath || '') ? config.windsurf.dbPath : 'not found (not installed, or set WINDSURF_DB=)'}`);

  // Copilot
  const copilotPath = config.copilot.telemetryDb;
  console.log(`  ${found(copilotPath)} GitHub Copilot   — ${copilotPath && existsSync(copilotPath) ? copilotPath : 'not found (VS Code extension data missing)'}`);

  // Continue.dev
  console.log(`  ${found(config.continueDev.sessionsDir)} Continue.dev     — ${existsSync(config.continueDev.sessionsDir) ? config.continueDev.sessionsDir : 'not found. Set CONTINUE_SESSIONS_DIR=~/.continue/sessions'}`);

  console.log('');
  console.log(`  Set missing paths in .env — see .env.example for all options.`);
  console.log(`  Full setup guide: https://github.com/Riko5652/ai-productivity-dashboard/blob/main/SETUP.md`);
  console.log('');
}
