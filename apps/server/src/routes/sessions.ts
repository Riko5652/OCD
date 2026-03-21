// Session routes — CRUD, import, upload, classification
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { registry } from '../adapters/registry.js';
import { streamSessionAnalysis, getInsightDebugPayload } from '../engine/llm-analyzer.js';
import { detectTopic, scoreProjectRelevance } from '../engine/topic-segmenter.js';
import type { CacheStore, LlmRateLimiter } from './types.js';

function clampInt(val: any, min: number, max: number, fallback: number): number {
    const n = parseInt(val);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function sanitizeString(val: any, maxLen = 200): string {
    return typeof val === 'string' ? val.replace(/[\x00-\x1f]/g, '').slice(0, maxLen) : '';
}

function importSessionData(data: any) {
    if (!data || typeof data !== 'object') throw new Error('Invalid request body');
    if (!Array.isArray(data.turns) || data.turns.length === 0) throw new Error('turns must be a non-empty array');
    if (data.turns.length > 2000) throw new Error('Too many turns (max 2000)');
    for (const t of data.turns) {
        if (!t.role || (t.role !== 'user' && t.role !== 'assistant')) throw new Error('Each turn must have role "user" or "assistant"');
        if (typeof t.content !== 'string') throw new Error('Each turn must have string content');
        if (t.content.length > 10000) t.content = t.content.slice(0, 10000);
    }
    if (data.tool && (typeof data.tool !== 'string' || data.tool.length > 64)) throw new Error('Invalid tool name');
    if (data.title && (typeof data.title !== 'string' || data.title.length > 500)) throw new Error('Title too long');

    const db = getDb();
    const id = `import-${sanitizeString(data.tool, 32) || 'custom'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const turns = data.turns;
    const userTurns = turns.filter((t: any) => t.role === 'user');
    const assistantTurns = turns.filter((t: any) => t.role === 'assistant');
    const totalInput = userTurns.reduce((s: number, t: any) => s + ((t.content?.length || 0) / 4), 0);
    const totalOutput = assistantTurns.reduce((s: number, t: any) => s + ((t.content?.length || 0) / 4), 0);
    const startedAt = data.started_at ? new Date(data.started_at).getTime() : Date.now();
    const toolId = data.tool || 'manual-import';

    try { db.prepare('INSERT OR IGNORE INTO tools (id, display_name) VALUES (?, ?)').run(toolId, data.tool || 'Imported'); } catch { /* ok */ }

    db.prepare(`INSERT OR REPLACE INTO sessions (id, tool_id, title, started_at, ended_at, total_turns,
        total_input_tokens, total_output_tokens, primary_model, raw_data)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, toolId, data.title || (userTurns[0]?.content || '').slice(0, 80) || 'Imported session',
        startedAt, startedAt + turns.length * 60000, turns.length,
        Math.round(totalInput), Math.round(totalOutput), data.model || 'unknown',
        JSON.stringify({ source: 'import', original_tool: data.tool })
    );

    const insertTurn = db.prepare('INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, label, type) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => {
        for (let i = 0; i < turns.length; i++) {
            const t = turns[i];
            insertTurn.run(id, startedAt + i * 30000, data.model || 'unknown',
                t.role === 'user' ? Math.round((t.content?.length || 0) / 4) : 0,
                t.role === 'assistant' ? Math.round((t.content?.length || 0) / 4) : 0,
                (t.content || '').slice(0, 120), t.role === 'user' ? 1 : 2);
        }
    })();

    return { id, turns: turns.length, tool: toolId };
}

