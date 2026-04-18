/**
 * Proactive IDE Interception — Zero-Click Context
 *
 * Monitors active terminal output files and LSP diagnostic logs for stack
 * traces.  When a match is detected:
 *   1. Queries SQLite vector storage via cosine similarity.
 *   2. If a match is found, sends an OS-level notification.
 *   3. Broadcasts the solution payload over the existing SSE channel so any
 *      connected MCP client / IDE extension receives it before the user types.
 */

import { watch, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { getDb } from '../db/index.js';
import { embedText, cosineSimilarity } from '../lib/vector-store.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 1500;
const SIMILARITY_THRESHOLD = 0.55;
const MAX_TRACE_CHARS = 4096;

// Terminal output file locations monitored by default.
// Users can append to TERMINAL_LOG_PATHS env (colon-separated).
const DEFAULT_WATCH_PATHS: string[] = [
    join(tmpdir(), 'ocd-terminal.log'),          // Explicit pipe target
    join(process.env.HOME || '~', '.ocd', 'terminal.log'),
    // VS Code / JetBrains integrated terminal dump (if routed here via shell hook)
    '/tmp/vscode-terminal.log',
];

const EXTRA_PATHS = (process.env.TERMINAL_LOG_PATHS || '')
    .split(':')
    .map(p => p.trim())
    .filter(Boolean);

const WATCH_PATHS = [...new Set([...DEFAULT_WATCH_PATHS, ...EXTRA_PATHS])];

// ─── Stack trace detection ────────────────────────────────────────────────────

// Patterns that strongly indicate a stack trace / runtime error.
const STACK_TRACE_PATTERNS: RegExp[] = [
    /Error:\s+.+/,
    /Traceback \(most recent call last\)/,
    /at \S+\s+\(\S+:\d+:\d+\)/,          // JS/TS stack frames
    /\bat\b .+\(.+\.java:\d+\)/,          // Java
    /File ".+", line \d+, in/,            // Python
    /panicked at '.*'/,                   // Rust
    /EXCEPTION_.*_FAULT/,                 // Windows native
    /\bsegfault\b|\bsegmentation fault\b/i,
    /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/,
    /\bUnhandledPromiseRejection\b/,
    /\bnull pointer\b|\bnullpointerexception\b/i,
];

function looksLikeStackTrace(text: string): boolean {
    return STACK_TRACE_PATTERNS.some(re => re.test(text));
}

/** Extract a short fingerprint from a trace to deduplicate notifications. */
function errorSignature(trace: string): string {
    // Take the first Error/Exception line + first code frame
    const lines = trace.split('\n').filter(Boolean);
    const errorLine = lines.find(l => /error:|exception:|panicked/i.test(l)) || lines[0] || '';
    const frameLine = lines.find(l => /at |File "|\.py:|\.ts:|\.js:/.test(l)) || '';
    return `${errorLine.trim().slice(0, 120)}|${frameLine.trim().slice(0, 80)}`.toLowerCase();
}

// ─── OS notification ─────────────────────────────────────────────────────────

function sendOsNotification(title: string, body: string): void {
    const os = platform();
    try {
        if (os === 'linux') {
            execFile('notify-send', ['-t', '8000', title, body], { timeout: 3000 }, () => {});
        } else if (os === 'darwin') {
            // Escape backslashes before quotes so trailing backslashes can't subvert the quote.
            const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
            execFile('osascript', ['-e', script], { timeout: 3000 }, () => {});
        } else if (os === 'win32') {
            const safeTitle = title.replace(/[`$"\\]/g, '').slice(0, 100);
            const safeBody = body.replace(/[`$"\\]/g, '').slice(0, 200);
            const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${safeTitle.replace(/'/g, "''")}')) | Out-Null; $xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('${safeBody.replace(/'/g, "''")}')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OCD').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 5000 }, () => {});
        }
    } catch { /* notification failure is non-critical */ }
}

// ─── Vector similarity search ─────────────────────────────────────────────────

async function findSimilarSolution(trace: string): Promise<{ session_id: string; similarity: number; title: string; tldr: string } | null> {
    const db = getDb();
    const rows = db.prepare('SELECT session_id, embedding FROM session_embeddings ORDER BY created_at DESC LIMIT 1000').all() as any[];
    if (!rows.length) return null;

    let queryVec: number[];
    try {
        queryVec = await embedText(trace.slice(0, 2048));
    } catch {
        return null;
    }

    let best: { session_id: string; similarity: number } | null = null;
    for (const row of rows) {
        try {
            const stored = JSON.parse(row.embedding) as number[];
            const sim = cosineSimilarity(queryVec, stored);
            if (sim >= SIMILARITY_THRESHOLD && (!best || sim > best.similarity)) {
                best = { session_id: row.session_id, similarity: sim };
            }
        } catch { /* skip malformed */ }
    }

    if (!best) return null;

    const session = db.prepare('SELECT title, tldr FROM sessions WHERE id = ?').get(best.session_id) as any;
    return {
        session_id: best.session_id,
        similarity: best.similarity,
        title: session?.title || 'Unknown session',
        tldr: session?.tldr || '',
    };
}

