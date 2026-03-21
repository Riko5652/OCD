import { getDb } from '../db/index.js';

function sanitize(text: string, maxLen = 200): string {
    return (text || '').replace(/[\x00-\x1f]/g, ' ').slice(0, maxLen);
}

export function extractPromptTemplates({ minQuality = 75, limit = 20 } = {}) {
    const db = getDb();
    const sessions = db.prepare(`
        SELECT s.id, s.tool_id, s.primary_model, s.quality_score, s.total_turns,
            s.cache_hit_pct, s.agentic_score, tc.task_type, tc.language, t.label as first_prompt
        FROM sessions s
        LEFT JOIN task_classifications tc ON tc.session_id = s.id
        LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (SELECT MIN(rowid) FROM turns WHERE session_id = s.id)
        WHERE s.quality_score >= ?
        ORDER BY s.quality_score DESC, s.agentic_score DESC LIMIT ?
    `).all(minQuality, limit) as any[];

    const byType: Record<string, any[]> = {};
    for (const s of sessions) {
        const key = s.task_type || 'general';
        if (!byType[key]) byType[key] = [];
        byType[key].push({
            tool: s.tool_id, model: s.primary_model, quality: Math.round(s.quality_score),
            agentic: Math.round(s.agentic_score || 0), turns: s.total_turns,
            cache_hit: Math.round(s.cache_hit_pct || 0), first_prompt: sanitize(s.first_prompt || '', 200),
            language: s.language,
        });
    }
    return byType;
}

export function getOptimalPromptStructure(taskType = 'general') {
    const templates = extractPromptTemplates({ minQuality: 70 });
    const group = templates[taskType] || templates['general'] || [];
    if (!group.length) {
        return { task_type: taskType, available: false, reason: 'Not enough high-quality sessions yet.' };
    }
    const best = group[0];
    const avgTurns = group.reduce((s: number, g: any) => s + g.turns, 0) / group.length;
    const avgCache = group.reduce((s: number, g: any) => s + g.cache_hit, 0) / group.length;

    const tips: string[] = [];
    if (avgCache < 50) tips.push('Prime the cache by including full file contents in your first message');
    if (avgTurns > 20) tips.push(`Best sessions for ${taskType} average ${Math.round(avgTurns)} turns — break into sub-tasks`);
    if (best.first_prompt) tips.push(`High-quality sessions start with: "${best.first_prompt.slice(0, 100)}..."`);

    // Compute effect sizes from prompt_metrics
    const effectSizes = computeEffectSizes();

    return {
        task_type: taskType, available: true, best_tool: best.tool, best_model: best.model,
        avg_turns: Math.round(avgTurns), avg_cache_hit: Math.round(avgCache),
        example_count: group.length, tips, examples: group.slice(0, 3),
        effect_sizes: effectSizes,
        confidence: group.length >= 20 ? 'high' : group.length >= 10 ? 'medium' : 'low',
        sample_size: group.length,
    };
}

export function computeEffectSizes() {
    const db = getDb();

    // File context effect
    const fileCtx = db.prepare(`
        SELECT has_file_context, AVG(quality) as avg_quality, COUNT(*) as n
        FROM (
            SELECT pm.has_file_context, s.quality_score as quality
            FROM prompt_metrics pm JOIN sessions s ON s.id = pm.session_id
            WHERE s.quality_score IS NOT NULL
        ) GROUP BY has_file_context
    `).all() as any[];

    const withFile = fileCtx.find((r: any) => r.has_file_context === 1);
    const withoutFile = fileCtx.find((r: any) => r.has_file_context === 0);

    // Constraint effect
    const constraintEffect = db.prepare(`
        SELECT CASE WHEN pm.constraint_count > 0 THEN 1 ELSE 0 END as has_constraints,
            AVG(s.quality_score) as avg_quality, COUNT(*) as n
        FROM prompt_metrics pm JOIN sessions s ON s.id = pm.session_id
        WHERE s.quality_score IS NOT NULL
        GROUP BY has_constraints
    `).all() as any[];

    const withConstraint = constraintEffect.find((r: any) => r.has_constraints === 1);
    const withoutConstraint = constraintEffect.find((r: any) => r.has_constraints === 0);

    // First-turn length buckets vs quality
    const turnLength = db.prepare(`
        SELECT CASE
            WHEN pm.first_turn_tokens < 100 THEN 'short (<100)'
            WHEN pm.first_turn_tokens < 400 THEN 'medium (100-400)'
            ELSE 'long (400+)'
        END as bucket, AVG(s.quality_score) as avg_quality, COUNT(*) as n
        FROM prompt_metrics pm JOIN sessions s ON s.id = pm.session_id
        WHERE s.quality_score IS NOT NULL AND pm.first_turn_tokens IS NOT NULL
        GROUP BY bucket
    `).all() as any[];

    const effects: Array<{ signal: string; with_avg: number | null; without_avg: number | null; delta: number | null; delta_pct: number | null; sample_with: number; sample_without: number }> = [];

    if (withFile && withoutFile) {
        const delta = withFile.avg_quality - withoutFile.avg_quality;
        effects.push({
            signal: 'File context in first turn',
            with_avg: Math.round(withFile.avg_quality * 10) / 10,
            without_avg: Math.round(withoutFile.avg_quality * 10) / 10,
            delta: Math.round(delta * 10) / 10,
            delta_pct: withoutFile.avg_quality ? Math.round((delta / withoutFile.avg_quality) * 1000) / 10 : null,
            sample_with: withFile.n, sample_without: withoutFile.n,
        });
    }

    if (withConstraint && withoutConstraint) {
        const delta = withConstraint.avg_quality - withoutConstraint.avg_quality;
        effects.push({
            signal: 'Constraints (only, must, avoid...)',
            with_avg: Math.round(withConstraint.avg_quality * 10) / 10,
            without_avg: Math.round(withoutConstraint.avg_quality * 10) / 10,
            delta: Math.round(delta * 10) / 10,
            delta_pct: withoutConstraint.avg_quality ? Math.round((delta / withoutConstraint.avg_quality) * 1000) / 10 : null,
            sample_with: withConstraint.n, sample_without: withoutConstraint.n,
        });
    }

    for (const bucket of turnLength) {
        effects.push({
            signal: `First-turn length: ${bucket.bucket}`,
            with_avg: Math.round(bucket.avg_quality * 10) / 10,
            without_avg: null, delta: null, delta_pct: null,
            sample_with: bucket.n, sample_without: 0,
        });
    }

    return effects;
}

