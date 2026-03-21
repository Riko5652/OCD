// Continue.dev adapter — reads ~/.continue/sessions/*.json
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ContinueHistoryEntry {
    role: string;
    content?: string;
    model?: string;
    // Continue.dev also supports tool_calls, context items, etc.
    toolCalls?: Array<{ name: string; args?: any }>;
    contextItems?: Array<{ name: string; description?: string; content?: string }>;
}

/** Extract code metrics from message content */
function extractCodeMetrics(content: string): { linesAdded: number; filesReferenced: string[] } {
    let linesAdded = 0;
    const filesReferenced: string[] = [];

    // Count code block lines
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
        linesAdded += block.split('\n').slice(1, -1).length;
    }

    // Extract file paths
    const filePaths = content.match(/(?:[\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|cpp|c|h|css|html|json|yaml|yml|toml|sql|md))/g) || [];
    filesReferenced.push(...[...new Set(filePaths)].slice(0, 50));

    return { linesAdded, filesReferenced };
}

/** Detect slash commands and tool usage from content */
function detectToolsFromContent(entry: ContinueHistoryEntry): string[] {
    const tools: string[] = [];
    const content = entry.content || '';

    // Check explicit tool calls
    if (entry.toolCalls?.length) {
        for (const tc of entry.toolCalls) {
            tools.push(tc.name);
        }
    }

    // Check context items (files, URLs, etc.)
    if (entry.contextItems?.length) {
        for (const ci of entry.contextItems) {
            if (ci.name) tools.push(`context:${ci.name}`);
        }
    }

    // Detect slash commands
    if (/^\/edit\b/.test(content)) tools.push('slash:edit');
    if (/^\/comment\b/.test(content)) tools.push('slash:comment');
    if (/^\/share\b/.test(content)) tools.push('slash:share');
    if (/^\/cmd\b/.test(content)) tools.push('slash:cmd');
    if (/^\/test\b/.test(content)) tools.push('slash:test');

    // Detect actions from assistant content
    if (entry.role === 'assistant') {
        if (/\b(created|wrote|writing)\s+(file|to)\b/i.test(content)) tools.push('file-write');
        if (/\b(edited|modified|updated)\b/i.test(content)) tools.push('file-edit');
        if (/\b(ran|running|executed|terminal)\b/i.test(content)) tools.push('terminal');
        if (/\b(searched|searching|grep|find)\b/i.test(content)) tools.push('search');
    }

    return [...new Set(tools)];
}

/** Detect errors in content */
function detectErrors(content: string): number {
    let count = 0;
    const patterns = [
        /\bError:/i, /\bTraceback\b/i, /\bException\b/i,
        /\bfailed\b/i, /\bsyntax error\b/i, /\bTypeError\b/i,
        /\bReferenceError\b/i, /\bundefined is not\b/i,
    ];
    for (const p of patterns) {
        if (p.test(content)) count++;
    }
    return Math.min(count, 5);
}

interface ParsedContinueSession {
    session: UnifiedSession;
    turns: UnifiedTurn[];
}

