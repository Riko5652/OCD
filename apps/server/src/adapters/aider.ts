// Aider adapter — parses .aider.chat.history.md files
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

interface ParsedTurn {
    role: string;
    content: string;
    timestamp: number | null;
    model: string | null;
    linesAdded: number;
    linesRemoved: number;
    filesEdited: string[];
    hasError: boolean;
    editFormat: string | null; // whole, diff, udiff, architect
    tools: string[];
}

interface ParsedAiderHistory {
    turns: ParsedTurn[];
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    filesEdited: string[];
    editFormat: string | null;
    errorCount: number;
}

/** Extract code metrics from edit blocks in aider output */
function extractEditMetrics(content: string): { linesAdded: number; linesRemoved: number; files: string[] } {
    let linesAdded = 0;
    let linesRemoved = 0;
    const files: string[] = [];

    // Search/replace blocks: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
    const searchReplace = content.match(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g) || [];
    for (const block of searchReplace) {
        const parts = block.split('=======');
        if (parts.length === 2) {
            const searchLines = parts[0].split('\n').filter(l => l.trim()).length - 1; // minus header
            const replaceLines = parts[1].split('\n').filter(l => l.trim()).length - 1; // minus footer
            linesRemoved += searchLines;
            linesAdded += replaceLines;
        }
    }

    // Unified diff blocks
    const diffLines = content.split('\n');
    for (const line of diffLines) {
        if (/^\+[^+]/.test(line)) linesAdded++;
        if (/^-[^-]/.test(line)) linesRemoved++;
    }

    // Code blocks (general additions)
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
        linesAdded += block.split('\n').slice(1, -1).length;
    }

    // File path extraction from aider's edit markers
    const fileMarkers = content.match(/^(?:---|\+\+\+|diff --git a\/)(.+?)(?:\s|$)/gm) || [];
    for (const m of fileMarkers) {
        const path = m.replace(/^(?:---|\+\+\+|diff --git a\/)/, '').replace(/\s.*$/, '').trim();
        if (path && path !== '/dev/null') files.push(path);
    }

    return { linesAdded, linesRemoved, files: [...new Set(files)] };
}

/** Detect errors in aider output */
function detectErrors(content: string): boolean {
    const errorPatterns = [
        /\bError:/i, /\bTraceback\b/i, /\bException\b/i,
        /\bfailed\b/i, /\bsyntax error\b/i, /\bTypeError\b/i,
        /\bcan't|cannot\b/i, /\blint error\b/i, /\btest failed\b/i,
        /\bcommand not found\b/i, /\bImportError\b/i, /\bModuleNotFoundError\b/i,
    ];
    return errorPatterns.some(p => p.test(content));
}

/** Detect tools/commands used in aider output */
function detectAiderTools(content: string, role: string): string[] {
    const tools: string[] = [];

    if (role === 'user') {
        if (/^\/run\b/.test(content)) tools.push('cmd:run');
        if (/^\/test\b/.test(content)) tools.push('cmd:test');
        if (/^\/lint\b/.test(content)) tools.push('cmd:lint');
        if (/^\/add\b/.test(content)) tools.push('cmd:add');
        if (/^\/drop\b/.test(content)) tools.push('cmd:drop');
        if (/^\/architect\b/.test(content)) tools.push('cmd:architect');
        if (/^\/ask\b/.test(content)) tools.push('cmd:ask');
        if (/^\/diff\b/.test(content)) tools.push('cmd:diff');
        if (/^\/commit\b/.test(content)) tools.push('cmd:commit');
        if (/^\/undo\b/.test(content)) tools.push('cmd:undo');
        if (/^\/web\b/.test(content)) tools.push('cmd:web');
    }

    if (role === 'assistant') {
        if (/<<<<<<< SEARCH/.test(content)) tools.push('search-replace');
        if (/^diff --git/.test(content)) tools.push('diff-edit');
        if (/```[\s\S]*?```/.test(content)) tools.push('code-block');
    }

    return [...new Set(tools)];
}