export function getAttributionReport(opts: { project?: string; branch?: string; days?: number } = {}) {
    const db = getDb();
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.project) { conditions.push('branch LIKE ?'); params.push(`%${opts.project}%`); }
    if (opts.branch) { conditions.push('branch = ?'); params.push(opts.branch); }
    if (opts.days) {
        conditions.push('commit_date > ?');
        params.push(new Date(Date.now() - opts.days * 86400000).toISOString().split('T')[0]);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const summary = db.prepare(`
        SELECT COUNT(*) as total_commits,
            AVG(ai_percentage) as avg_ai_pct,
            MAX(ai_percentage) as max_ai_pct,
            MIN(ai_percentage) as min_ai_pct,
            SUM(ai_lines_added) as total_ai_lines,
            SUM(human_lines_added) as total_human_lines,
            SUM(lines_added) as total_lines_added,
            SUM(lines_deleted) as total_lines_deleted
        FROM commit_scores ${where}
    `).get(...params) as any;

    const byBranch = db.prepare(`
        SELECT branch, COUNT(*) as commits, AVG(ai_percentage) as avg_ai_pct,
            SUM(ai_lines_added) as ai_lines, SUM(human_lines_added) as human_lines
        FROM commit_scores ${where}
        GROUP BY branch ORDER BY commits DESC LIMIT 10
    `).all(...params) as any[];

    const byTool = db.prepare(`
        SELECT tool_id, COUNT(*) as commits, AVG(ai_percentage) as avg_ai_pct,
            SUM(ai_lines_added) as ai_lines
        FROM commit_scores ${where}
        GROUP BY tool_id ORDER BY commits DESC
    `).all(...params) as any[];

    const trend = db.prepare(`
        SELECT commit_date as date, AVG(ai_percentage) as avg_ai_pct, COUNT(*) as commits
        FROM commit_scores ${where}
        GROUP BY commit_date ORDER BY commit_date DESC LIMIT 30
    `).all(...params) as any[];

    return {
        summary: summary ? {
            total_commits: summary.total_commits || 0,
            avg_ai_percentage: Math.round((summary.avg_ai_pct || 0) * 10) / 10,
            max_ai_percentage: Math.round(summary.max_ai_pct || 0),
            min_ai_percentage: Math.round(summary.min_ai_pct || 0),
            total_ai_lines: summary.total_ai_lines || 0,
            total_human_lines: summary.total_human_lines || 0,
            total_lines_added: summary.total_lines_added || 0,
            ai_ratio: summary.total_lines_added ? Math.round(((summary.total_ai_lines || 0) / summary.total_lines_added) * 1000) / 10 : 0,
        } : null,
        by_branch: byBranch.map(b => ({
            branch: b.branch, commits: b.commits,
            avg_ai_pct: Math.round((b.avg_ai_pct || 0) * 10) / 10,
            ai_lines: b.ai_lines || 0, human_lines: b.human_lines || 0,
        })),
        by_tool: byTool.map(t => ({
            tool: t.tool_id, commits: t.commits,
            avg_ai_pct: Math.round((t.avg_ai_pct || 0) * 10) / 10,
            ai_lines: t.ai_lines || 0,
        })),
        trend: trend.reverse(),
    };
}

export function suggestImprovements(taskType = 'general') {
    const db = getDb();
    const lowQuality = db.prepare(`
        SELECT s.id, s.tool_id, s.primary_model, s.quality_score, s.total_turns, s.cache_hit_pct, s.error_count
        FROM sessions s LEFT JOIN task_classifications tc ON tc.session_id = s.id
        WHERE (tc.task_type = ? OR tc.task_type IS NULL) AND s.quality_score < 50 AND s.total_turns > 3
        ORDER BY s.quality_score ASC LIMIT 5
    `).all(taskType) as any[];

    const optimal = getOptimalPromptStructure(taskType);
    const improvements = lowQuality.map(s => {
        const gaps: string[] = [];
        if ((s.cache_hit_pct || 0) < 30) gaps.push('low cache hit — include more context upfront');
        if ((s.error_count || 0) > 3) gaps.push('high error count — break task into smaller steps');
        if ((s.total_turns || 0) > 50) gaps.push('too many turns — use subagents to parallelize');
        return { session_id: s.id, tool: s.tool_id, quality: Math.round(s.quality_score), gaps };
    });
    return { optimal, low_quality_patterns: improvements };
}
