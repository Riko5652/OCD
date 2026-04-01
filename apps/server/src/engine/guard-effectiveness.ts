import { getDb } from '../db/index.js';

export interface GuardEffectivenessReport {
    period: { from: string; to: string; days: number };
    interventions: {
        total: number;
        by_type: Record<string, number>;
        by_severity: { warning: number; critical: number; override: number };
        blocks: number;
        warnings: number;
        overrides: number;
        override_rate_pct: number;
    };
    tokens: {
        estimated_saved: number;
        estimated_saved_dollars: number;
        total_session_tokens: number;
        savings_pct: number;
    };
    quality: {
        avg_quality_with_guard: number;
        avg_quality_without_guard: number;
        quality_delta: number;
    };
    repetition: {
        loops_broken: number;
        loops_warned: number;
    };
    hallucination: {
        edits_without_read_caught: number;
        sql_without_schema_caught: number;
        total_prevented: number;
    };
    sessions: {
        hard_stops_triggered: number;
        sessions_saved_from_degradation: number;
    };
    daily_trend: Array<{ date: string; interventions: number; tokens_saved: number; blocks: number }>;
}

function tableExists(tableName: string): boolean {
    try {
        const db = getDb();
        const row = db.prepare(
            "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?"
        ).get(tableName) as any;
        return (row?.cnt ?? 0) > 0;
    } catch {
        return false;
    }
}

