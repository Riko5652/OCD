// Claude Code adapter — parses .jsonl session files from ~/.claude/projects/
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn, CommitScore } from './types.js';

interface ParsedTurn {
    timestamp: number | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_create: number;
    latency_ms: number | null;
    tok_per_sec: number | null;
    tools_used: string[];
    stop_reason: string | null;
    label: string;
    type: number;
    code_lines_added: number;
    code_lines_removed: number;
    files_touched: number;
    thinking_length: number;
}

interface CodeStats {
    totalLinesAdded: number;
    totalLinesRemoved: number;
    totalFilesTouched: number;
    filesEdited: string[];
    parallelToolCalls: number;
    firstAttemptPct: number | null;
    avgThinkingLength: number | null;
    errorCount: number;
    errorRecoveryPct: number | null;
    thinkingToOutputRatio: number | null;
}

interface ModelPerf {
    model: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    avg_latency_ms: number | null;
    error_count: number;
}

// Cache: filepath -> { mtime, session, turns }
const fileCache = new Map<string, { mtime: number; session: UnifiedSession & { _modelPerf?: ModelPerf[] }; turns: ParsedTurn[] }>();

function parseSessionFile(filePath: string): ParsedTurn[] & { _codeStats?: CodeStats } {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const turns: ParsedTurn[] = [];
    let prevTs: number | null = null;

    const fileEditOrder: { file: string; turnIndex: number }[] = [];
    let sessionErrorCount = 0;
    const toolOutcomeSequence: boolean[] = [];

    for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        // Parse user messages for tool_result errors
        if (obj.type === 'user' && obj.message?.content) {
            for (const block of obj.message.content) {
                if (block.type === 'tool_result') {
                    if (block.is_error === true) {
                        sessionErrorCount++;
                        toolOutcomeSequence.push(false);
                    } else {
                        toolOutcomeSequence.push(true);
                    }
                }
            }
            continue;
        }

        if (obj.type !== 'assistant' || !obj.message?.usage) continue;

        const u = obj.message.usage;
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;
        const turnIndex = turns.length;

        const tools: string[] = [];
        let label = '';
        let turnLinesAdded = 0;
        let turnLinesRemoved = 0;
        const turnFiles = new Set<string>();
        let thinkingLength = 0;

        for (const block of obj.message.content || []) {
            if (block.type === 'tool_use' && block.name) {
                tools.push(block.name);

                if (block.name === 'Write' && block.input?.content) {
                    turnLinesAdded += block.input.content.split('\n').length;
                    if (block.input.file_path) {
                        turnFiles.add(block.input.file_path);
                        fileEditOrder.push({ file: block.input.file_path, turnIndex });
                    }
                }

                if (block.name === 'Edit' && block.input) {
                    const oldLines = (block.input.old_string || '').split('\n').length;
                    const newLines = (block.input.new_string || '').split('\n').length;
                    turnLinesAdded += Math.max(0, newLines - oldLines);
                    turnLinesRemoved += Math.max(0, oldLines - newLines);
                    if (block.input.file_path) {
                        turnFiles.add(block.input.file_path);
                        fileEditOrder.push({ file: block.input.file_path, turnIndex });
                    }
                }
            }
            if (!label && block.type === 'text' && block.text) {
                label = block.text.slice(0, 100);
            }
            if (block.type === 'thinking' && block.thinking) {
                thinkingLength += block.thinking.length;
                if (!label) label = block.thinking.slice(0, 100);
            }
        }

        let latencyMs: number | null = null;
        let tokPerSec: number | null = null;
        if (ts && prevTs) {
            latencyMs = ts - prevTs;
            if (latencyMs > 0 && u.output_tokens) {
                tokPerSec = u.output_tokens / (latencyMs / 1000);
            }
        }

        turns.push({
            timestamp: ts,
            model: obj.message.model || null,
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_read: u.cache_read_input_tokens || 0,
            cache_create: u.cache_creation_input_tokens || 0,
            latency_ms: latencyMs,
            tok_per_sec: tokPerSec,
            tools_used: tools,
            stop_reason: obj.message.stop_reason || null,
            label,
            type: 2,
            code_lines_added: turnLinesAdded,
            code_lines_removed: turnLinesRemoved,
            files_touched: turnFiles.size,
            thinking_length: thinkingLength,
        });

        if (ts) prevTs = ts;
    }

    // Compute first-attempt success
    const fileEditCounts = new Map<string, number>();
    for (const { file } of fileEditOrder) {
        fileEditCounts.set(file, (fileEditCounts.get(file) || 0) + 1);
    }
    const totalFiles = fileEditCounts.size;
    const singleEditFiles = [...fileEditCounts.values()].filter(c => c === 1).length;
    const firstAttemptPct = totalFiles > 0 ? (singleEditFiles / totalFiles) * 100 : null;

    const thinkingLengths = turns.map(t => t.thinking_length).filter(v => v > 0);
    const totalThinkingChars = thinkingLengths.reduce((s, v) => s + v, 0);
    const avgThinkingLength = thinkingLengths.length > 0 ? totalThinkingChars / thinkingLengths.length : null;

    let recoveredErrors = 0;
    let totalErrors = 0;
    for (let i = 0; i < toolOutcomeSequence.length; i++) {
        if (toolOutcomeSequence[i] === false) {
            totalErrors++;
            for (let j = i + 1; j < toolOutcomeSequence.length; j++) {
                if (toolOutcomeSequence[j] === true) { recoveredErrors++; break; }
            }
        }
    }
    const errorRecoveryPct = totalErrors > 0 ? (recoveredErrors / totalErrors) * 100 : null;

    const totalOutputTokens = turns.reduce((s, t) => s + t.output_tokens, 0);
    const thinkingToOutputRatio = totalOutputTokens > 0 ? totalThinkingChars / totalOutputTokens : null;
    const parallelToolCalls = turns.filter(t => (t.tools_used || []).length >= 3).length;

    const result = turns as ParsedTurn[] & { _codeStats?: CodeStats };
    result._codeStats = {
        totalLinesAdded: turns.reduce((s, t) => s + t.code_lines_added, 0),
        totalLinesRemoved: turns.reduce((s, t) => s + t.code_lines_removed, 0),
        totalFilesTouched: totalFiles,
        filesEdited: [...fileEditCounts.keys()],
        parallelToolCalls,
        firstAttemptPct,
        avgThinkingLength,
        errorCount: sessionErrorCount,
        errorRecoveryPct,
        thinkingToOutputRatio,
    };

    return result;
}

