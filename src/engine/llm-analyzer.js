// src/engine/llm-analyzer.js
// Multi-provider LLM analysis: Ollama → Azure OpenAI → OpenAI-compat → Anthropic → structural-only.
// Uses plain fetch only — no new npm dependencies.
import { getDb, getCachedInsight, setCachedInsight } from '../db.js';
import { sanitizeForPrompt } from '../lib/sanitize.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma2:2b';

// Azure OpenAI (preferred cloud provider)
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_CHAT || 'gpt-5.2-chat';

// Vanilla OpenAI fallback
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Anthropic fallback
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export async function detectProvider() {
  // 1. Try Ollama (local, no cost)
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = await r.json();
      const models = (data.models || []).map(m => m.name);
      const preferred = [OLLAMA_MODEL, 'gemma2:2b', 'gemma2:9b', 'llama3.2:3b'];
      const model = preferred.find(m => models.includes(m)) || models[0];
      if (model) return { provider: 'ollama', model, available: true };
    }
  } catch { /* not available */ }

  // 2. Azure OpenAI (preferred cloud)
  if (AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT) {
    return { provider: 'azure', model: AZURE_OPENAI_DEPLOYMENT, available: true };
  }

  // 3. Vanilla OpenAI
  if (OPENAI_API_KEY) {
    return { provider: 'openai', model: OPENAI_MODEL, available: true };
  }

  // 4. Anthropic
  if (ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: ANTHROPIC_MODEL, available: true };
  }

  return { provider: null, available: false };
}

function buildPrompt(sessions) {
  const summaries = sessions.slice(0, 10).map(s => {
    const firstLabel = sanitizeForPrompt(s.first_label, 200).replace(/\n/g, ' ');
    return `- ${new Date(s.started_at).toLocaleDateString()} | ${s.tool_id} | ${s.total_turns} turns | cache ${s.cache_hit_pct ? s.cache_hit_pct.toFixed(0) + '%' : '--'} | errors ${s.error_count || 0} | ${s.code_lines_added || 0} lines | quality ${(s.quality_score || 0).toFixed(0)} | "${firstLabel}"`;
  }).join('\n');

  return `You are analyzing a developer's AI coding tool usage patterns. Here are summaries of their last ${sessions.length} sessions:\n\n${summaries}\n\nProvide a concise analysis (under 400 words) covering:\n1. Top 3 behavioral patterns you observe (positive and negative)\n2. Specific prompt improvement recommendations with a before/after example\n3. Conditions when they seem to perform best\n4. One concrete change to make this week\n\nBe specific, reference the actual data, avoid generic advice.`;
}

export function buildDailyPickPrompt(sessions) {
  const summaries = sessions.slice(0, 20).map(s => {
    const firstLabel = sanitizeForPrompt(s.first_label, 150).replace(/\n/g, ' ');
    return `- ${new Date(s.started_at).toLocaleDateString()} | ${s.tool_id} | turns:${s.total_turns} | quality:${(s.quality_score || 0).toFixed(0)} | cache:${s.cache_hit_pct ? s.cache_hit_pct.toFixed(0) + '%' : '--'} | "${firstLabel}"`;
  }).join('\n');

  return `You are a Claude Code automation advisor reviewing a developer's recent AI coding sessions.\n\nRecent sessions:\n${summaries}\n\nBased on these patterns, produce TODAY'S DAILY PICK — one high-value Claude Code automation recommendation. Format your response as:\n\n**Today's Pick: [short title]**\n\n[2-3 sentence explanation of what to automate and why, grounded in the session data above]\n\n**How to implement:** [1-2 concrete steps or the exact CLAUDE.md snippet / hook config to add]\n\n**Expected impact:** [specific metric improvement e.g. "reduce avg turns from X to Y" or "eliminate recurring error pattern"]\n\nKeep the total response under 200 words. Be specific and actionable.`;
}

// ── Azure OpenAI streaming ────────────────────────────────────────────────────

async function* streamAzure(prompt) {
  // Build the chat completions URL from the endpoint.
  // The endpoint may already include path components, so handle both forms:
  //   https://my-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview
  //   https://my-resource.openai.azure.com
  let baseUrl = AZURE_OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, '');
  // Strip any trailing path that isn't the resource root
  if (baseUrl.includes('/openai/')) {
    baseUrl = baseUrl.split('/openai/')[0];
  }
  const url = `${baseUrl}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_OPENAI_API_KEY,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_completion_tokens: 700,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Azure OpenAI ${r.status}: ${body.slice(0, 200)}`);
  }
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

// ── Non-streaming Azure call (for daily pick background job) ─────────────────

export async function callAzure(prompt) {
  let baseUrl = AZURE_OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, '');
  if (baseUrl.includes('/openai/')) {
    baseUrl = baseUrl.split('/openai/')[0];
  }
  const url = `${baseUrl}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_API_KEY },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_completion_tokens: 400 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Azure OpenAI ${r.status}: ${body.slice(0, 200)}`);
  }
  const json = await r.json();
  return json.choices?.[0]?.message?.content || '';
}

// ── Other provider streams ────────────────────────────────────────────────────

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
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }], max_tokens: 600 }),
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
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }], max_tokens: 600 }),
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

// ── Deep Analyze (streaming SSE) ─────────────────────────────────────────────

export async function streamDeepAnalysis(res) {
  const cacheKey = 'deep-analyze-default';
  const cached = getCachedInsight(cacheKey);
  if (cached) {
    res.write(`data: ${JSON.stringify({ token: cached, cached: true })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  const { provider, model, available } = await detectProvider();
  if (!available) {
    res.write(`data: ${JSON.stringify({ error: 'no_provider' })}\n\n`);
    res.end();
    return;
  }

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
      : provider === 'azure' ? streamAzure(prompt)
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
