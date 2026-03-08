// Seed a realistic mock database for screenshots/demos
// Run: node seed-mock.mjs  →  writes data/mock.db
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

mkdirSync('./data', { recursive: true });
const db = new Database('./data/mock.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, data_path TEXT, last_scan_at INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, title TEXT, tldr TEXT,
    started_at INTEGER, ended_at INTEGER,
    total_turns INTEGER DEFAULT 0, total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0, total_cache_read INTEGER DEFAULT 0,
    total_cache_create INTEGER DEFAULT 0, primary_model TEXT, models_used TEXT,
    cache_hit_pct REAL, avg_latency_ms REAL, top_tools TEXT, quality_score REAL,
    code_lines_added INTEGER DEFAULT 0, code_lines_removed INTEGER DEFAULT 0,
    files_touched INTEGER DEFAULT 0, first_attempt_pct REAL, avg_thinking_length REAL,
    error_count INTEGER DEFAULT 0, error_recovery_pct REAL,
    suggestion_acceptance_pct REAL, lint_improvement REAL, raw_data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    timestamp INTEGER, model TEXT, input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
    cache_create INTEGER DEFAULT 0, latency_ms REAL, tok_per_sec REAL,
    tools_used TEXT, stop_reason TEXT, label TEXT, type INTEGER
  );
  CREATE TABLE IF NOT EXISTS commit_scores (
    commit_hash TEXT NOT NULL, branch TEXT NOT NULL, tool_id TEXT DEFAULT 'cursor',
    scored_at INTEGER, lines_added INTEGER DEFAULT 0, lines_deleted INTEGER DEFAULT 0,
    ai_lines_added INTEGER DEFAULT 0, ai_lines_deleted INTEGER DEFAULT 0,
    human_lines_added INTEGER DEFAULT 0, human_lines_deleted INTEGER DEFAULT 0,
    ai_percentage REAL, commit_message TEXT, commit_date TEXT,
    PRIMARY KEY (commit_hash, branch)
  );
  CREATE TABLE IF NOT EXISTS ai_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id TEXT NOT NULL,
    session_id TEXT, file_path TEXT, file_extension TEXT, model TEXT, action TEXT, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    tool_id TEXT, category TEXT, severity TEXT, title TEXT, description TEXT,
    metric_value REAL, threshold REAL, dismissed INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT NOT NULL, tool_id TEXT NOT NULL,
    sessions INTEGER DEFAULT 0, total_turns INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0,
    avg_cache_hit_pct REAL, avg_latency_ms REAL,
    ai_lines_added INTEGER DEFAULT 0, human_lines_added INTEGER DEFAULT 0,
    avg_quality_score REAL,
    PRIMARY KEY (date, tool_id)
  );
  CREATE TABLE IF NOT EXISTS efficiency_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, tool_id TEXT,
    session_id TEXT, output_score REAL, quality_score REAL, scale_score REAL,
    value REAL, context_tokens INTEGER, efficiency REAL, description TEXT
  );
