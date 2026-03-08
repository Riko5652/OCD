// Cross-tool analytics engine — KPIs, aggregation, comparisons
import { getDb, getDailyStatsRange, getAllSessions, getCommitScores } from '../db.js';

// Estimated pricing per 1M tokens (USD) — update as prices change
const MODEL_PRICING = {
  // Claude models
  'claude-opus-4-6':          { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':        { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00 },
  // Cursor models
  'grok-code-fast-1':         { input: 0.10,  output: 0.30 },
  'composer-1':               { input: 0.50,  output: 1.50 },
  'gpt-5.1-codex-max':        { input: 2.50,  output: 10.00 },
  'claude-4.5-sonnet':        { input: 3.00,  output: 15.00 },
  'claude-4.1-opus':          { input: 15.00, output: 75.00 },
  'claude-4.5-opus-high-thinking': { input: 15.00, output: 75.00 },
  'kimi-k2.5':                { input: 0.60,  output: 2.40 },
  'auto':                     { input: 1.00,  output: 4.00 },
  // Gemini
  'gemini':                   { input: 0.15,  output: 0.60 },
  // Default fallback
  '_default':                 { input: 1.00,  output: 4.00 },
};

function estimateCost(model, inputTokens, outputTokens, cacheReadTokens) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['_default'];
  // Cache read tokens are typically 90% cheaper than input
  const cacheDiscount = 0.1;
  const inputCost = ((inputTokens || 0) / 1_000_000) * pricing.input;
  const outputCost = ((outputTokens || 0) / 1_000_000) * pricing.output;
  const cacheCost = ((cacheReadTokens || 0) / 1_000_000) * pricing.input * cacheDiscount;
  return inputCost + outputCost + cacheCost;
}

