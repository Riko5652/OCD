// Token budget tracker — burn rate, forecasts, and efficiency tips
import { getDb } from '../db/index.js';

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    'claude-opus-4-6': { input: 15.00, output: 75.00 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    'gpt-5.1-codex-max': { input: 2.50, output: 10.00 },
    '_default': { input: 1.00, output: 4.00 },
};

function pricingFor(model: string | null) {
    return MODEL_PRICING[model || ''] || MODEL_PRICING['_default'];
}

export function computeTokenBudget() {
    const db = getDb();

    // Daily token usage for last 14 days
    const dailyUsage = db.prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date,
            SUM(total_input_tokens) as input_tokens,
            SUM(total_output_tokens) as output_tokens,
            SUM(total_cache_read) as cache_tokens,
            COUNT(*) as sessions,
            SUM(total_turns) as turns
        FROM sessions
        WHERE started_at > ?
        GROUP BY date ORDER BY date
    `).all(Date.now() - 14 * 86400000) as any[];

    // Today's usage
    const todayStr = new Date().toISOString().slice(0, 10);
    const today = dailyUsage.find(d => d.date === todayStr) || { input_tokens: 0, output_tokens: 0, cache_tokens: 0, sessions: 0, turns: 0 };

    // 7-day averages
    const last7 = dailyUsage.slice(-7);
    const avgDailyInput = last7.length ? last7.reduce((s: number, d: any) => s + (d.input_tokens || 0), 0) / last7.length : 0;
    const avgDailyOutput = last7.length ? last7.reduce((s: number, d: any) => s + (d.output_tokens || 0), 0) / last7.length : 0;
    const avgDailySessions = last7.length ? last7.reduce((s: number, d: any) => s + (d.sessions || 0), 0) / last7.length : 0;
    const avgDailyTurns = last7.length ? last7.reduce((s: number, d: any) => s + (d.turns || 0), 0) / last7.length : 0;

    // Cost per day
    const dailyCosts = dailyUsage.map(d => {
        // Estimate cost using default pricing (we don't track model per day in this query)
        const pricing = MODEL_PRICING['_default'];
        return {
            date: d.date,
            cost: ((d.input_tokens || 0) / 1_000_000) * pricing.input + ((d.output_tokens || 0) / 1_000_000) * pricing.output,
            tokens: (d.input_tokens || 0) + (d.output_tokens || 0),
            sessions: d.sessions,
        };
    });

    const avgDailyCost = dailyCosts.length ? dailyCosts.reduce((s, d) => s + d.cost, 0) / dailyCosts.length : 0;

    // Weekly forecast
    const weeklyForecast = {
        tokens: Math.round((avgDailyInput + avgDailyOutput) * 7),
        cost: Math.round(avgDailyCost * 7 * 100) / 100,
        sessions: Math.round(avgDailySessions * 7),
    };

    // Token waste detection — sessions with high turn counts and low quality
    const wastefulSessions = db.prepare(`
        SELECT id, tool_id, primary_model, total_turns, total_input_tokens, total_output_tokens,
            cache_hit_pct, quality_score, title
        FROM sessions
        WHERE started_at > ? AND total_turns > 10
        ORDER BY (total_input_tokens + total_output_tokens) DESC LIMIT 5
    `).all(Date.now() - 7 * 86400000) as any[];

    // Tokens per quality point — efficiency metric
    const efficiencyByTool = db.prepare(`
        SELECT tool_id,
            AVG(CAST(total_input_tokens + total_output_tokens AS REAL) / NULLIF(quality_score, 0)) as tokens_per_quality,
            AVG(quality_score) as avg_quality,
            AVG(total_turns) as avg_turns,
            AVG(cache_hit_pct) as avg_cache,
            COUNT(*) as sessions
        FROM sessions
        WHERE started_at > ? AND quality_score > 0
        GROUP BY tool_id ORDER BY tokens_per_quality ASC
    `).all(Date.now() - 30 * 86400000) as any[];

    // Quick wins — top 3 actionable token-saving tips
    const quickWins = generateQuickWins(db);

    return {
        today: {
            input_tokens: today.input_tokens || 0,
            output_tokens: today.output_tokens || 0,
            cache_tokens: today.cache_tokens || 0,
            sessions: today.sessions || 0,
            turns: today.turns || 0,
        },
        daily_avg: {
            input_tokens: Math.round(avgDailyInput),
            output_tokens: Math.round(avgDailyOutput),
            sessions: Math.round(avgDailySessions * 10) / 10,
            turns: Math.round(avgDailyTurns),
            cost: Math.round(avgDailyCost * 100) / 100,
        },
        weekly_forecast: weeklyForecast,
        daily_trend: dailyCosts,
        top_consumers: wastefulSessions.map(s => ({
            id: s.id,
            tool: s.tool_id,
            model: s.primary_model,
            turns: s.total_turns,
            tokens: (s.total_input_tokens || 0) + (s.total_output_tokens || 0),
            cache_hit: Math.round(s.cache_hit_pct || 0),
            quality: Math.round(s.quality_score || 0),
            title: s.title?.slice(0, 60),
        })),
        efficiency_by_tool: efficiencyByTool.map(t => ({
            tool: t.tool_id,
            tokens_per_quality_point: Math.round(t.tokens_per_quality || 0),
            avg_quality: Math.round(t.avg_quality || 0),
            avg_turns: Math.round(t.avg_turns || 0),
            avg_cache: Math.round(t.avg_cache || 0),
            sessions: t.sessions,
        })),
        quick_wins: quickWins,
    };
}

function generateQuickWins(db: any): Array<{ tip: string; impact: string; priority: number }> {
    const wins: Array<{ tip: string; impact: string; priority: number }> = [];

    // 1. Check cache hit rate
    const cacheStats = db.prepare(`
        SELECT AVG(cache_hit_pct) as avg_cache, COUNT(*) as n
        FROM sessions WHERE started_at > ? AND cache_hit_pct IS NOT NULL
    `).get(Date.now() - 7 * 86400000) as any;

    if (cacheStats && cacheStats.avg_cache < 50 && cacheStats.n > 3) {
        wins.push({
            tip: 'Include file paths and code context in your first message to prime the prompt cache.',
            impact: `Cache hit is ${Math.round(cacheStats.avg_cache)}%. Getting to 60%+ saves ~${Math.round((60 - cacheStats.avg_cache) * 0.5)}% of input token costs.`,
            priority: 1,
        });
    }

    // 2. Check for long sessions
    const longSessions = db.prepare(`
        SELECT COUNT(*) as n, AVG(total_turns) as avg_turns
        FROM sessions WHERE started_at > ? AND total_turns > 80
    `).get(Date.now() - 7 * 86400000) as any;

    if (longSessions && longSessions.n > 0) {
        wins.push({
            tip: `Break long sessions into focused sub-tasks. ${longSessions.n} sessions exceeded 80 turns this week.`,
            impact: `Sessions >80 turns have 2x lower quality scores. Splitting saves tokens and improves output.`,
            priority: 2,
        });
    }

    // 3. Check for abandoned sessions (wasted tokens)
    const abandoned = db.prepare(`
        SELECT COUNT(*) as n,
            SUM(total_input_tokens + total_output_tokens) as wasted_tokens
        FROM sessions WHERE started_at > ? AND total_turns < 3 AND total_turns > 0
    `).get(Date.now() - 7 * 86400000) as any;

    if (abandoned && abandoned.n > 2) {
        const wastedK = Math.round((abandoned.wasted_tokens || 0) / 1000);
        wins.push({
            tip: `${abandoned.n} sessions abandoned after 1-2 turns this week. Write more specific first prompts.`,
            impact: `~${wastedK}K tokens spent on sessions that produced nothing useful.`,
            priority: 3,
        });
    }

    // 4. Check for Bash overuse (tokens wasted on cat/grep via Bash instead of native tools)
    const bashOveruse = db.prepare(`
        SELECT COUNT(*) as n FROM sessions
        WHERE started_at > ? AND tool_id = 'claude-code' AND top_tools LIKE '%Bash%'
    `).get(Date.now() - 7 * 86400000) as any;

    if (bashOveruse && bashOveruse.n > 5) {
        wins.push({
            tip: 'Use Read/Grep/Glob instead of Bash for file operations — native tools cache better.',
            impact: 'Native tools avoid re-sending full outputs through context. Better cache hit rate.',
            priority: 4,
        });
    }

    // 5. Check if subagents could help
    const noSubagents = db.prepare(`
        SELECT COUNT(*) as n FROM sessions
        WHERE started_at > ? AND tool_id = 'claude-code'
            AND total_turns > 30 AND top_tools NOT LIKE '%Agent%'
    `).get(Date.now() - 7 * 86400000) as any;

    if (noSubagents && noSubagents.n > 2) {
        wins.push({
            tip: `${noSubagents.n} long sessions without subagent parallelization. Use Agent tool for multi-file tasks.`,
            impact: 'Subagents split context windows, reducing main-thread token consumption.',
            priority: 5,
        });
    }

    // 6. Single-tool user: model-level optimization tips
    const toolDistribution = db.prepare(`
        SELECT tool_id, COUNT(*) as sessions FROM sessions
        WHERE started_at > ? GROUP BY tool_id ORDER BY sessions DESC
    `).all(Date.now() - 30 * 86400000) as any[];

    if (toolDistribution.length === 1) {
        const tool = toolDistribution[0].tool_id;
        const modelPerf = db.prepare(`
            SELECT primary_model,
                AVG(CAST(total_input_tokens + total_output_tokens AS REAL) / NULLIF(quality_score, 0)) as cost_per_quality,
                AVG(quality_score) as avg_quality, COUNT(*) as sessions
            FROM sessions WHERE tool_id = ? AND quality_score > 0 AND started_at > ?
            GROUP BY primary_model HAVING sessions >= 2 ORDER BY cost_per_quality ASC
        `).all(tool, Date.now() - 30 * 86400000) as any[];

        if (modelPerf.length >= 2) {
            const cheapest = modelPerf[0];
            const priciest = modelPerf[modelPerf.length - 1];
            if (cheapest.primary_model !== priciest.primary_model) {
                const qualityDiff = Math.abs((priciest.avg_quality || 0) - (cheapest.avg_quality || 0));
                if (qualityDiff < 10) {
                    wins.push({
                        tip: `Switch to ${cheapest.primary_model} for routine tasks — similar quality to ${priciest.primary_model} at ${Math.round(((priciest.cost_per_quality || 0) - (cheapest.cost_per_quality || 0)) / (priciest.cost_per_quality || 1) * 100)}% less cost.`,
                        impact: `Quality: ${Math.round(cheapest.avg_quality)} vs ${Math.round(priciest.avg_quality)} (negligible difference). Cost efficiency: ${Math.round(cheapest.cost_per_quality)} vs ${Math.round(priciest.cost_per_quality)} tokens/quality.`,
                        priority: 6,
                    });
                }
            }
        }

        // Single-tool specific tips
        if (tool === 'claude-code') {
            const noThinkingMode = db.prepare(`
                SELECT COUNT(*) as n FROM sessions
                WHERE tool_id = 'claude-code' AND started_at > ?
                AND raw_data LIKE '%thinking_to_output_ratio%' AND raw_data LIKE '%null%'
            `).get(Date.now() - 7 * 86400000) as any;
            if (noThinkingMode && noThinkingMode.n > 3) {
                wins.push({
                    tip: 'Enable extended thinking for complex debugging — sessions with thinking mode have higher first-attempt success rates.',
                    impact: 'Thinking tokens cost the same but reduce back-and-forth iterations.',
                    priority: 7,
                });
            }
        } else if (tool === 'cursor') {
            wins.push({
                tip: 'Use Composer for multi-file edits, and review Cursor\'s token usage in Settings > Usage to track model costs.',
                impact: 'Composer batches changes, reducing per-file context overhead.',
                priority: 7,
            });
        } else if (tool === 'copilot') {
            const lowAcceptance = db.prepare(`
                SELECT AVG(CAST(json_extract(raw_data, '$.suggestion_acceptance_pct') AS REAL)) as avg_accept
                FROM sessions WHERE tool_id = 'copilot' AND raw_data LIKE '%suggestion_acceptance_pct%' AND started_at > ?
            `).get(Date.now() - 7 * 86400000) as any;
            if (lowAcceptance && lowAcceptance.avg_accept < 25) {
                wins.push({
                    tip: `Inline suggestion acceptance is ${Math.round(lowAcceptance.avg_accept)}%. Write clearer function signatures and comments — Copilot uses them as context for better completions.`,
                    impact: 'Higher acceptance rate means fewer manual corrections and faster coding flow.',
                    priority: 7,
                });
            }
        }
    }

    return wins.sort((a, b) => a.priority - b.priority).slice(0, 5);
}
