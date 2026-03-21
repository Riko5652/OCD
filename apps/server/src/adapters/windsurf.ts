// Windsurf adapter — reads Codeium's local SQLite DB
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

/** Extract code metrics from message content */
function extractCodeMetrics(content: string): { linesAdded: number; linesRemoved: number; filesReferenced: string[] } {
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesReferenced: string[] = [];

    // Count lines in code blocks (fenced)
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
        const lines = block.split('\n').slice(1, -1); // strip fences
        linesAdded += lines.length;
    }

    // Detect diff-style additions/removals
    const diffLines = content.split('\n');
    for (const line of diffLines) {
        if (/^\+[^+]/.test(line)) linesAdded++;
        if (/^-[^-]/.test(line)) linesRemoved++;
    }

    // Extract file paths referenced in content
    const filePatterns = content.match(/(?:[\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|cpp|c|h|css|html|json|yaml|yml|toml|sql|md))/g) || [];
    const uniqueFiles = [...new Set(filePatterns)];
    filesReferenced.push(...uniqueFiles.slice(0, 50));

    return { linesAdded, linesRemoved, filesReferenced };
}

/** Detect tool usage from assistant message content */
function detectTools(content: string): string[] {
    const tools: string[] = [];
    if (/\b(created|wrote|writing)\s+(file|to)\b/i.test(content)) tools.push('file-write');
    if (/\b(edited|modified|updated)\s+(file|the file)\b/i.test(content)) tools.push('file-edit');
    if (/\b(ran|running|executed|terminal|command)\b/i.test(content)) tools.push('terminal');
    if (/\b(searched|searching|grep|find|looking for)\b/i.test(content)) tools.push('search');
    if (/\b(read|reading|opened)\s+(file|the file)\b/i.test(content)) tools.push('file-read');
    if (/\b(installed|npm|pip|cargo|brew)\b/i.test(content)) tools.push('package-install');
    if (/\b(debug|breakpoint|stack trace)\b/i.test(content)) tools.push('debug');
    if (/\b(refactor|rename|extract)\b/i.test(content)) tools.push('refactor');
    return [...new Set(tools)];
}

/** Detect errors from message content */
function detectErrors(content: string): number {
    let errors = 0;
    const errorPatterns = [
        /\bError:/i, /\bTraceback\b/i, /\bException\b/i, /\bfailed\b/i,
        /\bsyntax error\b/i, /\bTypeError\b/i, /\bReferenceError\b/i,
        /\bundefined is not\b/i, /\bcannot read\b/i, /\bcommand not found\b/i,
        /\bpermission denied\b/i, /\bEACCES\b/, /\bENOENT\b/,
    ];
    for (const p of errorPatterns) {
        if (p.test(content)) errors++;
    }
    return Math.min(errors, 5); // cap per message
}

export class WindsurfAdapter implements IAiAdapter {
    readonly id: ToolId = 'windsurf';
    readonly name = 'Windsurf';

    private getDb(): ReturnType<typeof Database> | null {
        const dbPath = config.windsurf.dbPath;
        if (!existsSync(dbPath)) return null;
        try {
            return new Database(dbPath, { readonly: true, fileMustExist: true });
        } catch {
            return null;
        }
    }