export function computeOverview() {
  const db = getDb();

  // Per-tool aggregates
  const toolStats = db.prepare(`
    SELECT tool_id,
      COUNT(*) as sessions,
      SUM(total_turns) as turns,
      SUM(total_input_tokens) as input_tokens,
      SUM(total_output_tokens) as output_tokens,
      SUM(total_cache_read) as cache_read,
      SUM(total_cache_create) as cache_create,
      AVG(cache_hit_pct) as avg_cache_pct,
      AVG(avg_latency_ms) as avg_latency,
      SUM(code_lines_added) as code_lines_added,
      SUM(code_lines_removed) as code_lines_removed,
      SUM(files_touched) as files_touched,
      AVG(first_attempt_pct) as avg_first_attempt_pct,
      AVG(avg_thinking_length) as avg_thinking_depth,
      SUM(error_count) as total_errors,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      AVG(lint_improvement) as avg_lint_improvement,
      MIN(started_at) as first_session,
      MAX(started_at) as last_session
    FROM sessions GROUP BY tool_id
  `).all();

  // Global totals
  const global = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(total_turns) as total_turns,
      SUM(total_input_tokens) as total_input,
      SUM(total_output_tokens) as total_output,
      AVG(cache_hit_pct) as avg_cache_pct,
      AVG(avg_thinking_length) as avg_thinking_depth,
      SUM(error_count) as total_errors,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      AVG(lint_improvement) as avg_lint_improvement
    FROM sessions
  `).get();

  // Today's activity
  const today = new Date().toISOString().slice(0, 10);
  const todaySessions = db.prepare(`
    SELECT tool_id, COUNT(*) as count, SUM(total_turns) as turns
    FROM sessions
    WHERE date(started_at / 1000, 'unixepoch') = ?
    GROUP BY tool_id
  `).all(today);

  // AI authorship from commit scores
  const commitStats = db.prepare(`
    SELECT
      COUNT(*) as total_commits,
      AVG(ai_percentage) as avg_ai_pct,
      SUM(ai_lines_added) as total_ai_lines,
      SUM(human_lines_added) as total_human_lines
    FROM commit_scores WHERE ai_percentage IS NOT NULL
  `).get();

  // 30-day trend
  const daily = getDailyStatsRange(30);

  return {
    tools: toolStats,
    global,
    today: todaySessions,
    commits: commitStats,
    daily,
  };
}

export function computeToolComparison() {
  const db = getDb();

  return db.prepare(`
    SELECT tool_id,
      COUNT(*) as sessions,
      SUM(total_turns) as turns,
      SUM(total_output_tokens) as output_tokens,
      AVG(total_turns) as avg_turns_per_session,
      AVG(total_output_tokens * 1.0 / NULLIF(total_turns, 0)) as avg_output_per_turn,
      AVG(cache_hit_pct) as avg_cache_pct,
      AVG(avg_latency_ms) as avg_latency,
      SUM(code_lines_added) as total_code_lines_added,
      SUM(code_lines_removed) as total_code_lines_removed,
      SUM(files_touched) as total_files_touched,
      AVG(code_lines_added) as avg_lines_per_session,
      AVG(first_attempt_pct) as avg_first_attempt_pct,
      AVG(avg_thinking_length) as avg_thinking_depth,
      SUM(error_count) as total_errors,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      AVG(lint_improvement) as avg_lint_improvement,
      GROUP_CONCAT(DISTINCT primary_model) as models
    FROM sessions
    GROUP BY tool_id
  `).all();
}

export function computeModelUsage() {
  const db = getDb();

  return db.prepare(`
    SELECT primary_model as model,
      COUNT(*) as sessions,
      SUM(total_turns) as turns,
      SUM(total_output_tokens) as output_tokens,
      AVG(cache_hit_pct) as avg_cache_pct,
      AVG(avg_latency_ms) as avg_latency,
      SUM(code_lines_added) as code_lines_added,
      AVG(first_attempt_pct) as avg_first_attempt_pct
    FROM sessions
    WHERE primary_model IS NOT NULL AND primary_model != ''
    GROUP BY primary_model
    ORDER BY sessions DESC
  `).all();
}

export function computeCodeGeneration() {
  const db = getDb();

  // Per-tool code generation summary
  const byTool = db.prepare(`
    SELECT tool_id,
      SUM(code_lines_added) as lines_added,
      SUM(code_lines_removed) as lines_removed,
      SUM(files_touched) as files_touched,
      AVG(first_attempt_pct) as avg_first_attempt_pct,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      COUNT(CASE WHEN first_attempt_pct >= 80 THEN 1 END) as high_quality_sessions,
      COUNT(CASE WHEN code_lines_added > 0 THEN 1 END) as sessions_with_code,
      COUNT(*) as total_sessions
    FROM sessions
    GROUP BY tool_id
  `).all();

  // Top sessions by code output
  const topSessions = db.prepare(`
    SELECT id, tool_id, title, code_lines_added, code_lines_removed,
      files_touched, first_attempt_pct, primary_model, started_at
    FROM sessions
    WHERE code_lines_added > 0
    ORDER BY code_lines_added DESC
    LIMIT 20
  `).all();

  // First-attempt success by model (Claude Code only, where we have the data)
  const byModel = db.prepare(`
    SELECT primary_model as model,
      COUNT(*) as sessions,
      AVG(first_attempt_pct) as avg_first_attempt_pct,
      SUM(code_lines_added) as lines_added,
      AVG(code_lines_added) as avg_lines_per_session
    FROM sessions
    WHERE first_attempt_pct IS NOT NULL AND code_lines_added > 0
    GROUP BY primary_model
    ORDER BY avg_first_attempt_pct DESC
  `).all();

  return { byTool, topSessions, byModel };
}

export function computeInsights() {
  const db = getDb();

  // Per-tool insight metrics
  const perTool = db.prepare(`
    SELECT tool_id,
      AVG(avg_thinking_length) as avg_thinking_depth,
      SUM(error_count) as total_errors,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      AVG(lint_improvement) as avg_lint_improvement,
      COUNT(*) as sessions
    FROM sessions
    GROUP BY tool_id
  `).all();

  // Thinking depth trend by week
  const thinkingTrend = db.prepare(`
    SELECT
      strftime('%Y-W%W', started_at / 1000, 'unixepoch') as week,
      AVG(avg_thinking_length) as avg_thinking_depth,
      COUNT(*) as sessions
    FROM sessions
    WHERE avg_thinking_length IS NOT NULL AND started_at IS NOT NULL
    GROUP BY week
    ORDER BY week
  `).all();

  // Error rate trend by week
  const errorTrend = db.prepare(`
    SELECT
      strftime('%Y-W%W', started_at / 1000, 'unixepoch') as week,
      SUM(error_count) as total_errors,
      COUNT(*) as sessions,
      CAST(SUM(error_count) AS REAL) / NULLIF(COUNT(*), 0) as errors_per_session
    FROM sessions
    WHERE started_at IS NOT NULL
    GROUP BY week
    ORDER BY week
  `).all();

  // Model comparison: error recovery and suggestion acceptance
  // Filter out empty/null models and models with < 3 sessions
  const modelComparison = db.prepare(`
    SELECT primary_model as model,
      COUNT(*) as sessions,
      AVG(error_recovery_pct) as avg_error_recovery,
      AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
      AVG(avg_thinking_length) as avg_thinking_depth,
      AVG(lint_improvement) as avg_lint_improvement
    FROM sessions
    WHERE primary_model IS NOT NULL AND primary_model != ''
    GROUP BY primary_model
    HAVING COUNT(*) >= 3
    ORDER BY sessions DESC
  `).all();

  return {
    perTool,
    trends: {
      thinkingDepth: thinkingTrend,
      errorRate: errorTrend,
    },
    modelComparison,
  };
}

export function rebuildDailyStats() {
  const db = getDb();

  // Aggregate sessions into daily_stats
  const rows = db.prepare(`
    SELECT
      date(started_at / 1000, 'unixepoch') as date,
      tool_id,
      COUNT(*) as sessions,
      SUM(total_turns) as total_turns,
      SUM(total_input_tokens) as total_input_tokens,
      SUM(total_output_tokens) as total_output_tokens,
      AVG(cache_hit_pct) as avg_cache_hit_pct,
      AVG(avg_latency_ms) as avg_latency_ms,
      AVG(quality_score) as avg_quality_score
    FROM sessions
    WHERE started_at IS NOT NULL
    GROUP BY date, tool_id
  `).all();

  const upsert = db.prepare(`
    INSERT INTO daily_stats (date, tool_id, sessions, total_turns,
      total_input_tokens, total_output_tokens, avg_cache_hit_pct,
      avg_latency_ms, avg_quality_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, tool_id) DO UPDATE SET
      sessions=excluded.sessions, total_turns=excluded.total_turns,
      total_input_tokens=excluded.total_input_tokens,
      total_output_tokens=excluded.total_output_tokens,
      avg_cache_hit_pct=excluded.avg_cache_hit_pct,
      avg_latency_ms=excluded.avg_latency_ms,
      avg_quality_score=excluded.avg_quality_score
  `);

  const batch = db.transaction(() => {
    for (const r of rows) {
      upsert.run(r.date, r.tool_id, r.sessions, r.total_turns,
        r.total_input_tokens, r.total_output_tokens,
        r.avg_cache_hit_pct, r.avg_latency_ms, r.avg_quality_score);
    }
  });
  batch();
}

// ---- Personal Insights ----

const RANK_TITLES = [
  [1, 'Novice'], [3, 'Apprentice'], [5, 'Practitioner'], [8, 'Engineer'],
  [11, 'Architect'], [15, 'Master'], [20, 'Grandmaster'], [25, 'Legend'], [30, 'Mythic'],
];

const ACHIEVEMENTS = [
  // Volume
  { id: 'sessions-100', cat: 'Volume', icon: '🎯', title: '100 Sessions', desc: 'Complete 100 AI sessions', check: s => s.totalSessions >= 100, threshold: 100 },
  { id: 'sessions-500', cat: 'Volume', icon: '🔥', title: '500 Sessions', desc: 'Complete 500 AI sessions', check: s => s.totalSessions >= 500, threshold: 500 },
  { id: 'sessions-1k', cat: 'Volume', icon: '💎', title: '1K Sessions', desc: 'Complete 1,000 AI sessions', check: s => s.totalSessions >= 1000, threshold: 1000 },
  { id: 'sessions-5k', cat: 'Volume', icon: '👑', title: '5K Sessions', desc: 'Complete 5,000 AI sessions', check: s => s.totalSessions >= 5000, threshold: 5000 },
  { id: 'ai-lines-10k', cat: 'Volume', icon: '📝', title: '10K AI Lines', desc: 'Generate 10,000 AI-authored lines', check: s => s.totalAiLines >= 10000, threshold: 10000 },
  { id: 'ai-lines-100k', cat: 'Volume', icon: '📚', title: '100K AI Lines', desc: 'Generate 100,000 AI-authored lines', check: s => s.totalAiLines >= 100000, threshold: 100000 },
  { id: 'ai-lines-1m', cat: 'Volume', icon: '🏛️', title: '1M AI Lines', desc: 'Generate 1,000,000 AI-authored lines', check: s => s.totalAiLines >= 1000000, threshold: 1000000 },
  { id: 'tokens-1m', cat: 'Volume', icon: '🪙', title: '1M Tokens', desc: 'Use 1 million output tokens', check: s => s.totalOutputTokens >= 1000000, threshold: 1000000 },
  { id: 'tokens-10m', cat: 'Volume', icon: '💰', title: '10M Tokens', desc: 'Use 10 million output tokens', check: s => s.totalOutputTokens >= 10000000, threshold: 10000000 },
  { id: 'tokens-100m', cat: 'Volume', icon: '🏆', title: '100M Tokens', desc: 'Use 100 million output tokens', check: s => s.totalOutputTokens >= 100000000, threshold: 100000000 },
  // Streaks
  { id: 'streak-7', cat: 'Streaks', icon: '📅', title: 'Week Warrior', desc: '7-day coding streak', check: s => s.longestStreak >= 7, threshold: 7 },
  { id: 'streak-14', cat: 'Streaks', icon: '🔄', title: 'Fortnight Focus', desc: '14-day coding streak', check: s => s.longestStreak >= 14, threshold: 14 },
  { id: 'streak-30', cat: 'Streaks', icon: '📆', title: 'Monthly Machine', desc: '30-day coding streak', check: s => s.longestStreak >= 30, threshold: 30 },
  { id: 'streak-60', cat: 'Streaks', icon: '⚡', title: 'Relentless', desc: '60-day coding streak', check: s => s.longestStreak >= 60, threshold: 60 },
  { id: 'streak-100', cat: 'Streaks', icon: '🌟', title: 'Centurion', desc: '100-day coding streak', check: s => s.longestStreak >= 100, threshold: 100 },
  // Quality
  { id: 'flow-10', cat: 'Quality', icon: '🧘', title: 'Flow Finder', desc: '10 flow state sessions', check: s => s.flowCount >= 10, threshold: 10 },
  { id: 'flow-50', cat: 'Quality', icon: '🌊', title: 'Flow Master', desc: '50 flow state sessions', check: s => s.flowCount >= 50, threshold: 50 },
  { id: 'flow-100', cat: 'Quality', icon: '🧠', title: 'Deep Mind', desc: '100 flow state sessions', check: s => s.flowCount >= 100, threshold: 100 },
  { id: 'cache-king', cat: 'Quality', icon: '💾', title: 'Cache King', desc: '90%+ cache hit rate 10 times', check: s => s.highCacheCount >= 10, threshold: 10 },
  { id: 'zero-errors-5', cat: 'Quality', icon: '✨', title: 'Flawless Five', desc: '5 consecutive zero-error sessions', check: s => s.maxZeroErrorStreak >= 5, threshold: 5 },
  // Tools
  { id: 'claude-50', cat: 'Tools', icon: '🤖', title: 'Claude Veteran', desc: '50+ Claude Code sessions', check: s => (s.toolCounts['claude-code'] || 0) >= 50, threshold: 50 },
  { id: 'cursor-50', cat: 'Tools', icon: '🖱️', title: 'Cursor Pro', desc: '50+ Cursor sessions', check: s => (s.toolCounts['cursor'] || 0) >= 50, threshold: 50 },
  { id: 'antigravity-50', cat: 'Tools', icon: '🚀', title: 'Anti-G Ace', desc: '50+ Antigravity sessions', check: s => (s.toolCounts['antigravity'] || 0) >= 50, threshold: 50 },
  { id: 'polyglot', cat: 'Tools', icon: '🌐', title: 'Polyglot', desc: 'Use all 3 tools in one day', check: s => s.polyglotDays >= 1, threshold: 1 },
  // Scale
  { id: 'mega-session', cat: 'Scale', icon: '🗂️', title: 'Mega Session', desc: '50+ files in one session', check: s => s.maxFilesInSession >= 50, threshold: 50 },
  { id: 'pure-ai', cat: 'Scale', icon: '🤯', title: 'Pure AI', desc: 'Commit with 95%+ AI authorship', check: s => s.maxAiPct >= 95, threshold: 95 },
  { id: 'marathon', cat: 'Scale', icon: '🏃', title: 'Marathon', desc: 'Session with 500+ turns', check: s => s.maxTurns >= 500, threshold: 500 },
];

const CHALLENGE_TEMPLATES = [
  { id: 'flow-sessions', title: 'Hit {target} flow state sessions this week', metric: 'weeklyFlowCount', targets: [3, 5, 7], check: (stats, target) => stats.weeklyFlowCount >= target },
  { id: 'cache-hit', title: 'Maintain >80% cache hit rate for {target} sessions', metric: 'weeklyCacheHitCount', targets: [3, 5, 8], check: (stats, target) => stats.weeklyCacheHitCount >= target },
  { id: 'ai-lines', title: 'Write {target}+ AI lines this week', metric: 'weeklyAiLines', targets: [300, 500, 1000], check: (stats, target) => stats.weeklyAiLines >= target },
  { id: 'sessions-count', title: 'Complete {target} sessions this week', metric: 'weeklySessionCount', targets: [10, 15, 20], check: (stats, target) => stats.weeklySessionCount >= target },
  { id: 'zero-error', title: 'Have {target} zero-error sessions this week', metric: 'weeklyZeroErrorCount', targets: [2, 4, 6], check: (stats, target) => stats.weeklyZeroErrorCount >= target },
  { id: 'output-volume', title: 'Generate {target}+ output tokens this week', metric: 'weeklyOutputTokens', targets: [50000, 100000, 200000], check: (stats, target) => stats.weeklyOutputTokens >= target },
];

export function computePersonalInsights() {
  const db = getDb();

  // ---- XP & Level ----
  const xpRow = db.prepare('SELECT COALESCE(SUM(value), 0) as total_xp FROM efficiency_log').get();
  const totalXP = xpRow.total_xp || 0;
  const level = Math.floor(Math.sqrt(totalXP / 50));
  const currentLevelXP = 50 * level * level;
  const nextLevelXP = 50 * (level + 1) * (level + 1);
  const xpProgress = nextLevelXP > currentLevelXP ? (totalXP - currentLevelXP) / (nextLevelXP - currentLevelXP) : 0;
  const rank = (RANK_TITLES.filter(([lvl]) => level >= lvl).pop() || RANK_TITLES[0])[1];

  // ---- Streaks ----
  const sessionDays = db.prepare(`
    SELECT DISTINCT date(started_at / 1000, 'unixepoch', 'localtime') as day
    FROM sessions WHERE started_at IS NOT NULL
    ORDER BY day
  `).all().map(r => r.day);

  let currentStreak = 0, longestStreak = 0, tempStreak = 1;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (let i = 1; i < sessionDays.length; i++) {
    const prev = new Date(sessionDays[i - 1]);
    const curr = new Date(sessionDays[i]);
    const diff = (curr - prev) / 86400000;
    if (diff === 1) { tempStreak++; }
    else { longestStreak = Math.max(longestStreak, tempStreak); tempStreak = 1; }
  }
  longestStreak = Math.max(longestStreak, tempStreak);

  // Current streak: count backwards from today/yesterday
  if (sessionDays.length > 0) {
    const last = sessionDays[sessionDays.length - 1];
    if (last === today || last === yesterday) {
      currentStreak = 1;
      for (let i = sessionDays.length - 2; i >= 0; i--) {
        const prev = new Date(sessionDays[i]);
        const curr = new Date(sessionDays[i + 1]);
        if ((curr - prev) / 86400000 === 1) currentStreak++;
        else break;
      }
    }
  }

  // ---- Lifetime stats ----
  const lifetime = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(total_output_tokens) as total_output_tokens,
      SUM(total_turns) as total_turns,
      SUM(code_lines_added) as total_code_lines,
      SUM(files_touched) as total_files,
      MAX(total_turns) as max_turns,
      MAX(total_output_tokens) as max_output_tokens,
      MAX(code_lines_added) as max_code_lines,
      MAX(files_touched) as max_files_in_session,
      MAX(cache_hit_pct) as max_cache_hit,
      COUNT(DISTINCT date(started_at / 1000, 'unixepoch', 'localtime')) as days_active
    FROM sessions
  `).get();

  const commitStats = db.prepare(`
    SELECT
      SUM(ai_lines_added) as total_ai_lines,
      MAX(ai_percentage) as max_ai_pct
    FROM commit_scores WHERE ai_percentage IS NOT NULL
  `).get();

  // Per-tool counts
  const toolCounts = {};
  db.prepare('SELECT tool_id, COUNT(*) as cnt FROM sessions GROUP BY tool_id').all()
    .forEach(r => { toolCounts[r.tool_id] = r.cnt; });

  // ---- Flow state detection ----
  // Flow = duration > 30min AND turns > 20 AND error_count < turns*0.1 AND output_tokens > 10000
  const flowSessions = db.prepare(`
    SELECT id, tool_id, started_at, ended_at, total_turns, total_output_tokens, error_count,
      code_lines_added, cache_hit_pct, primary_model, title
    FROM sessions
    WHERE total_turns > 20
      AND total_output_tokens > 10000
      AND (error_count * 1.0 / NULLIF(total_turns, 0)) < 0.1
      AND ended_at IS NOT NULL AND started_at IS NOT NULL
      AND (ended_at - started_at) > 1800000
  `).all();
  const flowCount = flowSessions.length;

  // High cache sessions
  const highCacheCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM sessions WHERE cache_hit_pct >= 90'
  ).get().cnt;

  // Max zero-error streak
  const allSessions = db.prepare(
    'SELECT error_count FROM sessions WHERE started_at IS NOT NULL ORDER BY started_at'
  ).all();
  let maxZeroErrorStreak = 0, tempZeroStreak = 0;
  for (const s of allSessions) {
    if ((s.error_count || 0) === 0) { tempZeroStreak++; maxZeroErrorStreak = Math.max(maxZeroErrorStreak, tempZeroStreak); }
    else tempZeroStreak = 0;
  }

  // Polyglot days (all 3 tools in one day)
  const polyglotDays = db.prepare(`
    SELECT date(started_at / 1000, 'unixepoch', 'localtime') as day,
      COUNT(DISTINCT tool_id) as tools
    FROM sessions WHERE started_at IS NOT NULL
    GROUP BY day HAVING tools >= 3
  `).all().length;

  // Max efficiency
  const maxEfficiency = db.prepare('SELECT MAX(value) as v FROM efficiency_log').get()?.v || 0;

  // ---- Achievement evaluation ----
  const achieveStats = {
    totalSessions: lifetime.total_sessions || 0,
    totalAiLines: commitStats?.total_ai_lines || 0,
    totalOutputTokens: lifetime.total_output_tokens || 0,
    longestStreak,
    flowCount,
    highCacheCount,
    maxZeroErrorStreak,
    toolCounts,
    polyglotDays,
    maxFilesInSession: lifetime.max_files_in_session || 0,
    maxAiPct: commitStats?.max_ai_pct || 0,
    maxTurns: lifetime.max_turns || 0,
  };

  const achievements = ACHIEVEMENTS.map(a => ({
    id: a.id, cat: a.cat, icon: a.icon, title: a.title, desc: a.desc,
    earned: a.check(achieveStats),
    threshold: a.threshold,
  }));

  // ---- Heatmap (day-of-week x hour-of-day) ----
  const heatmapRows = db.prepare(`
    SELECT
      CAST(strftime('%w', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) as dow,
      CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
      COUNT(*) as count,
      AVG(total_output_tokens * 1.0 / NULLIF(total_turns, 0)) as avg_output_per_turn
    FROM sessions WHERE started_at IS NOT NULL
    GROUP BY dow, hour
  `).all();

  // Find golden hours (top 3 by avg output per turn, min 3 sessions)
  const heatmapWithCount = db.prepare(`
    SELECT
      CAST(strftime('%w', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) as dow,
      CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
      COUNT(*) as count,
      AVG(total_output_tokens * 1.0 / NULLIF(total_turns, 0)) as avg_output_per_turn
    FROM sessions WHERE started_at IS NOT NULL
    GROUP BY dow, hour HAVING count >= 3
    ORDER BY avg_output_per_turn DESC LIMIT 3
  `).all();

  // ---- Session duration distribution ----
  const durationBuckets = db.prepare(`
    SELECT
      CASE
        WHEN (ended_at - started_at) < 900000 THEN '0-15m'
        WHEN (ended_at - started_at) < 1800000 THEN '15-30m'
        WHEN (ended_at - started_at) < 3600000 THEN '30-60m'
        WHEN (ended_at - started_at) < 7200000 THEN '1-2h'
        ELSE '2h+'
      END as bucket,
      COUNT(*) as count,
      AVG(quality_score) as avg_quality
    FROM sessions
    WHERE started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
    GROUP BY bucket
  `).all();

  // ---- Flow state trend (weekly) ----
  const flowTrend = db.prepare(`
    SELECT
      strftime('%Y-W%W', started_at / 1000, 'unixepoch') as week,
      COUNT(*) as flow_count
    FROM sessions
    WHERE total_turns > 20
      AND total_output_tokens > 10000
      AND (error_count * 1.0 / NULLIF(total_turns, 0)) < 0.1
      AND ended_at IS NOT NULL AND started_at IS NOT NULL
      AND (ended_at - started_at) > 1800000
    GROUP BY week ORDER BY week
  `).all();

  // Deep vs shallow breakdown
  const deepShallow = db.prepare(`
    SELECT
      CASE
        WHEN total_turns > 20 AND total_output_tokens > 10000
          AND (error_count * 1.0 / NULLIF(total_turns, 0)) < 0.1
          AND ended_at IS NOT NULL AND started_at IS NOT NULL
          AND (ended_at - started_at) > 1800000 THEN 'flow'
        WHEN total_turns < 5 THEN 'shallow'
        ELSE 'normal'
      END as category,
      COUNT(*) as count
    FROM sessions
    GROUP BY category
  `).all();

  // ---- Tool comparison radar (normalized 0-100) ----
  const radarData = db.prepare(`
    SELECT tool_id,
      AVG(total_output_tokens) as avg_output,
      AVG(cache_hit_pct) as avg_cache,
      AVG(code_lines_added) as avg_code,
      AVG(error_recovery_pct) as avg_recovery,
      AVG(total_turns) as avg_turns
    FROM sessions GROUP BY tool_id
  `).all();

  // Get per-tool cost efficiency (tokens per dollar, approximate)
  const costEff = {};
  for (const t of radarData) {
    costEff[t.tool_id] = t.avg_output || 0; // simplified: use raw output as proxy
  }

  // Normalize each axis to 0-100
  const axes = ['avg_output', 'avg_cache', 'avg_code', 'avg_recovery', 'avg_turns'];
  const maxes = {};
  for (const ax of axes) {
    maxes[ax] = Math.max(...radarData.map(r => r[ax] || 0), 1);
  }
  const radar = radarData.map(r => ({
    tool_id: r.tool_id,
    output: Math.round(((r.avg_output || 0) / maxes.avg_output) * 100),
    cache: Math.round(((r.avg_cache || 0) / 100) * 100), // already 0-100
    code: Math.round(((r.avg_code || 0) / maxes.avg_code) * 100),
    recovery: Math.round((r.avg_recovery || 0)), // already 0-100
    session_depth: Math.round(((r.avg_turns || 0) / maxes.avg_turns) * 100),
    cost_efficiency: Math.round(((costEff[r.tool_id] || 0) / Math.max(...Object.values(costEff), 1)) * 100),
  }));

  // ---- Personal records ----
  const records = [];
  const recSession = (label, sql) => {
    const row = db.prepare(sql).get();
    if (row) records.push({ label, ...row });
  };
  recSession('Most Turns', 'SELECT total_turns as value, tool_id, started_at FROM sessions ORDER BY total_turns DESC LIMIT 1');
  recSession('Most Output Tokens', 'SELECT total_output_tokens as value, tool_id, started_at FROM sessions ORDER BY total_output_tokens DESC LIMIT 1');
  recSession('Most Code Lines', 'SELECT code_lines_added as value, tool_id, started_at FROM sessions ORDER BY code_lines_added DESC LIMIT 1');
  recSession('Best Cache Hit', 'SELECT cache_hit_pct as value, tool_id, started_at FROM sessions WHERE cache_hit_pct IS NOT NULL ORDER BY cache_hit_pct DESC LIMIT 1');
  recSession('Most Files', 'SELECT files_touched as value, tool_id, started_at FROM sessions ORDER BY files_touched DESC LIMIT 1');
  recSession('Best Efficiency', 'SELECT value, tool_id, date as started_at FROM efficiency_log ORDER BY value DESC LIMIT 1');

  // ---- Weekly challenge ----
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);
  const weekStartTs = weekStart.getTime();

  const weeklyStats = db.prepare(`
    SELECT
      COUNT(*) as weeklySessionCount,
      SUM(total_output_tokens) as weeklyOutputTokens,
      SUM(CASE WHEN error_count = 0 THEN 1 ELSE 0 END) as weeklyZeroErrorCount,
      SUM(CASE WHEN cache_hit_pct >= 80 THEN 1 ELSE 0 END) as weeklyCacheHitCount
    FROM sessions WHERE started_at >= ?
  `).get(weekStartTs);

  const weeklyFlowCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions
    WHERE started_at >= ?
      AND total_turns > 20 AND total_output_tokens > 10000
      AND (error_count * 1.0 / NULLIF(total_turns, 0)) < 0.1
      AND ended_at IS NOT NULL AND (ended_at - started_at) > 1800000
  `).get(weekStartTs)?.cnt || 0;

  const weeklyAiLines = db.prepare(`
    SELECT COALESCE(SUM(ai_lines_added), 0) as lines FROM commit_scores
    WHERE scored_at >= ?
  `).get(weekStartTs)?.lines || 0;

  const wStats = {
    weeklySessionCount: weeklyStats?.weeklySessionCount || 0,
    weeklyOutputTokens: weeklyStats?.weeklyOutputTokens || 0,
    weeklyZeroErrorCount: weeklyStats?.weeklyZeroErrorCount || 0,
    weeklyCacheHitCount: weeklyStats?.weeklyCacheHitCount || 0,
    weeklyFlowCount,
    weeklyAiLines,
  };

  // Deterministic challenge selection based on week number
  const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (7 * 86400000));
  const seed = weekNum + (lifetime.total_sessions || 0);
  const challengeIdx = seed % CHALLENGE_TEMPLATES.length;
  const tmpl = CHALLENGE_TEMPLATES[challengeIdx];
  const targetIdx = Math.min(Math.floor((lifetime.total_sessions || 0) / 100), tmpl.targets.length - 1);
  const target = tmpl.targets[targetIdx];
  const challenge = {
    title: tmpl.title.replace('{target}', fmt(target)),
    current: wStats[tmpl.metric] || 0,
    target,
    complete: tmpl.check(wStats, target),
  };

  return {
    xp: { total: totalXP, level, rank, currentLevelXP, nextLevelXP, progress: xpProgress },
    streak: { current: currentStreak, longest: longestStreak },
    lifetime: {
      sessions: lifetime.total_sessions || 0,
      outputTokens: lifetime.total_output_tokens || 0,
      aiLines: commitStats?.total_ai_lines || 0,
      codeLines: lifetime.total_code_lines || 0,
      daysActive: lifetime.days_active || 0,
      totalTurns: lifetime.total_turns || 0,
    },
    challenge,
    achievements,
    heatmap: heatmapRows,
    goldenHours: heatmapWithCount,
    durationBuckets,
    flowTrend,
    deepShallow,
    radar,
    records,
  };
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function computeCostAnalysis() {
  const db = getDb();

  const sessions = db.prepare(`
    SELECT tool_id, primary_model,
      total_input_tokens, total_output_tokens, total_cache_read,
      started_at
    FROM sessions WHERE primary_model IS NOT NULL
  `).all();

  // Per-tool costs
  const byTool = {};
  const byModel = {};
  let totalCost = 0;

  for (const s of sessions) {
    const cost = estimateCost(s.primary_model, s.total_input_tokens, s.total_output_tokens, s.total_cache_read);
    totalCost += cost;

    if (!byTool[s.tool_id]) byTool[s.tool_id] = { cost: 0, sessions: 0 };
    byTool[s.tool_id].cost += cost;
    byTool[s.tool_id].sessions++;

    if (!byModel[s.primary_model]) byModel[s.primary_model] = { cost: 0, sessions: 0, tokens: 0 };
    byModel[s.primary_model].cost += cost;
    byModel[s.primary_model].sessions++;
    byModel[s.primary_model].tokens += (s.total_input_tokens || 0) + (s.total_output_tokens || 0);
  }

  // Sort models by cost descending
  const modelList = Object.entries(byModel)
    .map(([model, data]) => ({ model, ...data, cost_per_session: data.cost / data.sessions }))
    .sort((a, b) => b.cost - a.cost);

  // Cache savings: what we'd have paid if cached tokens were full-price input
  const cacheSavings = sessions.reduce((s, r) => {
    const p = MODEL_PRICING[r.primary_model] || MODEL_PRICING['_default'];
    return s + ((r.total_cache_read || 0) / 1_000_000) * p.input * 0.9;
  }, 0);

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    cacheSavings: Math.round(cacheSavings * 100) / 100,
    byTool: Object.entries(byTool).map(([tool_id, data]) => ({
      tool_id, cost: Math.round(data.cost * 100) / 100, sessions: data.sessions,
      cost_per_session: Math.round(data.cost / data.sessions * 100) / 100
    })),
    byModel: modelList.map(m => ({
      ...m, cost: Math.round(m.cost * 100) / 100,
      cost_per_session: Math.round(m.cost_per_session * 100) / 100
    })),
    pricing: MODEL_PRICING,
  };
}
