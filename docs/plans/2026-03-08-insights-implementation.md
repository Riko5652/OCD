# Insights Tab + Live Issues Banner — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a live issues banner to every tab, a new Insights tab (Profile / Trends / Actions), structural prompt analysis computed at ingest, and on-demand LLM deep-analyze with multi-provider support (Ollama → OpenAI-compatible → Anthropic → structural-only fallback).

**Architecture:** Two new engine files (`prompt-analyzer.js`, `llm-analyzer.js`) + a refactored `insights.js` extracted from `analytics.js`. Five new API routes in `server.js`. Frontend gains a `#issue-banner` div rendered on every tab switch, a new `Insights` nav button, and three panels inside `t-insights`. No new npm dependencies — Ollama and Anthropic use plain `fetch`; OpenAI-compat uses plain `fetch` too.

**Tech Stack:** Node.js ESM, better-sqlite3, Express, vanilla JS + Chart.js, SSE for streaming deep-analyze.

---

## Task 1: DB migrations — add `prompt_metrics` and `insight_cache` tables

**Files:**
- Modify: `src/db.js` (inside the `migrate()` function's `db.exec` block, after the `efficiency_log` table)

**Step 1: Add the two CREATE TABLE statements**

In `src/db.js`, inside the template literal passed to `db.exec(...)`, append after the `efficiency_log` block:

```sql
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
```

**Step 2: Add a `upsertPromptMetrics` export at the bottom of `src/db.js`**

```js
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
```

**Step 3: Restart server and verify tables exist**

```bash
cd C:/Projects/pm-dashboard/.claude-analytics/v2
node -e "import('./src/db.js').then(m => { const db = m.getDb(); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name).join(', ')); })"
```
Expected output includes: `prompt_metrics, insight_cache`

**Step 4: Commit**

```bash
git add src/db.js
git commit -m "feat: add prompt_metrics and insight_cache DB tables"
```

---

## Task 2: Structural prompt analyzer

**Files:**
- Create: `src/engine/prompt-analyzer.js`

**Step 1: Create the file**

```js
// src/engine/prompt-analyzer.js
// Computes structural prompt quality signals from turn data.
// Called at ingest time for each session. Stores to prompt_metrics table.
import { getDb, upsertPromptMetrics } from '../db.js';

const CONSTRAINT_WORDS = ['only', "don't", 'must', 'avoid', 'never', 'exactly', 'do not', 'without', 'except'];
const FILE_PATH_RE = /[./\\](?:ts|js|py|go|rs|css|json|md|sh|jsx|tsx|vue)\b|src\/|\.\/|\.\.\/|\/[a-zA-Z]/;

export function analyzePromptMetrics(sessionId) {
  const db = getDb();
  const turns = db.prepare(
    `SELECT input_tokens, tools_used, label FROM turns WHERE session_id=? ORDER BY rowid ASC`
  ).all(sessionId);

  if (turns.length === 0) return;

  // first_turn_tokens — how much context user gave upfront
  const firstTurn = turns[0];
  const firstTurnTokens = firstTurn.input_tokens || 0;

  // turns_to_first_edit — how many turns before first Write/Edit/Bash call
  let turnsToFirstEdit = null;
  for (let i = 0; i < turns.length; i++) {
    const tools = JSON.parse(turns[i].tools_used || '[]');
    const names = tools.map(t => Array.isArray(t) ? t[0] : t);
    if (names.some(n => ['Edit', 'Write', 'Bash'].includes(n))) {
      turnsToFirstEdit = i;
      break;
    }
  }

  // reask_rate — turns where label indicates re-asking (human turns after first)
  // proxy: count human turns that repeat within 3 turns (label=null or type=0 = human)
  // Simple heuristic: turns with very low input tokens (<50) after turn 2 = clarification
  const humanTurns = turns.filter((t, i) => i > 0 && t.input_tokens != null && t.input_tokens < 100);
  const reaskRate = turns.length > 1 ? humanTurns.length / (turns.length - 1) : 0;

  // has_file_context — does turn 0 label reference a file path?
  const firstLabel = firstTurn.label || '';
  const hasFileContext = FILE_PATH_RE.test(firstLabel) ? 1 : 0;

  // constraint_count — count scoping/constraint words in turn 0 label
  const labelLower = firstLabel.toLowerCase();
  const constraintCount = CONSTRAINT_WORDS.filter(w => labelLower.includes(w)).length;

  upsertPromptMetrics({
    session_id: sessionId,
    first_turn_tokens: firstTurnTokens,
    reask_rate: Math.round(reaskRate * 100) / 100,
    has_file_context: hasFileContext,
    constraint_count: constraintCount,
    turns_to_first_edit: turnsToFirstEdit,
  });
}
```

**Step 2: Wire into ingest pipeline in `src/server.js`**

At the top of `server.js`, add to existing imports:
```js
import { upsertPromptMetrics } from './db.js'; // already there via db imports
import { analyzePromptMetrics } from './engine/prompt-analyzer.js';
```

In `ingestAdapter()`, after `insertTurns(session.id, turns)` (around line 63), add:
```js
      analyzePromptMetrics(session.id);
```

**Step 3: Verify manually**

```bash
cd C:/Projects/pm-dashboard/.claude-analytics/v2
node -e "
import('./src/db.js').then(m => {
  const rows = m.getDb().prepare('SELECT * FROM prompt_metrics LIMIT 5').all();
  console.log(JSON.stringify(rows, null, 2));
})
"
```
Expected: array of 5 rows with `first_turn_tokens`, `reask_rate`, `has_file_context`, etc.

**Step 4: Commit**

```bash
git add src/engine/prompt-analyzer.js src/server.js
git commit -m "feat: structural prompt analyzer — first_turn_tokens, reask_rate, file_context, constraints"
```

---

## Task 3: Insights computation engine

**Files:**
- Create: `src/engine/insights.js`

**Step 1: Create the file**

```js
// src/engine/insights.js
// Profile + trends + prompt metric aggregations for the Insights tab.
import { getDb } from '../db.js';

// ── Profile ─────────────────────────────────────────────────────────────────

export function computeProfile() {
  const db = getDb();

  // Median session stats (use percentile approximation via ORDER BY + LIMIT)
  const sessions = db.prepare(`
    SELECT total_turns, (ended_at - started_at) as duration_ms, tool_id,
           started_at, top_tools, quality_score
    FROM sessions WHERE started_at IS NOT NULL AND ended_at IS NOT NULL
    ORDER BY started_at DESC LIMIT 200
  `).all();

  const sorted_turns = [...sessions].map(s => s.total_turns).sort((a, b) => a - b);
  const sorted_dur = [...sessions].map(s => s.duration_ms / 60000).filter(d => d > 0).sort((a, b) => a - b);
  const medianTurns = sorted_turns[Math.floor(sorted_turns.length / 2)] || 0;
  const medianDurationMin = Math.round(sorted_dur[Math.floor(sorted_dur.length / 2)] || 0);

  // Most-used tool
  const toolCounts = {};
  for (const s of sessions) { toolCounts[s.tool_id] = (toolCounts[s.tool_id] || 0) + 1; }
  const primaryTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '--';

  // Peak hour (hour with most sessions)
  const hourCounts = Array(24).fill(0);
  for (const s of sessions) {
    if (s.started_at) hourCounts[new Date(s.started_at).getHours()]++;
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  // Tool call breakdown (Claude Code only — has detailed top_tools)
  const toolCallTotals = {};
  for (const s of sessions.filter(s => s.tool_id === 'claude-code')) {
    const tools = JSON.parse(s.top_tools || '[]');
    for (const [name, count] of tools) {
      toolCallTotals[name] = (toolCallTotals[name] || 0) + count;
    }
  }
  const totalToolCalls = Object.values(toolCallTotals).reduce((a, b) => a + b, 0);
  const toolBreakdown = Object.entries(toolCallTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count, pct: totalToolCalls ? Math.round(count / totalToolCalls * 100) : 0 }));

  // Session start patterns (from prompt_metrics)
  const pm = db.prepare(`
    SELECT pm.has_file_context, pm.constraint_count, pm.first_turn_tokens, s.quality_score
    FROM prompt_metrics pm JOIN sessions s ON pm.session_id = s.id
    ORDER BY s.started_at DESC LIMIT 200
  `).all();

  const fileContextRate = pm.length ? Math.round(pm.filter(r => r.has_file_context).length / pm.length * 100) : 0;
  const constrainedRate = pm.length ? Math.round(pm.filter(r => r.constraint_count > 0).length / pm.length * 100) : 0;

  // Correlation: quality score for sessions with vs without file context
  const withFile = pm.filter(r => r.has_file_context && r.quality_score);
  const withoutFile = pm.filter(r => !r.has_file_context && r.quality_score);
  const avgQWithFile = withFile.length ? (withFile.reduce((a, r) => a + r.quality_score, 0) / withFile.length).toFixed(1) : null;
  const avgQWithoutFile = withoutFile.length ? (withoutFile.reduce((a, r) => a + r.quality_score, 0) / withoutFile.length).toFixed(1) : null;

  // First-turn token buckets (histogram)
  const buckets = { '<50': 0, '50-200': 0, '200-500': 0, '500-1k': 0, '>1k': 0 };
  for (const r of pm) {
    const t = r.first_turn_tokens || 0;
    if (t < 50) buckets['<50']++;
    else if (t < 200) buckets['50-200']++;
    else if (t < 500) buckets['200-500']++;
    else if (t < 1000) buckets['500-1k']++;
    else buckets['>1k']++;
  }

  return {
    medianTurns,
    medianDurationMin,
    primaryTool,
    peakHour,
    toolBreakdown,
    fileContextRate,
    constrainedRate,
    avgQWithFile,
    avgQWithoutFile,
    firstTurnBuckets: buckets,
    sessionCount: sessions.length,
  };
}

// ── Trends ───────────────────────────────────────────────────────────────────

export function computeTrends(days = 90) {
  const db = getDb();
  const since = new Date(); since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const daily = db.prepare(`
    SELECT date, AVG(avg_cache_hit_pct) as cache_hit,
           AVG(avg_quality_score) as quality,
           SUM(total_turns) as turns,
           AVG(avg_latency_ms) as latency
    FROM daily_stats WHERE date >= ?
    GROUP BY date ORDER BY date ASC
  `).all(sinceStr);

  // Rolling 7-day averages
  function rolling7(arr, key) {
    return arr.map((row, i) => {
      const window = arr.slice(Math.max(0, i - 6), i + 1);
      const valid = window.map(r => r[key]).filter(v => v != null);
      return { date: row.date, value: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null };
    });
  }

  const baseline30 = daily.slice(0, Math.max(0, daily.length - 30));
  const cacheBaseline = baseline30.length
    ? baseline30.filter(r => r.cache_hit != null).reduce((a, r) => a + r.cache_hit, 0) / baseline30.filter(r => r.cache_hit != null).length
    : null;

  // Turns-to-completion trend: use avg quality as proxy (higher quality = fewer wasted turns)
  // Use prompt_metrics reask_rate as direct signal
  const reaskTrend = db.prepare(`
    SELECT DATE(s.started_at / 1000, 'unixepoch') as date, AVG(pm.reask_rate) as reask_rate
    FROM prompt_metrics pm JOIN sessions s ON pm.session_id = s.id
    WHERE DATE(s.started_at / 1000, 'unixepoch') >= ?
    GROUP BY date ORDER BY date ASC
  `).all(sinceStr);

  // Error rate trend
  const errorTrend = db.prepare(`
    SELECT DATE(started_at / 1000, 'unixepoch') as date,
           SUM(error_count) as errors, COUNT(*) as sessions,
           CAST(SUM(error_count) AS REAL) / COUNT(*) as error_rate
    FROM sessions WHERE DATE(started_at / 1000, 'unixepoch') >= ?
    GROUP BY date ORDER BY date ASC
  `).all(sinceStr);

  return {
    cacheHit: rolling7(daily, 'cache_hit'),
    quality: rolling7(daily, 'quality'),
    cacheBaseline: cacheBaseline ? Math.round(cacheBaseline * 10) / 10 : null,
    reaskRate: rolling7(reaskTrend, 'reask_rate'),
    errorRate: rolling7(errorTrend, 'error_rate'),
  };
}

// ── Prompt Metrics Aggregation ────────────────────────────────────────────────

export function computePromptMetrics() {
  const db = getDb();

  const rows = db.prepare(`
    SELECT pm.*, s.quality_score, s.total_turns, s.cache_hit_pct
    FROM prompt_metrics pm JOIN sessions s ON pm.session_id = s.id
    WHERE s.quality_score IS NOT NULL
    ORDER BY s.started_at DESC LIMIT 300
  `).all();

  if (rows.length === 0) return { signals: [], correlations: [] };

  // Quartile quality by first_turn_tokens bucket
  function avgQ(subset) {
    return subset.length ? Math.round(subset.reduce((a, r) => a + r.quality_score, 0) / subset.length * 10) / 10 : null;
  }

  const correlations = [
    {
      signal: 'File context in first turn',
      withLabel: 'With file path', withoutLabel: 'Without file path',
      with: avgQ(rows.filter(r => r.has_file_context)),
      without: avgQ(rows.filter(r => !r.has_file_context)),
      rate: Math.round(rows.filter(r => r.has_file_context).length / rows.length * 100),
    },
    {
      signal: 'Constraints in first turn',
      withLabel: 'With constraints', withoutLabel: 'Without constraints',
      with: avgQ(rows.filter(r => r.constraint_count > 0)),
      without: avgQ(rows.filter(r => r.constraint_count === 0)),
      rate: Math.round(rows.filter(r => r.constraint_count > 0).length / rows.length * 100),
    },
    {
      signal: 'Prompt length (first turn)',
      withLabel: 'Long (>500 tok)', withoutLabel: 'Short (<200 tok)',
      with: avgQ(rows.filter(r => r.first_turn_tokens > 500)),
      without: avgQ(rows.filter(r => r.first_turn_tokens < 200)),
      rate: Math.round(rows.filter(r => r.first_turn_tokens > 500).length / rows.length * 100),
    },
    {
      signal: 'Quick re-ask rate',
      withLabel: 'Low reask (<10%)', withoutLabel: 'High reask (>30%)',
      with: avgQ(rows.filter(r => r.reask_rate < 0.1)),
      without: avgQ(rows.filter(r => r.reask_rate > 0.3)),
      rate: Math.round(rows.filter(r => r.reask_rate < 0.1).length / rows.length * 100),
    },
  ];

  const avgFirstEdit = rows.filter(r => r.turns_to_first_edit != null)
    .reduce((a, r, _, arr) => a + r.turns_to_first_edit / arr.length, 0);

  return { correlations, avgTurnsToFirstEdit: Math.round(avgFirstEdit * 10) / 10, totalSessions: rows.length };
}
```

**Step 2: Commit**

```bash
git add src/engine/insights.js
git commit -m "feat: insights engine — profile, trends, prompt metric aggregations"
```

---

## Task 4: LLM analyzer — multi-provider with graceful fallback

**Files:**
- Create: `src/engine/llm-analyzer.js`

**Step 1: Create the file**

```js
// src/engine/llm-analyzer.js
// Multi-provider LLM analysis: Ollama → OpenAI-compat → Anthropic → structural-only.
// All providers use plain fetch. No new npm dependencies.
import { getDb, getCachedInsight, setCachedInsight } from '../db.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma2:2b';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// ── Provider detection ────────────────────────────────────────────────────────

export async function detectProvider() {
  // 1. Try Ollama
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = await r.json();
      const models = (data.models || []).map(m => m.name);
      // prefer configured model, fallback to smallest available
      const preferred = [OLLAMA_MODEL, 'gemma2:2b', 'gemma2:9b', 'llama3.2:3b'];
      const model = preferred.find(m => models.includes(m)) || models[0];
      if (model) return { provider: 'ollama', model, available: true };
    }
  } catch { /* not available */ }

  // 2. Try OpenAI-compatible
  if (OPENAI_API_KEY) {
    return { provider: 'openai', model: OPENAI_MODEL, available: true };
  }

  // 3. Try Anthropic
  if (ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: ANTHROPIC_MODEL, available: true };
  }

  return { provider: null, available: false };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(sessions) {
  const summaries = sessions.slice(0, 10).map(s => {
    const firstLabel = (s.first_label || '').slice(0, 200).replace(/\n/g, ' ');
    return `- ${new Date(s.started_at).toLocaleDateString()} | ${s.tool_id} | ${s.total_turns} turns | cache ${s.cache_hit_pct ? s.cache_hit_pct.toFixed(0) + '%' : '--'} | errors ${s.error_count || 0} | ${s.code_lines_added || 0} lines | quality ${(s.quality_score || 0).toFixed(0)} | "${firstLabel}"`;
  }).join('\n');

  return `You are analyzing a developer's AI coding tool usage patterns. Here are summaries of their last ${sessions.length} sessions:

${summaries}

Provide a concise analysis (under 400 words) covering:
1. Top 3 behavioral patterns you observe (positive and negative)
2. Specific prompt improvement recommendations with a before/after example
3. Conditions when they seem to perform best
4. One concrete change to make this week

Be specific, reference the actual data, avoid generic advice.`;
}

// ── Streaming helpers ─────────────────────────────────────────────────────────

async function* streamOllama(model, prompt) {
  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.response) yield obj.response;
        if (obj.done) return;
      } catch { /* partial line */ }
    }
  }
}

async function* streamOpenAI(model, prompt) {
  const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model, stream: true,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim();
      if (!data || data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        const token = obj.choices?.[0]?.delta?.content;
        if (token) yield token;
      } catch { /* partial */ }
    }
  }
}

async function* streamAnthropic(model, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, stream: true,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim();
      if (!data) continue;
      try {
        const obj = JSON.parse(data);
        const token = obj.delta?.text;
        if (token) yield token;
      } catch { /* partial */ }
    }
  }
}

// ── Main streaming export ─────────────────────────────────────────────────────

export async function* streamDeepAnalysis(res) {
  // Check cache first
  const cacheKey = 'deep-analyze-default';
  const cached = getCachedInsight(cacheKey);
  if (cached) {
    // Replay cached result as a single chunk
    res.write(`data: ${JSON.stringify({ token: cached, cached: true })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return;
  }

  const { provider, model, available } = await detectProvider();
  if (!available) {
    res.write(`data: ${JSON.stringify({ error: 'no_provider' })}\n\n`);
    res.end();
    return;
  }

  // Load recent sessions with first turn label
  const sessions = getDb().prepare(`
    SELECT s.*, t.label as first_label
    FROM sessions s
    LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (
      SELECT MIN(rowid) FROM turns WHERE session_id = s.id
    )
    ORDER BY s.started_at DESC LIMIT 10
  `).all();

  const prompt = buildPrompt(sessions);
  let fullText = '';

  try {
    const stream = provider === 'ollama' ? streamOllama(model, prompt)
      : provider === 'openai' ? streamOpenAI(model, prompt)
      : streamAnthropic(model, prompt);

    for await (const token of stream) {
      fullText += token;
      res.write(`data: ${JSON.stringify({ token, provider, model })}\n\n`);
    }

    setCachedInsight(cacheKey, fullText);
    res.write(`data: ${JSON.stringify({ done: true, provider, model })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
}
```

**Step 2: Commit**

```bash
git add src/engine/llm-analyzer.js
git commit -m "feat: LLM analyzer — Ollama/OpenAI/Anthropic with streaming, cache, graceful fallback"
```

---

## Task 5: New API routes in server.js

**Files:**
- Modify: `src/server.js`

**Step 1: Add imports at top of server.js (after existing engine imports)**

```js
import { computeProfile, computeTrends, computePromptMetrics } from './engine/insights.js';
import { detectProvider, streamDeepAnalysis } from './engine/llm-analyzer.js';
```

**Step 2: Add 5 new routes (add after existing `app.get('/api/recommendations', ...)` route)**

```js
// ── Insights routes ──────────────────────────────────────────────────────────

app.get('/api/insights/profile', (_req, res) => {
  try { res.json(computeProfile()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/insights/trends', (req, res) => {
  const days = parseInt(req.query.days) || 90;
  try { res.json(computeTrends(days)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/insights/prompt-metrics', (_req, res) => {
  try { res.json(computePromptMetrics()); }
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
  // Pass ?refresh=1 to bust cache
  if (req.query.refresh === '1') {
    const { getDb } = await import('./db.js');
    getDb().prepare(`DELETE FROM insight_cache WHERE key='deep-analyze-default'`).run();
  }
  streamDeepAnalysis(res).catch(e => {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  });
});
```

**Note:** The `deep-analyze` route uses a top-level `await import` inside a callback — change to static import by moving the `getDb` import to the top-level imports already present.

Fix: Replace the refresh block with:
```js
  if (req.query.refresh === '1') {
    getDb().prepare(`DELETE FROM insight_cache WHERE key='deep-analyze-default'`).run();
  }
```
(And add `getDb` to the existing destructured import from `./db.js`)

**Step 3: Test all endpoints**

```bash
curl http://localhost:3031/api/insights/profile | python -m json.tool | head -30
curl http://localhost:3031/api/insights/trends | python -m json.tool | head -20
curl http://localhost:3031/api/insights/prompt-metrics | python -m json.tool
curl http://localhost:3031/api/ollama/status
```

**Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: insights API routes — profile, trends, prompt-metrics, ollama/status, deep-analyze SSE"
```

---

## Task 6: Live Issues Banner — frontend

**Files:**
- Modify: `public/index.html` (add banner div + CSS)
- Modify: `public/app.js` (add banner render logic, call on every tab switch)

**Step 1: Add CSS to `public/index.html` inside the `<style>` block, before `@media`**

```css
    /* Live issues banner */
    #issue-banner{display:none;position:sticky;top:50px;z-index:90;background:var(--lv-warn-bg);border-bottom:1px solid var(--lv-warn);padding:8px 24px;font-size:.8rem;color:var(--lv-warn);display:flex;align-items:center;gap:10px}
    #issue-banner.has-issues{display:flex}
    #issue-banner .ib-msg{flex:1}
    #issue-banner a{color:inherit;font-weight:600;cursor:pointer;text-decoration:underline}
    #issue-banner .ib-close{background:none;border:none;cursor:pointer;color:inherit;font-size:1rem;padding:0 4px;line-height:1}
    #issue-banner.warn-only{background:var(--lv-ok-bg);border-color:var(--lv-ok);color:#92400e}
```

**Step 2: Add the banner div to `public/index.html` — after `</nav>`, before the first `<section>`**

```html
  <div id="issue-banner" role="alert">
    <span class="ib-msg" id="ib-msg"></span>
    <a id="ib-link">View all →</a>
    <button class="ib-close" id="ib-close" aria-label="Dismiss">✕</button>
  </div>
```

**Step 3: Add banner JS to `public/app.js` — after the `toolChip` helper function**

```js
// ---- Issue Banner ----
let bannerDismissed = false;

function renderIssueBanner(recs) {
  const banner = $('issue-banner');
  if (!banner || bannerDismissed) return;
  const active = (recs || []).filter(r => !r.dismissed && (r.severity === 'critical' || r.severity === 'warning'));
  if (active.length === 0) { banner.className = ''; banner.style.display = 'none'; return; }
  const criticals = active.filter(r => r.severity === 'critical');
  const top2 = active.slice(0, 2).map(r => r.title).join(' · ');
  $('ib-msg').textContent = `⚠ ${active.length} active issue${active.length > 1 ? 's' : ''} — ${top2}`;
  banner.className = criticals.length ? 'has-issues' : 'has-issues warn-only';
  banner.style.display = 'flex';
}

// Wire up dismiss + link after DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const close = $('ib-close');
  if (close) close.onclick = () => { bannerDismissed = true; $('issue-banner').style.display = 'none'; };
  const link = $('ib-link');
  if (link) link.onclick = () => onTab('insights');
});
```

**Step 4: Call `renderIssueBanner` in the `onTab` function in `app.js`**

Find the `onTab` function (it dispatches to tab renderers). After fetching `S.recs` or at the start of the function body, add:

```js
  if (!S.recs) S.recs = await fJ('/api/recommendations?all=true');
  renderIssueBanner(S.recs);
```

**Step 5: Verify**

Start the server. With an existing recommendation of severity `critical` or `warning`, the orange/red bar should appear below the nav on every tab. Clicking ✕ hides it for the session.

**Step 6: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: live issues banner — sticky alert on all tabs for critical/warning recommendations"
```

---

## Task 7: Insights tab HTML skeleton

**Files:**
- Modify: `public/index.html`

**Step 1: Add the nav button — in `<nav id="nav">`, after the Optimization button**

```html
    <button class="tb" data-t="insights">Insights</button>
```

**Step 2: Add the tab section — after the `t-optimize` section, before `</body>`**

```html
  <!-- INSIGHTS -->
  <section id="t-insights" class="tp">
    <!-- Panel A: Profile -->
    <div class="card" id="ins-profile-card">
      <h2>How You Work</h2>
      <div class="kpi" id="ins-profile-kpi"></div>
      <div class="g2">
        <div class="card" style="margin:0">
          <h2>Tool Call Breakdown (Claude Code)</h2>
          <div id="ins-tool-breakdown"></div>
        </div>
        <div class="card" style="margin:0">
          <h2>First-Turn Length Distribution</h2>
          <canvas id="ins-first-turn-chart" height="160"></canvas>
        </div>
      </div>
      <div id="ins-start-patterns" style="margin-top:12px"></div>
    </div>

    <!-- Panel B: Trends -->
    <div class="card" id="ins-trends-card">
      <h2>Getting Better or Worse?</h2>
      <div class="g2">
        <div>
          <h2 style="font-size:.82rem;margin-bottom:8px">Cache Hit Rate (7-day rolling)</h2>
          <canvas id="ins-cache-trend" height="140"></canvas>
        </div>
        <div>
          <h2 style="font-size:.82rem;margin-bottom:8px">Session Quality Score (7-day rolling)</h2>
          <canvas id="ins-quality-trend" height="140"></canvas>
        </div>
      </div>
      <div class="g2" style="margin-top:14px">
        <div>
          <h2 style="font-size:.82rem;margin-bottom:8px">Re-ask Rate Trend (lower = better)</h2>
          <canvas id="ins-reask-trend" height="140"></canvas>
        </div>
        <div>
          <h2 style="font-size:.82rem;margin-bottom:8px">Error Rate Trend</h2>
          <canvas id="ins-error-trend" height="140"></canvas>
        </div>
      </div>
    </div>

    <!-- Panel C: Actions + Deep Analyze -->
    <div class="card" id="ins-actions-card">
      <h2>Actions &amp; Prompt Analysis</h2>
      <div id="ins-prompt-correlations" style="margin-bottom:16px"></div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <button id="ins-deep-btn" style="background:var(--primary);color:#fff;border:none;padding:8px 20px;border-radius:var(--radius-pill);cursor:pointer;font-size:.84rem;font-weight:600">
          🔍 Deep Analyze
        </button>
        <span id="ins-llm-status" style="font-size:.76rem;color:var(--text-s)"></span>
      </div>
      <div id="ins-deep-output" style="display:none;background:#f8f9fa;border-radius:var(--radius-sm);padding:14px;font-size:.82rem;line-height:1.7;white-space:pre-wrap;max-height:400px;overflow-y:auto;border:1px solid #e5e7eb"></div>
      <h2 style="margin-top:20px;margin-bottom:12px">Recommendations</h2>
      <div id="ins-recs-enhanced" class="rg"></div>
    </div>
  </section>
```

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: insights tab HTML skeleton — profile, trends, actions panels"
```

---

## Task 8: Insights tab JS — Profile panel

**Files:**
- Modify: `public/app.js`

**Step 1: Add `rIns()` renderer function — add after `rOpt()` function**

```js
// ---- Insights Tab ----

async function rIns() {
  if (!S.insProfile) S.insProfile = await fJ('/api/insights/profile');
  if (!S.insTrends) S.insTrends = await fJ('/api/insights/trends');
  if (!S.insPrompt) S.insPrompt = await fJ('/api/insights/prompt-metrics');
  if (!S.insLlmStatus) S.insLlmStatus = await fJ('/api/ollama/status');

  rInsProfile(S.insProfile);
  rInsTrends(S.insTrends);
  rInsActions(S.insPrompt, S.insLlmStatus);
}

function rInsProfile(p) {
  if (!p) { $('ins-profile-kpi').innerHTML = '<p style="color:var(--text-s)">No data yet — run a few sessions first.</p>'; return; }

  const hour12 = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

  $('ins-profile-kpi').innerHTML = [
    kpi(p.medianTurns, 'Median Turns', '--primary'),
    kpi(p.medianDurationMin + 'm', 'Median Duration', '--c-output'),
    kpi(p.primaryTool, 'Primary Tool', '--t-claude'),
    kpi(hour12(p.peakHour), 'Peak Hour', '--lv-good'),
    kpi(p.sessionCount, 'Sessions Analyzed', '--text-s'),
  ].join('');

  // Tool call breakdown bars
  const breakdown = p.toolBreakdown || [];
  const max = breakdown[0]?.count || 1;
  $('ins-tool-breakdown').innerHTML = breakdown.map(t => `
    <div class="br">
      <div class="bl">${t.name}</div>
      <div class="bt"><div class="bf" style="width:${t.count / max * 100}%;background:var(--primary)"></div></div>
      <div class="bv">${fmt(t.count)} <span style="color:var(--text-s);font-size:.72rem">(${t.pct}%)</span></div>
    </div>`).join('') || '<p style="color:var(--text-s);font-size:.8rem">No Claude Code sessions yet.</p>';

  // First-turn histogram
  const b = p.firstTurnBuckets || {};
  const labels = Object.keys(b);
  const vals = Object.values(b);
  mc('ins-first-turn-chart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Sessions', data: vals, backgroundColor: 'rgba(241,90,43,0.7)', borderRadius: 4 }]
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });

  // Start patterns
  $('ins-start-patterns').innerHTML = `
    <div class="g3">
      <div class="rc tip">
        <div class="rc-cat">Prompt Habit</div>
        <div class="rc-t">${p.fileContextRate}% include file context</div>
        <div class="rc-d">Sessions starting with a file path reference tend to have ${p.avgQWithFile > p.avgQWithoutFile ? 'higher' : 'similar'} quality scores (avg ${p.avgQWithFile || '--'} vs ${p.avgQWithoutFile || '--'} without).</div>
      </div>
      <div class="rc tip">
        <div class="rc-cat">Prompt Habit</div>
        <div class="rc-t">${p.constrainedRate}% use constraints</div>
        <div class="rc-d">Adding scoping words (only, don't, must, avoid) in your first turn correlated with more focused sessions.</div>
      </div>
      <div class="rc tip">
        <div class="rc-cat">Workflow</div>
        <div class="rc-t">Peak productivity: ${hour12(p.peakHour)}</div>
        <div class="rc-d">Most sessions start around this hour. Consider scheduling your most complex AI tasks here.</div>
      </div>
    </div>`;
}
```

**Step 2: Wire `rIns` into `onTab` dispatcher — find the switch/if block in `onTab` and add:**

```js
  if (t === 'insights') rIns();
