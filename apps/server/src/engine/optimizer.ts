import { getDb } from '../db/index.js';
import { estimateCost, normalizeModel } from './model-normalizer.js';

interface PatternResult {
    severity: string; title: string; description: string;
    metric_value: number; threshold: number;
}

interface Pattern {
    id: string; category: string;
    check?: (session: any) => PatternResult | null;
    checkCohort?: (sessions: any[], commitScores?: any[]) => PatternResult | null;
}

const PATTERNS: Pattern[] = [
    {
        id: 'long-session', category: 'session-length',
        check: session => session.total_turns > 150 ? {
            severity: 'warning', title: 'Long session detected',
            description: `Session "${session.title || session.id}" has ${session.total_turns} turns. Context compression likely degrading quality.`,
            metric_value: session.total_turns, threshold: 150,
        } : null,
    },
    {
        id: 'poor-caching', category: 'caching',
        check: session => {
            if (session.tool_id !== 'claude-code') return null;
            if (session.cache_hit_pct != null && session.cache_hit_pct < 70) return {
                severity: session.cache_hit_pct < 50 ? 'critical' : 'warning',
                title: 'Poor prompt caching',
                description: `Cache hit rate ${session.cache_hit_pct.toFixed(1)}%. Stabilize CLAUDE.md, use targeted tool calls.`,
                metric_value: session.cache_hit_pct, threshold: 70,
            };
            return null;
        },
    },
    {
        id: 'bash-overuse', category: 'tool-use',
        check: session => {
            if (session.tool_id !== 'claude-code') return null;
            const tools = JSON.parse(session.top_tools || '[]');
            const bash = tools.find((t: any) => t[0] === 'Bash')?.[1] || 0;
            const read = tools.find((t: any) => t[0] === 'Read')?.[1] || 0;
            const grep = tools.find((t: any) => t[0] === 'Grep')?.[1] || 0;
            if (bash > (read + grep) * 2 && bash > 10) return {
                severity: 'info', title: 'Bash overuse for file reads',
                description: `${bash} Bash calls vs ${read + grep} Read/Grep calls. Dedicated tools have better caching.`,
                metric_value: bash, threshold: (read + grep) * 2,
            };
            return null;
        },
    },
    {
        id: 'no-subagents', category: 'tool-use',
        check: session => {
            if (session.tool_id !== 'claude-code' || session.total_turns < 30) return null;
            const tools = JSON.parse(session.top_tools || '[]');
            const agent = tools.find((t: any) => t[0] === 'Agent' || t[0] === 'Task')?.[1] || 0;
            if (agent === 0) return {
                severity: 'info', title: 'No subagent usage in long session',
                description: `${session.total_turns} turns with 0 Agent/Task calls. Parallelize multi-file tasks with subagents.`,
                metric_value: 0, threshold: 1,
            };
            return null;
        },
    },
    {
        id: 'session-abandonment', category: 'workflow',
        checkCohort: sessions => {
            const recent = sessions.slice(0, 20);
            const short = recent.filter(s => s.total_turns < 5).length;
            const pct = recent.length > 0 ? (short / recent.length) * 100 : 0;
            if (pct > 20) return {
                severity: 'info', title: 'High session abandonment rate',
                description: `${pct.toFixed(0)}% of recent sessions have <5 turns. Consider more specific initial prompts.`,
                metric_value: pct, threshold: 20
            };
            return null;
        },
    },
    {
        id: 'tool-bias', category: 'workflow',
        checkCohort: sessions => {
            if (sessions.length < 10) return null;
            const toolCounts: Record<string, number> = {};
            for (const s of sessions) toolCounts[s.tool_id] = (toolCounts[s.tool_id] || 0) + 1;
            for (const [tool, count] of Object.entries(toolCounts)) {
                const pct = (count / sessions.length) * 100;
                if (pct > 80) return {
                    severity: 'info', title: `Heavy ${tool} preference`,
                    description: `${pct.toFixed(0)}% of sessions use ${tool}. Try other tools for different task types.`,
                    metric_value: pct, threshold: 80
                };
            }
            return null;
        },
    },
    {
        id: 'ai-authorship-drop', category: 'productivity',
        checkCohort: (_sessions, commitScores) => {
            if (!commitScores || commitScores.length < 10) return null;
            const recent = commitScores.slice(0, 10);
            const older = commitScores.slice(10, 20);
            if (older.length < 5) return null;
            const recentAvg = recent.reduce((s: number, c: any) => s + (c.ai_percentage || 0), 0) / recent.length;
            const olderAvg = older.reduce((s: number, c: any) => s + (c.ai_percentage || 0), 0) / older.length;
            if (recentAvg < olderAvg - 15) return {
                severity: 'warning', title: 'AI authorship declining',
                description: `Recent AI authorship ${recentAvg.toFixed(0)}% vs earlier ${olderAvg.toFixed(0)}%.`,
                metric_value: recentAvg, threshold: olderAvg - 15
            };
            return null;
        },
    },
    // ---- Cost alerting patterns ----
    {
        id: 'daily-spend-spike', category: 'cost',
        checkCohort: sessions => {
            // Check if any single day in last 7 days exceeds $20
            const sevenDaysAgo = Date.now() - 7 * 86400000;
            const recent = sessions.filter((s: any) => s.started_at > sevenDaysAgo);
            if (recent.length < 3) return null;

            const dailyCosts: Record<string, number> = {};
            for (const s of recent) {
                const date = new Date(s.started_at).toISOString().slice(0, 10);
                const cost = estimateCost(s.primary_model, s.total_input_tokens || 0, s.total_output_tokens || 0, s.total_cache_read || 0);
                dailyCosts[date] = (dailyCosts[date] || 0) + cost.totalCost;
            }

            const maxDay = Object.entries(dailyCosts).sort((a, b) => b[1] - a[1])[0];
            if (maxDay && maxDay[1] > 20) return {
                severity: maxDay[1] > 50 ? 'critical' : 'warning',
                title: `High daily spend: $${maxDay[1].toFixed(2)} on ${maxDay[0]}`,
                description: `Single-day AI spend hit $${maxDay[1].toFixed(2)} on ${maxDay[0]}. Review model selection — cheaper models may produce equivalent quality for this task type.`,
                metric_value: maxDay[1], threshold: 20,
            };
            return null;
        },
    },
    {
        id: 'model-concentration', category: 'cost',
        checkCohort: sessions => {
            // Alert if one model accounts for >40% of total cost
            if (sessions.length < 10) return null;
            const modelCosts: Record<string, number> = {};
            let totalCost = 0;
            for (const s of sessions) {
                const canonical = normalizeModel(s.primary_model);
                const cost = estimateCost(canonical, s.total_input_tokens || 0, s.total_output_tokens || 0, s.total_cache_read || 0);
                modelCosts[canonical] = (modelCosts[canonical] || 0) + cost.totalCost;
                totalCost += cost.totalCost;
            }
            if (totalCost < 10) return null; // Not enough spend to matter

            const top = Object.entries(modelCosts).sort((a, b) => b[1] - a[1])[0];
            if (top) {
                const pct = (top[1] / totalCost) * 100;
                if (pct > 40) return {
                    severity: pct > 60 ? 'warning' : 'info',
                    title: `${top[0]} is ${pct.toFixed(0)}% of total spend ($${top[1].toFixed(2)})`,
                    description: `${top[0]} accounts for ${pct.toFixed(0)}% of your $${totalCost.toFixed(2)} total AI spend. Consider routing simpler tasks to cheaper models.`,
                    metric_value: pct, threshold: 40,
                };
            }
            return null;
        },
    },
    {
        id: 'expensive-low-quality', category: 'cost',
        check: session => {
            // Flag sessions that cost a lot but scored poorly
            const cost = estimateCost(session.primary_model, session.total_input_tokens || 0, session.total_output_tokens || 0, session.total_cache_read || 0);
            if (cost.totalCost < 2) return null; // Ignore cheap sessions
            const quality = session.quality_score || 0;
            if (quality > 0 && quality < 200 && cost.totalCost > 5) return {
                severity: 'warning',
                title: `$${cost.totalCost.toFixed(2)} session with low quality (${quality.toFixed(0)})`,
                description: `Session "${session.title || session.id}" cost ~$${cost.totalCost.toFixed(2)} using ${normalizeModel(session.primary_model)} but scored only ${quality.toFixed(0)} quality. Review if a cheaper model could handle this task type.`,
                metric_value: cost.totalCost, threshold: 5,
            };
            return null;
        },
    },
    {
        id: 'weekly-spend-trend', category: 'cost',
        checkCohort: sessions => {
            // Compare last 7 days vs prior 7 days
            const now = Date.now();
            const thisWeek = sessions.filter((s: any) => s.started_at > now - 7 * 86400000);
            const lastWeek = sessions.filter((s: any) => s.started_at > now - 14 * 86400000 && s.started_at <= now - 7 * 86400000);
            if (thisWeek.length < 3 || lastWeek.length < 3) return null;

            const costOf = (arr: any[]) => arr.reduce((sum: number, s: any) => {
                return sum + estimateCost(s.primary_model, s.total_input_tokens || 0, s.total_output_tokens || 0, s.total_cache_read || 0).totalCost;
            }, 0);

            const thisWeekCost = costOf(thisWeek);
            const lastWeekCost = costOf(lastWeek);
            if (lastWeekCost < 5) return null; // Not enough baseline

            const increase = ((thisWeekCost - lastWeekCost) / lastWeekCost) * 100;
            if (increase > 50) return {
                severity: increase > 100 ? 'critical' : 'warning',
                title: `Weekly spend up ${increase.toFixed(0)}%: $${thisWeekCost.toFixed(2)} vs $${lastWeekCost.toFixed(2)}`,
                description: `This week's AI spend ($${thisWeekCost.toFixed(2)}) is ${increase.toFixed(0)}% higher than last week ($${lastWeekCost.toFixed(2)}). Check if new models or increased usage are driving the spike.`,
                metric_value: increase, threshold: 50,
            };
            return null;
        },
    },
];

