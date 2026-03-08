# Design: Insights Tab + Live Issues Banner

**Date:** 2026-03-08
**Status:** Approved
**Scope:** New Insights tab, live issues banner on all tabs, structural prompt analysis, on-demand Ollama deep analysis

---

## Problem

The current Optimization tab shows 7 static recommendation cards with no trend data, no evidence charts, no prompt analysis, and no narrative explanation of how the user works. There is no persistent alerting for critical issues — users only see them if they navigate to Optimization.

---

## Solution Overview

Three deliverables:

1. **Live Issues Banner** — sticky bar below nav on every tab, shows critical/warning issues
2. **Insights Tab** — new tab with Profile, Trends, and Actions panels
3. **Prompt Analysis** — structural (always-on) + LLM deep-analyze (on-demand, Ollama-backed)

---

## Architecture

### New Engine Files

| File | Purpose |
|------|---------|
| `src/engine/prompt-analyzer.js` | Computes structural prompt metrics from turns at ingest time |
| `src/engine/llm-analyzer.js` | Ollama health-check, batched prompt builder, streaming, cache read/write |
| `src/engine/insights.js` | Profile + trends computations (split from analytics.js) |

### New DB Tables

```sql
CREATE TABLE IF NOT EXISTS insight_cache (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_metrics (
  session_id TEXT PRIMARY KEY,
  first_turn_tokens INTEGER,
  reask_rate REAL,
  has_file_context INTEGER,
  constraint_count INTEGER,
  turns_to_first_edit INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### New API Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/insights/profile` | Behavioral profile: median session, tool call breakdown, start patterns |
| `GET /api/insights/trends` | Rolling averages: cache hit, quality score, turns-to-completion, error rate |
| `GET /api/insights/prompt-metrics` | Structural signal aggregates + outcome correlations |
| `GET /api/ollama/status` | `{available, model, latency_ms}` |
| `GET /api/insights/deep-analyze` | SSE stream — tokens from Ollama or cached result |

---

## Live Issues Banner

### Behavior
- Injected below nav, above tab content on **every tab**
- Renders from existing `/api/recommendations` data — no new endpoint
- Shows only when `critical` or `warning` issues exist
- Format: `⚠ 2 active issues — Poor caching (58%) · Bash overuse detected [View all →]`
- Dismissible per-session via ✕ (localStorage flag, resets on next page load)
- Auto-hides when zero issues

### Implementation
- Single `renderIssueBanner(recs)` function called after every tab switch
- Piggybacks on recommendations fetch already in flight — zero extra requests

---

## Insights Tab — Three Panels

### Panel A: Profile — "How you work"

Data from `GET /api/insights/profile`:

- **Typical session card**: median turns, median duration, most-used tool, peak hour
- **Tool call breakdown** (Claude Code): % of turns using Bash vs Read vs Edit vs Grep — bar chart
- **Session start patterns**: % starting with file path / question / task command — correlated against quality score
- **First-turn length distribution**: histogram of token counts in turn 0

### Panel B: Trends — "Getting better or worse?"

Data from `GET /api/insights/trends`:

- **Cache hit trend**: 7-day rolling avg vs 30-day baseline — line chart, color-coded (green above baseline, red below)
- **Quality score trajectory**: 7-day rolling avg — line chart
- **Turns-to-completion trend**: lower = more precise prompting
- **Error rate trend**: 7-day rolling

All charts use 90-day lookback, consistent x-axis.

### Panel C: Actions — Deep Recommendations

Replaces Optimization tab as the canonical home for recommendations. Each card gets:

- Mini sparkline showing the trend (7-day rolling metric value)
- "Why this matters" one-liner explanation
- Expandable "How to fix" guide with concrete steps
- Badge: `↑ improving` / `↓ worsening` / `→ stable` based on 7-day trend direction

---

## Prompt Analysis

### Structural Signals (always-on, computed at ingest)

Stored in `prompt_metrics` table, one row per session:

| Signal | Computation |
|--------|-------------|
| `first_turn_tokens` | Input tokens on turn index 0 |
| `reask_rate` | % of turns where intent overlaps with a prior turn (simple keyword overlap check) |
| `has_file_context` | 1 if turn 0 text contains a file path pattern (`/`, `.ts`, `.js`, etc.) |
| `constraint_count` | Count of constraint words in turn 0 (only, don't, must, avoid, never, exactly) |
| `turns_to_first_edit` | Turn index of first Edit/Write tool call |

Aggregated in `GET /api/insights/prompt-metrics`:
- Avg per signal vs quality_score quartiles (shows which habits correlate with good sessions)
- Trend: each signal as 30-day rolling average

### LLM Deep Analyze (on-demand)

**Trigger:** "Deep Analyze" button in Panel C

**Ollama health check:**
- `GET http://{OLLAMA_HOST}/api/tags` with 2s timeout
- If unavailable: button greyed out, tooltip "Start Ollama to enable — run `ollama serve`"
- `OLLAMA_HOST` env var, default `localhost:11434`

**Model selection:**
- Prefers `gemma2:2b` (fastest, 1.6GB)
- Falls back to first available model from `/api/tags`
- Configurable via `OLLAMA_MODEL` env var

**Prompt (single batched call — last 10 sessions):**
```
You are analyzing a developer's AI coding tool usage patterns.
Here are summaries of their last 10 sessions:
[date, tool, turns, cache_hit_pct, error_count, code_lines, quality_score, first_turn_excerpt (200 chars)]

Provide a concise analysis covering:
1. Top 3 behavioral patterns (positive and negative)
2. Specific prompt improvement recommendations with before/after examples
3. Conditions when they perform best
4. One concrete change to make this week

Be specific, reference the actual data, and keep total response under 400 words.
```

**Streaming:**
- `GET /api/insights/deep-analyze` returns SSE stream
- Frontend appends tokens to a `<pre>` block as they arrive
- Hard 45s timeout — partial result shown if stream cuts
- Result stored in `insight_cache` with key `deep-analyze-{userId or 'default'}`, TTL 24h
- Second click within TTL: instant cache hit, no Ollama call

---

## What Is NOT Changed

- Optimization tab stays (becomes a redirect/alias to Insights Panel C)
- Personal tab unchanged
- All existing endpoints unchanged
- No new npm dependencies (Ollama uses plain `fetch`, SSE already implemented)

---

## Success Criteria

- [ ] Live banner appears on Overview when a critical recommendation exists
- [ ] Insights tab loads Profile + Trends with no Ollama dependency
- [ ] Structural prompt metrics computed for all sessions on ingest
- [ ] "Deep Analyze" button works end-to-end when Ollama is running
- [ ] "Deep Analyze" button degrades gracefully when Ollama is down
- [ ] LLM result cached — second click is instant
- [ ] All existing tests pass
- [ ] No new ESLint errors