```

**Step 3: Add cache invalidation for insights in `refreshAll()`**

```js
  S.insProfile = null; S.insTrends = null; S.insPrompt = null; S.insLlmStatus = null;
```

**Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: insights tab — profile panel (KPIs, tool breakdown, first-turn histogram, start patterns)"
```

---

## Task 9: Insights tab JS — Trends panel

**Files:**
- Modify: `public/app.js`

**Step 1: Add `rInsTrends()` function after `rInsProfile()`**

```js
function rInsTrends(t) {
  if (!t) return;

  const trendChartOpts = (color, baselineVal, baselineLabel) => ({
    type: 'line',
    options: {
      plugins: {
        legend: { display: !!baselineVal },
        annotation: baselineVal ? {
          annotations: [{
            type: 'line', yMin: baselineVal, yMax: baselineVal,
            borderColor: 'rgba(100,116,139,0.4)', borderWidth: 1, borderDash: [4, 4],
            label: { content: baselineLabel, display: true, position: 'end', font: { size: 10 } }
          }]
        } : {}
      },
      scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } }, y: { beginAtZero: false } },
      elements: { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 2 } }
    }
  });

  function trendDataset(arr, color) {
    return {
      labels: arr.map(r => r.date),
      datasets: [{ data: arr.map(r => r.value != null ? Math.round(r.value * 10) / 10 : null), borderColor: color, backgroundColor: color + '18', fill: true, spanGaps: true }]
    };
  }

  const cacheOpts = trendChartOpts('#10b981', t.cacheBaseline, `30d avg: ${t.cacheBaseline?.toFixed(1)}%`);
  mc('ins-cache-trend', { ...cacheOpts, data: trendDataset(t.cacheHit, '#10b981') });
  mc('ins-quality-trend', { ...trendChartOpts('#F15A2B'), data: trendDataset(t.quality, '#F15A2B') });
  mc('ins-reask-trend', { ...trendChartOpts('#8b5cf6'), data: trendDataset(t.reaskRate, '#8b5cf6') });
  mc('ins-error-trend', { ...trendChartOpts('#ef4444'), data: trendDataset(t.errorRate, '#ef4444') });
}
```

**Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: insights tab — trends panel (cache, quality, reask rate, error rate rolling charts)"
```

---

## Task 10: Insights tab JS — Actions panel + enhanced recommendations

**Files:**
- Modify: `public/app.js`

**Step 1: Add `rInsActions()` function**

```js
function rInsActions(prompt, llmStatus) {
  // Prompt correlations
  const corrs = prompt?.correlations || [];
  if (corrs.length > 0) {
    $('ins-prompt-correlations').innerHTML = `
      <h2 style="font-size:.88rem;margin-bottom:10px">Prompt Signals vs Session Quality</h2>
      <div class="rg">
        ${corrs.map(c => {
          const diff = c.with && c.without ? (c.with - c.without).toFixed(1) : null;
          const sign = diff > 0 ? '+' : '';
          const color = diff > 0 ? '--lv-good' : diff < 0 ? '--lv-warn' : '--lv-tip';
          return `<div class="rc tip">
            <div class="rc-cat">Prompt Signal</div>
            <div class="rc-t">${c.signal}</div>
            <div class="rc-d">
              ${c.withLabel}: avg quality <strong>${c.with || '--'}</strong><br>
              ${c.withoutLabel}: avg quality <strong>${c.without || '--'}</strong><br>
              ${diff != null ? `<span style="color:var(${color})">${sign}${diff} quality pts difference</span>` : ''}
              <br><span style="color:var(--text-s)">${c.rate}% of your sessions use this</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      ${prompt.avgTurnsToFirstEdit != null ? `<p style="font-size:.8rem;color:var(--text-s);margin-top:4px">Avg turns before first code edit: <strong>${prompt.avgTurnsToFirstEdit}</strong></p>` : ''}
    `;
  }

  // LLM status + deep analyze button
  const btn = $('ins-deep-btn');
  const statusEl = $('ins-llm-status');
  if (llmStatus?.available) {
    statusEl.textContent = `${llmStatus.provider} · ${llmStatus.model} · results cached 24h`;
    btn.disabled = false;
    btn.title = '';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    statusEl.innerHTML = `No LLM available — set <code>OLLAMA_HOST</code>, <code>OPENAI_API_KEY</code>, or <code>ANTHROPIC_API_KEY</code> to enable`;
  }

  // Enhanced recommendations with trend badge
  const recs = (S.recs || []).filter(r => !r.dismissed);
  const grouped = {};
  for (const r of recs) {
    if (!grouped[r.title]) grouped[r.title] = [];
    grouped[r.title].push(r);
  }
  const FIX_GUIDES = {
    'Poor prompt caching': 'Keep CLAUDE.md stable between sessions. Avoid volatile content at the top of system prompts. Use targeted file reads rather than broad greps.',
    'Bash overuse for file reads': 'Replace `Bash cat file.ts` with the Read tool. Replace `Bash grep pattern` with the Grep tool. These have better prompt caching.',
    'No subagent usage in long session': 'For tasks touching 3+ files, open your prompt with "Use parallel subagents for each file". This reduces total turns and improves quality.',
    'Long session detected': 'After 100 turns, start a fresh session with a summary of what was accomplished. Prefix: "Continuing from: [summary]".',
  };
  $('ins-recs-enhanced').innerHTML = Object.entries(grouped)
    .sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      return (sev[a[1][0].severity] || 2) - (sev[b[1][0].severity] || 2);
    })
    .map(([title, items]) => {
      const r = items[0];
      const guide = FIX_GUIDES[title] || '';
      const guideId = `guide-${title.replace(/\s+/g, '-')}`;
      return `<div class="rc ${r.severity}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div class="rc-cat">${r.category} · ${items.length > 1 ? items.length + ' sessions' : '1 session'}</div>
            <div class="rc-t">${title}</div>
          </div>
          <span style="font-size:.7rem;padding:2px 7px;border-radius:var(--radius-pill);background:rgba(0,0,0,.06);color:var(--text-s);white-space:nowrap">${r.severity}</span>
        </div>
        <div class="rc-d">${r.description}</div>
        ${guide ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:.76rem;font-weight:600;color:var(--text-s)">How to fix ▸</summary>
            <div style="margin-top:6px;font-size:.78rem;line-height:1.6;color:var(--text-m)">${guide}</div>
          </details>` : ''}
      </div>`;
    }).join('') || '<p style="color:var(--text-s);font-size:.8rem">No active recommendations — looking good!</p>';
}
```

**Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: insights tab — actions panel with prompt correlations and enhanced rec cards"
```

