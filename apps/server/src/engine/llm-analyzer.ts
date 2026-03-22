import { getDb } from '../db/index.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma2:2b';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT_CHAT || 'gpt-5.2-chat';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Cascade: try in order, fall back on 404/5xx
const GEMINI_CASCADE = (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
]);

function sanitize(text: string, maxLen = 200): string {
    return (text || '').replace(/[\x00-\x1f]/g, ' ').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;' }[c] || c)).slice(0, maxLen);
}

export async function detectProvider() {
    // Allow explicit provider preference via env var (azure, ollama, gemini, openai, anthropic)
    const preferredProvider = (process.env.PREFERRED_LLM_PROVIDER || '').toLowerCase();
    if (preferredProvider === 'azure' && AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT) {
        return { provider: 'azure' as const, model: AZURE_OPENAI_DEPLOYMENT, available: true };
    }
    try {
        const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const data = await r.json() as any;
            const models = (data.models || []).map((m: any) => m.name);
            const preferred = [OLLAMA_MODEL, 'gemma2:2b', 'gemma2:9b', 'llama3.2:3b'];
            const model = preferred.find(m => models.includes(m)) || models[0];
            if (model) return { provider: 'ollama' as const, model, available: true };
        }
    } catch { /* not available */ }
    if (GEMINI_API_KEY) return { provider: 'gemini' as const, model: GEMINI_CASCADE[0], available: true };
    if (AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT) return { provider: 'azure' as const, model: AZURE_OPENAI_DEPLOYMENT, available: true };
    if (OPENAI_API_KEY) return { provider: 'openai' as const, model: OPENAI_MODEL, available: true };
    if (ANTHROPIC_API_KEY) return { provider: 'anthropic' as const, model: ANTHROPIC_MODEL, available: true };
    return { provider: null, available: false };
}

function buildPrompt(sessions: any[]): string {
    // Filter out ghost / empty sessions with 0 turns and 0 tokens
    const real = sessions.filter(s => (s.total_turns || 0) > 0 || (s.total_output_tokens || 0) > 0);
    const data = real.length > 0 ? real : sessions;

    const summaries = data.slice(0, 15).map((s, i) => {
        const label = sanitize(s.first_label || s.title || 'untitled', 120).replace(/\n/g, ' ');
        const date = new Date(s.started_at).toLocaleDateString('en-GB');
        const cacheStr = s.cache_hit_pct != null ? `${s.cache_hit_pct.toFixed(0)}%` : 'n/a';
        const tokOut = s.total_output_tokens ? `${Math.round(s.total_output_tokens / 1000)}k` : '0';
        const tokIn = s.total_input_tokens ? `${Math.round(s.total_input_tokens / 1000)}k` : '0';
        return `${i + 1}. [${date}] ${s.tool_id} | turns:${s.total_turns} | in:${tokIn} out:${tokOut} | cache:${cacheStr} | errors:${s.error_count || 0} | +${s.code_lines_added || 0}/-${s.code_lines_removed || 0} lines | quality:${(s.quality_score || 0).toFixed(0)} | "${label}"`;
    }).join('\n');

    const totalTurns = data.reduce((a, s) => a + (s.total_turns || 0), 0);
    const totalOut = data.reduce((a, s) => a + (s.total_output_tokens || 0), 0);
    const validCache = data.filter(s => s.cache_hit_pct != null);
    const avgCache = validCache.length ? validCache.reduce((a, s) => a + s.cache_hit_pct, 0) / validCache.length : 0;
    const totalErrors = data.reduce((a, s) => a + (s.error_count || 0), 0);
    const tools = [...new Set(data.map(s => s.tool_id))];

    return `You are an expert AI productivity coach analyzing a developer's real session data.

AGGREGATE STATS (${data.length} sessions):
- Tools used: ${tools.join(', ')}
- Total turns: ${totalTurns} | Total output tokens: ${Math.round(totalOut / 1000)}k
- Avg cache hit: ${avgCache.toFixed(0)}% | Total errors: ${totalErrors}

SESSION DATA (most recent first):
${summaries}

Produce a concise performance analysis (max 300 words) with this exact structure using Markdown:

## What You Accomplished
One paragraph summarizing the actual coding work done. Reference the session titles and key metrics.

## Token Efficiency
Was token usage efficient? Note any runaway output sessions, good cache hits, or waste. Reference specific sessions by number where notable.

## Bottlenecks & Failures
What slowed things down the most? High error counts, low quality scores, sessions with many turns for little output? Be specific with the actual data.

## Key Recommendation
One concrete, actionable suggestion for this week — specific to the patterns you observed.

Write in second person ("you"), be direct, and ground every claim in the actual numbers and session labels above. Do NOT make generic statements.`;
}

