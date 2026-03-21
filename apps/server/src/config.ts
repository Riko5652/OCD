// Configuration — auto-detects OS paths for all AI tools, supports env var overrides
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform as osPlatform } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const platform = osPlatform();
const home = homedir();

// User data dir: local-dev uses ./data, npm global uses ~/.ai-productivity-dashboard
const isLocalDev = existsSync(join(ROOT, '..', '..', '.git'));
const DATA_DIR = process.env.DB_PATH
    ? dirname(process.env.DB_PATH)
    : isLocalDev
        ? join(ROOT, '.data')
        : join(home, '.ai-productivity-dashboard');

// ---- Cursor paths per OS ----
function getCursorStatePath(): string {
    if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
    const paths: Record<string, string> = {
        win32: join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        darwin: join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        linux: join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    };
    return paths[platform] || paths.linux;
}

function getCursorTrackingPath(): string {
    if (process.env.CURSOR_TRACKING_DB) return process.env.CURSOR_TRACKING_DB;
    return join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

// ---- Claude Code paths ----
function getClaudeCodeDirs(): string[] {
    if (process.env.CLAUDE_PROJECT_DIR) {
        return [process.env.CLAUDE_PROJECT_DIR];
    }
    const projectsRoot = join(home, '.claude', 'projects');
    if (!existsSync(projectsRoot)) return [];

    const dirs: string[] = [];
    try {
        for (const dir of readdirSync(projectsRoot)) {
            const fullPath = join(projectsRoot, dir);
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
function getAntigravityDir(): string {
    if (process.env.ANTIGRAVITY_DIR) return process.env.ANTIGRAVITY_DIR;
    return join(home, '.gemini', 'antigravity');
}

function getImportedAntigravityDirs(): string[] {
    const importDir = process.env.CURSOR_IMPORT_DIR || join(DATA_DIR, 'cursor-imports');
    const dirs: string[] = [];
    if (!existsSync(importDir)) return dirs;
    try {
        for (const sub of readdirSync(importDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
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

// ---- Windsurf DB path ----
function getWindsurfDbPath(): string {
    const base: Record<string, string> = {
        win32: join(home, 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
        darwin: join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
        linux: join(home, '.config', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
    };
    return process.env.WINDSURF_DB || join(base[platform] || join(home, '.windsurf'), 'ai_usage.db');
}

// ---- Continue.dev ----
function getContinueSessionsDir(): string {
    return process.env.CONTINUE_SESSIONS_DIR || join(home, '.continue', 'sessions');
}

// ---- Copilot ----
function getCopilotStoragePath(): string {
    const vsBase: Record<string, string> = {
        win32: join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
        darwin: join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
        linux: join(home, '.config', 'Code', 'User', 'globalStorage'),
    };
    return vsBase[platform] || vsBase.linux;
}

// Aider history file count
function getAiderHistoryCount(): number {
    let count = 0;
    const scan = (dir: string, depth = 0) => {
        if (depth > 3) return;
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    scan(join(dir, entry.name), depth + 1);
                } else if (entry.name === '.aider.chat.history.md') {
                    count++;
                }
            }
        } catch { /* skip */ }
    };
    scan(process.cwd());
    return count;
}

// ---- Exported config ----
export const config = {
    port: parseInt(process.env.PORT || '3030', 10),
    dbPath: process.env.DB_PATH || join(DATA_DIR, 'ai-productivity.db'),

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
        storagePath: getCopilotStoragePath(),
    },

    platform,
} as const;

function found(path: string | null): string {
    return path && existsSync(path) ? '✓' : '✗';
}

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

    // Antigravity
    console.log(`  ${found(config.antigravity.dir)} Gemini/Antigrav  — ${existsSync(config.antigravity.dir) ? config.antigravity.dir : 'not found. Set ANTIGRAVITY_DIR=~/.gemini/antigravity'}`);

    // Aider
    const aiderCount = getAiderHistoryCount();
    console.log(`  ${aiderCount > 0 ? '✓' : '✗'} Aider            — ${aiderCount > 0 ? `${aiderCount} history file(s)` : 'no .aider.chat.history.md found'}`);

    // Windsurf
    console.log(`  ${found(config.windsurf.dbPath)} Windsurf         — ${existsSync(config.windsurf.dbPath) ? config.windsurf.dbPath : 'not found'}`);

    // Copilot
    const copilotTelDb = join(config.copilot.storagePath, 'github.copilot', 'telemetry.db');
    console.log(`  ${found(copilotTelDb)} GitHub Copilot   — ${existsSync(copilotTelDb) ? copilotTelDb : 'not found'}`);

    // Continue.dev
    console.log(`  ${found(config.continueDev.sessionsDir)} Continue.dev     — ${existsSync(config.continueDev.sessionsDir) ? config.continueDev.sessionsDir : 'not found'}`);

    console.log('');
}
