// AI Productivity Dashboard V2 — Express server
// Usage: cd .claude-analytics/v2 && npm start → http://localhost:3030
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  initDb, getDb, upsertSession, insertTurns, upsertCommitScore,
  getAllSessions, getSessionById, getTurnsForSession,
  getDailyStatsRange, getCommitScores as dbGetCommitScores,
  getRecommendations,
  getCachedInsight, setCachedInsight,
  upsertModelPerformance, getModelPerformance,
} from './db.js';
import { adapter as claudeAdapter } from './adapters/claude-code.js';
import { adapter as cursorAdapter } from './adapters/cursor.js';
import { adapter as antigravityAdapter } from './adapters/antigravity.js';
import { adapter as aiderAdapter } from './adapters/aider.js';
import { adapter as windsurfAdapter } from './adapters/windsurf.js';
import { adapter as copilotAdapter } from './adapters/copilot.js';
import { adapter as continueAdapter } from './adapters/continue.js';

const _adapters = [claudeAdapter, cursorAdapter, antigravityAdapter, aiderAdapter, windsurfAdapter, copilotAdapter, continueAdapter];
const getAdapters = () => _adapters;
const getAdapter = (id) => _adapters.find(a => a.id === id);
import { computeOverview, computeToolComparison, computeModelUsage, computeCodeGeneration, computeInsights, computeCostAnalysis, computePersonalInsights, rebuildDailyStats } from './engine/analytics.js';
import { runOptimizer } from './engine/optimizer.js';
import { scoreAndSave } from './engine/scorer.js';
import { computeProfile, computeTrends, computePromptMetrics } from './engine/insights.js';
import { computeAllProjects, computeProjectInsights } from './engine/project-insights.js';
import { detectProvider, streamDeepAnalysis, buildDailyPickPrompt, callAzure } from './engine/llm-analyzer.js';
import { startWatchers, stopWatchers } from './watcher.js';
import { analyzePromptMetrics } from './engine/prompt-analyzer.js';
import { classifySession, computeToolModelWinRates, getRoutingRecommendation } from './engine/cross-tool-router.js';
import { detectToolSwitches, getCrossToolStats } from './engine/cross-tool.js';
import { scoreAllSessions, getAgenticLeaderboard } from './engine/agentic-scorer.js';
import { checkActiveSession } from './engine/session-coach.js';
import { getOptimalPromptStructure, suggestImprovements, extractPromptTemplates } from './engine/prompt-coach.js';
import { classifyAllSessionTopics, getTopicBreakdown, getTopicSummary, detectTopic, scoreProjectRelevance } from './engine/topic-segmenter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config, printConfig } from './config.js';

const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Optional auth token — set AUTH_TOKEN env var to require Bearer token on all API routes
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
if (AUTH_TOKEN) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    if (!req.path.startsWith('/api/')) return next();
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized — set Authorization: Bearer <AUTH_TOKEN>' });
    }
    next();
  });
}

const PORT = config.port;
// Global history window: how many days back to show in charts and stats by default.
// 0 = all time. Override via HISTORY_DAYS env var or ?days=N query param per request.
const HISTORY_DAYS = process.env.HISTORY_DAYS ? parseInt(process.env.HISTORY_DAYS) : 0;

// ---- Simple rate limiter for LLM-triggering endpoints ----
// Prevents accidental or malicious repeated calls that consume cloud API quota.
const llmCallTimestamps = new Map();
function llmRateLimit(windowMs = 60_000) {
  return (req, res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    const last = llmCallTimestamps.get(key) || 0;
    if (now - last < windowMs) {
      const retryIn = Math.ceil((windowMs - (now - last)) / 1000);
      return res.status(429).json({ error: `Rate limited — wait ${retryIn}s before retrying.` });
    }
    llmCallTimestamps.set(key, now);
    next();
  };
}
// Adapters self-register via their import above — use getAdapters() to access them

// ---- SSE live push ----
const sseClients = new Set();

