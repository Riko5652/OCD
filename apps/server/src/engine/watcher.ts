// File watchers for all tool data sources
// Triggers re-ingestion when source data changes
import { watch, statSync, existsSync, FSWatcher } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const DEBOUNCE_MS = 3000;
const watchers: Array<FSWatcher | { close: () => void }> = [];

export function startWatchers(
    onClaudeChange: () => void,
    onCursorChange: () => void,
    onAntigravityChange: () => void
) {
    // 1. Claude Code: watch .jsonl files in all discovered project dirs
    for (const dir of config.claudeCode.dirs) {
        if (!existsSync(dir)) continue;
        try {
            let claudeTimer: ReturnType<typeof setTimeout> | null = null;
            const w = watch(dir, { persistent: false }, () => {
                if (claudeTimer) clearTimeout(claudeTimer);
                claudeTimer = setTimeout(onClaudeChange, DEBOUNCE_MS);
            });
            watchers.push(w);
            console.log('[watcher] Claude Code: watching', dir);
        } catch { /* dir not watchable */ }
    }

    // 2. Cursor: poll ai-code-tracking.db mtime (can't watch SQLite safely)
    if (existsSync(config.cursor.trackingDb)) {
        let lastCursorMtime = 0;
        const cursorPoll = setInterval(() => {
            try {
                const { mtimeMs } = statSync(config.cursor.trackingDb);
                if (mtimeMs > lastCursorMtime) {
                    lastCursorMtime = mtimeMs;
                    onCursorChange();
                }
            } catch { /* DB not available */ }
        }, 30000);
        watchers.push({ close: () => clearInterval(cursorPoll) });
        console.log('[watcher] Cursor: polling', config.cursor.trackingDb, '(30s interval)');
    }

    // 3. Antigravity: watch annotations + brain dirs
    if (existsSync(config.antigravity.dir)) {
        const annotationsDir = join(config.antigravity.dir, 'annotations');
        const brainDir = join(config.antigravity.dir, 'brain');
        let agTimer: ReturnType<typeof setTimeout> | null = null;
        const onChange = () => {
            if (agTimer) clearTimeout(agTimer);
            agTimer = setTimeout(onAntigravityChange, DEBOUNCE_MS);
        };
        for (const dir of [annotationsDir, brainDir]) {
            if (!existsSync(dir)) continue;
            try {
                const w = watch(dir, { recursive: true, persistent: false }, onChange);
                watchers.push(w);
            } catch { /* dir not watchable */ }
        }
        console.log('[watcher] Antigravity: watching', config.antigravity.dir);
    }
}

export function stopWatchers() {
    for (const w of watchers) {
        if (typeof w.close === 'function') w.close();
    }
    watchers.length = 0;
}
