// File watchers for all 3 tool data sources
// Triggers re-ingestion when source data changes
import chokidar from 'chokidar';
import { statSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

const DEBOUNCE_MS = 3000;
const watchers = [];

export function startWatchers(onClaudeChange, onCursorChange, onAntigravityChange) {
  // 1. Claude Code: watch .jsonl files in all discovered project dirs
  for (const dir of config.claudeCode.dirs) {
    const claudeWatcher = chokidar.watch(join(dir, '*.jsonl'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000 },
    });
    let claudeTimer = null;
    claudeWatcher.on('all', () => {
      clearTimeout(claudeTimer);
      claudeTimer = setTimeout(onClaudeChange, DEBOUNCE_MS);
    });
    watchers.push(claudeWatcher);
    console.log('[watcher] Claude Code: watching', dir);
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
    const agWatcher = chokidar.watch([
      join(config.antigravity.dir, 'annotations', '*.pbtxt'),
      join(config.antigravity.dir, 'brain', '**', '*.metadata.json'),
    ], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000 },
    });
    let agTimer = null;
    agWatcher.on('all', () => {
      clearTimeout(agTimer);
      agTimer = setTimeout(onAntigravityChange, DEBOUNCE_MS);
    });
    watchers.push(agWatcher);
    console.log('[watcher] Antigravity: watching', config.antigravity.dir);
  }
}

export function stopWatchers() {
  for (const w of watchers) {
    if (typeof w.close === 'function') w.close();
  }
  watchers.length = 0;
}
