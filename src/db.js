// Unified SQLite store — persistent analytics across all tools
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const DB_PATH = config.dbPath;
// Ensure data directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { fileMustExist: false });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      data_path TEXT,
      last_scan_at INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL REFERENCES tools(id),
      title TEXT,
      tldr TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      total_turns INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0,
      total_cache_create INTEGER DEFAULT 0,
      primary_model TEXT,
      models_used TEXT,
      cache_hit_pct REAL,
      avg_latency_ms REAL,
      top_tools TEXT,
      quality_score REAL,
      code_lines_added INTEGER DEFAULT 0,
      code_lines_removed INTEGER DEFAULT 0,
      files_touched INTEGER DEFAULT 0,
      first_attempt_pct REAL,
      avg_thinking_length REAL,
      error_count INTEGER DEFAULT 0,
      error_recovery_pct REAL,
      suggestion_acceptance_pct REAL,
      lint_improvement REAL,
      raw_data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      timestamp INTEGER,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_create INTEGER DEFAULT 0,
      latency_ms REAL,
      tok_per_sec REAL,
      tools_used TEXT,
      stop_reason TEXT,
      label TEXT,
      type INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

    CREATE TABLE IF NOT EXISTS commit_scores (
      commit_hash TEXT NOT NULL,
      branch TEXT NOT NULL,
      tool_id TEXT DEFAULT 'cursor',
      scored_at INTEGER,
      lines_added INTEGER DEFAULT 0,
      lines_deleted INTEGER DEFAULT 0,
      ai_lines_added INTEGER DEFAULT 0,
      ai_lines_deleted INTEGER DEFAULT 0,
      human_lines_added INTEGER DEFAULT 0,
      human_lines_deleted INTEGER DEFAULT 0,
      ai_percentage REAL,
      commit_message TEXT,
      commit_date TEXT,
      PRIMARY KEY (commit_hash, branch)
    );

    CREATE TABLE IF NOT EXISTS ai_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id TEXT NOT NULL,
      session_id TEXT,
      file_path TEXT,
      file_extension TEXT,
      model TEXT,
      action TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_files_tool ON ai_files(tool_id);

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      tool_id TEXT,
      category TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      metric_value REAL,
      threshold REAL,
      dismissed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_turns INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      avg_cache_hit_pct REAL,
      avg_latency_ms REAL,
      ai_lines_added INTEGER DEFAULT 0,
      human_lines_added INTEGER DEFAULT 0,
      avg_quality_score REAL,
      PRIMARY KEY (date, tool_id)
    );

    CREATE TABLE IF NOT EXISTS efficiency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      tool_id TEXT,
      session_id TEXT,
      output_score REAL,
      quality_score REAL,
      scale_score REAL,
      value REAL,
      context_tokens INTEGER,
      efficiency REAL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS prompt_metrics (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      first_turn_tokens INTEGER,
      reask_rate REAL,
      has_file_context INTEGER DEFAULT 0,
      constraint_count INTEGER DEFAULT 0,
      turns_to_first_edit INTEGER,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS insight_cache (
      key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      model TEXT NOT NULL,
      turns INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      avg_latency_ms REAL,
      error_count INTEGER DEFAULT 0,
      date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mp_model ON model_performance(model);
    CREATE INDEX IF NOT EXISTS idx_mp_tool ON model_performance(tool_id, model);

    CREATE TABLE IF NOT EXISTS task_classifications (
      session_id TEXT PRIMARY KEY,
      task_type TEXT,
      language TEXT,
      framework TEXT,
      complexity TEXT,
      classified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tc_task ON task_classifications(task_type, language);

    CREATE TABLE IF NOT EXISTS project_index (
      name TEXT PRIMARY KEY,
      session_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_lines_added INTEGER DEFAULT 0,
      dominant_tool TEXT,
      dominant_model TEXT,
      last_active INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_a TEXT NOT NULL REFERENCES sessions(id),
      session_b TEXT NOT NULL REFERENCES sessions(id),
      link_type TEXT NOT NULL,
      quality_score REAL,
      shared_files INTEGER DEFAULT 0,
      detected_at INTEGER NOT NULL,
      UNIQUE(session_a, session_b)
    );
    CREATE INDEX IF NOT EXISTS idx_sl_session_a ON session_links(session_a);
    CREATE INDEX IF NOT EXISTS idx_sl_session_b ON session_links(session_b);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT,
      topic TEXT NOT NULL,
      session_ids TEXT NOT NULL,
      summary TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      date_range_start INTEGER,
      date_range_end INTEGER,
      generated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tc_project ON topic_clusters(project_name, topic);
  `);

  // Add columns to sessions table if not present
  try { db.exec(`ALTER TABLE sessions ADD COLUMN topic TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN project_relevance_score REAL`); } catch (_) {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN topic_summary TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN meta INTEGER DEFAULT 0`); } catch (_) {}

  // Add agentic_score column (idempotent — ALTER TABLE fails silently if already exists)
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN agentic_score REAL`);
  } catch (_) {} // column may already exist

  // Seed tools
  const upsert = db.prepare(
    `INSERT OR IGNORE INTO tools (id, display_name) VALUES (?, ?)`
  );
  upsert.run('claude-code', 'Claude Code');
  upsert.run('cursor', 'Cursor');
  upsert.run('antigravity', 'Antigravity');
  upsert.run('aider', 'Aider');
  upsert.run('windsurf', 'Windsurf');
  upsert.run('copilot', 'GitHub Copilot');
  db.prepare(`INSERT OR IGNORE INTO tools (id, display_name) VALUES ('continue', 'Continue.dev')`).run();
}

// ---- Query helpers ----

export function upsertSession(s) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, tool_id, title, tldr, started_at, ended_at,
      total_turns, total_input_tokens, total_output_tokens, total_cache_read,
      total_cache_create, primary_model, models_used, cache_hit_pct,
      avg_latency_ms, top_tools, quality_score,
      code_lines_added, code_lines_removed, files_touched, first_attempt_pct,
      avg_thinking_length, error_count, error_recovery_pct,
      suggestion_acceptance_pct, lint_improvement,
      meta, raw_data)
    VALUES (@id, @tool_id, @title, @tldr, @started_at, @ended_at,
      @total_turns, @total_input_tokens, @total_output_tokens, @total_cache_read,
      @total_cache_create, @primary_model, @models_used, @cache_hit_pct,
      @avg_latency_ms, @top_tools, @quality_score,
      @code_lines_added, @code_lines_removed, @files_touched, @first_attempt_pct,
      @avg_thinking_length, @error_count, @error_recovery_pct,
      @suggestion_acceptance_pct, @lint_improvement,
      @meta, @raw_data)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, tldr=excluded.tldr, ended_at=excluded.ended_at,
      total_turns=excluded.total_turns, total_input_tokens=excluded.total_input_tokens,
      total_output_tokens=excluded.total_output_tokens, total_cache_read=excluded.total_cache_read,
      total_cache_create=excluded.total_cache_create, primary_model=excluded.primary_model,
      models_used=excluded.models_used, cache_hit_pct=excluded.cache_hit_pct,
      avg_latency_ms=excluded.avg_latency_ms, top_tools=excluded.top_tools,
      quality_score=excluded.quality_score,
      code_lines_added=excluded.code_lines_added, code_lines_removed=excluded.code_lines_removed,
      files_touched=excluded.files_touched, first_attempt_pct=excluded.first_attempt_pct,
      avg_thinking_length=excluded.avg_thinking_length, error_count=excluded.error_count,
      error_recovery_pct=excluded.error_recovery_pct,
      suggestion_acceptance_pct=excluded.suggestion_acceptance_pct,
      lint_improvement=excluded.lint_improvement,
      meta=excluded.meta,
      raw_data=excluded.raw_data
  `).run({
    id: s.id,
    tool_id: s.tool_id,
    title: s.title || null,
    tldr: s.tldr || null,
    started_at: s.started_at || null,
    ended_at: s.ended_at || null,
    total_turns: s.total_turns || 0,
    total_input_tokens: s.total_input_tokens || 0,
    total_output_tokens: s.total_output_tokens || 0,
    total_cache_read: s.total_cache_read || 0,
    total_cache_create: s.total_cache_create || 0,
    primary_model: s.primary_model || null,
    models_used: JSON.stringify(s.models_used || []),
    cache_hit_pct: s.cache_hit_pct ?? null,
    avg_latency_ms: s.avg_latency_ms ?? null,
    top_tools: JSON.stringify(s.top_tools || []),
    quality_score: s.quality_score ?? null,
    code_lines_added: s.code_lines_added || 0,
    code_lines_removed: s.code_lines_removed || 0,
    files_touched: s.files_touched || 0,
    first_attempt_pct: s.first_attempt_pct ?? null,
    avg_thinking_length: s.avg_thinking_length ?? null,
    error_count: s.error_count || 0,
    error_recovery_pct: s.error_recovery_pct ?? null,
    suggestion_acceptance_pct: s.suggestion_acceptance_pct ?? null,
    lint_improvement: s.lint_improvement ?? null,
    meta: s.meta ? 1 : 0,
    raw_data: s.raw ? JSON.stringify(s.raw) : null,
  });
}

