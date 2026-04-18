// Cross-tool analytics engine — KPIs, aggregation, comparisons
import { getDb } from '../db/index.js';
import { estimateCost, normalizeModel } from './model-normalizer.js';

export { estimateCost };

export function computeOverview() {
    const db = getDb();
    const toolStats = db.prepare(`
        SELECT tool_id,
            COUNT(*) as sessions,
            SUM(total_turns) as total_turns,
            SUM(total_input_tokens) as input_tokens,
            SUM(total_output_tokens) as output_tokens,
            SUM(total_cache_read) as cache_read,
            AVG(cache_hit_pct) as avg_cache_hit,
            AVG(avg_latency_ms) as avg_latency,
            SUM(code_lines_added) as lines_added,
            SUM(code_lines_removed) as lines_removed,
            SUM(files_touched) as files_touched,
            AVG(quality_score) as avg_quality,
            AVG(agentic_score) as avg_agentic,
            AVG(first_attempt_pct) as avg_first_attempt,
            MAX(started_at) as last_session
        FROM sessions
        GROUP BY tool_id
    `).all() as any[];

    const global = db.prepare(`
        SELECT COUNT(*) as total_sessions,
            SUM(total_turns) as total_turns,
            SUM(total_input_tokens) as total_input,
            SUM(total_output_tokens) as total_output,
            SUM(total_cache_read) as total_cache,
            SUM(total_cache_create) as total_cache_create,
            AVG(cache_hit_pct) as avg_cache_hit,
            AVG(quality_score) as avg_quality,
            SUM(code_lines_added) as total_lines_added,
            SUM(files_touched) as total_files_touched
        FROM sessions
    `).get() as any;

    // Gross = every token the model saw. Effective = billing-weight equivalent
    // (cache reads at 0.1×, cache writes at 1.25× — Anthropic-style pricing).
    const input = global.total_input || 0;
    const output = global.total_output || 0;
    const cacheRead = global.total_cache || 0;
    const cacheCreate = global.total_cache_create || 0;
    global.total_gross = input + output + cacheRead + cacheCreate;
    global.total_effective = Math.round(input + output + cacheRead * 0.1 + cacheCreate * 1.25);
    global.effective_input = Math.round(input + cacheRead * 0.1 + cacheCreate * 1.25);

    const daily = db.prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date,
            COUNT(*) as sessions,
            SUM(total_turns) as turns,
            SUM(total_output_tokens) as output_tokens,
            AVG(quality_score) as avg_quality
        FROM sessions
        WHERE started_at > ?
        GROUP BY date ORDER BY date
    `).all(Date.now() - 30 * 86400000) as any[];

    return { tools: toolStats, global, daily };
}

export function computeToolComparison() {
    const db = getDb();
    return db.prepare(`
        SELECT tool_id,
            COUNT(*) as sessions,
            SUM(total_turns) as total_turns,
            SUM(total_output_tokens) as output_tokens,
            AVG(cache_hit_pct) as avg_cache_hit,
            AVG(quality_score) as avg_quality,
            AVG(agentic_score) as avg_agentic,
            SUM(code_lines_added) as lines_added,
            SUM(files_touched) as files_touched,
            AVG(avg_latency_ms) as avg_latency,
            SUM(error_count) as total_errors,
            AVG(first_attempt_pct) as avg_first_attempt
        FROM sessions
        GROUP BY tool_id ORDER BY sessions DESC
    `).all();
}

export function computeModelUsage() {
    const db = getDb();
    const raw = db.prepare(`
        SELECT primary_model as model,
            COUNT(*) as sessions,
            SUM(total_turns) as total_turns,
            SUM(total_input_tokens) as input_tokens,
            SUM(total_output_tokens) as output_tokens,
            SUM(total_cache_read) as cache_read,
            AVG(quality_score) as avg_quality
        FROM sessions
        WHERE primary_model IS NOT NULL
        GROUP BY primary_model ORDER BY sessions DESC
    `).all() as any[];

    // Aggregate by normalized model name
    const grouped: Record<string, any> = {};
    for (const r of raw) {
        const canonical = normalizeModel(r.model);
        if (!grouped[canonical]) {
            grouped[canonical] = { model: canonical, sessions: 0, total_turns: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, quality_sum: 0, raw_slugs: [] };
        }
        const g = grouped[canonical];
        g.sessions += r.sessions;
        g.total_turns += r.total_turns || 0;
        g.input_tokens += r.input_tokens || 0;
        g.output_tokens += r.output_tokens || 0;
        g.cache_read += r.cache_read || 0;
        g.quality_sum += (r.avg_quality || 0) * r.sessions;
        g.raw_slugs.push(r.model);
    }

    return Object.values(grouped).map((g: any) => {
        const cost = estimateCost(g.model, g.input_tokens, g.output_tokens, g.cache_read);
        return {
            model: g.model,
            sessions: g.sessions,
            total_turns: g.total_turns,
            input_tokens: g.input_tokens,
            output_tokens: g.output_tokens,
            avg_quality: g.sessions > 0 ? g.quality_sum / g.sessions : 0,
            estimated_cost: Math.round(cost.totalCost * 100) / 100,
            cache_savings: Math.round(cost.cacheSavings * 100) / 100,
            raw_slugs: g.raw_slugs,
        };
    }).sort((a: any, b: any) => b.estimated_cost - a.estimated_cost);
}

export function computeCodeGeneration() {
    const db = getDb();
    const byTool = db.prepare(`
        SELECT tool_id,
            SUM(code_lines_added) as lines_added,
            SUM(code_lines_removed) as lines_removed,
            SUM(files_touched) as files_touched,
            AVG(first_attempt_pct) as avg_first_attempt,
            COUNT(*) as sessions
        FROM sessions
        WHERE code_lines_added > 0
        GROUP BY tool_id ORDER BY lines_added DESC
    `).all();

    const commits = db.prepare(`
        SELECT branch,
            COUNT(*) as commits,
            SUM(lines_added) as lines_added,
            SUM(lines_deleted) as lines_deleted,
            SUM(ai_lines_added) as ai_lines_added,
            AVG(ai_percentage) as avg_ai_pct
        FROM commit_scores
        GROUP BY branch ORDER BY commits DESC
    `).all();

    return { byTool, commits };
}

export function dbGetCommitScores(limit: number = 100) {
    const db = getDb();
    return db.prepare('SELECT * FROM commit_scores ORDER BY scored_at DESC LIMIT ?').all(limit);
}

export function computeInsights() {
    const db = getDb();
    const thinkingStats = db.prepare(`
        SELECT tool_id,
            AVG(avg_thinking_length) as avg_thinking,
            AVG(error_count) as avg_errors,
            AVG(error_recovery_pct) as avg_recovery,
            AVG(first_attempt_pct) as avg_first_attempt,
            COUNT(*) as sessions
        FROM sessions
        WHERE avg_thinking_length IS NOT NULL
        GROUP BY tool_id
    `).all();

    const errorSessions = db.prepare(`
        SELECT id, tool_id, title, error_count, error_recovery_pct, total_turns, primary_model
        FROM sessions
        WHERE error_count > 0
        ORDER BY error_count DESC LIMIT 20
    `).all();

    return { thinkingStats, errorSessions };
}

export function computeCostAnalysis() {
    const db = getDb();
    const byModel = db.prepare(`
        SELECT primary_model as model,
            SUM(total_input_tokens) as input_tokens,
            SUM(total_output_tokens) as output_tokens,
            SUM(total_cache_read) as cache_read,
            COUNT(*) as sessions
        FROM sessions
        WHERE primary_model IS NOT NULL
        GROUP BY primary_model ORDER BY output_tokens DESC
    `).all() as any[];

    // Aggregate by normalized model name for accurate cost
    const grouped: Record<string, any> = {};
    for (const m of byModel) {
        const canonical = normalizeModel(m.model);
        if (!grouped[canonical]) {
            grouped[canonical] = { model: canonical, input_tokens: 0, output_tokens: 0, cache_read: 0, sessions: 0 };
        }
        grouped[canonical].input_tokens += m.input_tokens || 0;
        grouped[canonical].output_tokens += m.output_tokens || 0;
        grouped[canonical].cache_read += m.cache_read || 0;
        grouped[canonical].sessions += m.sessions;
    }

    const costs = Object.values(grouped).map((m: any) => ({
        ...m,
        ...estimateCost(m.model, m.input_tokens, m.output_tokens, m.cache_read),
    }));

    costs.sort((a: any, b: any) => b.totalCost - a.totalCost);
    const totalCost = costs.reduce((s: number, c: any) => s + c.totalCost, 0);
    const totalSavings = costs.reduce((s: number, c: any) => s + c.cacheSavings, 0);

    // Daily cost breakdown (last 30 days)
    const dailyRaw = db.prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date,
            primary_model as model,
            SUM(total_input_tokens) as input_tokens,
            SUM(total_output_tokens) as output_tokens,
            SUM(total_cache_read) as cache_read
        FROM sessions
        WHERE started_at > ?
        GROUP BY date, primary_model ORDER BY date
    `).all(Date.now() - 30 * 86400000) as any[];

    const dailyCosts: Record<string, { date: string; cost: number; models: Record<string, number> }> = {};
    for (const row of dailyRaw) {
        if (!dailyCosts[row.date]) dailyCosts[row.date] = { date: row.date, cost: 0, models: {} };
        const canonical = normalizeModel(row.model);
        const cost = estimateCost(canonical, row.input_tokens || 0, row.output_tokens || 0, row.cache_read || 0);
        dailyCosts[row.date].cost += cost.totalCost;
        dailyCosts[row.date].models[canonical] = (dailyCosts[row.date].models[canonical] || 0) + cost.totalCost;
    }

    return {
        costs,
        totalCost: Math.round(totalCost * 100) / 100,
        totalSavings: Math.round(totalSavings * 100) / 100,
        daily: Object.values(dailyCosts).map(d => ({
            ...d,
            cost: Math.round(d.cost * 100) / 100,
        })),
    };
}

