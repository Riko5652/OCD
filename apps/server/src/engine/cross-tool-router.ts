import { getDb } from '../db/index.js';

const TASK_SIGNALS: Record<string, RegExp[]> = {
    migration: [/migrat|schema\.sql|alembic|flyway|db\.exec|CREATE TABLE/i],
    component: [/\.tsx|\.jsx|react|useState|useEffect|styled|tailwind/i],
    debug: [/error|exception|crash|traceback|undefined is not|cannot read/i],
    refactor: [/refactor|rename|extract|clean up|reorganize/i],
    test: [/test|spec|vitest|jest|describe\(|it\(|expect\(/i],
    api: [/endpoint|route|handler|app\.get|app\.post|router\./i],
    devops: [/docker|nginx|ci|deploy|pipeline|Dockerfile/i],
};

const LANG_SIGNALS: Record<string, RegExp[]> = {
    python: [/\.py|fastapi|django|flask|pandas|numpy/i],
    typescript: [/\.ts|\.tsx|interface |type |: string|: number/i],
    sql: [/SELECT |INSERT |UPDATE |DELETE |CREATE TABLE/i],
    javascript: [/\.js|require\(|module\.exports/i],
};

export function classifySession(session: any) {
    let text = '';
    try {
        const raw = JSON.parse(session.raw_data || '{}');
        const files = (raw.filesEdited || raw.project || '').toString();
        text = `${session.title || ''} ${files}`;
    } catch { /* skip */ }

    let taskType = 'general';
    for (const [type, patterns] of Object.entries(TASK_SIGNALS)) {
        if (patterns.some(p => p.test(text))) { taskType = type; break; }
    }
    let language: string | null = null;
    for (const [lang, patterns] of Object.entries(LANG_SIGNALS)) {
        if (patterns.some(p => p.test(text))) { language = lang; break; }
    }
    const complexity = (session.total_turns || 0) > 60 ? 'complex' :
        (session.total_turns || 0) > 20 ? 'moderate' :
            (session.total_turns || 0) > 5 ? 'simple' : 'trivial';

    return { taskType, language, complexity };
}

export function classifyAndSave(session: any) {
    const db = getDb();
    const { taskType, language, complexity } = classifySession(session);
    db.prepare(`INSERT OR REPLACE INTO task_classifications (session_id, task_type, language, complexity, classified_at)
        VALUES (?,?,?,?,?)`).run(session.id, taskType, language, complexity, Date.now());
    return { taskType, language, complexity };
}

export function computeToolModelWinRates({ taskType, language }: { taskType?: string; language?: string } = {}) {
    const db = getDb();
    let sql = `SELECT s.tool_id, COALESCE(s.primary_model, 'unknown') AS model, tc.task_type, tc.language,
        COUNT(s.id) AS sessions, AVG(s.total_turns) AS avg_turns, AVG(s.first_attempt_pct) AS avg_first_attempt,
        AVG(s.cache_hit_pct) AS avg_cache_hit, AVG(s.quality_score) AS avg_quality
        FROM sessions s JOIN task_classifications tc ON tc.session_id = s.id
        WHERE s.primary_model IS NOT NULL`;
    const params: any[] = [];
    if (taskType) { sql += ' AND tc.task_type = ?'; params.push(taskType); }
    if (language) { sql += ' AND tc.language = ?'; params.push(language); }
    sql += ` GROUP BY s.tool_id, model, tc.task_type, tc.language HAVING sessions >= 2 ORDER BY avg_turns ASC`;

    const rows = db.prepare(sql).all(...params) as any[];
    const byTask: Record<string, any[]> = {};
    for (const r of rows) {
        const key = `${r.task_type}::${r.language || 'any'}`;
        if (!byTask[key]) byTask[key] = [];
        byTask[key].push(r);
    }
    const results: any[] = [];
    for (const group of Object.values(byTask)) {
        const maxT = Math.max(...group.map(r => r.avg_turns));
        const minT = Math.min(...group.map(r => r.avg_turns));
        for (const r of group) {
            const turnsScore = maxT === minT ? 50 : (1 - (r.avg_turns - minT) / (maxT - minT)) * 100;
            r.win_rate = Math.round(turnsScore * 0.6 + (r.avg_first_attempt || 50) * 0.4);
            results.push(r);
        }
    }
    return results.sort((a, b) => b.win_rate - a.win_rate);
}

export function getRoutingRecommendation(taskDescription: string) {
    const desc = taskDescription.toLowerCase();
    let taskType = 'general';
    let language: string | undefined;
    for (const [type, patterns] of Object.entries(TASK_SIGNALS)) {
        if (patterns.some(p => p.test(desc))) { taskType = type; break; }
    }
    for (const [lang, patterns] of Object.entries(LANG_SIGNALS)) {
        if (patterns.some(p => p.test(desc))) { language = lang; break; }
    }
    const winRates = computeToolModelWinRates({ taskType, language });
    if (!winRates.length) return { recommendation: null, reason: 'Not enough historical data yet.', single_tool: false };
    const best = winRates[0];

    // Detect single-tool users: if all sessions are from the same tool,
    // optimize model selection within that tool instead of cross-tool routing
    const uniqueTools = [...new Set(winRates.map(r => r.tool_id))];
    const isSingleTool = uniqueTools.length === 1;

    if (isSingleTool) {
        return getSingleToolRecommendation(uniqueTools[0], taskType, language, winRates);
    }

    return {
        recommendation: { tool: best.tool_id, model: best.model, task_type: best.task_type },
        win_rates: winRates.slice(0, 10),
        reason: `Based on ${best.sessions} similar sessions: ${best.tool_id} with ${best.model} resolves ${taskType} tasks in avg ${(best.avg_turns || 0).toFixed(1)} turns (${best.win_rate}% win rate).`,
        single_tool: false,
    };
}

/**
 * For users who only use one AI tool, provide model-level optimization
 * instead of recommending tool switches they won't make.
 */
function getSingleToolRecommendation(toolId: string, taskType: string, language: string | undefined, winRates: any[]) {
    const db = getDb();
    const best = winRates[0];

    // Get model-level comparison within this tool
    let modelSql = `SELECT s.primary_model AS model, COUNT(*) AS sessions,
        AVG(s.total_turns) AS avg_turns, AVG(s.quality_score) AS avg_quality,
        AVG(s.cache_hit_pct) AS avg_cache, AVG(s.error_count) AS avg_errors,
        AVG(s.agentic_score) AS avg_agentic,
        AVG(CAST(s.total_input_tokens + s.total_output_tokens AS REAL) / NULLIF(s.quality_score, 0)) AS tokens_per_quality
        FROM sessions s
        LEFT JOIN task_classifications tc ON tc.session_id = s.id
        WHERE s.tool_id = ? AND s.primary_model IS NOT NULL`;
    const params: any[] = [toolId];
    if (taskType !== 'general') { modelSql += ' AND tc.task_type = ?'; params.push(taskType); }
    modelSql += ` GROUP BY s.primary_model HAVING sessions >= 2 ORDER BY avg_quality DESC`;

    const modelRows = db.prepare(modelSql).all(...params) as any[];

    // Get workflow patterns — what separates high-quality from low-quality sessions
    const patterns = db.prepare(`
        SELECT
            CASE WHEN quality_score >= 70 THEN 'high' ELSE 'low' END AS tier,
            AVG(total_turns) AS avg_turns,
            AVG(cache_hit_pct) AS avg_cache,
            AVG(error_count) AS avg_errors,
            AVG(total_input_tokens) AS avg_input,
            AVG(total_output_tokens) AS avg_output,
            COUNT(*) AS sessions
        FROM sessions
        WHERE tool_id = ? AND quality_score IS NOT NULL AND started_at > ?
        GROUP BY tier
    `).all(toolId, Date.now() - 30 * 86400000) as any[];

    const highTier = patterns.find((p: any) => p.tier === 'high');
    const lowTier = patterns.find((p: any) => p.tier === 'low');

    // Generate tool-specific optimization tips
    const tips = generateSingleToolTips(toolId, modelRows, highTier, lowTier, taskType);

    const bestModel = modelRows[0];
    const altModels = modelRows.slice(1, 4);

    let reason = `You primarily use ${toolId}.`;
    if (bestModel) {
        reason += ` For ${taskType} tasks, ${bestModel.model} delivers the best quality (${(bestModel.avg_quality || 0).toFixed(0)}) in avg ${(bestModel.avg_turns || 0).toFixed(0)} turns.`;
    }
    if (altModels.length > 0) {
        const cheaperModel = altModels.find((m: any) => (m.tokens_per_quality || Infinity) < (bestModel?.tokens_per_quality || Infinity));
        if (cheaperModel) {
            reason += ` Consider ${cheaperModel.model} for simpler tasks — ${Math.round((cheaperModel.tokens_per_quality || 0))} tokens/quality point vs ${Math.round((bestModel?.tokens_per_quality || 0))}.`;
        }
    }

    return {
        recommendation: { tool: toolId, model: bestModel?.model || best.model, task_type: best.task_type },
        win_rates: winRates.slice(0, 10),
        reason,
        single_tool: true,
        model_comparison: modelRows.map((m: any) => ({
            model: m.model,
            sessions: m.sessions,
            avg_quality: Math.round(m.avg_quality || 0),
            avg_turns: Math.round(m.avg_turns || 0),
            avg_cache: Math.round(m.avg_cache || 0),
            avg_errors: Math.round((m.avg_errors || 0) * 10) / 10,
            tokens_per_quality: Math.round(m.tokens_per_quality || 0),
            avg_agentic: Math.round(m.avg_agentic || 0),
        })),
        workflow_tips: tips,
        workflow_patterns: {
            high_quality: highTier ? {
                avg_turns: Math.round(highTier.avg_turns || 0),
                avg_cache: Math.round(highTier.avg_cache || 0),
                avg_errors: Math.round((highTier.avg_errors || 0) * 10) / 10,
                sessions: highTier.sessions,
            } : null,
            low_quality: lowTier ? {
                avg_turns: Math.round(lowTier.avg_turns || 0),
                avg_cache: Math.round(lowTier.avg_cache || 0),
                avg_errors: Math.round((lowTier.avg_errors || 0) * 10) / 10,
                sessions: lowTier.sessions,
            } : null,
        },
    };
}

function generateSingleToolTips(toolId: string, modelRows: any[], highTier: any, lowTier: any, taskType: string): string[] {
    const tips: string[] = [];

    // Model selection tips
    if (modelRows.length > 1) {
        const cheapest = modelRows.reduce((a: any, b: any) => ((a.tokens_per_quality || Infinity) < (b.tokens_per_quality || Infinity) ? a : b));
        const highest = modelRows[0]; // already sorted by quality
        if (cheapest.model !== highest.model) {
            tips.push(`Use ${highest.model} for complex ${taskType} tasks, ${cheapest.model} for routine work — saves ${Math.round(((highest.tokens_per_quality || 0) - (cheapest.tokens_per_quality || 0)) / (highest.tokens_per_quality || 1) * 100)}% tokens.`);
        }
    }

    // Session length insights
    if (highTier && lowTier) {
        if (lowTier.avg_turns > highTier.avg_turns * 1.5) {
            tips.push(`Your high-quality sessions average ${Math.round(highTier.avg_turns)} turns vs ${Math.round(lowTier.avg_turns)} for low-quality. Break long tasks into sub-sessions.`);
        }
        if (highTier.avg_cache > lowTier.avg_cache + 15) {
            tips.push(`High-quality sessions have ${Math.round(highTier.avg_cache)}% cache hit vs ${Math.round(lowTier.avg_cache)}%. Front-load context to improve caching.`);
        }
    }

    // Tool-specific tips
    if (toolId === 'claude-code') {
        tips.push('Use subagents (Agent tool) for multi-file tasks to parallelize and reduce main context window growth.');
        tips.push('Include CLAUDE.md with project conventions — stabilizes cache and reduces re-asking.');
    } else if (toolId === 'cursor') {
        tips.push('Use Composer mode for multi-file edits. Tab mode is best for single-file inline completions.');
        tips.push('Pin important files in the context panel to improve response relevance.');
    } else if (toolId === 'copilot') {
        tips.push('Use @workspace for project-wide queries, @terminal for command help. Slash commands (/fix, /test) are faster than describing the task.');
        tips.push('Open relevant files before chatting — Copilot uses open tabs as context.');
    } else if (toolId === 'windsurf') {
        tips.push('Use Cascade (multi-step) mode for complex tasks, and Flow for quick inline edits.');
        tips.push('Reference files with @ mentions to ensure Windsurf has the right context.');
    } else if (toolId === 'aider') {
        tips.push('Use architect mode for planning, then switch to code mode for implementation. Keep the chat focused on one feature.');
        tips.push('Add files explicitly with /add before editing — aider works best with a focused file set.');
    } else if (toolId === 'continue') {
        tips.push('Use /edit for inline modifications and provide clear code context. Slash commands save turns over natural language.');
        tips.push('Configure your model in config.json — matching model to task complexity saves tokens.');
    } else if (toolId === 'antigravity') {
        tips.push('Use artifacts for iterative code — each version is tracked. Review artifact versions to understand iteration depth.');
        tips.push('Keep conversations focused on one artifact type to reduce context confusion.');
    }

    return tips;
}