export default async function sessionRoutes(fastify: FastifyInstance, opts: { cache: CacheStore; llmRateLimit: LlmRateLimiter; broadcast: (event?: string, extra?: Record<string, unknown>) => void }) {
    const { cache, llmRateLimit, broadcast } = opts;

    fastify.get('/api/sessions', async (request) => {
        const { tool, limit } = request.query as any;
        const db = getDb();
        let sql = 'SELECT * FROM sessions';
        const params: any[] = [];
        if (tool) { sql += ' WHERE tool_id = ?'; params.push(tool); }
        sql += ' ORDER BY started_at DESC LIMIT ?';
        params.push(clampInt(limit, 1, 1000, 100));
        return db.prepare(sql).all(...params);
    });

    fastify.get('/api/sessions/:id', async (request) => {
        const { id } = request.params as any;
        const db = getDb();
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        if (!session) return { error: 'Session not found' };
        let turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp').all(id);

        if (turns.length === 0) {
            const toolId = (session as any).tool_id;
            const adapter = registry.getAdapters().find((a: any) => a.id === toolId);
            if (adapter?.getTurns) {
                try {
                    const liveTurns = await adapter.getTurns(id);
                    if (liveTurns.length > 0) {
                        const insertTurn = db.prepare(`INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read, cache_create, latency_ms, tok_per_sec, tools_used, stop_reason, label, type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
                        db.transaction(() => {
                            for (const t of liveTurns) {
                                insertTurn.run(t.session_id, t.timestamp, t.model, t.input_tokens, t.output_tokens, t.cache_read || 0, t.cache_create || 0, t.latency_ms ?? null, null, JSON.stringify(t.tools_used || []), t.stop_reason || null, t.label || null, t.type || null);
                            }
                        })();
                        turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp').all(id);
                    }
                } catch { /* skip */ }
            }
        }

        return { session, turns };
    });

    fastify.get('/api/sessions/:id/insights', async (request, reply) => {
        const { id } = request.params as any;
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        await streamSessionAnalysis(reply.raw, id);
    });

    fastify.get('/api/sessions/:id/insights/debug', async (request) => {
        const { id } = request.params as any;
        return getInsightDebugPayload(id);
    });

    fastify.get('/api/sessions/:id/classify', async (request) => {
        const { id } = request.params as any;
        const session = getDb().prepare('SELECT id, title, tldr, raw_data, top_tools FROM sessions WHERE id = ?').get(id) as any;
        if (!session) return { error: 'Session not found' };
        const topic = detectTopic(session);
        const relevance = scoreProjectRelevance(session, (request.query as any).project || '');
        return { id: session.id, topic, project_relevance_score: relevance };
    });

    fastify.post('/api/sessions/upload', async (request, reply) => {
        try {
            const body = request.body as any;
            const data = Array.isArray(body) ? body : [body];
            const results = data.map((d: any) => importSessionData(d));
            cache.invalidate();
            broadcast('refresh');
            return { ok: true, imported: results };
        } catch (e: any) {
            reply.status(400);
            return { error: e.message };
        }
    });

    fastify.post('/api/sessions/import', async (request, reply) => {
        try {
            const body = request.body as any;
            const data = Array.isArray(body) ? body : [body];
            const db = getDb();
            const insert = db.prepare(`
                INSERT OR REPLACE INTO sessions (id, tool_id, title, started_at, total_turns,
                    total_input_tokens, total_output_tokens, primary_model)
                VALUES (?,?,?,?,?,?,?,?)
            `);
            let count = 0;
            db.transaction(() => {
                for (const d of data) {
                    const id = `import-${Date.now()}-${count}`;
                    insert.run(id, d.tool || 'manual-import', d.title || 'Imported', Date.now(), d.turns?.length || 0, 0, 0, d.model || 'unknown');
                    count++;
                }
            })();
            cache.invalidate();
            broadcast('refresh');
            return { ok: true, imported: count };
        } catch (e: any) {
            reply.status(400);
            return { error: e.message };
        }
    });

    fastify.get('/api/sessions/import/schema', async () => ({
        type: 'object',
        properties: {
            tool: { type: 'string', description: 'Source tool: chatgpt, claude-web, gemini-web, custom' },
            title: { type: 'string' },
            model: { type: 'string' },
            turns: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } } },
        },
        required: ['tool', 'turns'],
    }));
}