export function buildDailyPickPrompt(sessions: any[]): string {
    const summaries = sessions.slice(0, 20).map(s => {
        const firstLabel = sanitize(s.first_label, 150).replace(/\n/g, ' ');
        return `- ${new Date(s.started_at).toLocaleDateString()} | ${s.tool_id} | turns:${s.total_turns} | quality:${(s.quality_score || 0).toFixed(0)} | cache:${s.cache_hit_pct ? s.cache_hit_pct.toFixed(0) + '%' : '--'} | "${firstLabel}"`;
    }).join('\n');
    return `You are a Claude Code automation advisor reviewing a developer's recent AI coding sessions.\n\nRecent sessions:\n${summaries}\n\nBased on these patterns, produce TODAY'S DAILY PICK — one high-value automation recommendation.\n\nKeep the total response under 200 words. Be specific and actionable.`;
}

async function* streamAzure(prompt: string): AsyncGenerator<string> {
    let baseUrl = AZURE_OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, '');
    if (baseUrl.includes('/openai/')) baseUrl = baseUrl.split('/openai/')[0];
    const url = `${baseUrl}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`;
    const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_API_KEY },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true, max_completion_tokens: 700 }), signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) throw new Error(`Azure OpenAI ${r.status}`);
    const reader = (r.body as any).getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const data = line.replace(/^data: /, '').trim();
            if (!data || data === '[DONE]') continue;
            try { const obj = JSON.parse(data); const token = obj.choices?.[0]?.delta?.content; if (token) yield token; } catch { /* partial */ }
        }
    }
}

export async function callAzure(prompt: string): Promise<string> {
    let baseUrl = AZURE_OPENAI_ENDPOINT.split('?')[0].replace(/\/$/, '');
    if (baseUrl.includes('/openai/')) baseUrl = baseUrl.split('/openai/')[0];
    const url = `${baseUrl}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`;
    const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_API_KEY },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_completion_tokens: 400 }), signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) throw new Error(`Azure OpenAI ${r.status}`);
    const json = await r.json() as any;
    return json.choices?.[0]?.message?.content || '';
}

async function* streamOllama(model: string, prompt: string): AsyncGenerator<string> {
    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: true }), signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const reader = (r.body as any).getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try { const obj = JSON.parse(line); if (obj.response) yield obj.response; if (obj.done) return; } catch { /* partial */ }
        }
    }
}

async function* streamOpenAI(model: string, prompt: string): AsyncGenerator<string> {
    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }], max_tokens: 600 }), signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const reader = (r.body as any).getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const data = line.replace(/^data: /, '').trim();
            if (!data || data === '[DONE]') continue;
            try { const obj = JSON.parse(data); const token = obj.choices?.[0]?.delta?.content; if (token) yield token; } catch { /* partial */ }
        }
    }
}

async function* streamAnthropic(model: string, prompt: string): AsyncGenerator<string> {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }], max_tokens: 600 }), signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const reader = (r.body as any).getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            const data = line.replace(/^data: /, '').trim();
            if (!data) continue;
            try { const obj = JSON.parse(data); const token = obj.delta?.text; if (token) yield token; } catch { /* partial */ }
        }
    }
}

