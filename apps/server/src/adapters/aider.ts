// Aider adapter — parses .aider.chat.history.md files
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ParsedAiderHistory {
    turns: { role: string; content: string }[];
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    filesEdited: string[];
}

function parseAiderHistory(filePath: string): ParsedAiderHistory | null {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { return null; }

    const turns: { role: string; content: string }[] = [];
    const filesEdited = new Set<string>();
    let model = 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let currentRole: string | null = null;
    let currentLines: string[] = [];

    for (const line of content.split('\n')) {
        if (line.startsWith('#### ')) {
            if (currentLines.length && currentRole) turns.push({ role: currentRole, content: currentLines.join('\n').trim() });
            currentRole = 'user';
            currentLines = [line.slice(5).trim()];
        } else if (line.startsWith('# aider: edited ')) {
            filesEdited.add(line.replace('# aider: edited ', '').trim());
        } else if (/^Model: (.+)/.test(line)) {
            model = line.match(/^Model: (.+)/)![1].trim();
        } else if (/Tokens: (\d+) sent, (\d+) received/.test(line)) {
            const m = line.match(/Tokens: (\d+) sent, (\d+) received/)!;
            inputTokens += parseInt(m[1]); outputTokens += parseInt(m[2]);
        } else if (/Cost: \$([0-9.]+)/.test(line)) {
            cost += parseFloat(line.match(/Cost: \$([0-9.]+)/)![1]);
        } else if (currentRole && line.trim()) {
            if (currentRole === 'user' && line === '---') { currentRole = 'assistant'; currentLines = []; }
            else currentLines.push(line);
        }
    }
    if (currentLines.length && currentRole) turns.push({ role: currentRole, content: currentLines.join('\n').trim() });

    return { turns: turns.filter(t => t.content), model, inputTokens, outputTokens, cost, filesEdited: [...filesEdited] };
}

function scanForHistoryFiles(dir: string, results: string[] = []): string[] {
    if (!existsSync(dir)) return results;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.git') && !entry.name.includes('node_modules')) {
                scanForHistoryFiles(full, results);
            } else if (entry.name === '.aider.chat.history.md') {
                results.push(full);
            }
        }
    } catch { /* skip */ }
    return results;
}

export class AiderAdapter implements IAiAdapter {
    readonly id: ToolId = 'aider';
    readonly name = 'Aider';

    async getSessions(): Promise<UnifiedSession[]> {
        const home = homedir();
        const searchDirs = [
            process.cwd(),
            join(home, 'Projects'),
            join(home, 'projects'),
            join(home, 'dev'),
            join(home, 'code'),
            join(home, 'Documents'),
        ].filter(existsSync);

        const historyFiles: string[] = [];
        for (const dir of searchDirs) scanForHistoryFiles(dir, historyFiles);

        const sessions: UnifiedSession[] = [];
        for (const filePath of historyFiles) {
            try {
                const stat = statSync(filePath);
                const parsed = parseAiderHistory(filePath);
                if (!parsed || !parsed.turns.length) continue;

                const userTurns = parsed.turns.filter(t => t.role === 'user');
                const id = `aider-${Buffer.from(filePath).toString('base64url').slice(0, 20)}-${stat.mtimeMs.toFixed(0)}`;

                sessions.push({
                    id,
                    tool_id: 'aider',
                    title: basename(dirname(filePath)),
                    started_at: stat.birthtimeMs || stat.mtimeMs - userTurns.length * 30000,
                    ended_at: stat.mtimeMs,
                    total_turns: userTurns.length,
                    total_input_tokens: parsed.inputTokens,
                    total_output_tokens: parsed.outputTokens,
                    total_cache_read: 0,
                    total_cache_create: 0,
                    primary_model: parsed.model,
                    models_used: [parsed.model],
                    code_lines_added: 0,
                    code_lines_removed: 0,
                    files_touched: parsed.filesEdited.length,
                    error_count: 0,
                    raw: { filesEdited: parsed.filesEdited, cost: parsed.cost, historyFile: filePath },
                });
            } catch { /* skip */ }
        }
        return sessions;
    }

    async getTurns(_sessionId: string): Promise<UnifiedTurn[]> {
        return [];
    }
}
