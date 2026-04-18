/**
 * Session Governor — Hard-caps runaway Claude Code sessions
 *
 * Enforces convergence checkpoints based on:
 *   - Turn count (default: 180 turns → checkpoint, 250 → hard stop)
 *   - Output tokens (default: 100K → checkpoint, 200K → hard stop)
 *   - Duration (default: 180min → checkpoint, 300min → hard stop)
 *   - Error accumulation (default: 15 errors → checkpoint)
 *
 * At a checkpoint, the governor forces one of three actions:
 *   1. COMMIT — commit code + write TODOs, then continue briefly
 *   2. HANDOFF — push handoff note + start fresh session
 *   3. STOP — flag for human review
 *
 * Thresholds are configurable per-project via governor_config table.
 */

import { getDb } from '../db/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GovernorThresholds {
    checkpoint_turns: number;
    hardstop_turns: number;
    checkpoint_output_tokens_k: number;
    hardstop_output_tokens_k: number;
    checkpoint_duration_min: number;
    hardstop_duration_min: number;
    checkpoint_errors: number;
    checkpoint_output_amplification: number;
}

export type GovernorAction = 'continue' | 'checkpoint' | 'hard_stop';
export type CheckpointChoice = 'commit' | 'handoff' | 'stop';

export interface GovernorTrigger {
    metric: string;
    current: number;
    threshold: number;
    severity: 'checkpoint' | 'hard_stop';
}