async function* streamGeminiCascade(prompt: string): AsyncGenerator<string & { _model?: string }> {
    let lastErr: Error | null = null;
    for (const model of GEMINI_CASCADE) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
            const r = await fetch(`${url}&key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GEMINI_API_KEY },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                signal: AbortSignal.timeout(60000)
            });
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                lastErr = new Error(`Gemini ${model} ${r.status}: ${body.slice(0, 100)}`);
                console.warn(`[cascade] ${model} failed (${r.status}), trying next...`);
                continue;
            }
            // Yield a special first token to signal which model is actually being used
            yield `\0model:${model}`;
            const reader = (r.body as any).getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    const data = line.replace(/^data: /, '').trim();
                    if (!data) continue;
                    try {
                        const obj = JSON.parse(data);
                        const token = obj.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (token) yield token;
                    } catch { /* partial */ }
                }
            }
            return; // success – stop cascade
        } catch (e: any) {
            lastErr = e;
            console.warn(`[cascade] ${model} threw: ${e.message}, trying next...`);
        }
    }
    throw lastErr || new Error('All Gemini models in cascade failed');
}

/** Debug helper: returns the exact prompt and session data that would be sent to the LLM. */
export function getInsightDebugPayload(sessionId?: string): any {
    const db = getDb();
    if (sessionId) {
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
        if (!session) return { error: 'Session not found' };
        const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as any[];
        const turnsStr = turns.map((t, i) => `Turn ${i + 1}: In ${t.input_tokens} / Out ${t.output_tokens} / Latency ${t.latency_ms}ms / Tools: ${t.tools_used} / Stop: ${t.stop_reason}`).join('\n');
        const prompt = `You are a strict, analytical coding assistant evaluating a single AI session.\nSession ID: ${session.id}\nTopic: ${session.topic || 'Unknown'}\nTool: ${session.tool_id}\nTotal Turns: ${session.total_turns}\nTokens: In ${session.total_input_tokens} / Out ${session.total_output_tokens}\nQuality Score: ${session.quality_score}\nError Count: ${session.error_count}\nLines Added: ${session.code_lines_added} / Removed: ${session.code_lines_removed}\nCache Hits: ${session.cache_hit_pct}%\n\nTURN HISTORY (first 50 max):\n${turnsStr.split('\n').slice(0, 50).join('\n')}\n\n[...session analysis prompt...]`;
        return {
            model_cascade: GEMINI_CASCADE,
            session_id: sessionId,
            session_summary: {
                tool: session.tool_id, title: session.title, turns: session.total_turns,
                input_tokens: session.total_input_tokens, output_tokens: session.total_output_tokens,
                quality: session.quality_score, errors: session.error_count,
                cache_pct: session.cache_hit_pct, lines_added: session.code_lines_added,
            },
            turn_count: turns.length,
            turns_preview: turns.slice(0, 5),
            prompt_preview: prompt.slice(0, 800) + (prompt.length > 800 ? '\n...[truncated]' : ''),
        };
    }
    // Deep analysis debug
    const sessions = db.prepare(`
        SELECT s.*, t.label as first_label FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (SELECT MIN(rowid) FROM turns WHERE session_id = s.id)
        ORDER BY s.started_at DESC LIMIT 20
    `).all() as any[];
    const real = sessions.filter(s => (s.total_turns || 0) > 0 || (s.total_output_tokens || 0) > 0);
    const prompt = buildPrompt(sessions);
    return {
        model_cascade: GEMINI_CASCADE,
        total_sessions_fetched: sessions.length,
        sessions_after_ghost_filter: real.length,
        sessions_used: (real.length > 0 ? real : sessions).slice(0, 15).map(s => ({
            id: s.id?.slice(0, 12), tool: s.tool_id, turns: s.total_turns,
            out_tokens: s.total_output_tokens, quality: s.quality_score,
            title: s.first_label || s.title,
        })),
        prompt_length: prompt.length,
        prompt_full: prompt,
    };
}

export async function streamDeepAnalysis(res: any) {
    const db = getDb();
    // Check insight cache
    const cached = db.prepare('SELECT result, created_at FROM insight_cache WHERE key = ?').get('insight:deep-analyze-default') as any;
    if (cached && Date.now() - cached.created_at < 3600000) {
        res.write(`data: ${JSON.stringify({ token: cached.result, cached: true })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
    }

    const { provider, model, available } = await detectProvider();
    if (!available) {
        res.write(`data: ${JSON.stringify({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama locally.' })}\n\n`);
        res.end();
        return;
    }

    const sessions = db.prepare(`
        SELECT s.*, t.label as first_label FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (SELECT MIN(rowid) FROM turns WHERE session_id = s.id)
        WHERE s.total_turns > 0 OR s.total_output_tokens > 0
        ORDER BY s.started_at DESC LIMIT 10
    `).all() as any[];

    const prompt = buildPrompt(sessions);
    let fullText = '';
    let actualModel = GEMINI_CASCADE[0];
    try {
        const stream = provider === 'gemini' ? streamGeminiCascade(prompt)
            : provider === 'ollama' ? streamOllama(model!, prompt)
                : provider === 'azure' ? streamAzure(prompt)
                    : provider === 'openai' ? streamOpenAI(model!, prompt)
                        : streamAnthropic(model!, prompt);

        for await (const token of stream) {
            // Handle cascade sentinel: \0model:gemini-2.5-pro
            if (typeof token === 'string' && token.startsWith('\0model:')) {
                actualModel = token.slice(7);
                res.write(`data: ${JSON.stringify({ model_selected: actualModel, provider })}\n\n`);
                continue;
            }
            fullText += token;
            res.write(`data: ${JSON.stringify({ token, provider, model: actualModel })}\n\n`);
        }
        // Cache for 1 hour
        db.prepare('INSERT OR REPLACE INTO insight_cache (key, result, created_at) VALUES (?,?,?)').run('insight:deep-analyze-default', fullText, Date.now());
        res.write(`data: ${JSON.stringify({ done: true, provider, model: actualModel })}\n\n`);
    } catch (err: any) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
        res.end();
    }
}

