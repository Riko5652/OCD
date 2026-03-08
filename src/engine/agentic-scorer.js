import { getDb } from '../db.js';

/**
 * Scores 0-100 how agentic a session was.
 * Higher = more autonomous AI behavior (fewer human interventions per result).
 */
export function computeAgenticScore(session) {
  let score = 0;
  const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
  const topTools = (() => { try { return JSON.parse(session.top_tools || '[]'); } catch { return []; } })();
  const toolNames = topTools.map(([t]) => (t || '').toLowerCase());

  // Agent/Task calls present (+20)
  const hasAgentCalls = toolNames.some(t => t.includes('agent') || t.includes('task') || t === 'todowrite');
  if (hasAgentCalls) score += 20;

  // Batch tool use (parallel calls indicator) (+15)
  const hasBatchTools = raw.parallelToolCalls > 0 || toolNames.filter(t => t).length > 5;
  if (hasBatchTools) score += 15;

  // Files touched / turns ratio (+20 if >5 files with <30 turns = highly autonomous)
  const filesTouched = session.files_touched || 0;
  const turns = session.total_turns || 1;
  if (filesTouched > 5 && turns < 30) score += 20;
  else if (filesTouched > 2 && turns < 20) score += 10;

  // Error recovery (self-corrects without human) (+15 if error_recovery_pct > 60)
  if ((session.error_recovery_pct || 0) > 60) score += 15;

  // Low human-touch: many output tokens per turn (+15 if avg output/turn > 500)
  const avgOutput = (session.total_output_tokens || 0) / turns;
  if (avgOutput > 1000) score += 15;
  else if (avgOutput > 500) score += 8;

  // High cache hit = reusing context efficiently (+15 if > 60%)
  if ((session.cache_hit_pct || 0) > 60) score += 15;

  return Math.min(100, score);
}

export function scoreAllSessions() {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT id, raw_data, top_tools, total_turns, files_touched,
           error_recovery_pct, total_output_tokens, cache_hit_pct
    FROM sessions WHERE agentic_score IS NULL
  `).all();

  const update = db.prepare(`UPDATE sessions SET agentic_score = ? WHERE id = ?`);
  const updateAll = db.transaction((rows) => {
    for (const s of rows) {
      const score = computeAgenticScore(s);
      update.run(score, s.id);
    }
  });
  updateAll(sessions);
  return sessions.length;
}

export function getAgenticLeaderboard({ days = null } = {}) {
  const db = getDb();
  // days=null means all history
  let sql = `
    SELECT tool_id, primary_model,
           COUNT(*) as sessions,
           AVG(agentic_score) as avg_agentic,
           MAX(agentic_score) as peak_agentic,
           AVG(total_turns) as avg_turns
    FROM sessions
    WHERE agentic_score IS NOT NULL
  `;
  const params = [];
  if (days != null) {
    sql += ' AND started_at > ?';
    params.push(Date.now() - days * 86400000);
  }
  sql += ' GROUP BY tool_id, primary_model ORDER BY avg_agentic DESC';
  return db.prepare(sql).all(...params);
}