export function insertTurns(sessionId, turns) {
  const db = getDb();
  // Clear existing turns for this session then re-insert
  db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
  const insert = db.prepare(`
    INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens,
      cache_read, cache_create, latency_ms, tok_per_sec, tools_used,
      stop_reason, label, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const batch = db.transaction((rows) => {
    for (const t of rows) {
      insert.run(
        sessionId, t.timestamp, t.model || null,
        t.input_tokens || 0, t.output_tokens || 0,
        t.cache_read || 0, t.cache_create || 0,
        t.latency_ms ?? null, t.tok_per_sec ?? null,
        JSON.stringify(t.tools_used || []),
        t.stop_reason || null, t.label || null, t.type ?? null
      );
    }
  });
  batch(turns);
}

export function upsertCommitScore(c) {
  const db = getDb();
  db.prepare(`
    INSERT INTO commit_scores (commit_hash, branch, tool_id, scored_at,
      lines_added, lines_deleted, ai_lines_added, ai_lines_deleted,
      human_lines_added, human_lines_deleted, ai_percentage,
      commit_message, commit_date)
    VALUES (@commit_hash, @branch, @tool_id, @scored_at,
      @lines_added, @lines_deleted, @ai_lines_added, @ai_lines_deleted,
      @human_lines_added, @human_lines_deleted, @ai_percentage,
      @commit_message, @commit_date)
    ON CONFLICT(commit_hash, branch) DO UPDATE SET
      ai_percentage=excluded.ai_percentage,
      ai_lines_added=excluded.ai_lines_added,
      human_lines_added=excluded.human_lines_added
  `).run({
    commit_hash: c.commit_hash,
    branch: c.branch,
    tool_id: c.tool_id || 'cursor',
    scored_at: c.scored_at || null,
    lines_added: c.lines_added || 0,
    lines_deleted: c.lines_deleted || 0,
    ai_lines_added: c.ai_lines_added || 0,
    ai_lines_deleted: c.ai_lines_deleted || 0,
    human_lines_added: c.human_lines_added || 0,
    human_lines_deleted: c.human_lines_deleted || 0,
    ai_percentage: c.ai_percentage ?? null,
    commit_message: c.commit_message || null,
    commit_date: c.commit_date || null,
  });
}

export function upsertDailyStats(date, toolId, stats) {
  const db = getDb();
  db.prepare(`
    INSERT INTO daily_stats (date, tool_id, sessions, total_turns,
      total_input_tokens, total_output_tokens, avg_cache_hit_pct,
      avg_latency_ms, ai_lines_added, human_lines_added, avg_quality_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, tool_id) DO UPDATE SET
      sessions=excluded.sessions, total_turns=excluded.total_turns,
      total_input_tokens=excluded.total_input_tokens,
      total_output_tokens=excluded.total_output_tokens,
      avg_cache_hit_pct=excluded.avg_cache_hit_pct,
      avg_latency_ms=excluded.avg_latency_ms,
      ai_lines_added=excluded.ai_lines_added,
      human_lines_added=excluded.human_lines_added,
      avg_quality_score=excluded.avg_quality_score
  `).run(date, toolId, stats.sessions || 0, stats.total_turns || 0,
    stats.total_input_tokens || 0, stats.total_output_tokens || 0,
    stats.avg_cache_hit_pct ?? null, stats.avg_latency_ms ?? null,
    stats.ai_lines_added || 0, stats.human_lines_added || 0,
    stats.avg_quality_score ?? null);
}

// ---- Read queries ----

export function getAllSessions(toolId, limit = 5000) {
  const db = getDb();
  let sql = 'SELECT * FROM sessions';
  const params = [];
  if (toolId) { sql += ' WHERE tool_id = ?'; params.push(toolId); }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getSessionById(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function getTurnsForSession(sessionId) {
  return getDb().prepare(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp'
  ).all(sessionId);
}

export function getDailyStatsRange(days = 0) {
  if (!days || days <= 0) {
    return getDb().prepare(
      'SELECT * FROM daily_stats ORDER BY date, tool_id'
    ).all();
  }
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(
    'SELECT * FROM daily_stats WHERE date >= ? ORDER BY date, tool_id'
  ).all(cutoff);
}

export function getCommitScores(limit = 100) {
  return getDb().prepare(
    'SELECT * FROM commit_scores ORDER BY scored_at DESC LIMIT ?'
  ).all(limit);
}

export function getRecommendations(includesDismissed = false) {
  const sql = includesDismissed
    ? 'SELECT * FROM recommendations ORDER BY created_at DESC'
    : 'SELECT * FROM recommendations WHERE dismissed = 0 ORDER BY created_at DESC';
  return getDb().prepare(sql).all();
}

export function getOverview() {
  const db = getDb();
  const totals = db.prepare(`
    SELECT tool_id,
      COUNT(*) as sessions,
      SUM(total_turns) as turns,
      SUM(total_input_tokens) as input_tokens,
      SUM(total_output_tokens) as output_tokens,
      AVG(cache_hit_pct) as avg_cache_pct,
      AVG(avg_latency_ms) as avg_latency
    FROM sessions GROUP BY tool_id
  `).all();

  const today = new Date().toISOString().slice(0, 10);
  const todayStats = db.prepare(
    'SELECT * FROM daily_stats WHERE date = ?'
  ).all(today);

  return { totals, today: todayStats };
}

export function upsertPromptMetrics(m) {
  getDb().prepare(`
    INSERT INTO prompt_metrics
      (session_id, first_turn_tokens, reask_rate, has_file_context, constraint_count, turns_to_first_edit, created_at)
    VALUES (@session_id, @first_turn_tokens, @reask_rate, @has_file_context, @constraint_count, @turns_to_first_edit, @created_at)
    ON CONFLICT(session_id) DO UPDATE SET
      first_turn_tokens=excluded.first_turn_tokens, reask_rate=excluded.reask_rate,
      has_file_context=excluded.has_file_context, constraint_count=excluded.constraint_count,
      turns_to_first_edit=excluded.turns_to_first_edit
  `).run({ ...m, created_at: Date.now() });
}

export function getCachedInsight(key) {
  const ttl = 24 * 60 * 60 * 1000;
  const row = getDb().prepare(`SELECT result, created_at FROM insight_cache WHERE key=?`).get(key);
  if (!row) return null;
  if (Date.now() - row.created_at > ttl) {
    getDb().prepare(`DELETE FROM insight_cache WHERE key=?`).run(key);
    return null;
  }
  return row.result;
}

export function setCachedInsight(key, result) {
  getDb().prepare(`
    INSERT INTO insight_cache (key, result, created_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET result=excluded.result, created_at=excluded.created_at
  `).run(key, result, Date.now());
}

export function upsertModelPerformance(rows) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO model_performance
      (session_id, tool_id, model, turns, input_tokens, output_tokens,
       cache_read, avg_latency_ms, error_count, date)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run(
      r.session_id, r.tool_id, r.model, r.turns, r.input_tokens,
      r.output_tokens, r.cache_read, r.avg_latency_ms ?? null,
      r.error_count, r.date
    );
  });
  insertMany(rows);
}

export function getModelPerformance({ tool, model, days = null } = {}) {
  const db = getDb();
  // Default: all history. Pass days to restrict (e.g. days=90 for last 3 months).
  let sql = `
    SELECT mp.*, s.primary_model, s.cache_hit_pct
    FROM model_performance mp
    JOIN sessions s ON s.id = mp.session_id
  `;
  const params = [];
  const conditions = [];
  if (days != null) conditions.push(`s.started_at > ${Date.now() - days * 86400000}`);
  if (tool)  conditions.push(`mp.tool_id = ?`);
  if (model) conditions.push(`mp.model = ?`);
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  if (tool)  params.push(tool);
  if (model) params.push(model);
  return db.prepare(sql).all(...params);
}