function buildSession(filename: string, turns: ParsedTurn[] & { _codeStats?: CodeStats }, projectDir: string): UnifiedSession & { _modelPerf?: ModelPerf[] } {
    const id = `cc-${filename.replace('.jsonl', '')}`;
    const timestamps = turns.filter(t => t.timestamp).map(t => t.timestamp!);
    const models = [...new Set(turns.map(t => t.model).filter(Boolean))] as string[];

    const totalInput = turns.reduce((s, t) => s + t.input_tokens, 0);
    const totalOutput = turns.reduce((s, t) => s + t.output_tokens, 0);
    const totalCacheRead = turns.reduce((s, t) => s + t.cache_read, 0);
    const totalCacheCreate = turns.reduce((s, t) => s + t.cache_create, 0);

    const cacheTotal = totalInput + totalCacheCreate + totalCacheRead;
    const cacheHitPct = cacheTotal > 0 ? (totalCacheRead / cacheTotal) * 100 : 0;

    const latencies = turns.map(t => t.latency_ms).filter((v): v is number => v != null && v > 0);
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : undefined;

    const toolCounts: Record<string, number> = {};
    for (const t of turns) {
        for (const tool of t.tools_used || []) {
            toolCounts[tool] = (toolCounts[tool] || 0) + 1;
        }
    }
    const topTools: [string, number][] = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

    const modelCounts: Record<string, number> = {};
    for (const t of turns) {
        if (t.model) modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
    }
    const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || undefined;

    const codeStats = turns._codeStats || {} as Partial<CodeStats>;

    // Per-model performance
    const byModel: Record<string, { turns: number; input: number; output: number; cache: number; latencies: number[]; errors: number }> = {};
    for (const t of turns) {
        const m = t.model || primaryModel || 'unknown';
        if (!byModel[m]) byModel[m] = { turns: 0, input: 0, output: 0, cache: 0, latencies: [], errors: 0 };
        byModel[m].turns++;
        byModel[m].input += t.input_tokens || 0;
        byModel[m].output += t.output_tokens || 0;
        byModel[m].cache += t.cache_read || 0;
        if (t.latency_ms != null && t.latency_ms > 0) byModel[m].latencies.push(t.latency_ms);
        if (t.stop_reason === 'error' || t.label === 'error') byModel[m].errors++;
    }
    const _modelPerf: ModelPerf[] = Object.entries(byModel).map(([model, s]) => ({
        model,
        turns: s.turns,
        input_tokens: s.input,
        output_tokens: s.output,
        cache_read: s.cache,
        avg_latency_ms: s.latencies.length ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length : null,
        error_count: s.errors,
    }));

    const isMeta = projectDir.includes('ai-productivity-dashboard') || projectDir.includes('ai-dashboard');

    return {
        id,
        tool_id: 'claude-code',
        title: turns[0]?.label || filename,
        started_at: timestamps[0] || Date.now(),
        ended_at: timestamps[timestamps.length - 1],
        total_turns: turns.length,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_cache_read: totalCacheRead,
        total_cache_create: totalCacheCreate,
        primary_model: primaryModel,
        models_used: models,
        cache_hit_pct: cacheHitPct,
        avg_latency_ms: avgLatency,
        top_tools: topTools,
        code_lines_added: codeStats.totalLinesAdded || 0,
        code_lines_removed: codeStats.totalLinesRemoved || 0,
        files_touched: codeStats.totalFilesTouched || 0,
        error_count: codeStats.errorCount || 0,
        raw: {
            project: projectDir,
            thinking_to_output_ratio: codeStats.thinkingToOutputRatio ?? null,
            filesEdited: codeStats.filesEdited || [],
            parallelToolCalls: codeStats.parallelToolCalls || 0,
            meta: isMeta,
        },
        _modelPerf,
    };
}

