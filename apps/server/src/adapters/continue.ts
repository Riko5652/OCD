// Continue.dev adapter — reads ~/.continue/sessions/*.json
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ContinueHistoryEntry {
    role: string;
    content?: string;
    model?: string;
}

function parseContinueSession(filePath: string): UnifiedSession | null {
    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        const history: ContinueHistoryEntry[] = raw.history || [];
        const userMessages = history.filter(h => h.role === 'user');
        const model = history.find(h => h.model)?.model || 'unknown';

        let inputTokens = 0, outputTokens = 0;
        for (const msg of history) {
            if (msg.role === 'user') inputTokens += (msg.content || '').length / 4;
            if (msg.role === 'assistant') outputTokens += (msg.content || '').length / 4;
        }

        const stat = statSync(filePath);
        const fileBasename = basename(filePath, '.json');

        return {
            id: `continue-${fileBasename}`,
            tool_id: 'continue',
            title: raw.title || fileBasename,
            started_at: raw.dateCreated ? new Date(raw.dateCreated).getTime() : stat.birthtimeMs,
            ended_at: raw.dateUpdated ? new Date(raw.dateUpdated).getTime() : stat.mtimeMs,
            total_turns: userMessages.length,
            total_input_tokens: Math.round(inputTokens),
            total_output_tokens: Math.round(outputTokens),
            total_cache_read: 0,
            total_cache_create: 0,
            primary_model: model,
            models_used: [model],
            code_lines_added: 0,
            code_lines_removed: 0,
            files_touched: 0,
            error_count: 0,
            raw: { sessionId: raw.sessionId, continueFile: filePath },
        };
    } catch { return null; }
}

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
            if (parsed && parsed.total_turns > 0) sessions.push(parsed);
        }
        return sessions;
    }

    async getTurns(_sessionId: string): Promise<UnifiedTurn[]> {
        return [];
    }
}