export function computeGuardEffectiveness(days = 30): GuardEffectivenessReport {
    const db = getDb();
    const now = new Date();
    const from = new Date(now.getTime() - days * 86400000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = now.toISOString().slice(0, 10);
    const fromEpoch = Math.floor(from.getTime() / 1000);

    // Default empty report for when table doesn't exist yet
    const empty: GuardEffectivenessReport = {
        period: { from: fromStr, to: toStr, days },
        interventions: {
            total: 0,
            by_type: {},
            by_severity: { warning: 0, critical: 0, override: 0 },
            blocks: 0,
            warnings: 0,
            overrides: 0,
            override_rate_pct: 0,
        },
        tokens: {
            estimated_saved: 0,
            estimated_saved_dollars: 0,
            total_session_tokens: 0,
            savings_pct: 0,
        },
        quality: {
            avg_quality_with_guard: 0,
            avg_quality_without_guard: 0,
            quality_delta: 0,
        },
        repetition: { loops_broken: 0, loops_warned: 0 },
        hallucination: {
            edits_without_read_caught: 0,
            sql_without_schema_caught: 0,
            total_prevented: 0,
        },
        sessions: { hard_stops_triggered: 0, sessions_saved_from_degradation: 0 },
        daily_trend: [],
    };

    if (!tableExists('guard_interventions')) return empty;

    try {
        // ── 1. Interventions by type and severity ────────────────────────────
        const byTypeRows = db.prepare(`
            SELECT intervention_type, COUNT(*) as cnt
            FROM guard_interventions
            WHERE created_at >= ?
            GROUP BY intervention_type
        `).all(fromEpoch) as Array<{ intervention_type: string; cnt: number }>;

        const by_type: Record<string, number> = {};
        for (const row of byTypeRows) {
            by_type[row.intervention_type] = row.cnt;
        }

        const bySeverityRows = db.prepare(`
            SELECT severity, COUNT(*) as cnt
            FROM guard_interventions
            WHERE created_at >= ?
            GROUP BY severity
        `).all(fromEpoch) as Array<{ severity: string; cnt: number }>;

        const by_severity = { warning: 0, critical: 0, override: 0 };
        for (const row of bySeverityRows) {
            if (row.severity === 'warning') by_severity.warning = row.cnt;
            else if (row.severity === 'critical') by_severity.critical = row.cnt;
            else if (row.severity === 'override') by_severity.override = row.cnt;
        }

        const actionRows = db.prepare(`
            SELECT action_taken, COUNT(*) as cnt
            FROM guard_interventions
            WHERE created_at >= ?
            GROUP BY action_taken
        `).all(fromEpoch) as Array<{ action_taken: string; cnt: number }>;

        let blocks = 0, warnings = 0, overrides = 0;
        for (const row of actionRows) {
            if (row.action_taken === 'block') blocks = row.cnt;
            else if (row.action_taken === 'warn') warnings = row.cnt;
            else if (row.action_taken === 'override') overrides = row.cnt;
        }

        const total = blocks + warnings + overrides;
        const override_rate_pct = total > 0 ? Math.round((overrides / total) * 100) : 0;

        // ── 2. Token savings ─────────────────────────────────────────────────
        const tokenRow = db.prepare(`
            SELECT SUM(estimated_tokens_saved) as total_saved
            FROM guard_interventions
            WHERE created_at >= ?
        `).get(fromEpoch) as any;
        const estimated_saved = tokenRow?.total_saved ?? 0;
        const estimated_saved_dollars = Math.round((estimated_saved / 1_000_000) * 3 * 100) / 100;

        // Total tokens across all sessions in period
        const sessionTokenRow = db.prepare(`
            SELECT SUM(total_input_tokens + total_output_tokens) as total_tokens
            FROM sessions
            WHERE started_at >= ?
        `).get(fromEpoch) as any;
        const total_session_tokens = sessionTokenRow?.total_tokens ?? 0;
        const savings_pct = total_session_tokens > 0
            ? Math.round((estimated_saved / (total_session_tokens + estimated_saved)) * 100)
            : 0;

        // ── 3. Quality comparison: sessions with vs without guard interventions
        let avg_quality_with_guard = 0;
        let avg_quality_without_guard = 0;

        if (tableExists('sessions')) {
            try {
                // Sessions that had guard interventions
                const qualWithRow = db.prepare(`
                    SELECT AVG(s.quality_score) as avg_q
                    FROM sessions s
                    WHERE s.started_at >= ?
                      AND s.quality_score IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM guard_interventions gi
                        WHERE gi.session_id = s.id AND gi.created_at >= ?
                      )
                `).get(fromEpoch, fromEpoch) as any;
                avg_quality_with_guard = Math.round((qualWithRow?.avg_q ?? 0) * 10) / 10;

                // Sessions without guard interventions
                const qualWithoutRow = db.prepare(`
                    SELECT AVG(s.quality_score) as avg_q
                    FROM sessions s
                    WHERE s.started_at >= ?
                      AND s.quality_score IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM guard_interventions gi
                        WHERE gi.session_id = s.id AND gi.created_at >= ?
                      )
                `).get(fromEpoch, fromEpoch) as any;
                avg_quality_without_guard = Math.round((qualWithoutRow?.avg_q ?? 0) * 10) / 10;
            } catch { /* quality comparison unavailable */ }
        }
        const quality_delta = Math.round((avg_quality_with_guard - avg_quality_without_guard) * 10) / 10;

        // ── 4. Repetition stats ───────────────────────────────────────────────
        const loops_broken = by_type['repetition_block'] ?? 0;
        const loops_warned = by_type['repetition_warn'] ?? 0;

        // ── 5. Hallucination prevention ──────────────────────────────────────
        const edits_without_read_caught = by_type['hallucination_warn'] ?? 0;
        const sql_without_schema_caught = by_type['schema_warn'] ?? 0;
        const total_prevented = edits_without_read_caught + sql_without_schema_caught;

        // ── 6. Session overrun stats ─────────────────────────────────────────
        const hard_stops_triggered = by_type['overrun_block'] ?? 0;
        const sessions_saved_from_degradation = (by_type['overrun_warn'] ?? 0) + hard_stops_triggered;

        // ── 7. Daily trend ────────────────────────────────────────────────────
        const dailyRows = db.prepare(`
            SELECT
                date(created_at, 'unixepoch') as date,
                COUNT(*) as interventions,
                SUM(estimated_tokens_saved) as tokens_saved,
                SUM(CASE WHEN action_taken = 'block' THEN 1 ELSE 0 END) as blocks
            FROM guard_interventions
            WHERE created_at >= ?
            GROUP BY date(created_at, 'unixepoch')
            ORDER BY date ASC
        `).all(fromEpoch) as Array<{ date: string; interventions: number; tokens_saved: number; blocks: number }>;

        return {
            period: { from: fromStr, to: toStr, days },
            interventions: {
                total,
                by_type,
                by_severity,
                blocks,
                warnings,
                overrides,
                override_rate_pct,
            },
            tokens: {
                estimated_saved,
                estimated_saved_dollars,
                total_session_tokens,
                savings_pct,
            },
            quality: {
                avg_quality_with_guard,
                avg_quality_without_guard,
                quality_delta,
            },
            repetition: { loops_broken, loops_warned },
            hallucination: {
                edits_without_read_caught,
                sql_without_schema_caught,
                total_prevented,
            },
            sessions: { hard_stops_triggered, sessions_saved_from_degradation },
            daily_trend: dailyRows,
        };
    } catch (e: any) {
        // Return empty report on any unexpected error
        return empty;
    }
}