---

## Task 11: Deep Analyze streaming UI

**Files:**
- Modify: `public/app.js`

**Step 1: Add click handler for the Deep Analyze button — call this inside `rInsActions()` at the end**

```js
  // Deep Analyze click handler (re-bind on each render)
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', async () => {
      const out = $('ins-deep-output');
      out.style.display = 'block';
      out.textContent = '';
      btn.disabled = true;
      statusEl.textContent = 'Analyzing…';

      const es = new EventSource('/api/insights/deep-analyze');
      let fullText = '';

      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.error) {
          if (data.error === 'no_provider') {
            out.textContent = 'No LLM provider available. Set OLLAMA_HOST, OPENAI_API_KEY, or ANTHROPIC_API_KEY.';
          } else {
            out.textContent = `Error: ${data.error}`;
          }
          es.close();
          btn.disabled = false;
          statusEl.textContent = '';
          return;
        }
        if (data.token) {
          fullText += data.token;
          out.textContent = fullText;
          out.scrollTop = out.scrollHeight;
        }
        if (data.done) {
          es.close();
          btn.disabled = false;
          const src = data.cached ? 'cached result' : `${data.provider} · ${data.model}`;
          statusEl.textContent = `Analysis complete (${src}) · cached 24h · ?refresh=1 to regenerate`;
          // invalidate client-side cache so next render re-fetches status
          S.insLlmStatus = null;
        }
      };

      es.onerror = () => {
        es.close();
        if (!fullText) out.textContent = 'Connection error — is the server running?';
        btn.disabled = false;
      };
    });
  }
```