    async getSessions(): Promise<UnifiedSession[]> {
        const db = this.getDb();
        if (!db) return [];

        try {
            // Try to get message-level detail if the schema supports it
            const hasMessages = (() => {
                try {
                    db.prepare(`SELECT 1 FROM chat_messages LIMIT 1`).get();
                    return true;
                } catch { return false; }
            })();

            const sessions = db.prepare(`
                SELECT id, title, model, created_at, updated_at,
                       message_count, total_tokens_sent, total_tokens_received
                FROM chat_sessions ORDER BY updated_at DESC LIMIT 500
            `).all() as any[];

            return sessions.map(s => {
                let codeLinesAdded = 0;
                let codeLinesRemoved = 0;
                let filesTouched = 0;
                let errorCount = 0;
                const allTools: Record<string, number> = {};
                const modelsUsed = new Set<string>();
                if (s.model) modelsUsed.add(s.model);

                // Parse individual messages for detailed metrics
                if (hasMessages) {
                    try {
                        const messages = db.prepare(`
                            SELECT role, content, model, created_at
                            FROM chat_messages WHERE session_id = ?
                            ORDER BY created_at ASC
                        `).all(s.id) as any[];

                        for (const msg of messages) {
                            if (msg.model) modelsUsed.add(msg.model);
                            const content = msg.content || '';

                            if (msg.role === 'assistant') {
                                const metrics = extractCodeMetrics(content);
                                codeLinesAdded += metrics.linesAdded;
                                codeLinesRemoved += metrics.linesRemoved;
                                filesTouched += metrics.filesReferenced.length;

                                const tools = detectTools(content);
                                for (const t of tools) allTools[t] = (allTools[t] || 0) + 1;
                            }

                            errorCount += detectErrors(content);
                        }
                    } catch { /* message parsing failed, use session-level data */ }
                }

                const topTools: [string, number][] = Object.entries(allTools)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8);

                const totalInput = s.total_tokens_sent || 0;
                const totalOutput = s.total_tokens_received || 0;

                return {
                    id: `windsurf-${s.id}`,
                    tool_id: 'windsurf' as ToolId,
                    title: s.title || 'Windsurf session',
                    started_at: s.created_at,
                    ended_at: s.updated_at,
                    total_turns: Math.max(1, Math.floor((s.message_count || 0) / 2)),
                    total_input_tokens: totalInput,
                    total_output_tokens: totalOutput,
                    total_cache_read: 0,
                    total_cache_create: 0,
                    primary_model: s.model || 'windsurf-default',
                    models_used: [...modelsUsed].length > 0 ? [...modelsUsed] : [s.model || 'windsurf-default'],
                    code_lines_added: codeLinesAdded,
                    code_lines_removed: codeLinesRemoved,
                    files_touched: filesTouched,
                    error_count: errorCount,
                    top_tools: topTools.length > 0 ? topTools : undefined,
                    raw: {
                        windsurfId: s.id,
                        message_count: s.message_count || 0,
                        has_message_detail: hasMessages,
                    },
                };
            });
        } catch {
            return [];
        } finally {
            if (db.open) db.close();
        }
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const db = this.getDb();
        if (!db) return [];

        const windsurfId = sessionId.replace('windsurf-', '');

        try {
            // Attempt to read individual messages
            const messages = db.prepare(`
                SELECT role, content, model, created_at, tokens_sent, tokens_received
                FROM chat_messages WHERE session_id = ?
                ORDER BY created_at ASC
            `).all(windsurfId) as any[];

            if (messages.length === 0) return [];

            const turns: UnifiedTurn[] = [];
            let prevTs: number | null = null;

            for (const msg of messages) {
                if (msg.role !== 'assistant') {
                    if (msg.created_at) prevTs = msg.created_at;
                    continue;
                }

                const content = msg.content || '';
                const ts = msg.created_at || Date.now();

                const tools = detectTools(content);
                const metrics = extractCodeMetrics(content);
                const errors = detectErrors(content);

                let latencyMs: number | undefined;
                if (prevTs && ts > prevTs) {
                    latencyMs = ts - prevTs;
                }

                const inputTokens = msg.tokens_sent || (content.length > 0 ? Math.round(content.length / 4) : 0);
                const outputTokens = msg.tokens_received || Math.round(content.length / 4);

                turns.push({
                    session_id: sessionId,
                    timestamp: ts,
                    model: msg.model || undefined,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_read: 0,
                    cache_create: 0,
                    latency_ms: latencyMs,
                    tools_used: tools,
                    label: content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n+/g, ' ').trim().slice(0, 100) || undefined,
                    type: 2,
                });

                prevTs = ts;
            }
            return turns;
        } catch {
            return [];
        } finally {
            if (db.open) db.close();
        }
    }
}