`);

const upsertTool = db.prepare('INSERT OR IGNORE INTO tools (id, display_name) VALUES (?, ?)');
upsertTool.run('claude-code', 'Claude Code');
upsertTool.run('cursor', 'Cursor');
upsertTool.run('antigravity', 'Antigravity');

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const rndF = (min, max, dp = 1) => parseFloat((Math.random() * (max - min) + min).toFixed(dp));
const now = Date.now();
const DAY = 86400000;

const claudeTitles = [
  'Implement user authentication with Okta OIDC',
  'Refactor Express routes into domain modules',
  'Build AI analysis pipeline for ticket insights',
  'Fix 403 errors on admin guard middleware',
  'Add Redis caching layer for expensive queries',
  'Implement webhook handler for Jira events',
  'Create data migration for pgvector upgrade',
  'Debug slow PostgreSQL queries on dashboard',
  'Add rate limiting to public API endpoints',
  'Build CSV export for analytics data',
  'Integrate Slack bot with project updates',
  'Fix TypeScript errors in worker services',
  'Design multi-tenant permission system',
  'Optimize Docker build layers for CI speed',
  'Add end-to-end tests for auth flow',
  'Implement SSE for real-time dashboard updates',
  'Build GraphQL schema for new API',
  'Migrate database to PostgreSQL 16',
];

const cursorTitles = [
  'Update React components for new design system',
  'Fix responsive layout on mobile devices',
  'Add Chart.js visualizations to dashboard',
  'Refactor state management with Zustand',
  'Implement dark mode toggle',
  'Build drag-and-drop kanban board',
  'Add infinite scroll to session list',
  'Fix CSS variable theming issues',
  'Create reusable form components',
  'Add keyboard shortcuts to UI',
  'Build tooltip component library',
  'Optimize bundle size with code splitting',
];

const antigravityTitles = [
  'Design new API architecture',
  'Plan database migration strategy',
  'Research LLM evaluation frameworks',
  'Draft technical specification for v3',
  'Analyze codebase for refactoring opportunities',
  'Write product requirements document',
];

const claudeModels = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
const cursorModels = ['gpt-5.1-codex-max', 'claude-4.5-sonnet', 'grok-code-fast-1', 'auto', 'composer-1'];

const insertSession = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, tool_id, title, started_at, ended_at, total_turns,
    total_input_tokens, total_output_tokens, total_cache_read, total_cache_create,
    primary_model, models_used, cache_hit_pct, avg_latency_ms, top_tools,
    quality_score, code_lines_added, code_lines_removed, files_touched,
    first_attempt_pct, avg_thinking_length, error_count, error_recovery_pct,
    suggestion_acceptance_pct, lint_improvement
  ) VALUES (
    @id, @tool_id, @title, @started_at, @ended_at, @total_turns,
    @total_input_tokens, @total_output_tokens, @total_cache_read, @total_cache_create,
    @primary_model, @models_used, @cache_hit_pct, @avg_latency_ms, @top_tools,
    @quality_score, @code_lines_added, @code_lines_removed, @files_touched,
    @first_attempt_pct, @avg_thinking_length, @error_count, @error_recovery_pct,
    @suggestion_acceptance_pct, @lint_improvement
  )
`);

