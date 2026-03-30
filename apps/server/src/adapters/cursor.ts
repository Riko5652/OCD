import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn, CommitScore, AiFile } from './types.js';

interface CursorStateDb {
    key: string;
    value: string;
}

/** Extract a clean label from raw bubble text */
function extractLabel(text: string): string {
    if (!text) return '';
    return text
        .replace(/```[\s\S]*?```/g, '[code]')  // collapse code blocks
        .replace(/`[^`]+`/g, '[code]')           // inline code
        .replace(/\*\*([^*]+)\*\*/g, '$1')       // bold
        .replace(/\n+/g, ' ')
        .trim()
        .slice(0, 100);
}

/** Infer a project name from file paths edited in a session */
function inferProjectFromPaths(paths: string[]): string | null {
    if (paths.length === 0) return null;

    // Normalize separators
    const normalized = paths.map(p => p.replace(/\\/g, '/'));

    // Count how often each directory segment appears at various depths
    const segCounts: Record<string, number> = {};
    for (const p of normalized) {
        const parts = p.split('/');
        // Track the repo-level segment (depth 1 or 2 from drive root)
        for (let d = Math.max(0, parts.length - 4); d < parts.length - 1; d++) {
            const seg = parts[d];
            if (!seg || seg.length < 2 || seg === 'src' || seg === 'lib' || seg === 'app' || seg === 'dist' || seg === 'node_modules') continue;
            segCounts[seg] = (segCounts[seg] || 0) + 1;
        }
    }

    const top = Object.entries(segCounts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
}

export class CursorAdapter implements IAiAdapter {
    readonly id: ToolId = 'cursor';
    readonly name = 'Cursor';

    private stateDbPath = process.platform === 'win32'
        ? join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
        : process.platform === 'darwin'
            ? join(process.env.HOME || '', 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
            : join(process.env.HOME || '', '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

    private getStateDb(): ReturnType<typeof Database> | null {
        if (!existsSync(this.stateDbPath)) return null;
        try {
            return new Database(this.stateDbPath, { readonly: true, fileMustExist: true });
        } catch (e) {
            console.error('[cursor] Failed to open state.vscdb', e);
            return null;
        }
    }

    async getSessions(): Promise<UnifiedSession[]> {
        const db = this.getStateDb();
        if (!db) return [];

        const sessions: UnifiedSession[] = [];
        try {
            const rows = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 5000`).all() as CursorStateDb[];

            for (const row of rows) {
                try {
                    const composerId = row.key.replace('composerData:', '');
                    const data = JSON.parse(row.value);
                    const headers: any[] = data.fullConversationHeadersOnly || data.allConversationHeaders || [];

                    let userTurns = 0;
                    let assistantTurns = 0;
                    const filePaths: string[] = [];
                    let firstUserText = '';
                    let bubbleInputTokens = 0;
                    let bubbleOutputTokens = 0;
                    const modelsUsed = new Set<string>();

                    for (const h of headers) {
                        if (h.type === 1) {
                            userTurns++;
                            if (!firstUserText && h.text) firstUserText = extractLabel(h.text);
                            // Estimate input tokens from user message text
                            if (h.text) bubbleInputTokens += Math.round(h.text.length / 4);
                        }
                        if (h.type === 2) assistantTurns++;

                        // Collect file paths and token counts from bubble
                        if (h.bubbleId) {
                            try {
                                const bRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${composerId}:${h.bubbleId}`) as CursorStateDb | undefined;
                                if (bRow) {
                                    const bubble = JSON.parse(bRow.value);
                                    // Collect file paths from various bubble fields
                                    const bPaths: string[] = [
                                        ...(bubble.codeBlocks || []).map((b: any) => b.filepath || b.path || '').filter(Boolean),
                                        ...(bubble.edits || []).map((e: any) => e.filepath || e.path || '').filter(Boolean),
                                        ...(bubble['composer-done'] || []).map((e: any) => e.filepath || e.path || '').filter(Boolean),
                                    ];
                                    filePaths.push(...bPaths);

                                    // Aggregate token counts from bubbles
                                    const tc = bubble.tokenCount || {};
                                    const bInput = tc.inputTokens || bubble.inputTokenCount || bubble.promptTokens || 0;
                                    const bOutput = tc.outputTokens || bubble.outputTokenCount || bubble.completionTokens ||
                                        (bubble.text?.length ? Math.round(bubble.text.length / 4) : 0);
                                    bubbleInputTokens += bInput;
                                    bubbleOutputTokens += bOutput;

                                    // Track model per bubble if available
                                    if (bubble.modelSlug || bubble.model) modelsUsed.add(bubble.modelSlug || bubble.model);
                                }
                            } catch { /* skip */ }
                        }
                    }

                    const model = data.modelSlug || data.model || data.modelConfig?.modelName || data.modelConfig?.modelSlug || 'unknown';
                    modelsUsed.add(model);
                    const projectName = inferProjectFromPaths(filePaths);

                    // Use session-level estimates if available, fall back to bubble aggregation,
                    // then estimate from turn counts as last resort
                    const inputTokens = data.estimatedInput || bubbleInputTokens || (userTurns * 2000);
                    const outputTokens = data.estimatedOutput || bubbleOutputTokens || (assistantTurns * 1500);

                    const session: UnifiedSession = {
                        id: `cur-${composerId}`,
                        tool_id: this.id,
                        title: firstUserText || projectName || undefined,
                        started_at: data.createdAt || Date.now(),
                        total_turns: Math.max(userTurns + assistantTurns, 1),
                        total_input_tokens: inputTokens,
                        total_output_tokens: outputTokens,
                        total_cache_read: 0,
                        total_cache_create: 0,
                        error_count: 0,
                        files_touched: filePaths.length,
                        primary_model: model,
                        models_used: [...modelsUsed],
                        code_lines_added: data.totalLinesAdded || 0,
                        code_lines_removed: data.totalLinesRemoved || 0,
                        raw: {
                            mode: 'composer',
                            project: projectName,
                            capabilities: data.capabilities || [],
                        },
                    };
                    sessions.push(session);
                } catch { /* skip unparseable */ }
            }
        } finally {
            if (db.open) db.close();
        }

        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const composerId = sessionId.replace('cur-', '');
        const db = this.getStateDb();
        if (!db) return [];

        const turns: UnifiedTurn[] = [];
        try {
            const row = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`).get(`composerData:${composerId}`) as CursorStateDb | undefined;
            if (!row) return [];
            const data = JSON.parse(row.value);
            const headers: any[] = data.fullConversationHeadersOnly || data.allConversationHeaders || [];

            for (const h of headers) {
                if (h.type !== 2) continue; // assistant turns only

                let inputTokens = 0;
                let outputTokens = 0;
                let latencyMs: number | null = null;
                let toolsUsed: string[] = [];
                let label = extractLabel(h.text || h.summary || '');

                if (h.bubbleId) {
                    const bubbleRow = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`).get(`bubbleId:${composerId}:${h.bubbleId}`) as CursorStateDb | undefined;
                    if (bubbleRow) {
                        try {
                            const bubble = JSON.parse(bubbleRow.value);
                            // Cursor stores tokens in tokenCount.inputTokens / tokenCount.outputTokens
                            const tc = bubble.tokenCount || {};
                            inputTokens = tc.inputTokens || bubble.inputTokenCount || bubble.promptTokens || 0;
                            outputTokens = tc.outputTokens || bubble.outputTokenCount || bubble.completionTokens ||
                                (bubble.text?.length ? Math.round(bubble.text.length / 4) : 0);
                            latencyMs = bubble.timingMs || bubble.latencyMs || null;
                            toolsUsed = [
                                ...(bubble.toolResults || []).map((t: any) => t.toolName || t.name),
                                ...(bubble['composer-done']?.length ? ['code-edit'] : []),
                            ].filter(Boolean);

                            // Extract label from bubble text if header had none
                            if (!label && bubble.text) {
                                label = extractLabel(bubble.text);
                            }
                            // Try richText field
                            if (!label && bubble.richText) {
                                const rt = Array.isArray(bubble.richText) ? bubble.richText : [];
                                const textNode = rt.find((n: any) => n.text);
                                if (textNode?.text) label = extractLabel(textNode.text);
                            }
                        } catch { /* skip */ }
                    }
                }

                turns.push({
                    session_id: sessionId,
                    timestamp: h.createdAt || h.timestamp || Date.now(),
                    model: data.modelSlug || data.model || 'unknown',
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_read: 0,
                    cache_create: 0,
                    latency_ms: latencyMs ?? undefined,
                    tools_used: toolsUsed,
                    label: label || undefined,
                    type: h.type,
                });
            }
        } finally {
            if (db.open) db.close();
        }
        return turns;
    }
}