**Step 2: Verify end-to-end with Ollama**

```bash
# With Ollama running:
curl -N http://localhost:3031/api/insights/deep-analyze
# Should stream JSON chunks: {"token":"..."} ... {"done":true,"provider":"ollama","model":"gemma2:2b"}

# Without Ollama (no env vars set):
curl -N http://localhost:3031/api/insights/deep-analyze
# Should return: {"error":"no_provider"}
```

**Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: deep analyze button — SSE streaming UI with error handling and 24h cache display"
```

---

## Task 12: Update README with setup instructions for LLM providers

**Files:**
- Modify: `README.md`

**Step 1: Add LLM configuration section to the Configuration block**

Under the existing `## Configuration` section, add after the existing env vars block:

```markdown
### Enabling AI Deep Analysis (optional)

The **Insights** tab includes on-demand LLM analysis of your usage patterns. Configure one provider:

| Provider | Env vars needed | Cost | Speed |
|----------|----------------|------|-------|
| **Ollama (local)** | `OLLAMA_HOST=http://localhost:11434` | Free | Fast if running |
| **OpenAI / OpenAI-compat** | `OPENAI_API_KEY=sk-...` | ~$0.001/analyze | Fast |
| **Anthropic** | `ANTHROPIC_API_KEY=sk-ant-...` | ~$0.001/analyze | Fast |
| **None** | — | Free | Structural analysis only |