const insertDaily = db.prepare(`
  INSERT OR IGNORE INTO daily_stats (date, tool_id, sessions, total_turns,
    total_input_tokens, total_output_tokens, avg_cache_hit_pct, avg_latency_ms,
    ai_lines_added, human_lines_added, avg_quality_score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  let sid = 1;

  for (let dayOffset = 179; dayOffset >= 0; dayOffset--) {
    const dayStart = now - dayOffset * DAY;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const dow = new Date(dayStart).getDay();
    const isWeekend = dow === 0 || dow === 6;

    // Claude Code: 2–6 sessions/weekday, 0–2 weekend
    const claudeCount = isWeekend ? rnd(0, 2) : rnd(2, 6);
    for (let i = 0; i < claudeCount; i++) {
      const started = dayStart + rnd(7, 22) * 3600000;
      const duration = rnd(20, 180) * 60000;
      const turns = rnd(15, 280);
      const model = claudeModels[rnd(0, 2)];
      const linesAdded = rnd(20, 800);
      insertSession.run({
        id: `cc-${sid++}`, tool_id: 'claude-code',
        title: claudeTitles[rnd(0, claudeTitles.length - 1)],
        started_at: started, ended_at: started + duration,
        total_turns: turns,
        total_input_tokens: turns * rnd(800, 3000),
        total_output_tokens: turns * rnd(400, 1800),
        total_cache_read: turns * rnd(500, 4000),
        total_cache_create: turns * rnd(100, 800),
        primary_model: model,
        models_used: JSON.stringify([model]),
        cache_hit_pct: rndF(55, 95),
        avg_latency_ms: rndF(800, 3500),
        top_tools: JSON.stringify(['Read', 'Edit', 'Bash', 'Grep']),
        quality_score: rndF(180, 340),
        code_lines_added: linesAdded,
        code_lines_removed: rnd(5, Math.max(6, Math.floor(linesAdded * 0.4))),
        files_touched: rnd(1, 18),
        first_attempt_pct: rndF(55, 90),
        avg_thinking_length: model === 'claude-opus-4-6' ? rnd(800, 2400) : rnd(200, 900),
        error_count: rnd(0, 4),
        error_recovery_pct: rndF(70, 98),
        suggestion_acceptance_pct: null,
        lint_improvement: null,
      });
    }

    // Cursor: 1–4 sessions/weekday, 0–1 weekend
    const cursorCount = isWeekend ? rnd(0, 1) : rnd(1, 4);
    for (let i = 0; i < cursorCount; i++) {
      const started = dayStart + rnd(8, 21) * 3600000;
      const duration = rnd(10, 90) * 60000;
      const turns = rnd(5, 60);
      const model = cursorModels[rnd(0, 4)];
      const linesAdded = rnd(10, 400);
      insertSession.run({
        id: `cur-${sid++}`, tool_id: 'cursor',
        title: cursorTitles[rnd(0, cursorTitles.length - 1)],
        started_at: started, ended_at: started + duration,
        total_turns: turns,
        total_input_tokens: turns * rnd(400, 1200),
        total_output_tokens: turns * rnd(600, 2400),
        total_cache_read: turns * rnd(300, 1500),
        total_cache_create: turns * rnd(50, 400),
        primary_model: model,
        models_used: JSON.stringify([model]),
        cache_hit_pct: rndF(60, 98),
        avg_latency_ms: rndF(400, 2000),
        top_tools: JSON.stringify(['Tab', 'Composer']),
        quality_score: rndF(120, 280),
        code_lines_added: linesAdded,
        code_lines_removed: rnd(2, 80),
        files_touched: rnd(1, 8),
        first_attempt_pct: null,
        avg_thinking_length: null,
        error_count: rnd(0, 2),
        error_recovery_pct: null,
        suggestion_acceptance_pct: rndF(68, 94),
        lint_improvement: rndF(-2, 15),
      });
    }

    // Antigravity: 0–2 sessions/day
    const agCount = rnd(0, 2);
    for (let i = 0; i < agCount; i++) {
      const started = dayStart + rnd(9, 18) * 3600000;
      const duration = rnd(5, 45) * 60000;
      insertSession.run({
        id: `ag-${sid++}`, tool_id: 'antigravity',
        title: antigravityTitles[rnd(0, antigravityTitles.length - 1)],
        started_at: started, ended_at: started + duration,
        total_turns: rnd(3, 20),
        total_input_tokens: rnd(500, 3000),
        total_output_tokens: rnd(800, 5000),
        total_cache_read: 0, total_cache_create: 0,
        primary_model: 'gemini',
        models_used: JSON.stringify(['gemini']),
        cache_hit_pct: null, avg_latency_ms: rndF(1500, 4000),
        top_tools: JSON.stringify([]),
        quality_score: rndF(80, 200),
        code_lines_added: rnd(0, 50), code_lines_removed: 0,
        files_touched: rnd(0, 3),
        first_attempt_pct: null, avg_thinking_length: null,
        error_count: 0, error_recovery_pct: null,
        suggestion_acceptance_pct: null, lint_improvement: null,
      });
    }

    // Daily stats
    const dayCounts = { 'claude-code': claudeCount, cursor: cursorCount, antigravity: agCount };
    for (const [toolId, cnt] of Object.entries(dayCounts)) {
      if (cnt === 0) continue;
      insertDaily.run(
        date, toolId, cnt,
        cnt * rnd(20, 120),
        cnt * rnd(15000, 80000),
        cnt * rnd(8000, 40000),
        toolId === 'antigravity' ? null : rndF(60, 92),
        rndF(600, 2800),
        toolId === 'cursor' ? rnd(50, 600) : 0,
        toolId === 'cursor' ? rnd(10, 100) : 0,
        rndF(150, 310)
      );
    }
  }

  // Commit scores — 120 commits
  const commitMessages = [
    'feat: add user authentication', 'fix: resolve 403 on admin routes',
    'refactor: extract service layer', 'feat: implement real-time updates',
    'fix: correct token calculation', 'chore: update dependencies',
    'feat: add data export feature', 'fix: mobile responsive layout',
    'perf: optimize DB queries', 'feat: build kanban board',
    'fix: dark mode toggle', 'test: add E2E auth tests',
    'feat: Slack integration', 'fix: cache invalidation',
    'refactor: simplify state management',
  ];
  const insertCommit = db.prepare(`
    INSERT OR IGNORE INTO commit_scores
      (commit_hash, branch, tool_id, scored_at, lines_added, lines_deleted,
       ai_lines_added, ai_lines_deleted, human_lines_added, human_lines_deleted,
       ai_percentage, commit_message, commit_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < 120; i++) {
    const scored_at = now - rnd(0, 180) * DAY;
    const linesAdded = rnd(20, 600);
    const aiPct = rndF(55, 97);
    const aiLines = Math.floor(linesAdded * aiPct / 100);
    insertCommit.run(
      `abc${i.toString().padStart(4, '0')}`, 'main', 'cursor', scored_at,
      linesAdded, rnd(0, 80), aiLines, 0, linesAdded - aiLines, 0,
      aiPct, commitMessages[i % commitMessages.length],
      new Date(scored_at).toISOString().slice(0, 10)
    );
  }

  // Efficiency log — XP for personal tab
  const insertEff = db.prepare(`
    INSERT INTO efficiency_log
      (date, tool_id, session_id, output_score, quality_score, scale_score,
       value, context_tokens, efficiency, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tools3 = ['claude-code', 'cursor', 'antigravity'];
  for (let i = 0; i < 400; i++) {
    const date = new Date(now - rnd(0, 180) * DAY).toISOString().slice(0, 10);
    const toolId = tools3[rnd(0, 2)];
    const O = rndF(3, 9), Q = rndF(5, 10), S = rndF(3, 9);
    const value = O * Q * S;
    insertEff.run(
      date, toolId, `cc-${rnd(1, 500)}`,
      O, Q, S, value, rnd(2000, 20000), rndF(0.002, 0.05, 4), 'session work'
    );
  }

  // Recommendations
  const recs = [
    { tool_id: 'cursor', category: 'Cache', severity: 'info',
      title: 'High cache efficiency detected',
      description: 'Your Cursor cache hit rate of 89% is excellent. Context reuse is maximizing token efficiency.' ,
      metric_value: 89, threshold: 80 },
    { tool_id: 'claude-code', category: 'Flow', severity: 'tip',
      title: 'Morning sessions are 2.3x more productive',
      description: 'Sessions started between 9-11 AM average 312 quality score vs 136 in the afternoon. Front-load complex work.',
      metric_value: 2.3, threshold: 1.5 },
    { tool_id: 'cursor', category: 'Code Quality', severity: 'tip',
      title: 'AI authorship trending up (+13%)',
      description: 'AI-authored line percentage increased from 71% to 84% over the last 30 days. Composer mode is driving the gain.',
      metric_value: 84, threshold: 70 },
    { tool_id: 'claude-code', category: 'Sessions', severity: 'info',
      title: 'Long sessions yield 4x more code',
      description: 'Sessions over 60 minutes produce on average 4.2x more code lines than short sessions.',
      metric_value: 4.2, threshold: 2 },
  ];
  const insertRec = db.prepare(`
    INSERT INTO recommendations (created_at, tool_id, category, severity, title, description, metric_value, threshold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of recs) {
    insertRec.run(now - rnd(0, 7) * DAY, r.tool_id, r.category, r.severity, r.title, r.description, r.metric_value, r.threshold);
  }
});

seed();

const counts = db.prepare('SELECT tool_id, COUNT(*) as n FROM sessions GROUP BY tool_id').all();
console.log('Mock DB seeded:');
counts.forEach(r => console.log(`  ${r.tool_id}: ${r.n} sessions`));
console.log(`  commit_scores: ${db.prepare('SELECT COUNT(*) as n FROM commit_scores').get().n}`);
console.log(`  efficiency_log: ${db.prepare('SELECT COUNT(*) as n FROM efficiency_log').get().n}`);
console.log('Done -> data/mock.db');