export function computePersonalInsights() {
    const db = getDb();

    const stats = db.prepare(`
        SELECT COUNT(*) as totalSessions,
            SUM(total_output_tokens) as totalOutputTokens,
            SUM(total_turns) as totalTurns,
            AVG(quality_score) as avgQuality,
            MAX(files_touched) as maxFilesInSession,
            MAX(total_turns) as maxTurns,
            SUM(code_lines_added) as totalLinesAdded
        FROM sessions
    `).get() as any;

    // Flow state: sessions with quality > 70 and turns between 10-100
    const flowCount = (db.prepare(`
        SELECT COUNT(*) as cnt FROM sessions WHERE quality_score > 70 AND total_turns BETWEEN 10 AND 100
    `).get() as any)?.cnt || 0;

    // Tools used
    const toolsUsed = (db.prepare(`
        SELECT COUNT(DISTINCT tool_id) as cnt FROM sessions
    `).get() as any)?.cnt || 0;

    // Days with 3+ tools
    const polyglotDays = (db.prepare(`
        SELECT COUNT(*) as cnt FROM (
            SELECT date(started_at/1000, 'unixepoch') as d, COUNT(DISTINCT tool_id) as tools
            FROM sessions GROUP BY d HAVING tools >= 3
        )
    `).get() as any)?.cnt || 0;

    // Max AI percentage from commits
    const maxAiPct = (db.prepare(`
        SELECT MAX(ai_percentage) as pct FROM commit_scores
    `).get() as any)?.pct || 0;

    // Streak tracking
    const activeDays = db.prepare(`
        SELECT DISTINCT date(started_at/1000, 'unixepoch') as d
        FROM sessions ORDER BY d DESC LIMIT 365
    `).all() as any[];

    let streak = 0;
    const today = new Date().toISOString().slice(0, 10);
    const daySet = new Set(activeDays.map((r: any) => r.d));
    const currentDate = new Date();
    for (let i = 0; i < 365; i++) {
        const d = new Date(currentDate);
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        if (daySet.has(ds)) streak++;
        else if (i > 0) break; // Allow today to be missing
    }

    // XP and level
    const xp = (stats.totalSessions || 0) * 10 + Math.floor((stats.totalOutputTokens || 0) / 10000) + flowCount * 25;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;

    // Rank titles
    const RANK_TITLES: [number, string][] = [
        [1, 'Novice'], [3, 'Apprentice'], [5, 'Practitioner'], [8, 'Engineer'],
        [11, 'Architect'], [15, 'Master'], [20, 'Grandmaster'], [25, 'Legend'], [30, 'Mythic'],
    ];
    let rank = 'Novice';
    for (const [lvl, title] of RANK_TITLES) {
        if (level >= lvl) rank = title;
    }

    // Achievements
    const achievementStats = { ...stats, flowCount, toolsUsed, polyglotDays, maxAiPct, maxTurns: stats.maxTurns || 0, maxFilesInSession: stats.maxFilesInSession || 0 };
    const ACHIEVEMENTS = [
        { id: 'sessions-100', cat: 'Volume', icon: '🎯', title: '100 Sessions', desc: 'Complete 100 sessions', check: (s: any) => s.totalSessions >= 100 },
        { id: 'sessions-500', cat: 'Volume', icon: '🏆', title: '500 Sessions', desc: 'Complete 500 sessions', check: (s: any) => s.totalSessions >= 500 },
        { id: 'tokens-1m', cat: 'Volume', icon: '🪙', title: '1M Tokens', desc: 'Use 1M output tokens', check: (s: any) => s.totalOutputTokens >= 1000000 },
        { id: 'flow-10', cat: 'Quality', icon: '🧘', title: 'Flow Finder', desc: '10 flow sessions', check: (s: any) => s.flowCount >= 10 },
        { id: 'flow-50', cat: 'Quality', icon: '🌊', title: 'Flow Master', desc: '50 flow sessions', check: (s: any) => s.flowCount >= 50 },
        { id: 'multi-tool', cat: 'Tools', icon: '🔀', title: 'Multi Tool', desc: 'Use 3+ AI tools', check: (s: any) => s.toolsUsed >= 3 },
        { id: 'polyglot', cat: 'Tools', icon: '🌐', title: 'Polyglot', desc: 'Use 3+ tools in one day', check: (s: any) => s.polyglotDays >= 1 },
        { id: 'mega-session', cat: 'Scale', icon: '🗂️', title: 'Mega Session', desc: '50+ files in one session', check: (s: any) => s.maxFilesInSession >= 50 },
        { id: 'marathon', cat: 'Scale', icon: '🏃', title: 'Marathon', desc: '500+ turns in a session', check: (s: any) => s.maxTurns >= 500 },
        { id: 'pure-ai', cat: 'Scale', icon: '🤯', title: 'Pure AI', desc: '95%+ AI authorship commit', check: (s: any) => s.maxAiPct >= 95 },
    ];

    const unlocked = ACHIEVEMENTS.filter(a => a.check(achievementStats)).map(a => ({ id: a.id, cat: a.cat, icon: a.icon, title: a.title, desc: a.desc }));

    // Activity heatmap (last 365 days)
    const heatmap = db.prepare(`
        SELECT date(started_at/1000, 'unixepoch') as date,
            COUNT(*) as sessions,
            SUM(total_output_tokens) as output_tokens
        FROM sessions
        WHERE started_at > ?
        GROUP BY date ORDER BY date
    `).all(Date.now() - 365 * 86400000);

    return {
        xp, level, rank, streak, flowCount, toolsUsed,
        totalSessions: stats.totalSessions || 0,
        totalOutputTokens: stats.totalOutputTokens || 0,
        totalLinesAdded: stats.totalLinesAdded || 0,
        achievements: { unlocked, total: ACHIEVEMENTS.length },
        heatmap,
    };
}

export function rebuildDailyStats() {
    const db = getDb();
    db.prepare('DELETE FROM daily_stats').run();
    db.prepare(`
        INSERT INTO daily_stats (date, tool_id, sessions, total_turns, total_input_tokens, total_output_tokens, avg_cache_hit_pct, avg_latency_ms, avg_quality_score)
        SELECT date(started_at/1000, 'unixepoch') as d, tool_id,
            COUNT(*), SUM(total_turns), SUM(total_input_tokens), SUM(total_output_tokens),
            AVG(cache_hit_pct), AVG(avg_latency_ms), AVG(quality_score)
        FROM sessions
        GROUP BY d, tool_id
    `).run();
}
