// Auto O/Q/S scorer — replaces manual ai_learnings.json
import { getDb } from '../db.js';

/**
 * Score a session automatically:
 * O (output, 1-10): based on output tokens + turns
 * Q (quality, 1-10): based on completion rate + cache efficiency
 * S (scale, 1-10): based on tools used and AI files touched
 */
export function scoreSession(session) {
  // O — Output volume
  const tokens = session.total_output_tokens || 0;
  let O;
  if (tokens < 1000) O = 2;
  else if (tokens < 5000) O = 4;
  else if (tokens < 20000) O = 6;
  else if (tokens < 50000) O = 8;
  else O = 10;

  // Q — Quality signals
  let Q = 5; // baseline
  if (session.cache_hit_pct != null) {
    if (session.cache_hit_pct >= 80) Q += 2;
    else if (session.cache_hit_pct >= 60) Q += 1;
    else Q -= 1;
  }
  // Long sessions with many turns = likely good depth
  if (session.total_turns >= 20 && session.total_turns <= 150) Q += 1;
  // Very long sessions degrade quality
  if (session.total_turns > 200) Q -= 2;
  Q = Math.max(1, Math.min(10, Q));

  // S — Scale/breadth
  const db = getDb();
  const fileCount = db.prepare(
    'SELECT COUNT(DISTINCT file_path) as cnt FROM ai_files WHERE session_id = ?'
  ).get(session.id)?.cnt || 0;

  let S;
  if (fileCount <= 1) S = 3;
  else if (fileCount <= 5) S = 6;
  else if (fileCount <= 15) S = 8;
  else S = 10;

  // Fallback: use turn count as scale proxy if no file data
  if (fileCount === 0 && session.total_turns > 30) S = 6;
  if (fileCount === 0 && session.total_turns > 100) S = 8;

  const value = O * Q * S;
  const contextTokens = (session.total_input_tokens || 0) + (session.total_output_tokens || 0);
  const efficiency = contextTokens > 0 ? value / contextTokens : 0;

  return { O, Q, S, value, contextTokens, efficiency };
}

export function scoreAndSave(session) {
  const scores = scoreSession(session);
  const db = getDb();

  db.prepare(`
    INSERT INTO efficiency_log (date, tool_id, session_id,
      output_score, quality_score, scale_score, value,
      context_tokens, efficiency, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date(session.started_at || Date.now()).toISOString().slice(0, 10),
    session.tool_id,
    session.id,
    scores.O, scores.Q, scores.S, scores.value,
    scores.contextTokens, scores.efficiency,
    session.title || null
  );

  // Also update session quality_score
  db.prepare('UPDATE sessions SET quality_score = ? WHERE id = ?')
    .run(scores.value, session.id);

  return scores;
}
