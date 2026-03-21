// GitHub Copilot adapter — reads VS Code extension telemetry + Copilot Chat history
import Database from 'better-sqlite3';
import { join } from 'path';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ChatTurn {
    role: string;
    content?: string;
    text?: string;
    model?: string;
    type?: string;
    author?: string;
    // Extended fields for deeper parsing
    toolCalls?: Array<{ name: string; result?: string }>;
    references?: Array<{ uri?: string; path?: string }>;
}

/** Extract code metrics from chat message content */
function extractCodeMetrics(content: string): { linesAdded: number; linesRemoved: number; filesReferenced: string[] } {
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesReferenced: string[] = [];

    // Count lines in code blocks
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
        const lines = block.split('\n').slice(1, -1);
        linesAdded += lines.length;
    }

    // Detect diff-style content
    for (const line of content.split('\n')) {
        if (/^\+[^+]/.test(line)) linesAdded++;
        if (/^-[^-]/.test(line)) linesRemoved++;
    }

    // Extract file paths
    const filePaths = content.match(/(?:[\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|cpp|c|h|css|html|json|yaml|yml|toml|sql|md))/g) || [];
    filesReferenced.push(...[...new Set(filePaths)].slice(0, 50));

    return { linesAdded, linesRemoved, filesReferenced };
}

/** Detect tool/agent usage from message */
function detectTools(msg: ChatTurn): string[] {
    const tools: string[] = [];
    const content = msg.content || msg.text || '';

    // Check explicit tool calls
    if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) tools.push(tc.name);
    }

    // Check file references
    if (msg.references?.length) {
        tools.push('file-reference');
    }

    // Detect from content patterns
    if (msg.role === 'assistant') {
        if (/\b(created|wrote|writing)\s+(file|to)\b/i.test(content)) tools.push('file-write');
        if (/\b(edited|modified|updated)\b/i.test(content)) tools.push('file-edit');
        if (/\b(ran|running|executed|terminal)\b/i.test(content)) tools.push('terminal');
        if (/\b(searched|searching)\b/i.test(content)) tools.push('search');
        if (/\b(fix|fixed|fixing)\b/i.test(content)) tools.push('fix');
        if (/\b(explain|explained)\b/i.test(content)) tools.push('explain');
        if (/\b(test|tested|testing)\b/i.test(content)) tools.push('test');
    }

    // Detect slash commands from user messages
    if (msg.role === 'user') {
        if (/^\/fix\b/.test(content)) tools.push('slash:fix');
        if (/^\/explain\b/.test(content)) tools.push('slash:explain');
        if (/^\/tests?\b/.test(content)) tools.push('slash:test');
        if (/^\/doc\b/.test(content)) tools.push('slash:doc');
        if (/^\/workspace\b/.test(content)) tools.push('slash:workspace');
        if (/^@workspace\b/.test(content)) tools.push('agent:workspace');
        if (/^@terminal\b/.test(content)) tools.push('agent:terminal');
        if (/^@vscode\b/.test(content)) tools.push('agent:vscode');
    }

    return [...new Set(tools)];
}