// ─── Interception handler ─────────────────────────────────────────────────────

type BroadcastFn = (event: string, payload: Record<string, unknown>) => void;

let broadcastFn: BroadcastFn | null = null;
export function registerBroadcast(fn: BroadcastFn) { broadcastFn = fn; }

const recentSignatures = new Set<string>();

async function handleNewContent(content: string) {
    if (!looksLikeStackTrace(content)) return;

    const trace = content.slice(-MAX_TRACE_CHARS);
    const sig = errorSignature(trace);

    // Deduplicate — same error within this process lifetime
    if (recentSignatures.has(sig)) return;
    recentSignatures.add(sig);
    // Auto-clear after 5 minutes so same error re-triggers if it persists
    setTimeout(() => recentSignatures.delete(sig), 5 * 60 * 1000);

    const match = await findSimilarSolution(trace);
    const db = getDb();

    // Log the interception event
    db.prepare(`
        INSERT INTO ide_interceptions (detected_at, raw_trace, error_signature, matched_session_id, similarity, notification_sent)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), trace.slice(0, 2000), sig, match?.session_id ?? null, match?.similarity ?? null, match ? 1 : 0);

    if (!match) return;

    const notifTitle = 'OCD: Similar error found in memory';
    const notifBody = `${(match.similarity * 100).toFixed(0)}% match — ${match.title}. ${match.tldr?.slice(0, 120) || ''}`;

    sendOsNotification(notifTitle, notifBody);

    // MCP notification payload pushed via SSE so IDE extensions get it
    if (broadcastFn) {
        broadcastFn('ide_interception', {
            type: 'proactive_context',
            error_signature: sig,
            matched_session_id: match.session_id,
            similarity: match.similarity,
            title: match.title,
            tldr: match.tldr,
            message: notifBody,
        });
    }

    console.log(`[ide-interceptor] Match found: ${match.session_id} (${(match.similarity * 100).toFixed(0)}%)`);
}

// ─── File tail watcher ────────────────────────────────────────────────────────

function watchLogFile(filePath: string) {
    if (!existsSync(filePath)) return;

    let lastSize = 0;
    try { lastSize = statSync(filePath).size; } catch { return; }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const watcher = watch(filePath, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            try {
                const newSize = statSync(filePath).size;
                if (newSize <= lastSize) return;
                const buf = readFileSync(filePath);
                const newContent = buf.slice(lastSize).toString('utf8');
                lastSize = newSize;
                await handleNewContent(newContent);
            } catch { /* file may have rotated */ }
        }, DEBOUNCE_MS);
    });

    console.log(`[ide-interceptor] Watching: ${filePath}`);
    return watcher;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startIdeInterceptor(broadcast?: BroadcastFn) {
    if (broadcast) broadcastFn = broadcast;

    for (const p of WATCH_PATHS) {
        watchLogFile(p);
    }

    console.log('[ide-interceptor] Proactive IDE interception active.');
    console.log('[ide-interceptor] Pipe terminal output to one of:', WATCH_PATHS.filter(existsSync).join(', ') || WATCH_PATHS[0]);
}

/**
 * Allow external callers (e.g. Fastify route) to manually submit a trace
 * for immediate analysis — useful for LSP diagnostic webhooks or IDE plugins.
 */
export async function submitTrace(trace: string): Promise<{ matched: boolean; session_id?: string; similarity?: number; title?: string; tldr?: string }> {
    await handleNewContent(trace);
    const sig = errorSignature(trace);
    const db = getDb();
    const row = db.prepare(`
        SELECT matched_session_id, similarity FROM ide_interceptions
        WHERE error_signature = ? ORDER BY detected_at DESC LIMIT 1
    `).get(sig) as any;

    if (row?.matched_session_id) {
        const session = db.prepare('SELECT title, tldr FROM sessions WHERE id = ?').get(row.matched_session_id) as any;
        return { matched: true, session_id: row.matched_session_id, similarity: row.similarity, title: session?.title, tldr: session?.tldr };
    }
    return { matched: false };
}
