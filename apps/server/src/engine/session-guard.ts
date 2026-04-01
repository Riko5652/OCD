import { getDb } from '../db/index.js';

export interface GuardVerdict {
    action: 'allow' | 'warn' | 'block';
    category: 'ok' | 'overrun' | 'repetition' | 'hallucination';
    message: string;
}

export interface SessionGuardReport {
    session_status: 'healthy' | 'degrading' | 'critical';
    verdicts: GuardVerdict[];
    stats: {
        turn_count: number;
        duration_min: number;
        unique_tools: number;
        repeated_calls: number;
        top_repetitions: Array<{ tool_name: string; args_summary: string; count: number }>;
    };
}

export function getSessionGuardReport(sessionId?: string): SessionGuardReport {
    const db = getDb();

    // 1. Find the session
    let session: any = null;
    if (sessionId) {
        session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
    } else {
        session = db.prepare(
            `SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1`
        ).get();
    }

    const turnCount: number = session?.total_turns ?? 0;
    const startedAt: number = session?.started_at ?? Date.now();
    const durationMin: number = Math.round((Date.now() - startedAt) / 60_000);

    const verdicts: GuardVerdict[] = [];
    type SessionStatus = 'healthy' | 'degrading' | 'critical';
    let sessionStatus: SessionStatus = 'healthy';

    // 2. Overrun checks
    if (turnCount >= 100) {
        sessionStatus = 'critical';
        verdicts.push({
            action: 'block',
            category: 'overrun',
            message: `Session has ${turnCount} turns — critical overrun. Start a new session immediately.`,
        });
    } else if (turnCount >= 60) {
        sessionStatus = 'degrading';
        verdicts.push({
            action: 'warn',
            category: 'overrun',
            message: `Session has ${turnCount} turns — approaching overrun. Consider wrapping up soon.`,
        });
    }

    // 3. Repetition checks — last 30 minutes
    const sid = session?.id ?? sessionId ?? '';
    const windowMs = 30 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    let repetitionRows: Array<{ tool_name: string; args_summary: string; args_fingerprint: string; cnt: number }> = [];
    let uniqueTools = 0;
    let repeatedCalls = 0;

    // Check if tool_call_log table exists before querying
    const tableExists = db
        .prepare(`SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='tool_call_log'`)
        .get() as any;

    if (tableExists?.cnt > 0) {
        if (sid) {
            repetitionRows = db.prepare(`
                SELECT tool_name, args_summary, args_fingerprint, COUNT(*) as cnt
                FROM tool_call_log
                WHERE session_id = ? AND created_at >= ?
                GROUP BY args_fingerprint
                HAVING cnt >= 3
                ORDER BY cnt DESC
                LIMIT 10
            `).all(sid, cutoff) as any[];

            const uniqueToolsRow = db.prepare(`
                SELECT COUNT(DISTINCT tool_name) as cnt
                FROM tool_call_log
                WHERE session_id = ?
            `).get(sid) as any;
            uniqueTools = uniqueToolsRow?.cnt ?? 0;

            const repeatedCallsRow = db.prepare(`
                SELECT SUM(cnt) as total FROM (
                    SELECT COUNT(*) as cnt
                    FROM tool_call_log
                    WHERE session_id = ? AND created_at >= ?
                    GROUP BY args_fingerprint
                    HAVING cnt >= 3
                )
            `).get(sid, cutoff) as any;
            repeatedCalls = repeatedCallsRow?.total ?? 0;
        }

        // 4. Repetition verdicts
        const maxRepeat = repetitionRows.reduce((m, r) => Math.max(m, r.cnt), 0);
        if (maxRepeat >= 5) {
            sessionStatus = 'critical';
            verdicts.push({
                action: 'block',
                category: 'repetition',
                message: `Detected ${maxRepeat}x repeated identical tool call — likely stuck in a loop. Stop and reassess.`,
            });
        } else if (maxRepeat >= 3) {
            if ((sessionStatus as string) === 'healthy') sessionStatus = 'degrading';
            verdicts.push({
                action: 'warn',
                category: 'repetition',
                message: `Detected ${maxRepeat}x repeated identical tool call in last 30 min — possible loop forming.`,
            });
        }
    }

    const topRepetitions = repetitionRows.map(r => ({
        tool_name: r.tool_name,
        args_summary: r.args_summary ?? r.args_fingerprint,
        count: r.cnt,
    }));

    return {
        session_status: sessionStatus,
        verdicts,
        stats: {
            turn_count: turnCount,
            duration_min: durationMin,
            unique_tools: uniqueTools,
            repeated_calls: repeatedCalls,
            top_repetitions: topRepetitions,
        },
    };
}

export function recordToolCall(
    sessionId: string,
    toolName: string,
    argsFingerprint: string,
    argsSummary: string
): void {
    const db = getDb();
    db.prepare(`
        INSERT INTO tool_call_log (session_id, tool_name, args_fingerprint, args_summary, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, toolName, argsFingerprint, argsSummary, Date.now());
}
