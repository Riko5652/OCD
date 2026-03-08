// src/engine/prompt-analyzer.js
// Computes structural prompt quality signals from turn data.
// Called at ingest time for each session. Stores to prompt_metrics table.
import { getDb, upsertPromptMetrics } from '../db.js';

const CONSTRAINT_WORDS = ['only', "don't", 'must', 'avoid', 'never', 'exactly', 'do not', 'without', 'except'];
const FILE_PATH_RE = /[./\\](?:ts|js|py|go|rs|css|json|md|sh|jsx|tsx|vue)\b|src\/|\.\/|\.\.\/|\/[a-zA-Z]/;

export function analyzePromptMetrics(sessionId) {
  const db = getDb();
  const turns = db.prepare(
    `SELECT input_tokens, tools_used, label FROM turns WHERE session_id=? ORDER BY rowid ASC`
  ).all(sessionId);

  if (turns.length === 0) return;

  // first_turn_tokens — how much context user gave upfront
  const firstTurn = turns[0];
  const firstTurnTokens = firstTurn.input_tokens || 0;

  // turns_to_first_edit — how many turns before first Write/Edit/Bash call
  let turnsToFirstEdit = null;
  for (let i = 0; i < turns.length; i++) {
    const tools = JSON.parse(turns[i].tools_used || '[]');
    const names = tools.map(t => Array.isArray(t) ? t[0] : t);
    if (names.some(n => ['Edit', 'Write', 'Bash'].includes(n))) {
      turnsToFirstEdit = i;
      break;
    }
  }

  // reask_rate — proxy: turns with very low input tokens (<100) after turn 0 = clarification
  const humanTurns = turns.filter((t, i) => i > 0 && t.input_tokens != null && t.input_tokens < 100);
  const reaskRate = turns.length > 1 ? humanTurns.length / (turns.length - 1) : 0;

  // has_file_context — does turn 0 label reference a file path?
  const firstLabel = firstTurn.label || '';
  const hasFileContext = FILE_PATH_RE.test(firstLabel) ? 1 : 0;

  // constraint_count — count scoping/constraint words in turn 0 label
  const labelLower = firstLabel.toLowerCase();
  const constraintCount = CONSTRAINT_WORDS.filter(w => labelLower.includes(w)).length;

  upsertPromptMetrics({
    session_id: sessionId,
    first_turn_tokens: firstTurnTokens,
    reask_rate: Math.round(reaskRate * 100) / 100,
    has_file_context: hasFileContext,
    constraint_count: constraintCount,
    turns_to_first_edit: turnsToFirstEdit,
  });
}