function dirNameToRepoPath(dirName: string): string | null {
    if (process.platform === 'win32') {
        const match = dirName.match(/^([A-Z])--(.*)$/);
        if (match) {
            return `${match[1]}:/${match[2].replace(/-/g, '/')}`;
        }
        return null;
    }
    return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
}

export class ClaudeCodeAdapter implements IAiAdapter {
    readonly id: ToolId = 'claude-code';
    readonly name = 'Claude Code';

    private commitCache: { ts: number; scores: CommitScore[] } = { ts: 0, scores: [] };
    private readonly COMMIT_CACHE_TTL = 60_000;

    async getSessions(): Promise<UnifiedSession[]> {
        const dirs = config.claudeCode.dirs;
        if (dirs.length === 0) return [];

        const sessions: UnifiedSession[] = [];
        const seenIds = new Set<string>();

        for (const dir of dirs) {
            let files: string[];
            try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

            for (const file of files) {
                const filePath = join(dir, file);
                const id = `cc-${file.replace('.jsonl', '')}`;
                if (seenIds.has(id)) continue;
                seenIds.add(id);

                const stat = statSync(filePath);
                const mtime = stat.mtimeMs;

                const cached = fileCache.get(filePath);
                if (cached && cached.mtime === mtime) {
                    sessions.push(cached.session);
                    continue;
                }

                const turns = parseSessionFile(filePath);
                if (turns.length === 0) continue;

                const session = buildSession(file, turns, dir);
                if (session.total_output_tokens === 0) continue;

                fileCache.set(filePath, { mtime, session, turns });
                sessions.push(session);
            }
        }

        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const filename = sessionId.replace('cc-', '') + '.jsonl';

        for (const dir of config.claudeCode.dirs) {
            const filePath = join(dir, filename);
            const cached = fileCache.get(filePath);
            if (cached) {
                return cached.turns.map(t => ({
                    session_id: sessionId,
                    timestamp: t.timestamp || Date.now(),
                    model: t.model || undefined,
                    input_tokens: t.input_tokens,
                    output_tokens: t.output_tokens,
                    cache_read: t.cache_read,
                    cache_create: t.cache_create,
                    latency_ms: t.latency_ms || undefined,
                    tok_per_sec: t.tok_per_sec || undefined,
                    tools_used: t.tools_used,
                    stop_reason: t.stop_reason || undefined,
                    label: t.label,
                    type: t.type,
                }));
            }

            try {
                const turns = parseSessionFile(filePath);
                return turns.map(t => ({
                    session_id: sessionId,
                    timestamp: t.timestamp || Date.now(),
                    model: t.model || undefined,
                    input_tokens: t.input_tokens,
                    output_tokens: t.output_tokens,
                    cache_read: t.cache_read,
                    cache_create: t.cache_create,
                    latency_ms: t.latency_ms || undefined,
                    tok_per_sec: t.tok_per_sec || undefined,
                    tools_used: t.tools_used,
                    stop_reason: t.stop_reason || undefined,
                    label: t.label,
                    type: t.type,
                }));
            } catch { /* not in this dir */ }
        }
        return [];
    }

