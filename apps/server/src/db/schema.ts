import type { Database } from 'better-sqlite3';

export function migrate(db: Database) {
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
      raw_data TEXT,
      topic TEXT,
      project_relevance_score REAL,
      topic_summary TEXT,
      meta INTEGER DEFAULT 0,
      agentic_score REAL
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

    CREATE TABLE IF NOT EXISTS session_embeddings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      embedding TEXT NOT NULL,
      metadata TEXT,
      provider TEXT,
      dimensions INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_se_created_at ON session_embeddings(created_at);

    -- Feature: Anti-Hallucination Negative Prompt Injector
    -- Tracks repeated failure patterns so future agents can avoid them
    CREATE TABLE IF NOT EXISTS anti_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_key TEXT NOT NULL,
      task_type TEXT,
      language TEXT,
      failure_description TEXT NOT NULL,
      failed_library TEXT,
      failed_approach TEXT,
      failure_count INTEGER DEFAULT 1,
      success_alternative TEXT,
      success_session_id TEXT REFERENCES sessions(id),
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(pattern_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_task ON anti_patterns(task_type, language);
    CREATE INDEX IF NOT EXISTS idx_ap_key ON anti_patterns(pattern_key);

    -- Feature: P2P Secure Team Memory
    -- Tracks discovered peers on the local network
    CREATE TABLE IF NOT EXISTS p2p_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_id TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      shared_sessions INTEGER DEFAULT 0,
      accepted_sessions INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_p2p_peer ON p2p_peers(peer_id);

    -- Feature: IDE Interception event log
    -- Logs stack traces detected and the solutions served
    CREATE TABLE IF NOT EXISTS ide_interceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at INTEGER NOT NULL,
      raw_trace TEXT NOT NULL,
      error_signature TEXT,
      matched_session_id TEXT REFERENCES sessions(id),
      similarity REAL,
      notification_sent INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ide_sig ON ide_interceptions(error_signature);

    -- Feature: Token Arbitrage log
    -- Tracks routing decisions made by the local proxy
    CREATE TABLE IF NOT EXISTS arbitrage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_at INTEGER NOT NULL,
      task_type TEXT,
      complexity TEXT,
      original_model TEXT,
      routed_model TEXT,
      routed_to_local INTEGER DEFAULT 0,
      historical_success_rate REAL,
      estimated_cost_original REAL,
      estimated_cost_routed REAL,
      actual_outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_arb_task ON arbitrage_log(task_type, routed_to_local);
  `);

    // Seed tools
    const upsert = db.prepare(
        `INSERT OR IGNORE INTO tools (id, display_name) VALUES (?, ?)`
    );

    db.transaction(() => {
        upsert.run('claude-code', 'Claude Code');
        upsert.run('cursor', 'Cursor');
        upsert.run('antigravity', 'Antigravity');
        upsert.run('aider', 'Aider');
        upsert.run('windsurf', 'Windsurf');
        upsert.run('copilot', 'GitHub Copilot');
        upsert.run('continue', 'Continue.dev');
        upsert.run('manual-import', 'Imported Sessions');
    })();
}
