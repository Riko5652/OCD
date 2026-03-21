/**
 * Anti-Hallucination Negative Prompt Injector
 *
 * AI models frequently loop on the same deprecated library or broken regex.
 * This engine:
 *   1. Scans sessions for "abandoned" or highly iterative, failing patterns.
 *   2. Builds an Anti-Pattern Graph stored in `anti_patterns` table.
 *   3. Exposes `getNegativeConstraints(task)` — called by the MCP tool
 *      `get_negative_constraints` to inject explicit "DO NOT" clauses.
 */

import { getDb } from '../db/index.js';

// ─── Pattern detection heuristics ────────────────────────────────────────────

/** A session qualifies as "failing / abandoned" when: */
const FAILURE_SIGNALS = {
    minTurns: 15,           // high iteration count
    maxQuality: 40,         // poor quality score
    minErrorCount: 3,       // multiple errors
    minReaskRate: 0.35,     // re-asking the same thing often
};

/** Common failing library patterns extracted from session text. */
const LIBRARY_EXTRACTORS: Array<{ re: RegExp; name: string }> = [
    { re: /\bexpress\b/i, name: 'express' },
    { re: /\bfastify\b/i, name: 'fastify' },
    { re: /\baxios\b/i, name: 'axios' },
    { re: /\bmoment\.js\b|\bmoment\b/i, name: 'moment.js' },
    { re: /\blodash\b/i, name: 'lodash' },
    { re: /\bwebpack\b/i, name: 'webpack' },
    { re: /\bbabel\b/i, name: 'babel' },
    { re: /\bprisma\b/i, name: 'prisma' },
    { re: /\bsequelize\b/i, name: 'sequelize' },
    { re: /\bmongoose\b/i, name: 'mongoose' },
    { re: /\bknex\b/i, name: 'knex' },
    { re: /\bgraphql\b/i, name: 'graphql' },
    { re: /\bgrpc\b/i, name: 'grpc' },
    { re: /\bredis\b/i, name: 'redis' },
    { re: /\bcelery\b/i, name: 'celery' },
    { re: /\bflask\b/i, name: 'flask' },
    { re: /\bdjango\b/i, name: 'django' },
    { re: /\bpandas\b/i, name: 'pandas' },
    { re: /\bnumpy\b/i, name: 'numpy' },
    { re: /\bscikit.learn\b/i, name: 'scikit-learn' },
    { re: /\btensorflow\b/i, name: 'tensorflow' },
    { re: /\bpytorch\b|\btorch\b/i, name: 'pytorch' },
];