Results are cached for 24 hours. Without any provider, all other Insights features (profile, trends, prompt signals) still work fully.

```bash
# Local Ollama (recommended for privacy)
OLLAMA_HOST=http://localhost:11434 npm start

# OpenAI
OPENAI_API_KEY=sk-... npm start

# Anthropic
ANTHROPIC_API_KEY=sk-ant-... npm start

# Override model
OLLAMA_MODEL=llama3.2:3b npm start
OPENAI_MODEL=gpt-4o-mini npm start
```
```

**Step 2: Commit + push**

```bash
git add README.md
git commit -m "docs: LLM provider setup instructions for Insights deep analyze"
git push origin main
```

---

## Verification Checklist

Run through these manually after all tasks complete:

- [ ] `prompt_metrics` and `insight_cache` tables exist in DB
- [ ] After server restart, prompt_metrics rows appear for claude-code sessions
- [ ] `GET /api/insights/profile` returns valid JSON with `medianTurns`, `toolBreakdown`, etc.
- [ ] `GET /api/insights/trends` returns `cacheHit`, `quality` arrays
- [ ] `GET /api/insights/prompt-metrics` returns `correlations` array
- [ ] `GET /api/ollama/status` returns `{available, provider, model}` (or `{available:false}`)
- [ ] Live issues banner appears on Overview when critical/warning recs exist
- [ ] Live issues banner hidden when no issues
- [ ] Insights tab loads all three panels without console errors
- [ ] Profile KPIs populated with real data
- [ ] Tool call breakdown bars render for Claude Code sessions
- [ ] Trend charts render (even if flat/empty for new installs)
- [ ] Prompt correlation cards show quality delta
- [ ] Enhanced recommendation cards show "How to fix" details section
- [ ] Deep Analyze button disabled + tooltip shown when no LLM configured
- [ ] Deep Analyze streams tokens when Ollama is running
- [ ] Second Deep Analyze click serves cached result instantly
- [ ] `?refresh=1` query busts the cache
- [ ] All existing tabs still work (no regressions)