export function runOptimizer() {
    const db = getDb();
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50').all() as any[];
    const commitScores = db.prepare('SELECT * FROM commit_scores WHERE ai_percentage IS NOT NULL ORDER BY scored_at DESC LIMIT 30').all() as any[];

    const recommendations: any[] = [];
    const now = Date.now();

    for (const session of sessions.slice(0, 20)) {
        for (const pattern of PATTERNS) {
            if (!pattern.check) continue;
            const rec = pattern.check(session);
            if (rec) recommendations.push({ ...rec, created_at: now, tool_id: session.tool_id, category: pattern.category });
        }
    }
    for (const pattern of PATTERNS) {
        if (!pattern.checkCohort) continue;
        const rec = pattern.checkCohort(sessions, commitScores);
        if (rec) recommendations.push({ ...rec, created_at: now, tool_id: null, category: pattern.category });
    }

    db.prepare('DELETE FROM recommendations WHERE dismissed = 0').run();
    const insert = db.prepare('INSERT INTO recommendations (created_at, tool_id, category, severity, title, description, metric_value, threshold) VALUES (?,?,?,?,?,?,?,?)');
    for (const r of recommendations) insert.run(r.created_at, r.tool_id, r.category, r.severity, r.title, r.description, r.metric_value, r.threshold);
    return recommendations;
}
