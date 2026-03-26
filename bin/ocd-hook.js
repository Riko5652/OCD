#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// OCD Guardian — Proactive AI Session Monitor & Optimizer
// ══════════════════════════════════════════════════════════════════════════════
// Hooks into Claude Code lifecycle events to provide real-time guidance:
//   session-start  → Context injection + session history + anti-patterns
//   prompt-guard   → Session health + delegation + focus + cross-session sync
//   edit-guard     → File advisor + trace + test gap + conflict detection
//   stop-guard     → Completion quality + handoff reminder + session summary

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
    return raw;
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
// COMMAND: session-start
// Fires: SessionStart hook
// Purpose: Full context load — history, handoffs, recommendations, anti-patterns
// ══════════════════════════════════════════════════════════════════════════════

function sessionStart() {
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

  if (out.length) console.log(out.join('\n'));
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMAND: prompt-guard
// Fires: UserPromptSubmit hook (every user message)
// Purpose: Session health, delegation advice, focus check, cross-session sync
// ══════════════════════════════════════════════════════════════════════════════

function promptGuard() {
  const state = loadState();
  state.turn_count++;
  const out = [];

  // ── Session Health ─────────────────────────────────────────────────────────

  const sessionMins = Math.floor((Date.now() - state.started_at) / 60000);

  // Session length warnings (escalating)
  if (state.turn_count >= 100 && shouldAdvise(state, 'session-critical', 20)) {
    out.push('[OCD] CRITICAL: Session at ' + state.turn_count + ' turns (' + sessionMins + 'min). Context is heavily compressed. START A NEW SESSION — quality is degrading. Push a handoff note first with push_handoff_note.');
  } else if (state.turn_count >= 60 && shouldAdvise(state, 'session-warn', 15)) {
    out.push('[OCD] WARNING: Session at ' + state.turn_count + ' turns. Consider wrapping up soon. If switching topics, start a fresh session.');
  } else if (state.turn_count >= 30 && shouldAdvise(state, 'session-info', 20)) {
    out.push('[OCD] Session at ' + state.turn_count + ' turns. Performance is still good but keep it focused.');
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

  const cmd = [
    'node',
    `"${digestScript}"`,
    '--workspace',
    `"${workspace}"`,
    '--transcripts-dir',
    `"${transcriptsDir}"`,
    ...(sessionId ? ['--session-id', `"${sessionId}"`] : []),
  ].join(' ');

  const result = spawnSync(cmd, {
    shell: true,
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
switch (cmd) {
  // New guardian commands
  case 'session-start': sessionStart(); break;
  case 'prompt-guard':  promptGuard(); break;
  case 'edit-guard':    editGuard(); break;
  case 'stop-guard':    stopGuard(); break;
  case 'session-digest': sessionDigest(); break;
  // Legacy aliases (backwards compat)
  case 'trace':         editGuard(); break;
  case 'cross-sync':    promptGuard(); break;
  case 'session-check': stopGuard(); break;
  default:
    console.error('OCD Guardian commands: session-start | prompt-guard | edit-guard | stop-guard | session-digest');
    process.exit(1);
}

db.close();
