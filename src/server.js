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
} from './db.js';
import { adapter as claudeAdapter } from './adapters/claude-code.js';
import { adapter as cursorAdapter } from './adapters/cursor.js';
import { adapter as antigravityAdapter } from './adapters/antigravity.js';
import { computeOverview, computeToolComparison, computeModelUsage, computeCodeGeneration, computeInsights, computeCostAnalysis, computePersonalInsights, rebuildDailyStats } from './engine/analytics.js';
import { runOptimizer } from './engine/optimizer.js';
import { scoreAndSave } from './engine/scorer.js';
import { startWatchers, stopWatchers } from './watcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { config, printConfig } from './config.js';

const app = express();
const PORT = config.port;
const adapters = [claudeAdapter, cursorAdapter, antigravityAdapter];

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
    }

    // Ingest turns for recent sessions (last 50)
    const recent = sessions
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
      .slice(0, 50);

    for (const session of recent) {
      const turns = await adapter.getTurns(session.id);
      if (turns.length > 0) {
        insertTurns(session.id, turns);
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

async function ingestAll() {
  console.log('[ingest] Starting full ingestion...');
  const start = Date.now();
  for (const adapter of adapters) {
    await ingestAdapter(adapter);
  }
  rebuildDailyStats();
  runOptimizer();
  console.log(`[ingest] Complete in ${Date.now() - start}ms`);
  broadcast('refresh');
}

// ---- Static files ----
app.use(express.static(join(__dirname, '..', 'public')));

// ---- API Routes ----

// Overview KPIs
app.get('/api/overview', (req, res) => {
  res.json(computeOverview());
});

// Tool comparison
app.get('/api/compare', (req, res) => {
  res.json(computeToolComparison());
});

// Model usage analytics
app.get('/api/models', (req, res) => {
  res.json(computeModelUsage());
});

// All sessions (with optional tool filter)
app.get('/api/sessions', (req, res) => {
  const toolId = req.query.tool || null;
  const limit = parseInt(req.query.limit) || 100;
  const sessions = getAllSessions(toolId, limit);
  res.json({ sessions });
});

// Single session with turns
app.get('/api/sessions/:id', (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const turns = getTurnsForSession(req.params.id);
  res.json({ ...session, turns });
});

// Daily stats (30-day default)
app.get('/api/daily', (req, res) => {
  const days = parseInt(req.query.days) || 180;
  res.json(getDailyStatsRange(days));
});

// Commit scores (Cursor AI vs human)
app.get('/api/commits', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(dbGetCommitScores(limit));
});

// Code generation analytics
app.get('/api/code-generation', (req, res) => {
  res.json(computeCodeGeneration());
});

// Cross-tool insights (thinking depth, errors, recovery, suggestions)
app.get('/api/insights', (req, res) => {
  res.json(computeInsights());
});

// Cost estimation by tool and model
app.get('/api/costs', (req, res) => {
  res.json(computeCostAnalysis());
});

// Personal insights (gamification + coaching)
let personalInsightsCache = null;
let personalInsightsCacheAt = 0;
app.get('/api/personal-insights', (req, res) => {
  const now = Date.now();
  if (!personalInsightsCache || now - personalInsightsCacheAt > 30000) {
    personalInsightsCache = computePersonalInsights();
    personalInsightsCacheAt = now;
  }
  res.json(personalInsightsCache);
});

// Optimization recommendations
app.get('/api/recommendations', (req, res) => {
  const all = req.query.all === 'true';
  res.json(getRecommendations(all));
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
    const stats = await cursorAdapter.getDailyStats();
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

// ---- Start ----

// Initialize DB
getDb();

// Run initial ingestion
ingestAll().catch(e => console.error('[startup] Ingestion error:', e.message));

// Start file watchers
startWatchers(
  () => { console.log('[watcher] Claude data changed'); ingestAdapter(claudeAdapter).then(broadcast); },
  () => { console.log('[watcher] Cursor data changed'); ingestAdapter(cursorAdapter).then(broadcast); },
  () => { console.log('[watcher] Antigravity data changed'); ingestAdapter(antigravityAdapter).then(broadcast); },
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  AI Productivity Dashboard`);
  console.log(`  Local:     http://localhost:${PORT}`);
  console.log(`  Network:   http://0.0.0.0:${PORT}`);
  printConfig();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopWatchers();
  const { closeAll } = cursorAdapter;
  if (closeAll) closeAll();
  process.exit(0);
});