app.get('/api/live', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event = 'refresh') {
  const msg = `event: ${event}\ndata: ${Date.now()}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// Periodic session coach: emit coaching nudges to all SSE clients every 60s
setInterval(() => {
  try {
    const nudges = checkActiveSession();
    if (nudges.length > 0) {
      const data = JSON.stringify({ nudges });
      for (const res of sseClients) {
        try { res.write(`event: coach\ndata: ${data}\n\n`); } catch { sseClients.delete(res); }
      }
    }
  } catch (_) {} // never crash the interval
}, 60000);

// ---- Ingestion ----

async function ingestAdapter(adapter) {
  const label = `[ingest:${adapter.id}]`;
  try {
    const sessions = await adapter.getSessions();
    console.log(`${label} ${sessions.length} sessions`);

    for (const session of sessions) {
      upsertSession(session);
      scoreAndSave(session);
      // Classify session by task type for routing recommendations
      try {
        const cls = classifySession(session);
        getDb().prepare(`
          INSERT OR REPLACE INTO task_classifications
            (session_id, task_type, language, complexity, classified_at)
          VALUES (?,?,?,?,?)
        `).run(session.id, cls.taskType, cls.language, cls.complexity, Date.now());
      } catch (_) {} // never block ingestion
      // Write per-model performance rows
      if (session._modelPerf?.length) {
        const date = new Date(session.started_at || Date.now()).toISOString().slice(0, 10);
        upsertModelPerformance(session._modelPerf.map(r => ({
          ...r,
          session_id: session.id,
          tool_id: session.tool_id || adapter.id,
          date,
        })));
      }
    }

    // Ingest turns for sessions that don't have turns stored yet.
    // This ensures all history is captured, not just the most recent 50.
    // We check the DB first to avoid re-reading files for already-ingested sessions.
    const db = getDb();
    const sessionsNeedingTurns = sessions.filter(s => {
      const count = db.prepare('SELECT COUNT(*) as c FROM turns WHERE session_id = ?').get(s.id);
      return (count?.c || 0) === 0;
    });

    for (const session of sessionsNeedingTurns) {
      const turns = await adapter.getTurns(session.id);
      if (turns.length > 0) {
        insertTurns(session.id, turns);
        analyzePromptMetrics(session.id);
        // Update session with aggregated turn data
        const totalInput = turns.reduce((s, t) => s + (t.input_tokens || 0), 0);
        const totalOutput = turns.reduce((s, t) => s + (t.output_tokens || 0), 0);
        if (totalInput > 0 || totalOutput > 0) {
          getDb().prepare(`
            UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ?
            WHERE id = ? AND total_input_tokens = 0
          `).run(totalInput, totalOutput, session.id);
        }
      }
    }

    // Adapter-specific data
    if (adapter.getCommitScores) {
      const scores = await adapter.getCommitScores();
      for (const score of scores) upsertCommitScore(score);
      console.log(`${label} ${scores.length} commit scores`);
    }

    if (adapter.getDailyStats) {
      const stats = await adapter.getDailyStats();
      console.log(`${label} ${stats.length} daily stat entries`);
    }
  } catch (e) {
    console.error(`${label} Error:`, e.message);
  }
}

// ---- In-memory result cache (invalidated after each ingest) ----
// All heavy compute functions write here once; subsequent requests return instantly.

const RC = {};

function invalidateCache() {
  for (const k of Object.keys(RC)) delete RC[k];
}

function cached(key, fn) {
  if (RC[key] === undefined) RC[key] = fn();
  return RC[key];
}

async function ingestAll() {
  console.log('[ingest] Starting full ingestion...');
  const start = Date.now();
  for (const adapter of getAdapters()) {
    await ingestAdapter(adapter);
  }
  rebuildDailyStats();
  runOptimizer();
  invalidateCache();
  console.log(`[ingest] Complete in ${Date.now() - start}ms`);
  // Embed high-quality sessions for semantic memory (async, non-blocking)
  setImmediate(async () => {
    try {
      const { embedSession } = await import('./lib/vector-store.js');
      const db = getDb();
      const unembedded = db.prepare(`
        SELECT s.id FROM sessions s
        LEFT JOIN session_embeddings se ON se.session_id = s.id
        WHERE se.session_id IS NULL AND s.quality_score > 50
        ORDER BY s.started_at DESC LIMIT 50
      `).all();
      if (unembedded.length > 0) {
        console.log(`[embed] Embedding ${unembedded.length} sessions...`);
        for (const { id } of unembedded) {
          try { await embedSession(id); } catch (_) {}
        }
        console.log(`[embed] Done`);
      }
    } catch (e) {
      console.warn('[embed] Skipped:', e.message);
    }
  });
  // Pre-warm cache in background so first tab load is instant
  setImmediate(() => {
    try {
      cached('overview', computeOverview);
      cached('compare', computeToolComparison);
      cached('models', computeModelUsage);
      cached('code-generation', computeCodeGeneration);
      cached('insights', computeInsights);
      cached('costs', computeCostAnalysis);
      cached('personal-insights', computePersonalInsights);
      cached('ins:profile', computeProfile);
      cached('ins:trends:0', () => computeTrends(0));
      cached('ins:prompt-metrics', computePromptMetrics);
      cached('recs:false', () => getRecommendations(false));
      cached('daily:0', () => getDailyStatsRange(0));
      cached('commits:100', () => dbGetCommitScores(100));
      console.log('[cache] Pre-warmed');
    } catch (e) {
      console.warn('[cache] Pre-warm error:', e.message);
    }
  });
  broadcast('refresh');
}

// ---- JSON body parsing for import/webhook routes ----
app.use(express.json({ limit: '5mb' }));

// CORS for session import endpoints (bookmarklet sends from other origins)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/sessions/import') || req.path.startsWith('/api/webhook/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// ---- Static files ----
app.use(express.static(join(__dirname, '..', 'public')));

// ---- API Routes ----

// Health check (for Docker, uptime monitors, etc.)
const CURRENT_VERSION = '4.0.0';
let latestVersionCache = { version: null, checkedAt: 0 };

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: CURRENT_VERSION, uptime: Math.round(process.uptime()) });
});

// Version check — polls npm registry at most once per hour
app.get('/api/version-check', async (_req, res) => {
  const ONE_HOUR = 3600_000;
  if (latestVersionCache.version && Date.now() - latestVersionCache.checkedAt < ONE_HOUR) {
    return res.json({ current: CURRENT_VERSION, latest: latestVersionCache.version, updateAvailable: latestVersionCache.version !== CURRENT_VERSION });
  }
  try {
    const resp = await fetch('https://registry.npmjs.org/ai-productivity-dashboard/latest', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      latestVersionCache = { version: data.version, checkedAt: Date.now() };
      return res.json({ current: CURRENT_VERSION, latest: data.version, updateAvailable: data.version !== CURRENT_VERSION });
    }
  } catch (_) { /* network error — don't block */ }
  res.json({ current: CURRENT_VERSION, latest: null, updateAvailable: false });
});

// Overview KPIs
app.get('/api/overview', (_req, res) => {
  res.json(cached('overview', computeOverview));
});

// Tool comparison
app.get('/api/compare', (_req, res) => {
  res.json(cached('compare', computeToolComparison));
});

// Model usage analytics
app.get('/api/models', (_req, res) => {
  res.json(cached('models', computeModelUsage));
});

// All sessions (with optional tool filter)
app.get('/api/sessions', (req, res) => {
  const toolId = req.query.tool || null;
  const limit = parseInt(req.query.limit) || 100;
  const cacheKey = `sessions:${toolId}:${limit}`;
  res.json({ sessions: cached(cacheKey, () => getAllSessions(toolId, limit)) });
});

// Single session with turns (not cached — low-frequency)
app.get('/api/sessions/:id', (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const turns = getTurnsForSession(req.params.id);
  res.json({ ...session, turns });
});

// Daily stats — defaults to HISTORY_DAYS; pass ?days=90 to restrict
app.get('/api/daily', (req, res) => {
  const days = req.query.days ? parseInt(req.query.days) : HISTORY_DAYS;
  res.json(cached(`daily:${days}`, () => getDailyStatsRange(days)));
});

// Commit scores (Cursor AI vs human)
app.get('/api/commits', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(cached(`commits:${limit}`, () => dbGetCommitScores(limit)));
});

// Code generation analytics
app.get('/api/code-generation', (_req, res) => {
  res.json(cached('code-generation', computeCodeGeneration));
});

// Cross-tool insights (thinking depth, errors, recovery, suggestions)
app.get('/api/insights', (_req, res) => {
  res.json(cached('insights', computeInsights));
});

// Cost estimation by tool and model
app.get('/api/costs', (_req, res) => {
  res.json(cached('costs', computeCostAnalysis));
});

// Personal insights (gamification + coaching)
app.get('/api/personal-insights', (_req, res) => {
  res.json(cached('personal-insights', computePersonalInsights));
});

// Optimization recommendations
app.get('/api/recommendations', (req, res) => {
  const all = req.query.all === 'true';
  res.json(cached(`recs:${all}`, () => getRecommendations(all)));
});

// ── Insights routes ──────────────────────────────────────────────────────────

app.get('/api/insights/profile', (_req, res) => {
  try { res.json(cached('ins:profile', computeProfile)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/insights/trends', (req, res) => {
  const days = req.query.days ? parseInt(req.query.days) : HISTORY_DAYS;
  try { res.json(cached(`ins:trends:${days}`, () => computeTrends(days))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/insights/prompt-metrics', (_req, res) => {
  try { res.json(cached('ins:prompt-metrics', computePromptMetrics)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ollama/status', async (_req, res) => {
  try { res.json(await detectProvider()); }
  catch (e) { res.json({ available: false, error: e.message }); }
});

app.get('/api/insights/deep-analyze', llmRateLimit(60_000), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  if (req.query.refresh === '1') {
    getDb().prepare(`DELETE FROM insight_cache WHERE key='deep-analyze-default'`).run();
  }
  streamDeepAnalysis(res).catch(e => {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  });
});

// Dismiss a recommendation
app.post('/api/recommendations/:id/dismiss', express.json(), (req, res) => {
  getDb().prepare('UPDATE recommendations SET dismissed = 1 WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true });
});

// Manual re-ingest trigger
app.post('/api/ingest', async (_req, res) => {
  await ingestAll();
  res.json({ ok: true, timestamp: Date.now() });
});

// Efficiency log
app.get('/api/efficiency', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const rows = getDb().prepare(
    'SELECT * FROM efficiency_log ORDER BY date DESC LIMIT ?'
  ).all(limit);
  res.json(rows);
});

// Cursor daily stats (tab/composer lines)
app.get('/api/cursor-daily', async (_req, res) => {
  try {
    const stats = await getAdapter('cursor')?.getDailyStats?.();
    res.json(stats);
  } catch (e) {
    res.json([]);
  }
});

// Cursor deep dive — model breakdown, bubble metrics, session-level insights
app.get('/api/cursor/deep', (_req, res) => {
  try {
    const db = getDb();

    // Cursor model breakdown
    const modelBreakdown = db.prepare(`
      SELECT primary_model as model,
        COUNT(*) as sessions,
        SUM(total_turns) as total_turns,
        SUM(total_output_tokens) as total_output,
        SUM(total_input_tokens) as total_input,
        AVG(cache_hit_pct) as avg_cache_pct,
        AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
        AVG(lint_improvement) as avg_lint_improvement,
        AVG(avg_thinking_length) as avg_thinking_depth,
        AVG(error_recovery_pct) as avg_error_recovery,
        SUM(code_lines_added) as total_code_lines,
        SUM(files_touched) as total_files,
        AVG(agentic_score) as avg_agentic_score
      FROM sessions WHERE tool_id = 'cursor' AND primary_model IS NOT NULL
      GROUP BY primary_model ORDER BY sessions DESC
    `).all();

    // Overall cursor stats
    const overview = db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        SUM(total_turns) as total_turns,
        SUM(total_output_tokens) as total_output,
        SUM(total_input_tokens) as total_input,
        AVG(cache_hit_pct) as avg_cache_pct,
        AVG(suggestion_acceptance_pct) as avg_suggestion_acceptance,
        AVG(lint_improvement) as avg_lint_improvement,
        AVG(avg_thinking_length) as avg_thinking_depth,
        SUM(code_lines_added) as total_code_lines,
        SUM(files_touched) as total_files,
        AVG(agentic_score) as avg_agentic_score,
        COUNT(DISTINCT date(started_at / 1000, 'unixepoch')) as active_days
      FROM sessions WHERE tool_id = 'cursor'
    `).get();

    // Top cursor sessions by output
    const topSessions = db.prepare(`
      SELECT id, title, primary_model, started_at, total_turns,
        total_output_tokens, total_input_tokens, cache_hit_pct,
        suggestion_acceptance_pct, lint_improvement, avg_thinking_length,
        code_lines_added, files_touched, agentic_score
      FROM sessions WHERE tool_id = 'cursor'
      ORDER BY total_output_tokens DESC LIMIT 20
    `).all();

    // Daily cursor activity
    const dailyActivity = db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch') as date,
        COUNT(*) as sessions,
        SUM(total_turns) as turns,
        SUM(total_output_tokens) as output_tokens,
        AVG(suggestion_acceptance_pct) as avg_suggestion_accept
      FROM sessions WHERE tool_id = 'cursor'
      GROUP BY date ORDER BY date
    `).all();

    res.json({ modelBreakdown, overview, topSessions, dailyActivity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Antigravity stats
app.get('/api/antigravity-stats', async (_req, res) => {
  try {
    const { getStats } = await import('./adapters/antigravity.js');
    res.json(getStats());
  } catch (e) {
    res.json({});
  }
});

// ── Daily Pick (Claude Automation Recommender) ───────────────────────────────

const DAILY_PICK_KEY = 'daily-pick';

async function generateDailyPick() {
  const today = new Date().toISOString().split('T')[0];
  const cached = getCachedInsight(DAILY_PICK_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.date === today) {
        console.log('[daily-pick] Already generated for today, skipping');
        return;
      }
    } catch { /* old format, regenerate */ }
  }

  const { provider, available } = await detectProvider();
  if (!available) {
    console.log('[daily-pick] No LLM provider available, skipping');
    return;
  }

  try {
    console.log(`[daily-pick] Generating with provider=${provider}`);
    const sessions = getDb().prepare(`
      SELECT s.*, t.label as first_label
      FROM sessions s
      LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (
        SELECT MIN(rowid) FROM turns WHERE session_id = s.id
      )
      ORDER BY s.started_at DESC LIMIT 20
    `).all();

    if (sessions.length === 0) {
      console.log('[daily-pick] No sessions yet, skipping');
      return;
    }

    const prompt = buildDailyPickPrompt(sessions);
    let text = '';

    if (provider === 'azure') {
      text = await callAzure(prompt);
    } else if (provider === 'openai') {
      const r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await r.json();
      text = json.choices?.[0]?.message?.content || '';
    } else if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await r.json();
      text = json.content?.[0]?.text || '';
    } else if (provider === 'ollama') {
      const r = await fetch(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'gemma2:2b', prompt, stream: false }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await r.json();
      text = json.response || '';
    }

    if (text) {
      setCachedInsight(DAILY_PICK_KEY, JSON.stringify({ date: today, text, provider }));
      console.log(`[daily-pick] Saved (${text.length} chars)`);
    }
  } catch (e) {
    console.error('[daily-pick] Error:', e.message);
  }
}

// Route: get today's daily pick
app.get('/api/insights/daily-pick', (_req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const cached = getCachedInsight(DAILY_PICK_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.date === today) return res.json({ text: parsed.text, provider: parsed.provider, date: today });
    } catch { /* old format */ }
  }
  res.json({ text: null, date: today });
});

// Route: force-regenerate daily pick
app.post('/api/insights/daily-pick/refresh', llmRateLimit(60_000), async (req, res) => {
  getDb().prepare(`DELETE FROM insight_cache WHERE key=?`).run(DAILY_PICK_KEY);
  generateDailyPick().catch(e => console.error('[daily-pick] refresh error:', e.message));
  res.json({ ok: true });
});

// Model-level performance breakdown
app.get('/api/models/performance', (req, res) => {
  try {
    const rows = getModelPerformance({
      tool:  req.query.tool,
      model: req.query.model,
      days:  req.query.days ? parseInt(req.query.days) : null, // null = all history
    });

    // Aggregate by model across all sessions
    const byModel = {};
    for (const r of rows) {
      if (!byModel[r.model]) byModel[r.model] = {
        model: r.model, tools: new Set(), sessions: 0,
        turns: 0, input_tokens: 0, output_tokens: 0, cache_read: 0,
        latencies: [], errors: 0,
      };
      const m = byModel[r.model];
      m.tools.add(r.tool_id);
      m.sessions++;
      m.turns        += r.turns;
      m.input_tokens += r.input_tokens;
      m.output_tokens+= r.output_tokens;
      m.cache_read   += r.cache_read;
      if (r.avg_latency_ms) m.latencies.push(r.avg_latency_ms);
      m.errors       += r.error_count;
    }

    const result = Object.values(byModel).map(m => ({
      model:          m.model,
      tools:          [...m.tools],
      sessions:       m.sessions,
      turns:          m.turns,
      input_tokens:   m.input_tokens,
      output_tokens:  m.output_tokens,
      cache_hit_pct:  m.cache_read / Math.max(m.input_tokens + m.cache_read, 1) * 100,
      avg_latency_ms: m.latencies.length
        ? m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length
        : null,
      error_rate: m.turns > 0 ? m.errors / m.turns : 0,
    }));

    res.json({ models: result.sort((a, b) => b.turns - a.turns) });
  } catch (err) {
    console.error('[models/performance]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cross-tool auto-routing
app.get('/api/routing/win-rates', (req, res) => {
  try {
    res.json({ win_rates: computeToolModelWinRates({
      taskType: req.query.task_type,
      language: req.query.language,
    })});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/routing/recommend', (req, res) => {
  try {
    res.json(getRoutingRecommendation(req.query.task || ''));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Project rollup
app.get('/api/projects', (_req, res) => {
  try {
    res.json({ projects: cached('projects:list', computeAllProjects) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/projects/:projectName/insights', (req, res) => {
  try {
    const data = computeProjectInsights(req.params.projectName);
    if (!data) return res.status(404).json({ error: 'No sessions found for this project.' });
    res.json(data);
  } catch (err) {
    console.error('[project-insights]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cross-tool intelligence
app.get('/api/cross-tool', (_req, res) => {
  try {
    detectToolSwitches(); // re-detect on every request (fast, idempotent)
    const stats = getCrossToolStats();
    res.json({ switches: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agentic session leaderboard
app.get('/api/agentic/scores', (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days) : null; // null = all history
    const leaderboard = getAgenticLeaderboard({ days });
    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prompt-coach/templates', (req, res) => {
  try {
    const templates = extractPromptTemplates({ minQuality: parseInt(req.query.min_quality || '70') });
    res.json({ templates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/prompt-coach/optimal', (req, res) => {
  try {
    const structure = getOptimalPromptStructure(req.query.task_type || 'general');
    res.json(structure);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/prompt-coach/improve', (req, res) => {
  try {
    const suggestions = suggestImprovements(req.query.task_type || 'general');
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Topic segmentation routes ─────────────────────────────────────────────

app.get('/api/projects/:projectName/topics', async (req, res) => {
  try {
    const projectName = req.params.projectName;
    const breakdown = getTopicBreakdown(projectName);

    // For each topic with 3+ sessions, get/generate summary
    const result = {};
    for (const [topic, group] of Object.entries(breakdown)) {
      const summaryData = group.sessions.length >= 3
        ? await getTopicSummary(projectName, topic)
        : { summary: null };
      result[topic] = {
        session_count: group.sessions.length,
        total_tokens: group.total_tokens,
        low_relevance_count: group.low_relevance_count,
        summary: summaryData.summary,
        sessions: group.sessions.slice(0, 10).map(s => ({
          id: s.id,
          tool: s.tool_id,
          model: s.primary_model,
          turns: s.total_turns,
          quality: Math.round(s.quality_score || 0),
          relevance: Math.round((s.project_relevance_score || 0.5) * 100),
          date: new Date(s.started_at).toISOString().slice(0, 10),
        })),
      };
    }

    res.json({ project: projectName, topics: result });
  } catch (err) {
    console.error('[topics]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/topics/summary', (_req, res) => {
  try {
    const db = getDb();
    const distribution = db.prepare(`
      SELECT topic, COUNT(*) as session_count, AVG(project_relevance_score) as avg_relevance
      FROM sessions
      WHERE topic IS NOT NULL
      GROUP BY topic
      ORDER BY session_count DESC
    `).all();
    res.json({ distribution });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sessions/:id/classify', (req, res) => {
  try {
    const session = getDb().prepare(`SELECT id, title, tldr, raw_data, top_tools FROM sessions WHERE id = ?`).get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const topic = detectTopic(session);
    const relevance = scoreProjectRelevance(session, req.query.project || '');
    res.json({ id: session.id, topic, project_relevance_score: relevance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Session Import routes ──────────────────────────────────────────────────

const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'Source tool: chatgpt, claude-web, gemini-web, custom, or any adapter id' },
    title: { type: 'string', description: 'Session title or first user message' },
    started_at: { type: 'string', description: 'ISO 8601 timestamp' },
    model: { type: 'string', description: 'Model name (optional)' },
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
        },
        required: ['role', 'content'],
      },
    },
  },
  required: ['tool', 'turns'],
};

app.get('/api/sessions/import/schema', (_req, res) => {
  res.json(IMPORT_SCHEMA);
});

function importSession(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid request body');
  if (!Array.isArray(data.turns) || data.turns.length === 0) throw new Error('turns must be a non-empty array');
  if (data.turns.length > 2000) throw new Error('Too many turns (max 2000)');
  if (data.tool && (typeof data.tool !== 'string' || data.tool.length > 64)) throw new Error('Invalid tool name');
  if (data.title && (typeof data.title !== 'string' || data.title.length > 500)) throw new Error('Title too long');
  if (data.started_at) {
    const ts = new Date(data.started_at).getTime();
    if (isNaN(ts)) throw new Error('Invalid started_at timestamp');
  }
  for (const t of data.turns) {
    if (!t.role || (t.role !== 'user' && t.role !== 'assistant')) throw new Error('Each turn must have role "user" or "assistant"');
    if (typeof t.content !== 'string') throw new Error('Each turn must have string content');
    if (t.content.length > 10000) t.content = t.content.slice(0, 10000);
  }

  const id = `import-${data.tool || 'custom'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const turns = data.turns;
  const userTurns = turns.filter(t => t.role === 'user');
  const assistantTurns = turns.filter(t => t.role === 'assistant');
  const totalInput = userTurns.reduce((s, t) => s + (t.content?.length || 0) / 4, 0);
  const totalOutput = assistantTurns.reduce((s, t) => s + (t.content?.length || 0) / 4, 0);
  const startedAt = data.started_at ? new Date(data.started_at).getTime() : Date.now();

  // Map tool names to known tool_ids or use 'manual-import'
  const TOOL_MAP = { chatgpt: 'manual-import', 'claude-web': 'manual-import', 'gemini-web': 'manual-import', custom: 'manual-import' };
  const toolId = TOOL_MAP[data.tool] || (getAdapters().find(a => a.id === data.tool) ? data.tool : 'manual-import');

  // Ensure the tool exists in DB
  try {
    getDb().prepare(`INSERT OR IGNORE INTO tools (id, display_name) VALUES (?, ?)`).run(toolId, data.tool || 'Imported');
  } catch (_) {}

  const session = {
    id,
    tool_id: toolId,
    title: data.title || (userTurns[0]?.content || '').slice(0, 80) || 'Imported session',
    started_at: startedAt,
    ended_at: startedAt + turns.length * 60000,
    total_turns: turns.length,
    total_input_tokens: Math.round(totalInput),
    total_output_tokens: Math.round(totalOutput),
    primary_model: data.model || 'unknown',
    raw: { source: 'import', original_tool: data.tool },
  };

  upsertSession(session);
  scoreAndSave(session);

  // Insert turns
  const turnRows = turns.map((t, i) => ({
    timestamp: startedAt + i * 30000,
    model: data.model || 'unknown',
    input_tokens: t.role === 'user' ? Math.round((t.content?.length || 0) / 4) : 0,
    output_tokens: t.role === 'assistant' ? Math.round((t.content?.length || 0) / 4) : 0,
    label: (t.content || '').slice(0, 120),
    type: t.role === 'user' ? 1 : 2,
  }));
  insertTurns(id, turnRows);

  // Classify
  try {
    const cls = classifySession(session);
    getDb().prepare(`
      INSERT OR REPLACE INTO task_classifications (session_id, task_type, language, complexity, classified_at)
      VALUES (?,?,?,?,?)
    `).run(id, cls.taskType, cls.language, cls.complexity, Date.now());
  } catch (_) {}

  return { id, turns: turns.length, tool: toolId };
}

