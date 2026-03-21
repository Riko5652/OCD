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
    if (!winRates.length) return { recommendation: null, reason: 'Not enough historical data yet.' };
    const best = winRates[0];
    return {
        recommendation: { tool: best.tool_id, model: best.model, task_type: best.task_type },
        win_rates: winRates.slice(0, 10),
        reason: `Based on ${best.sessions} similar sessions: ${best.tool_id} with ${best.model} resolves ${taskType} tasks in avg ${(best.avg_turns || 0).toFixed(1)} turns (${best.win_rate}% win rate).`,
    };
}