function parseContinueSession(filePath: string): ParsedContinueSession | null {
    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        const history: ContinueHistoryEntry[] = raw.history || [];
        const userMessages = history.filter(h => h.role === 'user');
        const assistantMessages = history.filter(h => h.role === 'assistant');

        if (userMessages.length === 0) return null;

        // Collect all models used
        const modelsUsed = new Set<string>();
        for (const msg of history) {
            if (msg.model) modelsUsed.add(msg.model);
        }
        const primaryModel = history.find(h => h.model)?.model || 'unknown';

        // Token estimation with better heuristics
        let totalInput = 0;
        let totalOutput = 0;
        for (const msg of history) {
            const charCount = (msg.content || '').length;
            if (msg.role === 'user') {
                // Context items inflate input tokens
                const contextBoost = (msg.contextItems || []).reduce((s, ci) => s + ((ci.content || '').length / 4), 0);
                totalInput += Math.round(charCount / 4) + contextBoost;
            }
            if (msg.role === 'assistant') {
                totalOutput += Math.round(charCount / 4);
            }
        }

        // Code metrics from assistant messages
        let totalLinesAdded = 0;
        const allFiles = new Set<string>();
        let totalErrors = 0;
        const toolCounts: Record<string, number> = {};

        for (const msg of history) {
            const content = msg.content || '';

            if (msg.role === 'assistant') {
                const metrics = extractCodeMetrics(content);
                totalLinesAdded += metrics.linesAdded;
                for (const f of metrics.filesReferenced) allFiles.add(f);
            }

            totalErrors += detectErrors(content);

            const tools = detectToolsFromContent(msg);
            for (const t of tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
        }

        const topTools: [string, number][] = Object.entries(toolCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8);

        const stat = statSync(filePath);
        const fileBasename = basename(filePath, '.json');

        // Build turns
        const turns: UnifiedTurn[] = [];
        let prevTs: number | null = null;
        const baseTs = raw.dateCreated ? new Date(raw.dateCreated).getTime() : stat.birthtimeMs;

        for (let i = 0; i < history.length; i++) {
            const msg = history[i];
            if (msg.role !== 'assistant') continue;

            const content = msg.content || '';
            // Estimate timestamp from position
            const ts = baseTs + (i * 30_000); // ~30s per message estimate
            const tools = detectToolsFromContent(msg);

            let latencyMs: number | undefined;
            if (prevTs) latencyMs = ts - prevTs;

            turns.push({
                session_id: `continue-${fileBasename}`,
                timestamp: ts,
                model: msg.model || primaryModel,
                input_tokens: 0, // input is context, hard to attribute per-turn
                output_tokens: Math.round(content.length / 4),
                cache_read: 0,
                cache_create: 0,
                latency_ms: latencyMs,
                tools_used: tools,
                label: content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n+/g, ' ').trim().slice(0, 100) || undefined,
                type: 2,
            });

            prevTs = ts;
        }

        const session: UnifiedSession = {
            id: `continue-${fileBasename}`,
            tool_id: 'continue',
            title: raw.title || fileBasename,
            started_at: raw.dateCreated ? new Date(raw.dateCreated).getTime() : stat.birthtimeMs,
            ended_at: raw.dateUpdated ? new Date(raw.dateUpdated).getTime() : stat.mtimeMs,
            total_turns: userMessages.length,
            total_input_tokens: Math.round(totalInput),
            total_output_tokens: Math.round(totalOutput),
            total_cache_read: 0,
            total_cache_create: 0,
            primary_model: primaryModel,
            models_used: [...modelsUsed].length > 0 ? [...modelsUsed] : [primaryModel],
            code_lines_added: totalLinesAdded,
            code_lines_removed: 0,
            files_touched: allFiles.size,
            error_count: totalErrors,
            top_tools: topTools.length > 0 ? topTools : undefined,
            raw: {
                sessionId: raw.sessionId,
                continueFile: filePath,
                hasContextItems: history.some(h => (h.contextItems || []).length > 0),
                hasToolCalls: history.some(h => (h.toolCalls || []).length > 0),
                slashCommandsUsed: Object.keys(toolCounts).filter(k => k.startsWith('slash:')),
            },
        };

        return { session, turns };
    } catch { return null; }
}

// Turn cache for getTurns lookups
const turnCache = new Map<string, UnifiedTurn[]>();

export class ContinueAdapter implements IAiAdapter {
    readonly id: ToolId = 'continue';
    readonly name = 'Continue.dev';

    async getSessions(): Promise<UnifiedSession[]> {
        const dir = config.continueDev.sessionsDir;
        if (!existsSync(dir)) return [];

        const sessions: UnifiedSession[] = [];
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json')) continue;
            const parsed = parseContinueSession(join(dir, file));
            if (parsed && parsed.session.total_turns > 0) {
                sessions.push(parsed.session);
                turnCache.set(parsed.session.id, parsed.turns);
            }
        }
        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        // Check cache first
        const cached = turnCache.get(sessionId);
        if (cached) return cached;

        // Re-parse from file
        const dir = config.continueDev.sessionsDir;
        if (!existsSync(dir)) return [];

        const fileBasename = sessionId.replace('continue-', '');
        const filePath = join(dir, `${fileBasename}.json`);
        if (!existsSync(filePath)) return [];

        const parsed = parseContinueSession(filePath);
        if (!parsed) return [];

        turnCache.set(sessionId, parsed.turns);
        return parsed.turns;
    }
}