function parseAiderHistory(filePath: string): ParsedAiderHistory | null {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { return null; }

    const turns: ParsedTurn[] = [];
    const filesEdited = new Set<string>();
    let model = 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let currentRole: string | null = null;
    let currentLines: string[] = [];
    let editFormat: string | null = null;
    let errorCount = 0;

    for (const line of content.split('\n')) {
        if (line.startsWith('#### ')) {
            if (currentLines.length && currentRole) {
                const turnContent = currentLines.join('\n').trim();
                const metrics = currentRole === 'assistant' ? extractEditMetrics(turnContent) : { linesAdded: 0, linesRemoved: 0, files: [] };
                const hasError = detectErrors(turnContent);
                if (hasError) errorCount++;
                const tools = detectAiderTools(turnContent, currentRole);

                turns.push({
                    role: currentRole,
                    content: turnContent,
                    timestamp: null,
                    model: model !== 'unknown' ? model : null,
                    linesAdded: metrics.linesAdded,
                    linesRemoved: metrics.linesRemoved,
                    filesEdited: metrics.files,
                    hasError,
                    editFormat,
                    tools,
                });
                for (const f of metrics.files) filesEdited.add(f);
            }
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
        } else if (/^Edit format: (\w+)/.test(line)) {
            editFormat = line.match(/^Edit format: (\w+)/)![1];
        } else if (currentRole && line.trim()) {
            if (currentRole === 'user' && line === '---') {
                currentRole = 'assistant';
                currentLines = [];
            } else {
                currentLines.push(line);
            }
        }
    }

    // Flush last turn
    if (currentLines.length && currentRole) {
        const turnContent = currentLines.join('\n').trim();
        const metrics = currentRole === 'assistant' ? extractEditMetrics(turnContent) : { linesAdded: 0, linesRemoved: 0, files: [] };
        const hasError = detectErrors(turnContent);
        if (hasError) errorCount++;
        const tools = detectAiderTools(turnContent, currentRole);

        turns.push({
            role: currentRole,
            content: turnContent,
            timestamp: null,
            model: model !== 'unknown' ? model : null,
            linesAdded: metrics.linesAdded,
            linesRemoved: metrics.linesRemoved,
            filesEdited: metrics.files,
            hasError,
            editFormat,
            tools,
        });
        for (const f of metrics.files) filesEdited.add(f);
    }

    return {
        turns: turns.filter(t => t.content),
        model,
        inputTokens,
        outputTokens,
        cost,
        filesEdited: [...filesEdited],
        editFormat,
        errorCount,
    };
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

// Cache for turn lookups
const turnCache = new Map<string, { turns: ParsedTurn[]; filePath: string }>();

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
                const assistantTurns = parsed.turns.filter(t => t.role === 'assistant');
                const id = `aider-${Buffer.from(filePath).toString('base64url').slice(0, 20)}-${stat.mtimeMs.toFixed(0)}`;

                // Aggregate code metrics from all assistant turns
                const totalLinesAdded = assistantTurns.reduce((s, t) => s + t.linesAdded, 0);
                const totalLinesRemoved = assistantTurns.reduce((s, t) => s + t.linesRemoved, 0);

                // Aggregate tool usage
                const toolCounts: Record<string, number> = {};
                for (const t of parsed.turns) {
                    for (const tool of t.tools) toolCounts[tool] = (toolCounts[tool] || 0) + 1;
                }
                const topTools: [string, number][] = Object.entries(toolCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8);

                // First-attempt success: files edited only once vs multiple times
                const fileEditCounts = new Map<string, number>();
                for (const t of assistantTurns) {
                    for (const f of t.filesEdited) {
                        fileEditCounts.set(f, (fileEditCounts.get(f) || 0) + 1);
                    }
                }
                const totalFiles = fileEditCounts.size;
                const singleEditFiles = [...fileEditCounts.values()].filter(c => c === 1).length;
                const firstAttemptPct = totalFiles > 0 ? Math.round((singleEditFiles / totalFiles) * 100) : null;

                // Error recovery tracking
                let recoveredErrors = 0;
                let totalErrors = 0;
                for (let i = 0; i < parsed.turns.length; i++) {
                    if (parsed.turns[i].hasError) {
                        totalErrors++;
                        for (let j = i + 1; j < parsed.turns.length; j++) {
                            if (!parsed.turns[j].hasError && parsed.turns[j].role === 'assistant') {
                                recoveredErrors++;
                                break;
                            }
                        }
                    }
                }
                const errorRecoveryPct = totalErrors > 0 ? Math.round((recoveredErrors / totalErrors) * 100) : null;

                // Cache turns for getTurns() lookup
                turnCache.set(id, { turns: parsed.turns, filePath });

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
                    code_lines_added: totalLinesAdded,
                    code_lines_removed: totalLinesRemoved,
                    files_touched: parsed.filesEdited.length,
                    error_count: parsed.errorCount,
                    top_tools: topTools.length > 0 ? topTools : undefined,
                    raw: {
                        filesEdited: parsed.filesEdited,
                        cost: parsed.cost,
                        historyFile: filePath,
                        editFormat: parsed.editFormat,
                        firstAttemptPct,
                        errorRecoveryPct,
                    },
                });
            } catch { /* skip */ }
        }
        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const cached = turnCache.get(sessionId);
        if (!cached) return [];

        const stat = statSync(cached.filePath);
        const baseTs = stat.birthtimeMs || stat.mtimeMs - cached.turns.length * 30000;

        return cached.turns
            .filter(t => t.role === 'assistant')
            .map((t, i) => {
                const ts = baseTs + (i * 60_000); // ~1min per assistant turn estimate
                return {
                    session_id: sessionId,
                    timestamp: ts,
                    model: t.model || undefined,
                    input_tokens: 0, // aider tracks at session level, not turn level
                    output_tokens: Math.round(t.content.length / 4),
                    cache_read: 0,
                    cache_create: 0,
                    tools_used: t.tools,
                    label: t.content
                        .replace(/```[\s\S]*?```/g, '[code]')
                        .replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g, '[edit]')
                        .replace(/\n+/g, ' ')
                        .trim()
                        .slice(0, 100) || undefined,
                    type: 2,
                };
            });
    }
}
