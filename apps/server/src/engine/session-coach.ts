import { getDb } from '../db/index.js';

interface CoachRule {
    id: string;
    check: (s: any) => boolean;
    message: (s: any) => string;
    severity: 'tip' | 'warning' | 'info';
}

const COACH_RULES: CoachRule[] = [
    {
        id: 'long-session',
        check: s => (s.total_turns || 0) > 80,
        message: s => `Session has ${s.total_turns} turns — consider breaking into smaller focused sessions. Sessions >80 turns have 2x lower quality scores on average.`,
        severity: 'warning',
    },
    {
        id: 'low-cache',
        check: s => (s.cache_hit_pct || 0) < 30 && (s.total_turns || 0) > 5,
        message: s => `Cache hit rate is ${Math.round(s.cache_hit_pct || 0)}% — add context to your first prompt to prime the cache. Target: >60%.`,
        severity: 'tip',
    },
    {
        id: 'error-spike',
        check: s => (s.error_count || 0) > 0 && (s.error_count / (s.total_turns || 1)) > 0.4,
        message: s => `${s.error_count} errors in ${s.total_turns} turns (${Math.round(s.error_count / s.total_turns * 100)}% error rate) — consider switching tools or models.`,
        severity: 'warning',
    },
    {
        id: 'high-token-burn',
        check: s => {
            const totalTokens = (s.total_input_tokens || 0) + (s.total_output_tokens || 0);
            return totalTokens > 500_000 && (s.total_turns || 0) > 10;
        },
        message: s => {
            const totalK = Math.round(((s.total_input_tokens || 0) + (s.total_output_tokens || 0)) / 1000);
            return `Session has consumed ${totalK}K tokens in ${s.total_turns} turns. Consider breaking into sub-tasks to manage context window growth.`;
        },
        severity: 'warning',
    },
    {
        id: 'poor-cache-active',
        check: s => (s.cache_hit_pct || 0) < 20 && (s.total_turns || 0) > 10,
        message: s => `Cache hit rate is only ${Math.round(s.cache_hit_pct || 0)}% after ${s.total_turns} turns. Stabilize your CLAUDE.md and use targeted tool calls to improve caching.`,
        severity: 'warning',
    },
    {
        id: 'stale-session',
        check: s => {
            const lastActivityMs = s.ended_at || s.started_at || 0;
            const idleMs = Date.now() - lastActivityMs;
            return idleMs > 15 * 60 * 1000 && idleMs < 2 * 60 * 60 * 1000 && (s.total_turns || 0) > 0;
        },
        message: () => 'Session has been idle for over 15 minutes. If stuck, try the routing recommendation.',
        severity: 'tip',
    },
];

export function checkActiveSession(): Array<{ id: string; message: string; severity: string; tool: string }> {
    const db = getDb();
    const session = db.prepare(`
        SELECT id, tool_id, total_turns, error_count, cache_hit_pct, error_recovery_pct, started_at, ended_at, files_touched
        FROM sessions WHERE started_at > ? AND (ended_at IS NULL OR ended_at > ?)
        ORDER BY started_at DESC LIMIT 1
    `).get(Date.now() - 2 * 60 * 60 * 1000, Date.now() - 5 * 60 * 1000) as any;

    if (!session) return [];
    const nudges: Array<{ id: string; message: string; severity: string; tool: string }> = [];
    for (const rule of COACH_RULES) {
        if (rule.check(session)) {
            nudges.push({ id: rule.id, message: rule.message(session), severity: rule.severity, tool: session.tool_id });
        }
    }
    return nudges;
}
