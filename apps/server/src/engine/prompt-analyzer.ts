import { getDb } from '../db/index.js';

const CONSTRAINT_WORDS = ['only', "don't", 'must', 'avoid', 'never', 'exactly', 'do not', 'without', 'except'];
const FILE_PATH_RE = /[./\\](?:ts|js|py|go|rs|css|json|md|sh|jsx|tsx|vue)\b|src\/|\.\//;

export function analyzePromptMetrics(sessionId: string) {
    const db = getDb();
    const turns = db.prepare('SELECT input_tokens, tools_used, label FROM turns WHERE session_id=? ORDER BY rowid ASC').all(sessionId) as any[];
    if (!turns.length) return;

    const firstTurn = turns[0];
    const firstTurnTokens = firstTurn.input_tokens || 0;

    let turnsToFirstEdit: number | null = null;
    for (let i = 0; i < turns.length; i++) {
        const tools = JSON.parse(turns[i].tools_used || '[]');
        const names = tools.map((t: any) => Array.isArray(t) ? t[0] : t);
        if (names.some((n: string) => ['Edit', 'Write', 'Bash'].includes(n))) { turnsToFirstEdit = i; break; }
    }

    const humanTurns = turns.filter((t, i) => i > 0 && t.input_tokens != null && t.input_tokens < 100);
    const reaskRate = turns.length > 1 ? humanTurns.length / (turns.length - 1) : 0;
    const firstLabel = firstTurn.label || '';
    const hasFileContext = FILE_PATH_RE.test(firstLabel) ? 1 : 0;
    const constraintCount = CONSTRAINT_WORDS.filter(w => firstLabel.toLowerCase().includes(w)).length;

    db.prepare(`INSERT OR REPLACE INTO prompt_metrics (session_id, first_turn_tokens, reask_rate, has_file_context, constraint_count, turns_to_first_edit)
        VALUES (?,?,?,?,?,?)`).run(sessionId, firstTurnTokens, Math.round(reaskRate * 100) / 100, hasFileContext, constraintCount, turnsToFirstEdit);
}
