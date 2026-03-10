// Savings report engine — quantifies cost, time, and efficiency gains
import { getDb } from '../db.js';

// Estimated pricing per 1M tokens (USD) — mirrors analytics.js
const MODEL_PRICING = {
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00 },
  'gpt-5.1-codex-max':          { input: 2.50,  output: 10.00 },
  '_default':                   { input: 1.00,  output: 4.00 },
};

const MINUTES_PER_TURN = 2;

/**
 * Return the pricing entry for a model, falling back to _default.
 */
function pricingFor(model) {
  return MODEL_PRICING[model] || MODEL_PRICING['_default'];
}

/**
 * Compute the median of a numeric array. Returns 0 for empty arrays.
 */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Round a number to a fixed number of decimal places (default 2).
 */
function round(n, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/**
 * Compute a comprehensive savings report across all recorded sessions.
 *
 * @returns {{ relative, dollars, time }}
 */
export function computeSavingsReport() {
  const db = getDb();

  // --------------- Fetch session data ---------------
  const sessions = db.prepare(`
    SELECT
      s.id,
      s.primary_model,
      s.total_turns,
      s.total_input_tokens,
      s.total_output_tokens,
      s.total_cache_read,
      s.quality_score,
      s.error_count,
      s.error_recovery_pct,
      s.started_at,
      s.ended_at,
      s.top_tools,
      tc.task_type
    FROM sessions s
    LEFT JOIN task_classifications tc ON tc.session_id = s.id
  `).all();

  const totalSessions = sessions.length;

  if (totalSessions === 0) {
    return emptyReport();
  }

  // --------------- Relative: cache savings % ---------------
  const totalInputTokens = sessions.reduce((s, r) => s + (r.total_input_tokens || 0), 0);
  const totalCacheRead = sessions.reduce((s, r) => s + (r.total_cache_read || 0), 0);
  const cacheSavingsPct = totalInputTokens > 0
    ? round((totalCacheRead / (totalInputTokens + totalCacheRead)) * 100)
    : 0;

  // --------------- Relative: turns vs baseline ---------------
  // Group sessions by task_type, compute median turns per type
  const turnsByType = {};
  for (const s of sessions) {
    const type = s.task_type || '_unclassified';
    if (!turnsByType[type]) turnsByType[type] = [];
    turnsByType[type].push(s.total_turns || 0);
  }
  const medianByType = {};
  for (const [type, arr] of Object.entries(turnsByType)) {
    medianByType[type] = median(arr);
  }

  const overallMedian = median(sessions.map(s => s.total_turns || 0));
  const totalTurns = sessions.reduce((s, r) => s + (r.total_turns || 0), 0);
  const avgTurnsVsBaseline = overallMedian > 0
    ? round(((overallMedian - (totalTurns / totalSessions)) / overallMedian) * 100)
    : 0;

  // --------------- Relative: routing adherence ---------------
  const recommended = buildRecommendedMap(db);
  let adherentCount = 0;
  let classifiedCount = 0;
  for (const s of sessions) {
    if (!s.task_type) continue;
    classifiedCount++;
    const rec = recommended[s.task_type];
    if (!rec) continue;
    if (s.primary_model === rec.model) {
      adherentCount++;
    }
  }
  const routingAdherencePct = classifiedCount > 0
    ? round((adherentCount / classifiedCount) * 100)
    : 0;

  // --------------- Relative: error recovery ---------------
  const sessionsWithErrors = sessions.filter(s => (s.error_count || 0) > 0);
  const recoveredSessions = sessionsWithErrors.filter(s => (s.error_recovery_pct || 0) > 0);
  const errorRecoveryRate = sessionsWithErrors.length > 0
    ? round((recoveredSessions.length / sessionsWithErrors.length) * 100)
    : 100; // no errors = perfect recovery

  // --------------- Relative: sessions optimized ---------------
  const sessionsOptimized = sessions.filter(s => (s.quality_score || 0) > 70).length;

  // --------------- Dollar: total estimated cost ---------------
  let totalEstimatedCost = 0;
  let cacheSavingsDollars = 0;

  for (const s of sessions) {
    const pricing = pricingFor(s.primary_model);
    const inputCost = ((s.total_input_tokens || 0) / 1_000_000) * pricing.input;
    const outputCost = ((s.total_output_tokens || 0) / 1_000_000) * pricing.output;
    // Cache reads are charged at 10% of input price
    const cacheCost = ((s.total_cache_read || 0) / 1_000_000) * pricing.input * 0.1;
    totalEstimatedCost += inputCost + outputCost + cacheCost;

    // Cache savings = what those tokens would have cost at full input price minus discounted price
    cacheSavingsDollars += ((s.total_cache_read || 0) / 1_000_000) * pricing.input * 0.9;
  }

  // --------------- Dollar: efficient session savings ---------------
  // For high-quality sessions (quality > 70), sum the turns saved vs median for their task_type
  let efficientTurnsSaved = 0;
  for (const s of sessions) {
    if ((s.quality_score || 0) <= 70) continue;
    const type = s.task_type || '_unclassified';
    const med = medianByType[type] || overallMedian;
    const delta = med - (s.total_turns || 0);
    if (delta > 0) {
      efficientTurnsSaved += delta;
    }
  }
  // Estimate cost per turn from overall average
  const avgCostPerTurn = totalTurns > 0 ? totalEstimatedCost / totalTurns : 0;
  const efficientSessionSavings = round(efficientTurnsSaved * avgCostPerTurn);

  // --------------- Time estimates ---------------
  // Turns saved vs baseline per task_type
  let totalTurnsSaved = 0;
  for (const s of sessions) {
    const type = s.task_type || '_unclassified';
    const med = medianByType[type] || overallMedian;
    const delta = med - (s.total_turns || 0);
    if (delta > 0) {
      totalTurnsSaved += delta;
    }
  }

  const avgSessionMinutes = round(
    sessions.reduce((sum, s) => {
      if (s.started_at && s.ended_at && s.ended_at > s.started_at) {
        return sum + (s.ended_at - s.started_at) / 60;
      }
      // Fallback: estimate from turns
      return sum + (s.total_turns || 0) * MINUTES_PER_TURN;
    }, 0) / totalSessions
  );

  const estimatedHoursSaved = round((totalTurnsSaved * MINUTES_PER_TURN) / 60);

  return {
    relative: {
      cache_savings_pct: cacheSavingsPct,
      avg_turns_vs_baseline: avgTurnsVsBaseline,
      routing_adherence_pct: routingAdherencePct,
      error_recovery_rate: errorRecoveryRate,
      sessions_optimized: sessionsOptimized,
      total_sessions: totalSessions,
    },
    dollars: {
      total_estimated_cost: round(totalEstimatedCost),
      cache_savings_dollars: round(cacheSavingsDollars),
      efficient_session_savings: efficientSessionSavings,
      disclaimer:
        'Estimates based on published model pricing. Actual costs depend on your billing plan.',
    },
    time: {
      avg_session_minutes: avgSessionMinutes,
      estimated_hours_saved: estimatedHoursSaved,
    },
  };
}

/**
 * Build a map of task_type -> { model, tool_id } from model_performance,
 * picking the model with the most turns per task_type.
 */
function buildRecommendedMap(db) {
  const map = {};
  try {
    const rows = db.prepare(`
      SELECT tc.task_type, mp.model, mp.tool_id, SUM(mp.turns) as total_turns
      FROM model_performance mp
      JOIN task_classifications tc ON tc.session_id = mp.session_id
      WHERE tc.task_type IS NOT NULL
      GROUP BY tc.task_type, mp.model, mp.tool_id
      ORDER BY tc.task_type, total_turns DESC
    `).all();
    for (const row of rows) {
      // First row per task_type wins (highest total_turns due to ORDER BY)
      if (!map[row.task_type]) {
        map[row.task_type] = { model: row.model, tool_id: row.tool_id };
      }
    }
  } catch {
    // model_performance or task_classifications table may not exist yet
  }
  return map;
}

/**
 * Return a zeroed-out report for when there are no sessions.
 */
function emptyReport() {
  return {
    relative: {
      cache_savings_pct: 0,
      avg_turns_vs_baseline: 0,
      routing_adherence_pct: 0,
      error_recovery_rate: 0,
      sessions_optimized: 0,
      total_sessions: 0,
    },
    dollars: {
      total_estimated_cost: 0,
      cache_savings_dollars: 0,
      efficient_session_savings: 0,
      disclaimer:
        'Estimates based on published model pricing. Actual costs depend on your billing plan.',
    },
    time: {
      avg_session_minutes: 0,
      estimated_hours_saved: 0,
    },
  };
}
