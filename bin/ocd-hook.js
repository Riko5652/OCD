#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// OCD Guardian — Proactive AI Session Monitor & Optimizer
// ══════════════════════════════════════════════════════════════════════════════
// Hooks into Claude Code lifecycle events to provide real-time guidance:
//   session-start     → Context injection + session history + anti-patterns
//   prompt-guard      → Session health + hard stop + delegation + cross-session sync
//   pre-tool-guard    → Repetition detection + edit-without-read + SQL-without-schema
//   post-tool-record  → Tool call logging + fingerprint tracking
//   edit-guard        → File advisor + trace + test gap + conflict detection
//   stop-guard        → Completion quality + handoff reminder + session summary

import { createRequire } from 'module';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ────────────────────────────────────────────────────────────────
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// ── Resolve DB ───────────────────────────────────────────────────────────────
function resolveDbPath() {
  if (process.env.OCD_DB_PATH) return process.env.OCD_DB_PATH;
  if (process.env.DB_PATH) return join(ROOT, process.env.DB_PATH);
  return existsSync(join(ROOT, '.git'))
    ? join(ROOT, 'apps', 'server', '.data', 'ai-productivity.db')
    : join(process.env.HOME || process.env.USERPROFILE || '', '.ai-productivity-dashboard', 'ai-productivity.db');
}
const DB_PATH = resolveDbPath();
const STATE_DIR = join(dirname(DB_PATH), '.hook-state');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

if (!existsSync(DB_PATH)) process.exit(0);

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  try {
    Database = createRequire(join(ROOT, 'apps', 'server', 'package.json'))('better-sqlite3');
  } catch { process.exit(0); }
}