    async getCommitScores(): Promise<CommitScore[]> {
        if (Date.now() - this.commitCache.ts < this.COMMIT_CACHE_TTL && this.commitCache.scores.length > 0) {
            return this.commitCache.scores;
        }

        const dirs = config.claudeCode.dirs;
        if (dirs.length === 0) return [];

        const sessions = await this.getSessions();
        const sessionWindows = sessions
            .filter(s => s.started_at && s.code_lines_added > 0)
            .map(s => ({
                start: s.started_at,
                end: (s.ended_at || s.started_at) + 600_000,
                linesAdded: s.code_lines_added,
                linesRemoved: s.code_lines_removed,
            }));

        if (sessionWindows.length === 0) return [];

        const scores: any[] = [];
        const seenCommits = new Set<string>();

        for (const dir of dirs) {
            const dirName = basename(dir);
            const repoPath = dirNameToRepoPath(dirName);
            if (!repoPath || !existsSync(repoPath)) continue;
            if (!existsSync(join(repoPath, '.git'))) continue;

            try {
                const raw = execSync(
                    'git log --format="%H|%ai|%s|%D" --numstat --since="90 days ago" --no-merges',
                    { cwd: repoPath, timeout: 10_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
                );

                let currentCommit: any = null;
                for (const line of raw.split('\n')) {
                    const commitMatch = line.match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.*)$/);
                    if (commitMatch) {
                        if (currentCommit?.additions > 0 && !seenCommits.has(currentCommit.hash)) {
                            seenCommits.add(currentCommit.hash);
                            scores.push(currentCommit);
                        }
                        const [, hash, dateStr, message, refs] = commitMatch;
                        const commitTs = new Date(dateStr).getTime();
                        const matchingSession = sessionWindows.find(w => commitTs >= w.start && commitTs <= w.end);
                        const branchMatch = refs.match(/HEAD -> ([^,]+)/);
                        const branch = branchMatch ? branchMatch[1].trim() : (refs.split(',')[0] || '').trim().replace('origin/', '') || 'unknown';

                        currentCommit = { hash, date: dateStr, message: message.slice(0, 200), branch, ts: commitTs, additions: 0, deletions: 0, aiSession: matchingSession };
                        continue;
                    }

                    if (currentCommit && line.match(/^\d/)) {
                        const [add, del] = line.split('\t');
                        currentCommit.additions += parseInt(add) || 0;
                        currentCommit.deletions += parseInt(del) || 0;
                    }
                }
                if (currentCommit?.additions > 0 && !seenCommits.has(currentCommit.hash)) {
                    seenCommits.add(currentCommit.hash);
                    scores.push(currentCommit);
                }
            } catch (e: any) {
                console.error(`[claude-code] git log failed for ${repoPath}: ${e.message}`);
            }
        }

        const result: CommitScore[] = scores.map(c => {
            if (c.aiSession) {
                const sessionTotal = c.aiSession.linesAdded + c.aiSession.linesRemoved;
                const commitTotal = c.additions + c.deletions;
                const rawPct = commitTotal > 0 && sessionTotal > 0
                    ? Math.min(95, (sessionTotal / Math.max(sessionTotal, commitTotal)) * 100) : 80;
                const aiPct = Math.round(rawPct);
                const aiLines = Math.round(c.additions * aiPct / 100);
                return {
                    commit_hash: c.hash, branch: c.branch, tool_id: 'claude-code' as ToolId,
                    scored_at: c.ts, lines_added: c.additions, lines_deleted: c.deletions,
                    ai_lines_added: aiLines, ai_lines_deleted: Math.round(c.deletions * aiPct / 100),
                    human_lines_added: c.additions - aiLines, human_lines_deleted: c.deletions - Math.round(c.deletions * aiPct / 100),
                    ai_percentage: aiPct, commit_message: c.message, commit_date: c.date,
                };
            }
            return {
                commit_hash: c.hash, branch: c.branch, tool_id: 'claude-code' as ToolId,
                scored_at: c.ts, lines_added: c.additions, lines_deleted: c.deletions,
                ai_lines_added: 0, ai_lines_deleted: 0, human_lines_added: c.additions, human_lines_deleted: c.deletions,
                ai_percentage: 0, commit_message: c.message, commit_date: c.date,
            };
        });

        this.commitCache = { ts: Date.now(), scores: result };
        return result;
    }
}
