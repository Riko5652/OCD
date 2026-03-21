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

    return {
        task_type: taskType, available: true, best_tool: best.tool, best_model: best.model,
        avg_turns: Math.round(avgTurns), avg_cache_hit: Math.round(avgCache),
        example_count: group.length, tips, examples: group.slice(0, 3),
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