function detectLibraries(text: string): string[] {
    return LIBRARY_EXTRACTORS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

function sessionToText(session: any): string {
    const parts: string[] = [];
    if (session.title) parts.push(session.title);
    if (session.tldr) parts.push(session.tldr);
    try {
        const raw = JSON.parse(session.raw_data || '{}');
        if (raw.filesEdited) parts.push(raw.filesEdited.join(' '));
        if (raw.project) parts.push(String(raw.project));
    } catch { /* ignore */ }
    return parts.join(' ');
}

function buildPatternKey(taskType: string, library: string): string {
    return `${taskType}::${library}`.toLowerCase().replace(/[^a-z0-9:]/g, '_');
}

// ─── Core analysis ────────────────────────────────────────────────────────────

export function analyzeFailingSessions(): number {
    const db = getDb();

    // Pull sessions that look like failures
    const failingSessions = db.prepare(`
        SELECT s.*, tc.task_type, tc.language, pm.reask_rate
        FROM sessions s
        LEFT JOIN task_classifications tc ON tc.session_id = s.id
        LEFT JOIN prompt_metrics pm ON pm.session_id = s.id
        WHERE (
            (s.total_turns >= ? AND s.quality_score < ?)
            OR s.error_count >= ?
            OR pm.reask_rate >= ?
        )
        AND s.quality_score IS NOT NULL
        ORDER BY s.started_at DESC
        LIMIT 500
    `).all(
        FAILURE_SIGNALS.minTurns,
        FAILURE_SIGNALS.maxQuality,
        FAILURE_SIGNALS.minErrorCount,
        FAILURE_SIGNALS.minReaskRate,
    ) as any[];

    // For each failing session, find a "successful" sibling on the same task
    const successSessions = db.prepare(`
        SELECT s.id, s.title, s.tool_id, tc.task_type, tc.language
        FROM sessions s
        JOIN task_classifications tc ON tc.session_id = s.id
        WHERE s.quality_score >= 75 AND s.error_count = 0
        ORDER BY s.quality_score DESC
        LIMIT 1000
    `).all() as any[];

    const successByTask: Record<string, any> = {};
    for (const s of successSessions) {
        const key = `${s.task_type}::${s.language || 'any'}`;
        if (!successByTask[key]) successByTask[key] = s;
    }

    const upsert = db.prepare(`
        INSERT INTO anti_patterns
          (pattern_key, task_type, language, failure_description, failed_library,
           failed_approach, failure_count, success_alternative, success_session_id,
           first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(pattern_key) DO UPDATE SET
          failure_count = failure_count + 1,
          last_seen_at  = excluded.last_seen_at,
          success_alternative = COALESCE(excluded.success_alternative, success_alternative),
          success_session_id  = COALESCE(excluded.success_session_id, success_session_id)
    `);

    let recorded = 0;
    const now = Date.now();

    db.transaction(() => {
        for (const session of failingSessions) {
            const text = sessionToText(session);
            const libs = detectLibraries(text);
            const taskType = session.task_type || 'general';
            const lang = session.language || null;

            for (const lib of libs) {
                const key = buildPatternKey(taskType, lib);
                const successKey = `${taskType}::${lang || 'any'}`;
                const altSession = successByTask[successKey];

                const desc = `Library "${lib}" used in a failing ${taskType} session (${session.total_turns} turns, quality ${session.quality_score?.toFixed(0) || '?'}, errors ${session.error_count}).`;
                const alt = altSession
                    ? `Try the approach from session "${altSession.title}" using ${altSession.tool_id}.`
                    : null;

                upsert.run(key, taskType, lang, desc, lib, null, alt, altSession?.id ?? null, now, now);
                recorded++;
            }
        }
    })();

    console.log(`[anti-pattern] Analyzed ${failingSessions.length} failing sessions, recorded ${recorded} patterns.`);
    return recorded;
}

// ─── Constraint injection ──────────────────────────────────────────────────────

export interface NegativeConstraint {
    pattern_key: string;
    task_type: string;
    failed_library: string | null;
    failure_description: string;
    failure_count: number;
    success_alternative: string | null;
    success_session_id: string | null;
    constraint_text: string;
}

export function getNegativeConstraints(task: string, limit = 5): NegativeConstraint[] {
    const db = getDb();

    // Classify the incoming task to find relevant anti-patterns
    const taskLower = task.toLowerCase();
    let taskType = 'general';
    const taskSignals: Record<string, RegExp[]> = {
        migration: [/migrat|schema|alembic|flyway/i],
        component: [/\.tsx|\.jsx|react|useState|useEffect/i],
        debug: [/error|exception|crash|traceback|undefined is not/i],
        refactor: [/refactor|rename|extract|clean up/i],
        test: [/test|spec|vitest|jest|describe|expect/i],
        api: [/endpoint|route|handler|app\.get|router/i],
        devops: [/docker|nginx|ci|deploy|pipeline/i],
    };
    for (const [type, patterns] of Object.entries(taskSignals)) {
        if (patterns.some(p => p.test(taskLower))) { taskType = type; break; }
    }

    // Also detect mentioned libraries directly in the task
    const mentionedLibs = detectLibraries(task);

    const rows = db.prepare(`
        SELECT * FROM anti_patterns
        WHERE (task_type = ? OR task_type = 'general')
           OR (failed_library IS NOT NULL AND failed_library IN (${mentionedLibs.map(() => '?').join(',') || "'__none__'"}))
        ORDER BY failure_count DESC, last_seen_at DESC
        LIMIT ?
    `).all(taskType, ...mentionedLibs, limit) as any[];

    return rows.map(r => ({
        pattern_key: r.pattern_key,
        task_type: r.task_type,
        failed_library: r.failed_library,
        failure_description: r.failure_description,
        failure_count: r.failure_count,
        success_alternative: r.success_alternative,
        success_session_id: r.success_session_id,
        constraint_text: buildConstraintText(r),
    }));
}

function buildConstraintText(row: any): string {
    let text = `DO NOT use "${row.failed_library || row.failed_approach || 'this approach'}" for ${row.task_type} tasks`;
    text += ` — it failed ${row.failure_count} time${row.failure_count !== 1 ? 's' : ''} locally.`;
    if (row.success_alternative) text += ` ${row.success_alternative}`;
    return text;
}

// ─── Scheduled refresh ────────────────────────────────────────────────────────

let analysisInterval: ReturnType<typeof setInterval> | null = null;

export function startAntiPatternAnalysis(intervalMs = 10 * 60 * 1000) {
    analyzeFailingSessions(); // run immediately on startup
    analysisInterval = setInterval(analyzeFailingSessions, intervalMs);
    console.log(`[anti-pattern] Background analysis started (every ${intervalMs / 60000}m).`);
}

export function stopAntiPatternAnalysis() {
    if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
}
