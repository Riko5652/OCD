import { getDb } from '../db/index.js';

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