export async function streamSessionAnalysis(res: any, sessionId: string) {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!session) { res.write(`data: ${JSON.stringify({ error: 'Session not found' })}\n\n`); res.end(); return; }

    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as any[];

    const { provider, model, available } = await detectProvider();
    if (!available) {
        res.write(`data: ${JSON.stringify({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama locally.' })}\n\n`);
        res.end();
        return;
    }

    const turnsStr = turns.map((t, i) => `Turn ${i + 1}: In ${t.input_tokens} / Out ${t.output_tokens} / Latency ${t.latency_ms}ms / Tools: ${t.tools_used} / Stop: ${t.stop_reason}`).join('\n');
    const prompt = `You are a strict, analytical coding assistant evaluating a single AI session.
Session ID: ${session.id}
Topic: ${session.topic || 'Unknown'}
Tool: ${session.tool_id}
Total Turns: ${session.total_turns}
Tokens: In ${session.total_input_tokens} / Out ${session.total_output_tokens}
Quality Score: ${session.quality_score}
Error Count: ${session.error_count}
Lines Added: ${session.code_lines_added} / Removed: ${session.code_lines_removed}
Cache Hits: ${session.cache_hit_pct}%

TURN HISTORY (first 50 max):
${turnsStr.split('\n').slice(0, 50).join('\n')}

Provide a concise analysis (under 250 words) covering:
1. What was exactly accomplished in this session
2. Token usage efficiency (were there runaway loops?)
3. The biggest failure point or bottleneck (if any)
4. Key takeaway or suggestion
Format using Markdown with bold headers.`;

    let fullText = '';
    let actualModel = GEMINI_CASCADE[0];
    try {
        const stream = provider === 'gemini' ? streamGeminiCascade(prompt)
            : provider === 'ollama' ? streamOllama(model!, prompt)
                : provider === 'azure' ? streamAzure(prompt)
                    : provider === 'openai' ? streamOpenAI(model!, prompt)
                        : streamAnthropic(model!, prompt);

        for await (const token of stream) {
            if (typeof token === 'string' && token.startsWith('\0model:')) {
                actualModel = token.slice(7);
                res.write(`data: ${JSON.stringify({ model_selected: actualModel, provider })}\n\n`);
                continue;
            }
            fullText += token;
            res.write(`data: ${JSON.stringify({ token, provider, model: actualModel })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true, provider, model: actualModel })}\n\n`);
    } catch (err: any) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
        res.end();
    }
}
