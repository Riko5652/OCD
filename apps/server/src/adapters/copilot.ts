// GitHub Copilot adapter — reads VS Code extension telemetry + Copilot Chat history
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ChatTurn {
    role: string;
    content?: string;
    text?: string;
    model?: string;
    type?: string;
    author?: string;
}

function getChatSessions(vsStoragePath: string): (UnifiedSession & { _chatTurns?: ChatTurn[] })[] {
    const chatDbPath = join(vsStoragePath, 'github.copilot-chat', 'state.vscdb');
    const sessions: (UnifiedSession & { _chatTurns?: ChatTurn[] })[] = [];
    let chatDb: ReturnType<typeof Database> | null = null;

    try {
        chatDb = new Database(chatDbPath, { readonly: true, fileMustExist: true });

        const rows = chatDb.prepare(`
            SELECT key, value FROM ItemTable
            WHERE key LIKE 'copilot-chat-%' OR key LIKE 'chat.panel.%'
        `).all() as { key: string; value: string }[];

        for (const row of rows) {
            try {
                const data = JSON.parse(row.value);
                const conversations = Array.isArray(data) ? data : data?.conversations || data?.threads || [data];

                for (const conv of conversations) {
                    if (!conv || (!conv.turns && !conv.messages && !conv.exchanges)) continue;
                    const messages: ChatTurn[] = conv.turns || conv.messages || conv.exchanges || [];
                    if (messages.length === 0) continue;

                    const id = `copilot-chat-${conv.id || conv.conversationId || row.key}-${messages.length}`;
                    const userMsgs = messages.filter(m => m.role === 'user' || m.type === 'user' || m.author === 'user');
                    const assistantMsgs = messages.filter(m => m.role === 'assistant' || m.type === 'assistant' || m.author === 'assistant');

                    const title = conv.title || conv.name || (userMsgs[0]?.content || userMsgs[0]?.text || '').slice(0, 80) || 'Copilot Chat';
                    const startTs = conv.createdAt || conv.timestamp || conv.created || Date.now();
                    const endTs = conv.updatedAt || conv.lastModified || startTs;

                    const totalInput = userMsgs.reduce((s, m) => s + ((m.content || m.text || '').length / 4), 0);
                    const totalOutput = assistantMsgs.reduce((s, m) => s + ((m.content || m.text || '').length / 4), 0);
                    const model = conv.model || conv.agentId || messages.find(m => m.model)?.model || 'copilot-chat';

                    sessions.push({
                        id,
                        tool_id: 'copilot',
                        title: `Copilot Chat — ${title}`,
                        started_at: typeof startTs === 'number' ? startTs : new Date(startTs).getTime(),
                        ended_at: typeof endTs === 'number' ? endTs : new Date(endTs).getTime(),
                        total_turns: messages.length,
                        total_input_tokens: Math.round(totalInput),
                        total_output_tokens: Math.round(totalOutput),
                        total_cache_read: 0,
                        total_cache_create: 0,
                        primary_model: model,
                        models_used: [model],
                        code_lines_added: 0,
                        code_lines_removed: 0,
                        files_touched: 0,
                        error_count: 0,
                        raw: { source: 'copilot-chat', messageCount: messages.length },
                        _chatTurns: messages,
                    });
                }
            } catch { /* skip malformed */ }
        }
    } catch { /* Chat DB not available */ } finally {
        chatDb?.close();
    }

    return sessions;
}

export class CopilotAdapter implements IAiAdapter {
    readonly id: ToolId = 'copilot';
    readonly name = 'GitHub Copilot';

    async getSessions(): Promise<UnifiedSession[]> {
        const vsStoragePath = config.copilot.storagePath;
        const telemetryPath = join(vsStoragePath, 'github.copilot', 'telemetry.db');
        const sessions: UnifiedSession[] = [];

        // 1. Telemetry DB — suggestion acceptance stats
        let telDb: ReturnType<typeof Database> | null = null;
        try {
            telDb = new Database(telemetryPath, { readonly: true, fileMustExist: true });
            const rows = telDb.prepare(`
                SELECT
                    DATE(timestamp/1000, 'unixepoch') as day,
                    MAX(timestamp) as latest_ts,
                    COUNT(*) as shown,
                    SUM(CASE WHEN event = 'ghostTextAccepted' THEN 1 ELSE 0 END) as accepted,
                    model_id
                FROM copilot_telemetry
                GROUP BY day, model_id
                ORDER BY day DESC LIMIT 180
            `).all() as any[];

            for (const r of rows) {
                const ts = new Date(r.day).getTime();
                sessions.push({
                    id: `copilot-${r.day}-${(r.model_id || 'default').replace(/[^a-z0-9]/gi, '-')}`,
                    tool_id: 'copilot',
                    title: `Copilot inline — ${r.day}`,
                    started_at: ts,
                    ended_at: r.latest_ts || ts + 86400000,
                    total_turns: r.accepted || 0,
                    total_input_tokens: 0,
                    total_output_tokens: 0,
                    total_cache_read: 0,
                    total_cache_create: 0,
                    primary_model: r.model_id || 'github-copilot',
                    models_used: [r.model_id || 'github-copilot'],
                    code_lines_added: 0,
                    code_lines_removed: 0,
                    files_touched: 0,
                    error_count: 0,
                    raw: { shown: r.shown, accepted: r.accepted, suggestion_acceptance_pct: r.shown > 0 ? (r.accepted / r.shown) * 100 : 0 },
                });
            }
        } catch { /* telemetry not available */ } finally {
            telDb?.close();
        }

        // 2. Copilot Chat conversations
        const chatSessions = getChatSessions(vsStoragePath);
        sessions.push(...chatSessions);

        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        if (!sessionId?.startsWith('copilot-chat-')) return [];

        const chatSessions = getChatSessions(config.copilot.storagePath);
        const session = chatSessions.find(s => s.id === sessionId);
        if (!session?._chatTurns) return [];

        return session._chatTurns.map((m, i) => ({
            session_id: sessionId,
            timestamp: session.started_at + i * 1000,
            model: m.model || session.primary_model,
            input_tokens: m.role === 'user' ? Math.round(((m.content || m.text || '').length) / 4) : 0,
            output_tokens: m.role === 'assistant' ? Math.round(((m.content || m.text || '').length) / 4) : 0,
            cache_read: 0,
            cache_create: 0,
            label: (m.content || m.text || '').slice(0, 120),
            type: m.role === 'user' ? 1 : 2,
        }));
    }
}