app.post('/api/sessions/import', (req, res) => {
  try {
    const data = Array.isArray(req.body) ? req.body : [req.body];
    const results = data.map(d => importSession(d));
    invalidateCache();
    broadcast('refresh');
    res.json({ ok: true, imported: results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/sessions/upload', (req, res) => {
  try {
    // Accept raw JSON body (already parsed by express.json)
    const data = Array.isArray(req.body) ? req.body : [req.body];
    const results = data.map(d => importSession(d));
    invalidateCache();
    broadcast('refresh');
    res.json({ ok: true, imported: results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Webhook receiver for CI/CD and automation
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
app.post('/api/webhook/session', (req, res) => {
  if (WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'] || '';
    if (provided !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }
  try {
    const result = importSession(req.body);
    invalidateCache();
    broadcast('refresh');
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bookmarklet source
app.get('/api/bookmarklet', async (_req, res) => {
  try {
    const { getBookmarkletCode } = await import('../public/bookmarklet.js');
    const code = getBookmarkletCode();
    res.type('html').send(`
      <!DOCTYPE html>
      <html><head><title>AI Dashboard Bookmarklet</title></head>
      <body style="font-family:system-ui;max-width:600px;margin:2em auto;padding:1em">
        <h1>Session Capture Bookmarklet</h1>
        <p>Drag this link to your bookmarks bar:</p>
        <p><a href="${code}" style="padding:8px 16px;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:bold">
          Capture AI Session
        </a></p>
        <h2>Supported platforms</h2>
        <ul>
          <li>ChatGPT (chat.openai.com / chatgpt.com)</li>
          <li>Claude.ai</li>
          <li>Google Gemini</li>
        </ul>
        <p>Click the bookmarklet while on any supported AI chat page. It will capture the conversation and send it to your local dashboard.</p>
      </body></html>
    `);
  } catch (e) {
    const safe = String(e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.type('html').send(`<p>Bookmarklet not available: ${safe}</p>`);
  }
});

// ── Savings Report ────────────────────────────────────────────────────────
app.get('/api/savings-report', async (_req, res) => {
  try {
    const { computeSavingsReport } = await import('./engine/savings-report.js');
    res.json(cached('savings-report', computeSavingsReport));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Start ----

// Initialize DB (async — loads sql.js WASM) then run initial ingestion
await initDb();
ingestAll().catch(e => console.error('[startup] Ingestion error:', e.message));

// Start file watchers
startWatchers(
  () => { const a = getAdapter('claude-code'); if (a) { console.log('[watcher] Claude data changed'); ingestAdapter(a).then(broadcast); } },
  () => { const a = getAdapter('cursor'); if (a) { console.log('[watcher] Cursor data changed'); ingestAdapter(a).then(broadcast); } },
  () => { const a = getAdapter('antigravity'); if (a) { console.log('[watcher] Antigravity data changed'); ingestAdapter(a).then(broadcast); } },
);

// Bind to localhost by default (personal tool — don't expose to LAN).
// Set BIND=0.0.0.0 to listen on all interfaces (e.g. Docker or remote access).
const BIND = process.env.BIND || '127.0.0.1';
if (BIND !== '127.0.0.1' && BIND !== 'localhost') {
  console.warn('\u26a0\ufe0f  WARNING: Server binding to ' + BIND + ' (network accessible). Set AUTH_TOKEN env var to protect access.');
}

app.listen(PORT, BIND, () => {
  console.log(`\n  AI Productivity Dashboard v3`);
  console.log(`  Open: http://localhost:${PORT}`);
  printConfig();

  // Generate daily pick on startup (runs only if not already generated today)
  setTimeout(() => generateDailyPick().catch(e => console.error('[daily-pick] startup error:', e.message)), 5000);

  // Score unscored sessions for agentic leaderboard
  setTimeout(() => scoreAllSessions(), 5000);

  // Build knowledge graph
  setTimeout(async () => {
    try {
      const { buildGraph } = await import('./lib/knowledge-graph.js');
      buildGraph();
      console.log('[knowledge-graph] Built');
    } catch (e) {
      console.warn('[knowledge-graph] Skipped:', e.message);
    }
  }, 10000);

  // Classify session topics on startup
  setTimeout(() => classifyAllSessionTopics(), 8000);

  // Re-run daily pick at midnight
  const scheduleNextMidnight = () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
    const msUntilMidnight = tomorrow - now;
    setTimeout(() => {
      generateDailyPick().catch(e => console.error('[daily-pick] midnight error:', e.message));
      scheduleNextMidnight();
    }, msUntilMidnight);
    console.log(`[daily-pick] Next run scheduled in ${Math.round(msUntilMidnight / 60000)}m`);
  };
  scheduleNextMidnight();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopWatchers();
  const { closeAll } = getAdapter('cursor') || {};
  if (closeAll) closeAll();
  process.exit(0);
});