export interface GovernorVerdict {
    action: GovernorAction;
    triggers: GovernorTrigger[];
    message: string;
    checkpoint_prompt: string | null;
    override_available: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: GovernorThresholds = {
    checkpoint_turns: 180,
    hardstop_turns: 250,
    checkpoint_output_tokens_k: 100,
    hardstop_output_tokens_k: 200,
    checkpoint_duration_min: 180,
    hardstop_duration_min: 300,
    checkpoint_errors: 15,
    checkpoint_output_amplification: 8,
};

// ── Config persistence ───────────────────────────────────────────────────────

export function ensureGovernorTable(): void {
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS governor_config (
            project TEXT PRIMARY KEY,
            thresholds TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS governor_checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            triggered_at INTEGER NOT NULL,
            triggers TEXT NOT NULL,
            action_taken TEXT,
            override INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_gc_session ON governor_checkpoints(session_id);
        CREATE INDEX IF NOT EXISTS idx_gc_triggered ON governor_checkpoints(triggered_at);
    `);
}

export function getThresholds(project?: string | null): GovernorThresholds {
    const db = getDb();
    ensureGovernorTable();

    if (project) {
        const row = db.prepare(
            `SELECT thresholds FROM governor_config WHERE project = ?`
        ).get(project) as { thresholds: string } | undefined;
        if (row) {
            return { ...DEFAULT_THRESHOLDS, ...JSON.parse(row.thresholds) };
        }
    }

    const globalRow = db.prepare(
        `SELECT thresholds FROM governor_config WHERE project = '__global__'`
    ).get() as { thresholds: string } | undefined;

    if (globalRow) {
        return { ...DEFAULT_THRESHOLDS, ...JSON.parse(globalRow.thresholds) };
    }

    return DEFAULT_THRESHOLDS;
}

export function setThresholds(project: string, overrides: Partial<GovernorThresholds>): void {
    const db = getDb();
    ensureGovernorTable();

    const current = getThresholds(project);
    const merged = { ...current, ...overrides };

    db.prepare(`
        INSERT INTO governor_config (project, thresholds, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project) DO UPDATE SET thresholds = excluded.thresholds, updated_at = excluded.updated_at
    `).run(project, JSON.stringify(merged), Date.now());
}

// ── Core verdict logic ───────────────────────────────────────────────────────

export interface SessionMetrics {
    turns: number;
    output_tokens_k: number;
    input_tokens_k: number;
    duration_min: number;
    error_count: number;
    session_id?: string;
}

export function getGovernorVerdict(
    metrics: SessionMetrics,
    project?: string | null
): GovernorVerdict {
    const th = getThresholds(project);
    const triggers: GovernorTrigger[] = [];

    if (metrics.turns >= th.hardstop_turns) {
        triggers.push({ metric: 'turns', current: metrics.turns, threshold: th.hardstop_turns, severity: 'hard_stop' });
    } else if (metrics.turns >= th.checkpoint_turns) {
        triggers.push({ metric: 'turns', current: metrics.turns, threshold: th.checkpoint_turns, severity: 'checkpoint' });
    }

    if (metrics.output_tokens_k >= th.hardstop_output_tokens_k) {
        triggers.push({ metric: 'output_tokens_k', current: metrics.output_tokens_k, threshold: th.hardstop_output_tokens_k, severity: 'hard_stop' });
    } else if (metrics.output_tokens_k >= th.checkpoint_output_tokens_k) {
        triggers.push({ metric: 'output_tokens_k', current: metrics.output_tokens_k, threshold: th.checkpoint_output_tokens_k, severity: 'checkpoint' });
    }

    if (metrics.duration_min >= th.hardstop_duration_min) {
        triggers.push({ metric: 'duration_min', current: metrics.duration_min, threshold: th.hardstop_duration_min, severity: 'hard_stop' });
    } else if (metrics.duration_min >= th.checkpoint_duration_min) {
        triggers.push({ metric: 'duration_min', current: metrics.duration_min, threshold: th.checkpoint_duration_min, severity: 'checkpoint' });
    }

    if (metrics.error_count >= th.checkpoint_errors) {
        triggers.push({ metric: 'errors', current: metrics.error_count, threshold: th.checkpoint_errors, severity: 'checkpoint' });
    }

    if (metrics.input_tokens_k > 0) {
        const ratio = metrics.output_tokens_k / metrics.input_tokens_k;
        if (ratio >= th.checkpoint_output_amplification) {
            triggers.push({
                metric: 'output_amplification',
                current: Math.round(ratio * 10) / 10,
                threshold: th.checkpoint_output_amplification,
                severity: 'checkpoint',
            });
        }
    }

    if (triggers.length === 0) {
        return {
            action: 'continue',
            triggers: [],
            message: '',
            checkpoint_prompt: null,
            override_available: false,
        };
    }

    const hasHardStop = triggers.some(tr => tr.severity === 'hard_stop');
    const action: GovernorAction = hasHardStop ? 'hard_stop' : 'checkpoint';

    const triggerDescs = triggers.map(tr => {
        const pct = Math.round((tr.current / tr.threshold) * 100);
        return `${tr.metric}: ${tr.current}/${tr.threshold} (${pct}%)`;
    });

    const message = hasHardStop
        ? `SESSION GOVERNOR: HARD STOP. Limits exceeded: ${triggerDescs.join(', ')}. Push a handoff note and start a new session.`
        : `SESSION GOVERNOR: CHECKPOINT. Limits approaching: ${triggerDescs.join(', ')}. Choose one action:\n` +
          `  1. COMMIT - commit current work + write TODOs for remaining items\n` +
          `  2. HANDOFF - push handoff note + start a fresh session\n` +
          `  3. STOP - flag for human review`;

    const checkpointPrompt = hasHardStop
        ? 'Summarize current state, push a handoff note with push_handoff_note, and stop. Do NOT continue working.'
        : 'Summarize: (1) What you accomplished so far, (2) What remains, (3) Key decisions made. Then choose: commit code + TODOs, push handoff note for fresh session, or stop for human review.';

    return {
        action,
        triggers,
        message,
        checkpoint_prompt: checkpointPrompt,
        override_available: !hasHardStop,
    };
}

// ── Checkpoint recording ─────────────────────────────────────────────────────

export function recordCheckpoint(
    sessionId: string,
    triggers: GovernorTrigger[],
    actionTaken?: CheckpointChoice,
    overridden = false
): void {
    const db = getDb();
    ensureGovernorTable();
    db.prepare(`
        INSERT INTO governor_checkpoints (session_id, triggered_at, triggers, action_taken, override)
        VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, Date.now(), JSON.stringify(triggers), actionTaken || null, overridden ? 1 : 0);
}

// ── Stats for dashboard ──────────────────────────────────────────────────────

export interface GovernorStats {
    total_checkpoints: number;
    total_hard_stops: number;
    total_overrides: number;
    most_common_trigger: string | null;
    thresholds: GovernorThresholds;
    recent: Array<{
        session_id: string;
        triggered_at: number;
        triggers: GovernorTrigger[];
        action_taken: string | null;
        override: boolean;
    }>;
}

export function getGovernorStats(days = 30, project?: string | null): GovernorStats {
    const db = getDb();
    ensureGovernorTable();

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const total = db.prepare(
        `SELECT COUNT(*) as cnt FROM governor_checkpoints WHERE triggered_at > ?`
    ).get(cutoff) as any;

    const hardStops = db.prepare(
        `SELECT COUNT(*) as cnt FROM governor_checkpoints WHERE triggered_at > ? AND action_taken IS NULL`
    ).get(cutoff) as any;

    const overrides = db.prepare(
        `SELECT COUNT(*) as cnt FROM governor_checkpoints WHERE triggered_at > ? AND override = 1`
    ).get(cutoff) as any;

    const recentRows = db.prepare(
        `SELECT session_id, triggered_at, triggers, action_taken, override
         FROM governor_checkpoints WHERE triggered_at > ?
         ORDER BY triggered_at DESC LIMIT 20`
    ).all(cutoff) as any[];

    const triggerCounts: Record<string, number> = {};
    const parsed = recentRows.map((r: any) => {
        const t = JSON.parse(r.triggers) as GovernorTrigger[];
        for (const trigger of t) {
            triggerCounts[trigger.metric] = (triggerCounts[trigger.metric] || 0) + 1;
        }
        return {
            session_id: r.session_id,
            triggered_at: r.triggered_at,
            triggers: t,
            action_taken: r.action_taken,
            override: r.override === 1,
        };
    });

    const mostCommon = Object.entries(triggerCounts).sort(([, a], [, b]) => b - a)[0];

    return {
        total_checkpoints: total?.cnt ?? 0,
        total_hard_stops: hardStops?.cnt ?? 0,
        total_overrides: overrides?.cnt ?? 0,
        most_common_trigger: mostCommon?.[0] ?? null,
        thresholds: getThresholds(project),
        recent: parsed,
    };
}

// ── Quick check for hook (lightweight, no session lookup) ────────────────────

export function quickGovernorCheck(
    turnCount: number,
    sessionMins: number,
    errorCount: number,
    project?: string | null
): { action: GovernorAction; message: string } | null {
    const th = getThresholds(project);

    if (turnCount >= th.hardstop_turns) {
        return {
            action: 'hard_stop',
            message: `SESSION GOVERNOR: HARD STOP at ${turnCount} turns (limit: ${th.hardstop_turns}). Push handoff note and stop.`,
        };
    }
    if (sessionMins >= th.hardstop_duration_min) {
        return {
            action: 'hard_stop',
            message: `SESSION GOVERNOR: HARD STOP at ${sessionMins}min (limit: ${th.hardstop_duration_min}min). Push handoff note and stop.`,
        };
    }

    if (turnCount >= th.checkpoint_turns) {
        return {
            action: 'checkpoint',
            message: `SESSION GOVERNOR: CHECKPOINT at ${turnCount} turns (limit: ${th.checkpoint_turns}). Summarize state, then: commit+TODOs, handoff, or stop.`,
        };
    }
    if (sessionMins >= th.checkpoint_duration_min) {
        return {
            action: 'checkpoint',
            message: `SESSION GOVERNOR: CHECKPOINT at ${sessionMins}min (limit: ${th.checkpoint_duration_min}min). Summarize state, then: commit+TODOs, handoff, or stop.`,
        };
    }
    if (errorCount >= th.checkpoint_errors) {
        return {
            action: 'checkpoint',
            message: `SESSION GOVERNOR: CHECKPOINT - ${errorCount} errors (limit: ${th.checkpoint_errors}). Too many retries. Summarize state, then: commit+TODOs, handoff, or stop.`,
        };
    }

    return null;
}
