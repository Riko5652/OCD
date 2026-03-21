import { getDb } from '../db/index.js';

export function computeProfile() {
    const db = getDb();
    const sessions = db.prepare(`
        SELECT total_turns, (ended_at - started_at) as duration_ms, tool_id, started_at, top_tools, quality_score
        FROM sessions WHERE started_at IS NOT NULL AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 200
    `).all() as any[];

    const sortedTurns = [...sessions].map(s => s.total_turns).sort((a, b) => a - b);
    const sortedDur = [...sessions].map(s => s.duration_ms / 60000).filter(d => d > 0).sort((a, b) => a - b);
    const medianTurns = sortedTurns[Math.floor(sortedTurns.length / 2)] || 0;
    const medianDurationMin = Math.round(sortedDur[Math.floor(sortedDur.length / 2)] || 0);

    const toolCounts: Record<string, number> = {};
    for (const s of sessions) toolCounts[s.tool_id] = (toolCounts[s.tool_id] || 0) + 1;
    const primaryTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '--';

    const hourCounts = Array(24).fill(0);
    for (const s of sessions) { if (s.started_at) hourCounts[new Date(s.started_at).getHours()]++; }
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

    const toolCallTotals: Record<string, number> = {};
    for (const s of sessions.filter(s => s.tool_id === 'claude-code')) {
        const tools = JSON.parse(s.top_tools || '[]');
        for (const [name, count] of tools) toolCallTotals[name] = (toolCallTotals[name] || 0) + count;
    }
    const totalToolCalls = Object.values(toolCallTotals).reduce((a, b) => a + b, 0);
    const toolBreakdown = Object.entries(toolCallTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([name, count]) => ({ name, count, pct: totalToolCalls ? Math.round(count / totalToolCalls * 100) : 0 }));

    const pm = db.prepare(`
        SELECT pm.has_file_context, pm.constraint_count, pm.first_turn_tokens, s.quality_score
        FROM prompt_metrics pm JOIN sessions s ON pm.session_id = s.id ORDER BY s.started_at DESC LIMIT 200
    `).all() as any[];

    const fileContextRate = pm.length ? Math.round(pm.filter(r => r.has_file_context).length / pm.length * 100) : 0;
    const constrainedRate = pm.length ? Math.round(pm.filter(r => r.constraint_count > 0).length / pm.length * 100) : 0;
    const withFile = pm.filter(r => r.has_file_context && r.quality_score);
    const withoutFile = pm.filter(r => !r.has_file_context && r.quality_score);
    const avgQWithFile = withFile.length ? (withFile.reduce((a, r) => a + r.quality_score, 0) / withFile.length).toFixed(1) : null;
    const avgQWithoutFile = withoutFile.length ? (withoutFile.reduce((a, r) => a + r.quality_score, 0) / withoutFile.length).toFixed(1) : null;

    return {
        medianTurns, medianDurationMin, primaryTool, peakHour, toolBreakdown, fileContextRate,
        constrainedRate, avgQWithFile, avgQWithoutFile, sessionCount: sessions.length
    };
}

export function computeTrends(days = 0) {
    const db = getDb();
    let daily: any[];
    if (!days || days <= 0) {
        daily = db.prepare(`SELECT date, AVG(avg_cache_hit_pct) as cache_hit, AVG(avg_quality_score) as quality,
            SUM(total_turns) as turns, AVG(avg_latency_ms) as latency FROM daily_stats GROUP BY date ORDER BY date ASC`).all() as any[];
    } else {
        const since = new Date(); since.setDate(since.getDate() - days);
        daily = db.prepare(`SELECT date, AVG(avg_cache_hit_pct) as cache_hit, AVG(avg_quality_score) as quality,
            SUM(total_turns) as turns, AVG(avg_latency_ms) as latency FROM daily_stats WHERE date >= ? GROUP BY date ORDER BY date ASC`).all(since.toISOString().split('T')[0]) as any[];
    }

    function rolling7(arr: any[], key: string) {
        return arr.map((row, i) => {
            const window = arr.slice(Math.max(0, i - 6), i + 1);
            const valid = window.map(r => r[key]).filter((v: any) => v != null);
            return { date: row.date, value: valid.length ? valid.reduce((a: number, b: number) => a + b, 0) / valid.length : null };
        });
    }
    return { cacheHit: rolling7(daily, 'cache_hit'), quality: rolling7(daily, 'quality') };
}

export function computePromptMetrics() {
    const db = getDb();
    const rows = db.prepare(`
        SELECT pm.*, s.quality_score, s.total_turns, s.cache_hit_pct
        FROM prompt_metrics pm JOIN sessions s ON pm.session_id = s.id
        WHERE s.quality_score IS NOT NULL ORDER BY s.started_at DESC LIMIT 300
    `).all() as any[];
    if (!rows.length) return { correlations: [], avgTurnsToFirstEdit: null, totalSessions: 0 };

    function avgQ(subset: any[]) {
        return subset.length ? Math.round(subset.reduce((a, r) => a + r.quality_score, 0) / subset.length * 10) / 10 : null;
    }
    const correlations = [
        {
            signal: 'File context in first turn', with: avgQ(rows.filter(r => r.has_file_context)), without: avgQ(rows.filter(r => !r.has_file_context)),
            rate: Math.round(rows.filter(r => r.has_file_context).length / rows.length * 100)
        },
        {
            signal: 'Constraints in first turn', with: avgQ(rows.filter(r => r.constraint_count > 0)), without: avgQ(rows.filter(r => r.constraint_count === 0)),
            rate: Math.round(rows.filter(r => r.constraint_count > 0).length / rows.length * 100)
        },
        {
            signal: 'Long prompt (>500 tok)', with: avgQ(rows.filter(r => r.first_turn_tokens > 500)), without: avgQ(rows.filter(r => r.first_turn_tokens < 200)),
            rate: Math.round(rows.filter(r => r.first_turn_tokens > 500).length / rows.length * 100)
        },
    ];

    const editable = rows.filter(r => r.turns_to_first_edit != null);
    const avgTurnsToFirstEdit = editable.length ? Math.round(editable.reduce((a, r) => a + r.turns_to_first_edit, 0) / editable.length * 10) / 10 : null;
    return { correlations, avgTurnsToFirstEdit, totalSessions: rows.length };
}