let db;
try {
  db = new Database(DB_PATH, { timeout: 3000 });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  // Bootstrap tool_call_log if server hasn't run yet
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_fingerprint TEXT NOT NULL,
        args_summary TEXT,
        result_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tcl_session ON tool_call_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_tcl_fingerprint ON tool_call_log(args_fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS idx_tcl_created ON tool_call_log(created_at);
    `);
  } catch {}
  // Bootstrap guard_interventions if server hasn't run yet
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guard_interventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        intervention_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        tool_name TEXT,
        action_taken TEXT NOT NULL,
        message TEXT,
        was_overridden INTEGER DEFAULT 0,
        estimated_tokens_saved INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gi_session ON guard_interventions(session_id);
      CREATE INDEX IF NOT EXISTS idx_gi_type ON guard_interventions(intervention_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_gi_created ON guard_interventions(created_at);
    `);
  } catch {}
  // Bootstrap governor tables if server hasn't run yet
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS governor_config (
        project TEXT PRIMARY KEY,
        thresholds TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS governor_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        triggered_at INTEGER NOT NULL,
        triggers TEXT NOT NULL,
        action_taken TEXT,
        override INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_gc_session ON governor_checkpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_gc_triggered ON governor_checkpoints(triggered_at);
    `);
  } catch {}
} catch { process.exit(0); }

// ══════════════════════════════════════════════════════════════════════════════
// SESSION STATE — persisted across hook invocations
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE = join(STATE_DIR, 'guardian-state.json');
const INACTIVITY_RESET_MS = 30 * 60 * 1000; // 30 min = new session

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    // Reset if inactive for too long
    if (Date.now() - raw.last_active > INACTIVITY_RESET_MS) return freshState();
    // Merge with defaults so new fields are always present
    const defaults = freshState();
    return { ...defaults, ...raw };
  } catch { return freshState(); }
}

function freshState() {
  return {
    started_at: Date.now(),
    last_active: Date.now(),
    turn_count: 0,
    files_edited: [],
    file_edit_counts: {},
    unique_dirs: [],
    errors_seen: 0,
    last_test_turn: 0,
    edits_since_test: 0,
    advice_cooldowns: {},
    last_advice: [],
    files_read: [],               // files Read in this session (for anti-hallucination)
    tool_fingerprints: {},        // {fingerprint: {tool_name, args_summary, ts, count}}
    override_until_turn: 0,       // turn count until override expires
  };
}

function saveState(state) {
  state.last_active = Date.now();
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function timeAgo(epochSec) {
  const d = Math.floor(Date.now() / 1000) - epochSec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function parseArgs() {
  const r = {}; const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--') && a[i + 1] && !a[i + 1].startsWith('--')) { r[a[i].slice(2)] = a[i + 1]; i++; }
    else if (a[i].startsWith('--')) r[a[i].slice(2)] = true;
  }
  return r;
}

function safeAll(sql, ...p) { try { return db.prepare(sql).all(...p); } catch { return []; } }
function safeGet(sql, ...p) { try { return db.prepare(sql).get(...p); } catch { return null; } }
function safeRun(sql, ...p) { try { db.prepare(sql).run(...p); } catch {} }

/** Token savings estimates per intervention type */
const TOKEN_SAVINGS = {
  overrun_block: 50000,
  repetition_block: 10000,
  repetition_warn: 3000,
  hallucination_warn: 5000,
  schema_warn: 8000,
  overrun_warn: 5000,
  override_granted: 0,
  governor_checkpoint: 20000,
  governor_hard_stop: 80000,
};

/**
 * Session Governor — configurable convergence checkpoints.
 * Reads thresholds from governor_config table (or uses defaults).
 * Returns { action: 'checkpoint'|'hard_stop', message } or null if OK.
 */
function governorCheck(turnCount, sessionMins, errorCount) {
  // Load thresholds from DB (project-aware via OCD_PROJECT env)
  const project = process.env.OCD_PROJECT || null;
  let thresholds = {
    checkpoint_turns: 180, hardstop_turns: 250,
    checkpoint_output_tokens_k: 100, hardstop_output_tokens_k: 200,
    checkpoint_duration_min: 180, hardstop_duration_min: 300,
    checkpoint_errors: 15, checkpoint_output_amplification: 8,
  };

  try {
    // Try project-specific config first, then global
    let row = project
      ? safeGet('SELECT thresholds FROM governor_config WHERE project = ?', project)
      : null;
    if (!row) row = safeGet('SELECT thresholds FROM governor_config WHERE project = ?', '__global__');
    if (row) thresholds = { ...thresholds, ...JSON.parse(row.thresholds) };
  } catch {}

  // Hard stops
  if (turnCount >= thresholds.hardstop_turns) {
    return { action: 'hard_stop', message: `SESSION GOVERNOR: HARD STOP at ${turnCount} turns (limit: ${thresholds.hardstop_turns}). Push handoff note and stop.` };
  }
  if (sessionMins >= thresholds.hardstop_duration_min) {
    return { action: 'hard_stop', message: `SESSION GOVERNOR: HARD STOP at ${sessionMins}min (limit: ${thresholds.hardstop_duration_min}min). Push handoff note and stop.` };
  }

  // Checkpoints
  if (turnCount >= thresholds.checkpoint_turns) {
    return { action: 'checkpoint', message: `SESSION GOVERNOR: CHECKPOINT at ${turnCount} turns (limit: ${thresholds.checkpoint_turns}). Summarize state, then: commit+TODOs, handoff, or stop for review.` };
  }
  if (sessionMins >= thresholds.checkpoint_duration_min) {
    return { action: 'checkpoint', message: `SESSION GOVERNOR: CHECKPOINT at ${sessionMins}min (limit: ${thresholds.checkpoint_duration_min}min). Summarize state, then: commit+TODOs, handoff, or stop for review.` };
  }
  if (errorCount >= thresholds.checkpoint_errors) {
    return { action: 'checkpoint', message: `SESSION GOVERNOR: CHECKPOINT - ${errorCount} errors (limit: ${thresholds.checkpoint_errors}). Too many retries. Summarize state, then: commit+TODOs, handoff, or stop for review.` };
  }

  return null;
}

/**
 * Record a guard intervention into the guard_interventions table.
 * @param {object} state - Current session state (for session_id)
 * @param {string} type - Intervention type key (e.g. 'overrun_block')
 * @param {string} severity - 'warning' | 'critical' | 'override'
 * @param {string|null} toolName - Tool name involved (if any)
 * @param {string} action - 'block' | 'warn' | 'override'
 * @param {string} message - Human-readable message
 * @param {number} [tokensSaved] - Override default token savings estimate
 */
function recordIntervention(state, type, severity, toolName, action, message, tokensSaved) {
  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.CURSOR_SESSION_ID || 'hook-' + process.pid;
  const estimated = tokensSaved !== undefined ? tokensSaved : (TOKEN_SAVINGS[type] || 0);
  safeRun(
    'INSERT INTO guard_interventions (session_id, intervention_type, severity, tool_name, action_taken, message, was_overridden, estimated_tokens_saved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sessionId, type, severity, toolName || null, action, message || null, 0, estimated, Math.floor(Date.now() / 1000)
  );
}

/** Only emit advice if cooldown expired. Returns true if advice should be shown. */
function shouldAdvise(state, key, cooldownTurns = 10) {
  const lastTurn = state.advice_cooldowns[key] || 0;
  if (state.turn_count - lastTurn < cooldownTurns) return false;
  state.advice_cooldowns[key] = state.turn_count;
  return true;
}

function getFileDir(filePath) {
  const normalized = (filePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts.slice(0, -1).slice(-2).join('/'); // last 2 dir segments
}

// ══════════════════════════════════════════════════════════════════════════════
// STDIN + FINGERPRINTING HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Read JSON from stdin (fd 0). Returns {} on failure. */
function readStdinJSON() {
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

/** Normalize path separators and lowercase for consistent fingerprinting. */
function normPath(p) {
  return (p || '').replace(/\\/g, '/').toLowerCase();
}

/** Normalize bash commands: trim + collapse whitespace. */
function normBash(cmd) {
  return (cmd || '').trim().replace(/\s+/g, ' ');
}

/** Compute djb2 hash of toolName:normalizedArgs, returns hex string. */
function computeFingerprint(toolName, toolInput) {
  const norm = normalizeToolInput(toolName, toolInput);
  const key = toolName + ':' + norm;
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash.toString(16);
}

/** Canonical form per tool for dedup fingerprinting. */
function normalizeToolInput(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read':
      return normPath(input.file_path || '');
    case 'Grep':
      return [input.pattern || '', normPath(input.path || ''), input.output_mode || ''].join(':');
    case 'Glob':
      return [input.pattern || '', normPath(input.path || '')].join(':');
    case 'Bash':
      return normBash(input.command || '');
    case 'Edit':
      return normPath(input.file_path || '') + ':' + (input.old_string || '').slice(0, 100);
    case 'Write':
      return normPath(input.file_path || '');
    case 'WebFetch':
      return (input.url || '').toLowerCase();
    case 'WebSearch':
      return (input.query || '').toLowerCase();
    default:
      // MCP tools: sorted key=value pairs
      return Object.keys(input).sort().map(k => k + '=' + String(input[k]).slice(0, 80)).join(',');
  }
}

/** Short human-readable summary of tool args for display. */
function summarizeArgs(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return basename(input.file_path || '');
    case 'Bash':
      return normBash(input.command || '').slice(0, 80);
    case 'Grep':
      return (input.pattern || '').slice(0, 60);
    case 'Glob':
      return (input.pattern || '').slice(0, 60);
    case 'WebFetch':
      return (input.url || '').slice(0, 80);
    case 'WebSearch':
      return (input.query || '').slice(0, 80);
    default:
      return toolName;
  }
}

/**
 * Returns true if a repeated call to this tool is expected/OK and should NOT trigger
 * the repetition block (e.g. re-reading files, safe status checks).
 */
function isRepeatAllowed(toolName, toolInput) {
  if (toolName === 'Read') return true;
  if (toolName === 'Bash') {
    const cmd = normBash((toolInput && toolInput.command) || '');
    return /^(git status|git diff|git log|ls |pwd|echo |npm test|npx vitest|npx tsc|npx eslint)/.test(cmd);
  }
  return false;
}

// Hard-stop message shown when session overruns limits
const HARD_STOP_MESSAGE = `[OCD] HARD STOP: Session exceeded safety limits (100 turns or 300 min).
Context is saturated — continuing will produce unreliable output.
ACTION REQUIRED:
  1. Push a handoff note (push_handoff_note) summarising what was done and next steps.
  2. Start a fresh session.
To override for 10 more turns, reply: "continue anyway"
`;

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: session-start
// Fires: SessionStart hook
// Purpose: Full context load — history, handoffs, recommendations, anti-patterns
// ══════════════════════════════════════════════════════════════════════════════

async function sessionStart() {
  // Reset state for new session
  saveState(freshState());
  const out = [];

  // Last 3 sessions
  const sessions = safeAll(`
    SELECT title, tldr, started_at, tool_id FROM sessions
    ORDER BY started_at DESC LIMIT 3
  `);
  if (sessions.length) {
    out.push('[OCD] Recent sessions:');
    for (const s of sessions) {
      const info = [s.tool_id, timeAgo(s.started_at)].filter(Boolean).join(', ');
      const title = (s.title || 'Untitled').slice(0, 80);
      out.push(`  - "${title}" (${info})${s.tldr ? ' — ' + s.tldr.slice(0, 100) : ''}`);
    }
  }

  // Handoff notes
  const handoffs = safeAll(`
    SELECT title, description FROM recommendations
    WHERE tool_id = 'handoff' AND dismissed = 0
    ORDER BY created_at DESC LIMIT 5
  `);
  if (handoffs.length) {
    out.push('[OCD] Handoff notes from other sessions:');
    for (const h of handoffs) out.push(`  - ${(h.description || h.title).slice(0, 150)}`);
  }

  // Active recommendations
  const recs = safeAll(`
    SELECT severity, title, description FROM recommendations
    WHERE dismissed = 0 AND tool_id != 'handoff'
    ORDER BY created_at DESC LIMIT 5
  `);
  if (recs.length) {
    out.push('[OCD] Recommendations:');
    for (const r of recs) out.push(`  - [${r.severity}] ${r.title}`);
  }

  // Anti-patterns
  const patterns = safeAll(`
    SELECT failure_description, success_alternative, failure_count
    FROM anti_patterns WHERE failure_count >= 2
    ORDER BY last_seen_at DESC LIMIT 3
  `);
  if (patterns.length) {
    out.push('[OCD] Known anti-patterns:');
    for (const p of patterns) {
      out.push(`  - ${p.failure_description}${p.success_alternative ? ' → ' + p.success_alternative.slice(0, 100) : ''} (${p.failure_count}x)`);
    }
  }

  // ── Production Errors (PM Dashboard PostgreSQL) ────────────────────────────
  const errSummary = await getProductionErrorsSummary();
  if (errSummary) out.push(errSummary);

  // ── Directive (lightweight — no vector search) ─────────────────────────────
  const directive = getHookDirective();
  if (directive) out.push(directive);

  if (out.length) console.log(out.join('\n'));
}

/** Query PM Dashboard error summary via unauthenticated HTTP endpoint. */
async function getProductionErrorsSummary() {
  const baseUrl = process.env.PM_DASHBOARD_URL || 'http://localhost:3030';
  try {
    const res = await fetch(`${baseUrl}/api/health/error-summary`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    if (!data.total) return null;
    const parts = [];
    if (data.bySeverity?.critical) parts.push(`${data.bySeverity.critical} critical`);
    if (data.bySeverity?.high) parts.push(`${data.bySeverity.high} high`);
    parts.push(`${data.total} total`);
    const top = (data.recent || []).slice(0, 2).map(e => `[${e.severity}] ${e.message}`).join('; ');
    return `[OCD] Errors (24h): ${parts.join(', ')}${top ? ' — ' + top : ''}`;
  } catch { return null; }
}

/** Lightweight directive from session health (no vector search). */
function getHookDirective() {
  const now = Date.now();
  const session = safeGet(`
    SELECT total_turns, total_input_tokens, total_output_tokens, error_count, title
    FROM sessions WHERE started_at > ? AND (ended_at IS NULL OR ended_at > ?)
    ORDER BY started_at DESC LIMIT 1
  `, now - 2 * 60 * 60 * 1000, now - 5 * 60 * 1000);
  if (!session) return null;

  const turns = session.total_turns || 0;
  const totalTokens = (session.total_input_tokens || 0) + (session.total_output_tokens || 0);
  const errorRate = turns > 0 ? (session.error_count || 0) / turns : 0;

  // Critical thresholds
  if (totalTokens > 800000) {
    return `[OCD] ⚠ DIRECTIVE: NEW_SESSION — ${Math.round(totalTokens / 1000)}K tokens burned. Context saturated.\n[OCD] Suggested: "Push handoff, start new chat. Focus: ${(session.title || 'continue previous work').slice(0, 80)}"`;
  }
  if (turns > 120) {
    return `[OCD] ⚠ DIRECTIVE: NEW_SESSION — ${turns} turns. Quality is degrading.\n[OCD] Suggested: "Push handoff, start new chat. Focus: ${(session.title || 'continue previous work').slice(0, 80)}"`;
  }
  if (errorRate > 0.4 && turns > 10) {
    return `[OCD] ⚠ DIRECTIVE: REDIRECT — ${Math.round(errorRate * 100)}% error rate. Consider a different approach or model.`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: prompt-guard
// Fires: UserPromptSubmit hook (every user message)
// Purpose: Session health, hard stop, delegation advice, focus check, cross-session sync
// ══════════════════════════════════════════════════════════════════════════════

function promptGuard() {
  const input = readStdinJSON();
  const prompt = (input.prompt || '').toLowerCase();
  const state = loadState();
  state.turn_count++;
  const out = [];

  const sessionMins = Math.floor((Date.now() - state.started_at) / 60000);

  // ── Override Detection ─────────────────────────────────────────────────────

  if (prompt.includes('continue anyway') || prompt.includes('override session') || prompt.includes('keep going')) {
    state.override_until_turn = state.turn_count + 10;
    saveState(state);
    recordIntervention(state, 'override_granted', 'override', null, 'override',
      'User requested override — proceeding for 10 more turns');
    console.log('[OCD] Override accepted. Proceeding for up to 10 more turns. Use this time to wrap up and push a handoff note.');
    return;
  }

  // ── Hard Stop ─────────────────────────────────────────────────────────────

  const overrideActive = state.turn_count <= (state.override_until_turn || 0);
  if ((state.turn_count >= 100 || sessionMins >= 300) && !overrideActive) {
    recordIntervention(state, 'overrun_block', 'critical', null, 'block',
      'Hard stop: ' + state.turn_count + ' turns / ' + sessionMins + 'min — prompt-guard triggered');
    process.stderr.write(HARD_STOP_MESSAGE);
    process.exit(2);
  }

  // ── Session Governor ──────────────────────────────────────────────────────
  // Configurable convergence checkpoints (higher thresholds than basic health)

  if (!overrideActive) {
    const govVerdict = governorCheck(state.turn_count, sessionMins, state.errors_seen || 0);
    if (govVerdict) {
      if (govVerdict.action === 'hard_stop') {
        recordIntervention(state, 'governor_hard_stop', 'critical', null, 'block', govVerdict.message);
        process.stderr.write(govVerdict.message + '\n');
        process.exit(2);
      } else if (govVerdict.action === 'checkpoint' && shouldAdvise(state, 'governor-checkpoint', 30)) {
        out.push('[OCD] ' + govVerdict.message);
        recordIntervention(state, 'governor_checkpoint', 'warning', null, 'warn', govVerdict.message);
      }
    }
  }

  // ── Session Health ─────────────────────────────────────────────────────────

  // Session length warnings (escalating)
  if (state.turn_count >= 100 && shouldAdvise(state, 'session-critical', 20)) {
    out.push('[OCD] CRITICAL: Session at ' + state.turn_count + ' turns (' + sessionMins + 'min). Context is heavily compressed. START A NEW SESSION — quality is degrading. Push a handoff note first with push_handoff_note.');
    recordIntervention(state, 'overrun_warn', 'critical', null, 'warn',
      'Session critical: ' + state.turn_count + ' turns / ' + sessionMins + 'min');
  } else if (state.turn_count >= 60 && shouldAdvise(state, 'session-warn', 15)) {
    out.push('[OCD] WARNING: Session at ' + state.turn_count + ' turns. Consider wrapping up soon. If switching topics, start a fresh session.');
    recordIntervention(state, 'overrun_warn', 'warning', null, 'warn',
      'Session warning: ' + state.turn_count + ' turns / ' + sessionMins + 'min');
  } else if (state.turn_count >= 30 && shouldAdvise(state, 'session-info', 20)) {
    out.push('[OCD] Session at ' + state.turn_count + ' turns. Performance is still good but keep it focused.');
  }

  // ── Repetition Summary ────────────────────────────────────────────────────

  const repeatedTools = Object.values(state.tool_fingerprints || {}).filter(fp => fp.count >= 3);
  if (repeatedTools.length >= 3 && shouldAdvise(state, 'repeat-summary', 10)) {
    const examples = repeatedTools.slice(0, 3).map(fp => `${fp.tool_name}(${fp.args_summary})`).join(', ');
    out.push('[OCD] REPETITION: ' + repeatedTools.length + ' tool calls repeated 3+ times this session: ' + examples + '. Review if this is necessary or if you are looping.');
    recordIntervention(state, 'repetition_warn', 'warning', null, 'warn',
      repeatedTools.length + ' tools repeated 3+ times: ' + examples.slice(0, 120));
  }

  // ── Delegation Advisor ─────────────────────────────────────────────────────

  const uniqueFiles = state.files_edited.length;
  const uniqueDirs = [...new Set(state.files_edited.map(getFileDir))].length;

  if (uniqueFiles >= 6 && shouldAdvise(state, 'delegate-files', 15)) {
    out.push('[OCD] DELEGATE: ' + uniqueFiles + ' files touched across ' + uniqueDirs + ' directories. Use subagents (Agent tool) to parallelize independent work across different areas.');
  } else if (uniqueDirs >= 3 && shouldAdvise(state, 'delegate-dirs', 15)) {
    out.push('[OCD] FOCUS: Work is spanning ' + uniqueDirs + ' different areas. Consider splitting into focused subagents — one per area.');
  }

  // ── File Churn Detection ───────────────────────────────────────────────────

  const churned = Object.entries(state.file_edit_counts)
    .filter(([, c]) => c >= 4)
    .map(([f, c]) => `${basename(f)} (${c}x)`);

  if (churned.length && shouldAdvise(state, 'file-churn', 10)) {
    out.push('[OCD] CHURN: Re-editing same files: ' + churned.join(', ') + '. Step back — read the error, check tests, understand root cause before editing again.');
  }

  // ── Test Gap Detection ─────────────────────────────────────────────────────

  if (state.edits_since_test >= 5 && shouldAdvise(state, 'test-gap', 8)) {
    out.push('[OCD] TEST GAP: ' + state.edits_since_test + ' edits since last test run. Run tests NOW before more changes pile up.');
  }

  // ── Cross-Session Sync ─────────────────────────────────────────────────────

  // Rate limited: every 60s
  const syncFile = join(STATE_DIR, 'cross-sync.ts');
  let doSync = true;
  try {
    const last = parseInt(readFileSync(syncFile, 'utf-8'), 10);
    if (Date.now() - last < 60000) doSync = false;
  } catch {}

  if (doSync) {
    writeFileSync(syncFile, String(Date.now()));
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;

    // Handoff notes from parallel sessions
    const handoffs = safeAll(`
      SELECT title, description FROM recommendations
      WHERE tool_id = 'handoff' AND dismissed = 0 AND created_at > ?
      ORDER BY created_at DESC LIMIT 3
    `, fiveMinAgo);
    if (handoffs.length) {
      out.push('[OCD] From parallel sessions:');
      for (const h of handoffs) out.push(`  - ${(h.description || h.title).slice(0, 150)}`);
    }

    // New recommendations
    const recs = safeAll(`
      SELECT title, description FROM recommendations
      WHERE dismissed = 0 AND tool_id != 'handoff' AND created_at > ?
      ORDER BY created_at DESC LIMIT 3
    `, fiveMinAgo);
    if (recs.length) {
      out.push('[OCD] New recommendations:');
      for (const r of recs) out.push(`  - ${r.title}`);
    }
  }

  // ── Cross-Session File Conflict Detection ──────────────────────────────────

  if (state.files_edited.length > 0 && doSync) {
    const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
    for (const file of state.files_edited.slice(-5)) {
      const bn = basename(file);
      const conflict = safeGet(`
        SELECT tool_id, session_id FROM ai_files
        WHERE file_path LIKE ? AND created_at > ? AND session_id NOT LIKE 'hook-%'
        ORDER BY created_at DESC LIMIT 1
      `, `%${bn}%`, tenMinAgo);
      if (conflict) {
        out.push('[OCD] CONFLICT: ' + bn + ' was recently edited in another session (' + conflict.tool_id + '). Coordinate to avoid overwriting.');
        break; // one conflict warning is enough
      }
    }
  }

  saveState(state);
  // Max 3 advice items per invocation to avoid noise
  if (out.length) console.log(out.slice(0, 3).join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: pre-tool-guard
// Fires: PreToolUse hook (before every tool call)
// Purpose: Session overrun block, repetition detection, edit-without-read, SQL-without-schema
// ══════════════════════════════════════════════════════════════════════════════

function preToolGuard() {
  const input = readStdinJSON();
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const state = loadState();
  const out = [];

  const sessionMins = Math.floor((Date.now() - state.started_at) / 60000);

  // ── Session Overrun Block ──────────────────────────────────────────────────

  const overrideActive = state.turn_count <= (state.override_until_turn || 0);
  if ((state.turn_count >= 100 || sessionMins >= 300) && !overrideActive) {
    recordIntervention(state, 'overrun_block', 'critical', toolName || null, 'block',
      'Session overrun: ' + state.turn_count + ' turns / ' + sessionMins + 'min — hard stop triggered');
    process.stderr.write(HARD_STOP_MESSAGE);
    process.exit(2);
  }

  // ── Repetition Detection ───────────────────────────────────────────────────

  if (toolName) {
    const fp = computeFingerprint(toolName, toolInput);
    const existing = (state.tool_fingerprints || {})[fp];

    if (existing && !isRepeatAllowed(toolName, toolInput)) {
      existing.count = (existing.count || 1) + 1;
      state.tool_fingerprints[fp] = existing;

      if (existing.count >= 5) {
        saveState(state);
        const blockMsg = '[OCD] BLOCKED: going in circles — ' + toolName + '(' + existing.args_summary + ') called ' + existing.count + ' times with identical args.\n' +
          'Stop and reassess: read the error message, check the actual file, or ask for clarification.\n';
        recordIntervention(state, 'repetition_block', 'critical', toolName, 'block',
          toolName + '(' + existing.args_summary + ') called ' + existing.count + 'x — repetition block');
        process.stderr.write(blockMsg);
        process.exit(2);
      } else if (existing.count >= 3) {
        const warnMsg = '[OCD] REPEAT WARNING: ' + toolName + '(' + existing.args_summary + ') called ' + existing.count + 'x with same args. Are you looping?';
        out.push(warnMsg);
        recordIntervention(state, 'repetition_warn', 'warning', toolName, 'warn',
          toolName + '(' + existing.args_summary + ') called ' + existing.count + 'x');
      }
    }
  }

  // ── Edit-Without-Read ─────────────────────────────────────────────────────

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = normPath(toolInput.file_path || '');
    const filesRead = (state.files_read || []).map(normPath);
    if (filePath && !filesRead.includes(filePath)) {
      const warnMsg = '[OCD] CAUTION: Editing ' + basename(toolInput.file_path || '') + ' without a prior Read. Verify you have current file contents to avoid overwriting changes.';
      out.push(warnMsg);
      recordIntervention(state, 'hallucination_warn', 'warning', toolName, 'warn',
        'Edit-without-read: ' + basename(toolInput.file_path || ''));
    }
  }

  // ── SQL-Without-Schema ─────────────────────────────────────────────────────

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').toUpperCase();
    const hasSql = /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(cmd) && /\bFROM\b/.test(cmd);
    const hasSchema = /INFORMATION_SCHEMA/.test(cmd);

    if (hasSql && !hasSchema) {
      // Check if any prior schema query exists in fingerprints
      const hasSchemaQuery = Object.values(state.tool_fingerprints || {}).some(fp =>
        fp.tool_name === 'Bash' && (fp.args_summary || '').toUpperCase().includes('INFORMATION_SCHEMA')
      );
      if (!hasSchemaQuery) {
        const warnMsg = '[OCD] SQL-WITHOUT-SCHEMA: Running SQL without a prior schema discovery. Per CLAUDE.md: discover table schema first with: SELECT column_name, data_type FROM information_schema.columns WHERE table_name = \'<table\'>;';
        out.push(warnMsg);
        recordIntervention(state, 'schema_warn', 'warning', toolName, 'warn',
          'SQL executed without prior INFORMATION_SCHEMA discovery');
      }
    }
  }

  saveState(state);
  // Max 2 warnings per invocation
  if (out.length) console.log(out.slice(0, 2).join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: post-tool-record
// Fires: PostToolUse hook (after every tool call)
// Purpose: Log tool calls, track fingerprints, track reads
// ══════════════════════════════════════════════════════════════════════════════

function postToolRecord() {
  const input = readStdinJSON();
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const state = loadState();

  // ── Record Fingerprint (init only — count stays at 1 on first call) ────────

  if (toolName) {
    const fp = computeFingerprint(toolName, toolInput);
    if (!state.tool_fingerprints[fp]) {
      state.tool_fingerprints[fp] = {
        tool_name: toolName,
        args_summary: summarizeArgs(toolName, toolInput),
        ts: Date.now(),
        count: 1,
      };
    }
    // count increments happen in pre-tool-guard, not here

    // ── Track Read Ops ─────────────────────────────────────────────────────

    if (toolName === 'Read' && toolInput.file_path) {
      const np = normPath(toolInput.file_path);
      if (!state.files_read.includes(np)) {
        state.files_read.push(np);
      }
    }

    // ── Track Grep/Glob as partial reads (if targeting a specific file) ───

    if ((toolName === 'Grep' || toolName === 'Glob') && toolInput.path) {
      const np = normPath(toolInput.path);
      // Only track if path looks like a specific file (has extension)
      if (/\.\w+$/.test(np) && !state.files_read.includes(np)) {
        state.files_read.push(np);
      }
    }

    // ── Insert into tool_call_log ──────────────────────────────────────────

    const sessionId = process.env.CLAUDE_SESSION_ID || process.env.CURSOR_SESSION_ID || 'hook-' + process.pid;
    safeRun(
      'INSERT INTO tool_call_log (session_id, tool_name, args_fingerprint, args_summary, result_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId,
      toolName,
      fp,
      summarizeArgs(toolName, toolInput),
      null,
      Math.floor(Date.now() / 1000)
    );

    // ── Prune fingerprints if > 200 entries (remove oldest by timestamp) ──

    const entries = Object.entries(state.tool_fingerprints);
    if (entries.length > 200) {
      entries.sort(([, a], [, b]) => a.ts - b.ts);
      const toRemove = entries.slice(0, entries.length - 200);
      for (const [key] of toRemove) {
        delete state.tool_fingerprints[key];
      }
    }
  }

  saveState(state);
  // No output — this is a silent recorder
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: edit-guard
// Fires: PostToolUse hook (after Edit/Write)
// Purpose: File advisor, trace recording, test reminders, anti-pattern matching
// ══════════════════════════════════════════════════════════════════════════════

function editGuard() {
  const args = parseArgs();
  const file = args.file || '';
  const state = loadState();
  const out = [];

  // ── Update Session State ───────────────────────────────────────────────────

  if (file) {
    if (!state.files_edited.includes(file)) state.files_edited.push(file);
    state.file_edit_counts[file] = (state.file_edit_counts[file] || 0) + 1;
    state.edits_since_test++;

    // Detect test runs (if the edited file is a test, reset the counter)
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__')) {
      state.last_test_turn = state.turn_count;
      state.edits_since_test = 0;
    }
  }

  // ── Record Trace ───────────────────────────────────────────────────────────

  safeRun(`
    INSERT INTO ai_files (tool_id, session_id, file_path, file_extension, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, 'claude-code', `hook-${Date.now()}`, file, (file.split('.').pop() || ''), 'edit', Math.floor(Date.now() / 1000));

  // ── File-Specific Intelligence ─────────────────────────────────────────────

  if (file) {
    const bn = basename(file);
    const fileDir = getFileDir(file);

    // Check past errors involving this file
    const issue = safeGet(`
      SELECT error_signature FROM ide_interceptions
      WHERE raw_trace LIKE ? AND similarity > 0.7
      ORDER BY detected_at DESC LIMIT 1
    `, `%${bn}%`);
    if (issue) {
      out.push('[OCD] WARNING: ' + bn + ' was involved in a past error (' + issue.error_signature + '). Run tests after this change.');
    }

    // Check anti-patterns for this file type
    const ext = file.split('.').pop() || '';
    const antiPattern = safeGet(`
      SELECT failure_description, success_alternative FROM anti_patterns
      WHERE (failed_library LIKE ? OR failure_description LIKE ?)
      AND failure_count >= 3
      ORDER BY failure_count DESC LIMIT 1
    `, `%${ext}%`, `%${bn}%`);
    if (antiPattern && shouldAdvise(state, 'anti-' + bn, 15)) {
      out.push('[OCD] ANTI-PATTERN for ' + bn + ': ' + antiPattern.failure_description.slice(0, 120) +
        (antiPattern.success_alternative ? ' → ' + antiPattern.success_alternative.slice(0, 80) : ''));
    }

    // Check if there's a known test file for this source
    if (!file.includes('.test.') && !file.includes('.spec.') && file.includes('src/')) {
      const srcBase = bn.replace('.ts', '').replace('.js', '');
      const hasTest = safeGet(`
        SELECT file_path FROM ai_files
        WHERE file_path LIKE ? AND file_path LIKE ?
        ORDER BY created_at DESC LIMIT 1
      `, `%${srcBase}%`, `%.test.%`);
      if (hasTest && state.edits_since_test >= 3 && shouldAdvise(state, 'test-hint-' + bn, 8)) {
        const testFile = basename(hasTest.file_path);
        out.push('[OCD] Test available: ' + testFile + ' (' + state.edits_since_test + ' edits since last test run)');
      }
    }

    // Churn warning for THIS file (immediate feedback)
    const editCount = state.file_edit_counts[file] || 0;
    if (editCount >= 5 && shouldAdvise(state, 'churn-' + bn, 5)) {
      out.push('[OCD] STOP: ' + bn + ' edited ' + editCount + ' times this session. You may be going in circles. Read the actual error, check the test output, or ask the user for clarification.');
    }
  }

  saveState(state);
  if (out.length) console.log(out.slice(0, 2).join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: stop-guard
// Fires: Stop hook (when Claude finishes responding)
// Purpose: Quality check, handoff reminder, session summary
// ══════════════════════════════════════════════════════════════════════════════

function stopGuard() {
  const state = loadState();
  const out = [];

  // ── Handoff Reminder ───────────────────────────────────────────────────────

  if (state.files_edited.length >= 3 && shouldAdvise(state, 'handoff-remind', 20)) {
    out.push('[OCD] ' + state.files_edited.length + ' files touched this session. If wrapping up, push a handoff note (push_handoff_note) with what you worked on and next steps.');
  }

  // ── Session Health Summary (periodic) ──────────────────────────────────────

  if (state.turn_count > 0 && state.turn_count % 25 === 0) {
    const sessionMins = Math.floor((Date.now() - state.started_at) / 60000);
    const uniqueDirs = [...new Set(state.files_edited.map(getFileDir))].length;
    out.push('[OCD] Session pulse: ' + state.turn_count + ' turns, ' + sessionMins + 'min, ' +
      state.files_edited.length + ' files, ' + uniqueDirs + ' areas. ' +
      (state.edits_since_test > 3 ? 'Tests overdue!' : 'Tests up to date.'));
  }

  saveState(state);
  if (out.length) console.log(out.slice(0, 2).join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: session-digest
// Fires: Stop hook (after stop-guard)
// Purpose: Generate structured next-actions markdown for session handoff
// ══════════════════════════════════════════════════════════════════════════════

function sessionDigest() {
  const args = parseArgs();
  const workspace = args.workspace || process.env.OCD_WORKSPACE;
  const transcriptsDir = args['transcripts-dir'] || process.env.OCD_TRANSCRIPTS_DIR;
  const sessionId = args['session-id'] || process.env.CLAUDE_SESSION_ID || process.env.CURSOR_SESSION_ID || '';

  const digestScript = join(workspace, 'scripts', 'ai', 'auto-session-digest.mjs');
  if (!existsSync(digestScript)) return;

  const cmdArgs = [
    digestScript,
    '--workspace',
    workspace,
    '--transcripts-dir',
    transcriptsDir,
  ];
  if (sessionId) {
    cmdArgs.push('--session-id', sessionId);
  }

  const result = spawnSync('node', cmdArgs, {
    encoding: 'utf8',
    cwd: workspace,
    timeout: 25000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) return;
  const out = (result.stdout || '').trim();
  if (out) console.log(`[OCD] ${out}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// DISPATCH
// ══════════════════════════════════════════════════════════════════════════════

const cmd = process.argv[2];

async function dispatch() {
  switch (cmd) {
    case 'session-start':    await sessionStart(); break;
    case 'prompt-guard':     promptGuard(); break;
    case 'pre-tool-guard':   preToolGuard(); break;
    case 'post-tool-record': postToolRecord(); break;
    case 'edit-guard':       editGuard(); break;
    case 'stop-guard':       stopGuard(); break;
    case 'session-digest':   sessionDigest(); break;
    case 'trace':            editGuard(); break;
    case 'cross-sync':       promptGuard(); break;
    case 'session-check':    stopGuard(); break;
    default:
      console.error('OCD Guardian commands: session-start | prompt-guard | pre-tool-guard | post-tool-record | edit-guard | stop-guard | session-digest');
      process.exit(1);
  }
}

dispatch().catch(() => {}).finally(() => db.close());
