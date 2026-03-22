import { getDb, escapeLike } from '../db/index.js';

function extractProjectName(session: any): string | null {
    try {
        const raw = JSON.parse(session.raw_data || '{}');
        const p = raw.project || raw.projectPath || raw.projectDir || '';
        if (!p) return null;
        return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || null;
    } catch { return null; }
}

export function computeAllProjects() {
    const db = getDb();
    const sessions = db.prepare(`
        SELECT id, tool_id, primary_model, started_at, total_input_tokens, total_output_tokens, code_lines_added, raw_data
        FROM sessions ORDER BY started_at DESC
    `).all() as any[];

    const map = new Map<string, any>();
    for (const s of sessions) {
        const name = extractProjectName(s);
        if (!name) continue;
        if (!map.has(name)) map.set(name, { name, sessions: [], tokens: 0, linesAdded: 0, tools: {} as Record<string, number>, models: {} as Record<string, number>, monthly: {} as Record<string, number> });
        const p = map.get(name)!;
        p.sessions.push(s.id);
        p.tokens += (s.total_input_tokens || 0) + (s.total_output_tokens || 0);
        p.linesAdded += s.code_lines_added || 0;
        p.tools[s.tool_id] = (p.tools[s.tool_id] || 0) + 1;
        if (s.primary_model) p.models[s.primary_model] = (p.models[s.primary_model] || 0) + 1;
        const month = new Date(s.started_at || 0).toISOString().slice(0, 7);
        p.monthly[month] = (p.monthly[month] || 0) + 1;
    }

    return [...map.values()].map(p => ({
        name: p.name, session_count: p.sessions.length, total_tokens: p.tokens,
        total_lines_added: p.linesAdded,
        dominant_tool: Object.entries(p.tools).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || null,
        dominant_model: Object.entries(p.models).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || null,
        tool_breakdown: p.tools, model_breakdown: p.models, monthly_velocity: p.monthly,
    })).sort((a, b) => b.session_count - a.session_count);
}

export function computeProjectInsights(projectName: string) {
    const db = getDb();
    const escapedName = escapeLike(projectName);
    const sessions = db.prepare(`
        SELECT tool_id, primary_model, total_turns, first_attempt_pct, cache_hit_pct, quality_score, error_count
        FROM sessions WHERE raw_data LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 200
    `).all(`%${escapedName}%`) as any[];

    if (!sessions.length) return null;
    const combos: Record<string, any> = {};
    for (const s of sessions) {
        const key = `${s.tool_id}::${s.primary_model || 'unknown'}`;
        if (!combos[key]) combos[key] = { tool: s.tool_id, model: s.primary_model, n: 0, turns: 0, quality: 0, cache: 0 };
        const c = combos[key];
        c.n++; c.turns += s.total_turns || 0; c.quality += s.quality_score || 0; c.cache += s.cache_hit_pct || 0;
    }
    const toolModelStats = Object.values(combos).map((c: any) => ({
        tool: c.tool, model: c.model, sessions: c.n, avg_turns: c.n > 0 ? c.turns / c.n : 0,
        avg_quality: c.n > 0 ? c.quality / c.n : 0, avg_cache: c.n > 0 ? c.cache / c.n : 0,
    })).sort((a, b) => a.avg_turns - b.avg_turns);

    const all = computeAllProjects();
    const project = all.find(p => p.name.toLowerCase() === projectName.toLowerCase());
    return { ...(project || { name: projectName }), tool_model_stats: toolModelStats, session_sample_count: sessions.length };
}
