// Savings report engine — quantifies cost, time, and efficiency gains
import { getDb } from '../db/index.js';

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    'claude-opus-4-6': { input: 15.00, output: 75.00 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    'gpt-5.1-codex-max': { input: 2.50, output: 10.00 },
    '_default': { input: 1.00, output: 4.00 },
};

const MINUTES_PER_TURN = 2;

function pricingFor(model: string | null) {
    return MODEL_PRICING[model || ''] || MODEL_PRICING['_default'];
}

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(n: number, decimals = 2): number {
    const f = Math.pow(10, decimals);
    return Math.round(n * f) / f;
}

function emptyReport() {
    return {
        relative: { cache_savings_pct: 0, avg_turns_vs_baseline: 0, routing_adherence_pct: 0, error_recovery_rate: 0, sessions_optimized: 0, total_sessions: 0 },
        dollars: { total_estimated_cost: 0, cache_savings_dollars: 0, efficient_session_savings: 0, disclaimer: 'Estimates based on published model pricing.' },
        time: { avg_session_minutes: 0, estimated_hours_saved: 0 },
    };
}

function buildRecommendedMap(db: any): Record<string, { model: string; tool_id: string }> {
    const map: Record<string, { model: string; tool_id: string }> = {};
    try {
        const rows = db.prepare(`
            SELECT tc.task_type, mp.model, mp.tool_id, SUM(mp.turns) as total_turns
            FROM model_performance mp
            JOIN task_classifications tc ON tc.session_id = mp.session_id
            WHERE tc.task_type IS NOT NULL
            GROUP BY tc.task_type, mp.model, mp.tool_id
            ORDER BY tc.task_type, total_turns DESC
        `).all() as any[];
        for (const row of rows) {
            if (!map[row.task_type]) map[row.task_type] = { model: row.model, tool_id: row.tool_id };
        }
    } catch { /* tables may not exist yet */ }
    return map;
}

export function computeSavingsReport() {
    const db = getDb();

    const sessions = db.prepare(`
        SELECT s.id, s.primary_model, s.total_turns, s.total_input_tokens, s.total_output_tokens,
            s.total_cache_read, s.quality_score, s.error_count, s.error_recovery_pct,
            s.started_at, s.ended_at, s.top_tools, tc.task_type
        FROM sessions s
        LEFT JOIN task_classifications tc ON tc.session_id = s.id
    `).all() as any[];

    if (sessions.length === 0) return emptyReport();

    const totalSessions = sessions.length;
    const totalInputTokens = sessions.reduce((s: number, r: any) => s + (r.total_input_tokens || 0), 0);
    const totalCacheRead = sessions.reduce((s: number, r: any) => s + (r.total_cache_read || 0), 0);
    const cacheSavingsPct = totalInputTokens > 0 ? round((totalCacheRead / (totalInputTokens + totalCacheRead)) * 100) : 0;

    // Turns by task type
    const turnsByType: Record<string, number[]> = {};
    for (const s of sessions) {
        const type = s.task_type || '_unclassified';
        if (!turnsByType[type]) turnsByType[type] = [];
        turnsByType[type].push(s.total_turns || 0);
    }
    const medianByType: Record<string, number> = {};
    for (const [type, arr] of Object.entries(turnsByType)) {
        medianByType[type] = median(arr);
    }

    const overallMedian = median(sessions.map((s: any) => s.total_turns || 0));
    const totalTurns = sessions.reduce((s: number, r: any) => s + (r.total_turns || 0), 0);
    const avgTurnsVsBaseline = overallMedian > 0 ? round(((overallMedian - (totalTurns / totalSessions)) / overallMedian) * 100) : 0;

    // Routing adherence
    const recommended = buildRecommendedMap(db);
    let adherentCount = 0, classifiedCount = 0;
    for (const s of sessions) {
        if (!s.task_type) continue;
        classifiedCount++;
        const rec = recommended[s.task_type];
        if (rec && s.primary_model === rec.model) adherentCount++;
    }
    const routingAdherencePct = classifiedCount > 0 ? round((adherentCount / classifiedCount) * 100) : 0;

    // Error recovery
    const sessionsWithErrors = sessions.filter((s: any) => (s.error_count || 0) > 0);
    const recoveredSessions = sessionsWithErrors.filter((s: any) => (s.error_recovery_pct || 0) > 0);
    const errorRecoveryRate = sessionsWithErrors.length > 0 ? round((recoveredSessions.length / sessionsWithErrors.length) * 100) : 100;

    const sessionsOptimized = sessions.filter((s: any) => (s.quality_score || 0) > 70).length;

    // Dollar estimates
    let totalEstimatedCost = 0, cacheSavingsDollars = 0;
    for (const s of sessions) {
        const pricing = pricingFor(s.primary_model);
        totalEstimatedCost += ((s.total_input_tokens || 0) / 1_000_000) * pricing.input + ((s.total_output_tokens || 0) / 1_000_000) * pricing.output;
        cacheSavingsDollars += ((s.total_cache_read || 0) / 1_000_000) * pricing.input * 0.9;
    }

    let efficientTurnsSaved = 0;
    for (const s of sessions) {
        if ((s.quality_score || 0) <= 70) continue;
        const med = medianByType[s.task_type || '_unclassified'] || overallMedian;
        const delta = med - (s.total_turns || 0);
        if (delta > 0) efficientTurnsSaved += delta;
    }
    const avgCostPerTurn = totalTurns > 0 ? totalEstimatedCost / totalTurns : 0;

    // Time estimates
    let totalTurnsSaved = 0;
    for (const s of sessions) {
        const med = medianByType[s.task_type || '_unclassified'] || overallMedian;
        const delta = med - (s.total_turns || 0);
        if (delta > 0) totalTurnsSaved += delta;
    }

    const avgSessionMinutes = round(
        sessions.reduce((sum: number, s: any) => {
            if (s.started_at && s.ended_at && s.ended_at > s.started_at) return sum + (s.ended_at - s.started_at) / 60000;
            return sum + (s.total_turns || 0) * MINUTES_PER_TURN;
        }, 0) / totalSessions
    );

    return {
        relative: { cache_savings_pct: cacheSavingsPct, avg_turns_vs_baseline: avgTurnsVsBaseline, routing_adherence_pct: routingAdherencePct, error_recovery_rate: errorRecoveryRate, sessions_optimized: sessionsOptimized, total_sessions: totalSessions },
        dollars: { total_estimated_cost: round(totalEstimatedCost), cache_savings_dollars: round(cacheSavingsDollars), efficient_session_savings: round(efficientTurnsSaved * avgCostPerTurn), disclaimer: 'Estimates based on published model pricing.' },
        time: { avg_session_minutes: avgSessionMinutes, estimated_hours_saved: round((totalTurnsSaved * MINUTES_PER_TURN) / 60) },
    };
}
