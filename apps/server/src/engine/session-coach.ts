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

// ---- Cross-session health check ----

export type SessionStatus = 'healthy' | 'degrading' | 'critical';
export type SuggestedAction = 'continue' | 'compact' | 'new_session';

export interface SessionHealthCheck {
    status: SessionStatus;
    suggested_action: SuggestedAction;
    current: {
        turns: number;
        tokens_k: number;
        cache_hit_pct: number;
        error_rate_pct: number;
        duration_min: number;
    };
    cross_session: {
        avg_turns_before_quality_drop: number | null;
        avg_cache_hit_pct: number | null;
        avg_quality_score: number | null;
        sessions_today: number;
        tokens_today_k: number;
        daily_avg_tokens_k: number | null;
    };
    nudges: string[];
}

export function getSessionHealthCheck(): SessionHealthCheck {
    const db = getDb();
    const now = Date.now();

    // Get the most recent active session
    const session = db.prepare(`
        SELECT id, tool_id, total_turns, total_input_tokens, total_output_tokens,
               cache_hit_pct, error_count, quality_score, started_at, ended_at
        FROM sessions WHERE started_at > ? AND (ended_at IS NULL OR ended_at > ?)
        ORDER BY started_at DESC LIMIT 1
    `).get(now - 2 * 60 * 60 * 1000, now - 5 * 60 * 1000) as any;

    if (!session) {
        return {
            status: 'healthy',
            suggested_action: 'continue',
            current: { turns: 0, tokens_k: 0, cache_hit_pct: 0, error_rate_pct: 0, duration_min: 0 },
            cross_session: {
                avg_turns_before_quality_drop: null, avg_cache_hit_pct: null,
                avg_quality_score: null, sessions_today: 0, tokens_today_k: 0, daily_avg_tokens_k: null,
            },
            nudges: [],
        };
    }

    const turns = session.total_turns || 0;
    const totalTokens = (session.total_input_tokens || 0) + (session.total_output_tokens || 0);
    const cacheHit = session.cache_hit_pct || 0;
    const errorRate = turns > 0 ? ((session.error_count || 0) / turns) * 100 : 0;
    const durationMin = Math.round((now - (session.started_at || now)) / 60_000);

    // Cross-session: average turns where quality_score started dropping
    // We look at past sessions with quality_score data and find the avg turn count
    const qualityDrop = db.prepare(`
        SELECT AVG(total_turns) as avg_turns
        FROM sessions
        WHERE quality_score IS NOT NULL AND quality_score < 60 AND total_turns > 10
        AND started_at > ?
    `).get(now - 30 * 24 * 60 * 60 * 1000) as any;

    // Cross-session: historical averages
    const historicalAvg = db.prepare(`
        SELECT AVG(cache_hit_pct) as avg_cache, AVG(quality_score) as avg_quality
        FROM sessions
        WHERE started_at > ? AND total_turns > 5
    `).get(now - 30 * 24 * 60 * 60 * 1000) as any;

    // Today's usage
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStats = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as tokens
        FROM sessions WHERE started_at > ?
    `).get(todayStart.getTime()) as any;

    // Daily average over last 14 days
    const dailyAvg = db.prepare(`
        SELECT AVG(day_tokens) as avg FROM (
            SELECT SUM(total_input_tokens + total_output_tokens) as day_tokens
            FROM sessions
            WHERE started_at > ?
            GROUP BY date(started_at / 1000, 'unixepoch')
        )
    `).get(now - 14 * 24 * 60 * 60 * 1000) as any;

    const crossSession = {
        avg_turns_before_quality_drop: qualityDrop?.avg_turns ? Math.round(qualityDrop.avg_turns) : null,
        avg_cache_hit_pct: historicalAvg?.avg_cache ? Math.round(historicalAvg.avg_cache) : null,
        avg_quality_score: historicalAvg?.avg_quality ? Math.round(historicalAvg.avg_quality) : null,
        sessions_today: todayStats?.count || 0,
        tokens_today_k: Math.round((todayStats?.tokens || 0) / 1000),
        daily_avg_tokens_k: dailyAvg?.avg ? Math.round(dailyAvg.avg / 1000) : null,
    };

    // Determine status and action
    const nudges: string[] = [];
    let status: SessionStatus = 'healthy';
    let action: SuggestedAction = 'continue';

    // Critical: session is way past quality drop threshold, or massive token burn
    const dropThreshold = crossSession.avg_turns_before_quality_drop;
    if (dropThreshold && turns > dropThreshold * 1.3) {
        status = 'critical';
        action = 'new_session';
        nudges.push(`This session has ${turns} turns. Your sessions typically degrade after ~${dropThreshold} turns. Start a new session with a focused prompt.`);
    } else if (totalTokens > 800_000) {
        status = 'critical';
        action = 'new_session';
        nudges.push(`Session has burned ${Math.round(totalTokens / 1000)}K tokens. Context window is likely saturated. Start fresh.`);
    } else if (dropThreshold && turns > dropThreshold * 0.8) {
        status = 'degrading';
        action = 'compact';
        nudges.push(`Approaching quality drop zone (${turns}/${dropThreshold} turns). Consider compacting context or wrapping up soon.`);
    } else if (totalTokens > 500_000) {
        status = 'degrading';
        action = 'compact';
        nudges.push(`${Math.round(totalTokens / 1000)}K tokens used. Compact context to free up headroom.`);
    }

    // Cache warning based on historical comparison
    if (crossSession.avg_cache_hit_pct && cacheHit < crossSession.avg_cache_hit_pct * 0.5 && turns > 5) {
        if (status === 'healthy') status = 'degrading';
        nudges.push(`Cache hit ${Math.round(cacheHit)}% is well below your average of ${crossSession.avg_cache_hit_pct}%. Stabilize context to improve caching.`);
    }

    // Error rate warning
    if (errorRate > 40) {
        if (status === 'healthy') status = 'degrading';
        nudges.push(`Error rate is ${Math.round(errorRate)}%. Consider a different approach or model.`);
    }

    // Daily budget warning
    if (crossSession.daily_avg_tokens_k && crossSession.tokens_today_k > crossSession.daily_avg_tokens_k * 1.5) {
        nudges.push(`Token usage today (${crossSession.tokens_today_k}K) is ${Math.round(crossSession.tokens_today_k / crossSession.daily_avg_tokens_k * 100)}% of your daily average. Pace yourself.`);
    }

    return {
        status,
        suggested_action: action,
        current: {
            turns,
            tokens_k: Math.round(totalTokens / 1000),
            cache_hit_pct: Math.round(cacheHit),
            error_rate_pct: Math.round(errorRate),
            duration_min: durationMin,
        },
        cross_session: crossSession,
        nudges,
    };
}
