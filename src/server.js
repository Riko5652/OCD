// AI Productivity Dashboard V2 — Express server
// Usage: cd .claude-analytics/v2 && npm start → http://localhost:3030
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getDb, upsertSession, insertTurns, upsertCommitScore,
  getAllSessions, getSessionById, getTurnsForSession,
  getDailyStatsRange, getCommitScores as dbGetCommitScores,
  getRecommendations, getOverview,
  getCachedInsight, setCachedInsight,
  upsertModelPerformance, getModelPerformance,
} from './db.js';
import './adapters/claude-code.js';    // self-registers via registry
import './adapters/cursor.js';         // self-registers via registry
import './adapters/antigravity.js';    // self-registers via registry
import './adapters/aider.js';          // self-registers via registry
import './adapters/windsurf.js';       // self-registers via registry
import { getAdapters, getAdapter } from './adapters/registry.js';
import { computeOverview, computeToolComparison, computeModelUsage, computeCodeGeneration, computeInsights, computeCostAnalysis, computePersonalInsights, rebuildDailyStats } from './engine/analytics.js';
import { runOptimizer } from './engine/optimizer.js';
import { scoreAndSave } from './engine/scorer.js';
import { computeProfile, computeTrends, computePromptMetrics } from './engine/insights.js';
import { computeAllProjects, computeProjectInsights } from './engine/project-insights.js';
import { detectProvider, streamDeepAnalysis, buildDailyPickPrompt, callAzure } from './engine/llm-analyzer.js';
import { startWatchers, stopWatchers } from './watcher.js';
import { analyzePromptMetrics } from './engine/prompt-analyzer.js';
import { classifySession, computeToolModelWinRates, getRoutingRecommendation } from './engine/cross-tool-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config, printConfig } from './config.js';

const app = express();
const PORT = config.port;
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

    // Ingest turns for recent sessions (last 50)
    const recent = sessions
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
      .slice(0, 50);

    for (const session of recent) {
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
      cached('ins:trends:90', () => computeTrends(90));
      cached('ins:prompt-metrics', computePromptMetrics);
      cached('recs:false', () => getRecommendations(false));
      cached('daily:180', () => getDailyStatsRange(180));
      cached('commits:100', () => dbGetCommitScores(100));
      console.log('[cache] Pre-warmed');
    } catch (e) {
      console.warn('[cache] Pre-warm error:', e.message);
    }
  });
  broadcast('refresh');
}

// ---- Static files ----
app.use(express.static(join(__dirname, '..', 'public')));

// ---- API Routes ----

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

// Daily stats (30-day default)
app.get('/api/daily', (req, res) => {
  const days = parseInt(req.query.days) || 180;
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
  const days = parseInt(req.query.days) || 90;
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

app.get('/api/insights/deep-analyze', (req, res) => {
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
app.post('/api/ingest', async (req, res) => {
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
app.get('/api/cursor-daily', async (req, res) => {
  try {
    const stats = await getAdapter('cursor')?.getDailyStats?.();
    res.json(stats);
  } catch (e) {
    res.json([]);
  }
});

// Antigravity stats
app.get('/api/antigravity-stats', async (req, res) => {
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
app.get('/api/insights/daily-pick', (req, res) => {
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
app.post('/api/insights/daily-pick/refresh', async (req, res) => {
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
      days:  parseInt(req.query.days || '90'),
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
app.get('/api/projects', (req, res) => {
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

// ---- Start ----

// Initialize DB
getDb();

// Run initial ingestion
ingestAll().catch(e => console.error('[startup] Ingestion error:', e.message));

// Start file watchers
startWatchers(
  () => { console.log('[watcher] Claude data changed'); ingestAdapter(getAdapter('claude-code')).then(broadcast); },
  () => { console.log('[watcher] Cursor data changed'); ingestAdapter(getAdapter('cursor')).then(broadcast); },
  () => { console.log('[watcher] Antigravity data changed'); ingestAdapter(getAdapter('antigravity')).then(broadcast); },
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  AI Productivity Dashboard`);
  console.log(`  Local:     http://localhost:${PORT}`);
  console.log(`  Network:   http://0.0.0.0:${PORT}`);
  printConfig();

  // Generate daily pick on startup (runs only if not already generated today)
  setTimeout(() => generateDailyPick().catch(e => console.error('[daily-pick] startup error:', e.message)), 5000);

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
