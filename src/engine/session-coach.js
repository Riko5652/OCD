import { getDb } from '../db.js';

const COACH_RULES = [
  {
    id: 'long-session',
    check: (s) => (s.total_turns || 0) > 80,
    message: (s) => `Session has ${s.total_turns} turns — consider breaking into smaller focused sessions. Sessions >80 turns have 2x lower quality scores on average.`,
    severity: 'warning',
  },
  {
    id: 'low-cache',
    check: (s) => (s.cache_hit_pct || 0) < 30 && (s.total_turns || 0) > 5,
    message: (s) => `Cache hit rate is ${Math.round(s.cache_hit_pct || 0)}% — add context to your first prompt to prime the cache. Target: >60%.`,
    severity: 'tip',
  },
  {
    id: 'error-spike',
    check: (s) => (s.error_count || 0) > 0 && (s.error_count / (s.total_turns || 1)) > 0.4,
    message: (s) => `${s.error_count} errors in ${s.total_turns} turns (${Math.round(s.error_count / s.total_turns * 100)}% error rate) — consider switching tools or models. Your error rate is 3x higher than your average.`,
    severity: 'warning',
  },
  {
    id: 'stale-session',
    check: (s) => {
      const idleMs = Date.now() - (s.last_activity_at || s.started_at || 0);
      return idleMs > 15 * 60 * 1000 && (s.total_turns || 0) > 0;
    },
    message: (_s) => `Session has been idle for over 15 minutes. If you're stuck, try the routing recommendation at /api/routing/recommend.`,
    severity: 'tip',
  },
];

/**
 * Checks the most recent active session for coaching nudges.
 * Returns array of {id, message, severity} for live coaching.
 */
export function checkActiveSession() {
  const db = getDb();

  // Get most recent session (last 2 hours, not yet ended)
  const session = db.prepare(`
    SELECT id, tool_id, total_turns, error_count, cache_hit_pct, error_recovery_pct,
           started_at, ended_at, files_touched
    FROM sessions
    WHERE started_at > ? AND (ended_at IS NULL OR ended_at > ?)
    ORDER BY started_at DESC LIMIT 1
  `).get(Date.now() - 2 * 60 * 60 * 1000, Date.now() - 5 * 60 * 1000);

  if (!session) return [];

  const nudges = [];
  for (const rule of COACH_RULES) {
    if (rule.check(session)) {
      nudges.push({ id: rule.id, message: rule.message(session), severity: rule.severity, tool: session.tool_id });
    }
  }
  return nudges;
}