/** Detect errors in content */
function detectErrors(content: string): number {
    let count = 0;
    const patterns = [
        /\bError:/i, /\bTraceback\b/i, /\bException\b/i,
        /\bfailed\b/i, /\bsyntax error\b/i, /\bTypeError\b/i,
        /\bReferenceError\b/i, /\bundefined is not\b/i, /\bcannot read\b/i,
    ];
    for (const p of patterns) {
        if (p.test(content)) count++;
    }
    return Math.min(count, 5);
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

                    // Extract code metrics across all assistant messages
                    let totalLinesAdded = 0;
                    let totalLinesRemoved = 0;
                    const allFiles = new Set<string>();
                    let errorCount = 0;
                    const toolCounts: Record<string, number> = {};
                    const modelsUsed = new Set<string>();
                    if (model) modelsUsed.add(model);

                    for (const msg of messages) {
                        const content = msg.content || msg.text || '';
                        if (msg.model) modelsUsed.add(msg.model);

                        if (msg.role === 'assistant' || msg.type === 'assistant' || msg.author === 'assistant') {
                            const metrics = extractCodeMetrics(content);
                            totalLinesAdded += metrics.linesAdded;
                            totalLinesRemoved += metrics.linesRemoved;
                            for (const f of metrics.filesReferenced) allFiles.add(f);
                        }

                        errorCount += detectErrors(content);

                        const tools = detectTools(msg);
                        for (const t of tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
                    }

                    const topTools: [string, number][] = Object.entries(toolCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 8);

                    // Detect conversation type (slash command, agent, regular)
                    const slashCommands = Object.keys(toolCounts).filter(k => k.startsWith('slash:'));
                    const agents = Object.keys(toolCounts).filter(k => k.startsWith('agent:'));

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
                        models_used: [...modelsUsed],
                        code_lines_added: totalLinesAdded,
                        code_lines_removed: totalLinesRemoved,
                        files_touched: allFiles.size,
                        error_count: errorCount,
                        top_tools: topTools.length > 0 ? topTools : undefined,
                        raw: {
                            source: 'copilot-chat',
                            messageCount: messages.length,
                            slashCommands,
                            agents,
                            hasFileReferences: allFiles.size > 0,
                        },
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
                    SUM(CASE WHEN event = 'ghostTextRejected' THEN 1 ELSE 0 END) as rejected,
                    model_id,
                    SUM(CASE WHEN language IS NOT NULL THEN 1 ELSE 0 END) as lang_count
                FROM copilot_telemetry
                GROUP BY day, model_id
                ORDER BY day DESC LIMIT 180
            `).all() as any[];

            // Also try to get per-language stats for inline suggestions
            let langStats: any[] = [];
            try {
                langStats = telDb.prepare(`
                    SELECT language, COUNT(*) as total,
                        SUM(CASE WHEN event = 'ghostTextAccepted' THEN 1 ELSE 0 END) as accepted
                    FROM copilot_telemetry
                    WHERE timestamp > ?
                    GROUP BY language ORDER BY total DESC LIMIT 10
                `).all(Date.now() - 30 * 86400000) as any[];
            } catch { /* column may not exist */ }

            for (const r of rows) {
                const ts = new Date(r.day).getTime();
                const acceptRate = r.shown > 0 ? (r.accepted / r.shown) * 100 : 0;
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
                    code_lines_added: r.accepted || 0, // each acceptance ~= 1+ lines
                    code_lines_removed: 0,
                    files_touched: 0,
                    error_count: 0,
                    raw: {
                        source: 'telemetry',
                        shown: r.shown,
                        accepted: r.accepted,
                        rejected: r.rejected || 0,
                        suggestion_acceptance_pct: Math.round(acceptRate * 10) / 10,
                        language_stats: langStats.length > 0 ? langStats : undefined,
                    },
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

        const turns: UnifiedTurn[] = [];
        let prevTs: number | null = null;

        for (let i = 0; i < session._chatTurns.length; i++) {
            const m = session._chatTurns[i];
            const content = m.content || m.text || '';
            const isAssistant = m.role === 'assistant' || m.type === 'assistant' || m.author === 'assistant';
            const ts = session.started_at + i * 1000;

            if (!isAssistant) {
                prevTs = ts;
                continue;
            }

            const tools = detectTools(m);
            const metrics = extractCodeMetrics(content);

            let latencyMs: number | undefined;
            if (prevTs) latencyMs = ts - prevTs;

            turns.push({
                session_id: sessionId,
                timestamp: ts,
                model: m.model || session.primary_model,
                input_tokens: 0,
                output_tokens: Math.round(content.length / 4),
                cache_read: 0,
                cache_create: 0,
                latency_ms: latencyMs,
                tools_used: tools,
                label: content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n+/g, ' ').trim().slice(0, 120) || undefined,
                type: 2,
            });

            prevTs = ts;
        }

        return turns;
    }
}
