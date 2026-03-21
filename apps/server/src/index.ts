import Fastify from 'fastify';
import { initDb, getDb } from './db/index.js';
import { config, printConfig } from './config.js';
import { registry } from './adapters/registry.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CursorAdapter } from './adapters/cursor.js';
import { AntigravityAdapter } from './adapters/antigravity.js';
import { AiderAdapter } from './adapters/aider.js';
import { WindsurfAdapter } from './adapters/windsurf.js';
import { CopilotAdapter } from './adapters/copilot.js';
import { ContinueAdapter } from './adapters/continue.js';
import { computeOverview, computeToolComparison, computeModelUsage, computeCodeGeneration, computeInsights, computeCostAnalysis, computePersonalInsights, rebuildDailyStats, dbGetCommitScores } from './engine/analytics.js';
import { scanAndScoreGitCommits, discoverRepos } from './engine/git-scanner.js';
import { scoreAndSave } from './engine/scorer.js';
import { scoreAllSessions, getAgenticLeaderboard } from './engine/agentic-scorer.js';
import { streamDeepAnalysis, streamSessionAnalysis, getInsightDebugPayload } from './engine/llm-analyzer.js';
import { computeSavingsReport } from './engine/savings-report.js';
import type { IAiAdapter, UnifiedSession } from './adapters/types.js';

const fastify = Fastify({ logger: true });

// ---- Register all adapters ----
registry.register(new ClaudeCodeAdapter());
registry.register(new CursorAdapter());
registry.register(new AntigravityAdapter());
registry.register(new AiderAdapter());
registry.register(new WindsurfAdapter());
registry.register(new CopilotAdapter());
registry.register(new ContinueAdapter());

// ---- In-memory result cache ----
const RC: Record<string, any> = {};
function invalidateCache() { for (const key of Object.keys(RC)) delete RC[key]; }
function cached<T>(key: string, fn: () => T): T {
    if (RC[key] !== undefined) return RC[key];
    RC[key] = fn();
    return RC[key];
}

// ---- SSE live push ----
const sseClients = new Set<any>();

fastify.get('/api/live', (request, reply) => {
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    reply.raw.write('data: connected\n\n');
    sseClients.add(reply.raw);
    request.raw.on('close', () => sseClients.delete(reply.raw));
});

function broadcast(event = 'refresh') {
    const data = JSON.stringify({ event, ts: Date.now() });
    for (const client of sseClients) {
        try { client.write(`event: ${event}\ndata: ${data}\n\n`); } catch { sseClients.delete(client); }
    }
}

// ---- Ingestion ----
async function ingestAdapter(adapter: IAiAdapter) {
    const db = getDb();
    const sessions = await adapter.getSessions();
    const insertSession = db.prepare(`
        INSERT OR REPLACE INTO sessions
        (id, tool_id, title, tldr, started_at, ended_at, total_turns, total_input_tokens, total_output_tokens,
         total_cache_read, total_cache_create, primary_model, models_used, cache_hit_pct, avg_latency_ms,
         top_tools, code_lines_added, code_lines_removed, files_touched, first_attempt_pct, avg_thinking_length,
         error_count, error_recovery_pct, raw_data, meta)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const bulkInsert = db.transaction((rows: UnifiedSession[]) => {
        for (const s of rows) {
            insertSession.run(
                s.id, s.tool_id, s.title || null, null,
                s.started_at, s.ended_at || null, s.total_turns,
                s.total_input_tokens, s.total_output_tokens,
                s.total_cache_read, s.total_cache_create,
                s.primary_model || null,
                JSON.stringify(s.models_used || []),
                s.cache_hit_pct ?? null, s.avg_latency_ms ?? null,
                JSON.stringify(s.top_tools || []),
                s.code_lines_added, s.code_lines_removed,
                s.files_touched, null, null,
                s.error_count, null,
                JSON.stringify(s.raw || {}),
                (s.raw as any)?.meta ? 1 : 0
            );
        }
    });

    bulkInsert(sessions);

    // Score sessions
    for (const s of sessions) {
        try { scoreAndSave(s as any); } catch { /* skip */ }
    }

    // Ingest commit scores if available
    if (adapter.getCommitScores) {
        const scores = await adapter.getCommitScores();
        const insertCommit = db.prepare(`
            INSERT OR REPLACE INTO commit_scores
            (commit_hash, branch, tool_id, scored_at, lines_added, lines_deleted,
             ai_lines_added, ai_lines_deleted, human_lines_added, human_lines_deleted,
             ai_percentage, commit_message, commit_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        db.transaction(() => {
            for (const c of scores) {
                insertCommit.run(
                    c.commit_hash, c.branch, c.tool_id, c.scored_at,
                    c.lines_added, c.lines_deleted, c.ai_lines_added, c.ai_lines_deleted,
                    c.human_lines_added, c.human_lines_deleted, c.ai_percentage,
                    c.commit_message, c.commit_date
                );
            }
        })();
    }

    // Ingest turns for each session
    if (adapter.getTurns) {
        const insertTurn = db.prepare(`
            INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read, cache_create, latency_ms, tok_per_sec, tools_used, stop_reason, label, type)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        // Process in chunks to avoid timeouts on large datasets
        for (const s of sessions) {
            try {
                // Skip if turns already exist for this session
                const existing = db.prepare('SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?').get(s.id) as any;
                if (existing.cnt > 0) continue;
                const turns = await adapter.getTurns(s.id);
                if (turns.length === 0) continue;
                db.transaction(() => {
                    for (const t of turns) {
                        insertTurn.run(
                            t.session_id, t.timestamp, t.model,
                            t.input_tokens, t.output_tokens,
                            t.cache_read || 0, t.cache_create || 0,
                            t.latency_ms ?? null,
                            t.latency_ms && t.output_tokens ? Math.round(t.output_tokens / (t.latency_ms / 1000)) : null,
                            JSON.stringify(t.tools_used || []),
                            t.stop_reason || null, t.label || null, t.type || null
                        );
                    }
                })();
            } catch { /* skip this session's turns */ }
        }
    }

    // Ingest AI files if available
    if (adapter.getAiFiles) {
        const files = await adapter.getAiFiles();
        const insertFile = db.prepare(`
            INSERT OR IGNORE INTO ai_files (tool_id, session_id, file_path, file_extension, model, action, created_at)
            VALUES (?,?,?,?,?,?,?)
        `);
        db.transaction(() => {
            for (const f of files) {
                insertFile.run(f.tool_id, f.session_id || null, f.file_path, f.file_extension || null, f.model || null, f.action, f.created_at);
            }
        })();
    }

    return sessions.length;
}

async function ingestAll() {
    const adapters = registry.getAdapters();
    let total = 0;
    for (const adapter of adapters) {
        try {
            const count = await ingestAdapter(adapter);
            fastify.log.info(`[ingest] ${adapter.name}: ${count} sessions`);
            total += count;
        } catch (e: any) {
            fastify.log.error(`[ingest] ${adapter.name} failed: ${e.message}`);
        }
    }
    invalidateCache();
    scoreAllSessions();
    rebuildDailyStats();
    rebuildProjectIndex();
    // Scan git repos and correlate commits to AI sessions
    try {
        const gitResult = scanAndScoreGitCommits();
        fastify.log.info(`[git-scanner] Scanned ${gitResult.repos} repos, scored ${gitResult.commits} new commits`);
    } catch (e: any) {
        fastify.log.error(`[git-scanner] Failed: ${e.message}`);
    }
    broadcast('refresh');
    return total;
}

function rebuildProjectIndex() {
    const db = getDb();
    // Derive project names from session titles, topic, or raw_data
    const sessions = db.prepare(`SELECT id, tool_id, title, primary_model, started_at, total_output_tokens, code_lines_added, raw_data FROM sessions`).all() as any[];
    const projects: Record<string, { sessions: number; tokens: number; lines: number; tools: Set<string>; models: Set<string>; last: number }> = {};

    for (const s of sessions) {
        // Try to extract a project name
        let project = 'Unknown';
        if (s.title) project = s.title.split('/')[0].split(':')[0].trim().slice(0, 40);
        else {
            try {
                const raw = JSON.parse(s.raw_data || '{}');
                project = raw.workspace || raw.project || raw.repo || 'Unknown';
            } catch { /* */ }
        }
        if (!project || project.length < 2) project = s.tool_id;

        if (!projects[project]) projects[project] = { sessions: 0, tokens: 0, lines: 0, tools: new Set(), models: new Set(), last: 0 };
        const p = projects[project];
        p.sessions++;
        p.tokens += s.total_output_tokens || 0;
        p.lines += s.code_lines_added || 0;
        p.tools.add(s.tool_id);
        if (s.primary_model) p.models.add(s.primary_model);
        if ((s.started_at || 0) > p.last) p.last = s.started_at;
    }

    const upsert = db.prepare(`INSERT OR REPLACE INTO project_index (name, session_count, total_tokens, total_lines_added, dominant_tool, dominant_model, last_active) VALUES (?,?,?,?,?,?,?)`);
    db.transaction(() => {
        for (const [name, p] of Object.entries(projects)) {
            upsert.run(name, p.sessions, p.tokens, p.lines, [...p.tools][0] || null, [...p.models][0] || null, p.last || null);
        }
    })();
}

// ---- API Routes ----

fastify.get('/api/health', async () => {
    return { status: 'ok', version: '5.0.0', uptime: Math.round(process.uptime()) };
});

fastify.get('/api/overview', async () => cached('overview', computeOverview));
fastify.get('/api/compare', async () => cached('compare', computeToolComparison));
fastify.get('/api/models', async () => cached('models', computeModelUsage));
fastify.get('/api/code-generation', async () => cached('codegen', computeCodeGeneration));
fastify.get('/api/insights', async () => cached('insights', computeInsights));
fastify.get('/api/costs', async () => cached('costs', computeCostAnalysis));
fastify.get('/api/personal-insights', async () => cached('personal', computePersonalInsights));
fastify.get('/api/savings-report', async () => cached('savings', computeSavingsReport));

fastify.get('/api/commits', async (request) => {
    const limit = (request.query as any).limit || 100;
    return cached(`commits:${limit}`, () => dbGetCommitScores(limit));
});

fastify.get('/api/insights/deep', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    await streamDeepAnalysis(reply.raw);
});

fastify.get('/api/sessions', async (request) => {
    const { tool, limit } = request.query as any;
    const db = getDb();
    let sql = 'SELECT * FROM sessions';
    const params: any[] = [];
    if (tool) { sql += ' WHERE tool_id = ?'; params.push(tool); }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(parseInt(limit) || 100);
    return db.prepare(sql).all(...params);
});

fastify.get('/api/sessions/:id', async (request) => {
    const { id } = request.params as any;
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session) return { error: 'Session not found' };
    let turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp').all(id);

    // On-demand turn ingestion: if turns are missing, fetch from adapter and write
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

fastify.get('/api/insights/debug', async () => {
    return getInsightDebugPayload();
});

fastify.get('/api/agentic/scores', async (request) => {
    const { days } = request.query as any;
    return { leaderboard: getAgenticLeaderboard({ days: days ? parseInt(days) : null }) };
});

fastify.get('/api/models/performance', async (request) => {
    const { tool, model, days } = request.query as any;
    const db = getDb();
    let sql = 'SELECT * FROM model_performance WHERE 1=1';
    const params: any[] = [];
    if (tool) { sql += ' AND tool_id = ?'; params.push(tool); }
    if (model) { sql += ' AND model = ?'; params.push(model); }
    if (days) { sql += ' AND date > ?'; params.push(new Date(Date.now() - parseInt(days) * 86400000).toISOString().slice(0, 10)); }
    sql += ' ORDER BY date DESC';
    return { models: db.prepare(sql).all(...params) };
});

fastify.get('/api/daily-stats', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM daily_stats ORDER BY date DESC LIMIT 365').all();
});

fastify.get('/api/projects', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM project_index ORDER BY last_active DESC').all();
});

fastify.get('/api/cursor/deep', async () => {
    const db = getDb();
    const modelBreakdown = db.prepare(`
        SELECT primary_model as model, COUNT(*) as sessions, SUM(total_turns) as total_turns,
            SUM(total_output_tokens) as output_tokens, AVG(quality_score) as avg_quality,
            AVG(agentic_score) as avg_agentic_score
        FROM sessions WHERE tool_id = 'cursor' AND primary_model IS NOT NULL
        GROUP BY primary_model ORDER BY sessions DESC
    `).all();

    const overview = db.prepare(`
        SELECT COUNT(*) as total_sessions, SUM(total_turns) as total_turns,
            SUM(total_output_tokens) as total_output, SUM(total_input_tokens) as total_input,
            AVG(quality_score) as avg_quality
        FROM sessions WHERE tool_id = 'cursor'
    `).get();

    const topSessions = db.prepare(`
        SELECT id, title, total_turns, total_output_tokens, primary_model, quality_score,
            code_lines_added, files_touched, agentic_score
        FROM sessions WHERE tool_id = 'cursor' ORDER BY total_output_tokens DESC LIMIT 20
    `).all();

    const dailyActivity = db.prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as sessions,
            SUM(total_turns) as turns, SUM(total_output_tokens) as output_tokens
        FROM sessions WHERE tool_id = 'cursor' GROUP BY date ORDER BY date
    `).all();

    return { modelBreakdown, overview, topSessions, dailyActivity };
});

fastify.get('/api/repos', async () => {
    const db = getDb();
    const repos = discoverRepos();
    const commitCounts = db.prepare('SELECT commit_hash FROM commit_scores').all().length;
    return {
        discovered: repos.map(r => ({ name: r.name, path: r.path })),
        total_commits_scored: commitCounts,
    };
});

fastify.get('/api/antigravity-stats', async () => {
    const adapter = registry.getAdapter('antigravity');
    if (!adapter || !('getStats' in adapter)) return {};
    return (adapter as AntigravityAdapter).getStats();
});

fastify.get('/api/topics/summary', async () => {
    const db = getDb();
    return db.prepare(`
        SELECT topic, COUNT(*) as session_count, AVG(project_relevance_score) as avg_relevance
        FROM sessions WHERE topic IS NOT NULL GROUP BY topic ORDER BY session_count DESC
    `).all();
});

fastify.get('/api/commit-scores', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM commit_scores ORDER BY scored_at DESC LIMIT 200').all();
});

fastify.get('/api/efficiency', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM efficiency_log ORDER BY date DESC LIMIT 500').all();
});

// ---- Session Import ----
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
        invalidateCache();
        broadcast('refresh');
        return { ok: true, imported: count };
    } catch (e: any) {
        reply.status(400);
        return { error: e.message };
    }
});

fastify.post('/api/webhook/session', async (request, reply) => {
    try {
        const body = request.body as any;
        const db = getDb();
        const id = `webhook-${Date.now()}`;
        db.prepare(`
            INSERT INTO sessions (id, tool_id, title, started_at, total_turns, total_input_tokens, total_output_tokens, primary_model)
            VALUES (?,?,?,?,?,?,?,?)
        `).run(id, body.tool || 'manual-import', body.title || 'Webhook Session', Date.now(), body.turns?.length || 0, 0, 0, body.model || 'unknown');
        invalidateCache();
        broadcast('refresh');
        return { ok: true, id };
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

// ---- Refresh / Ingest ----
fastify.post('/api/refresh', async () => {
    const total = await ingestAll();
    return { ok: true, sessions: total };
});

// ---- CORS for import endpoints ----
fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
        reply.status(204).send();
        return;
    }
    done();
});

// ---- Start ----
const start = async () => {
    try {
        fastify.log.info('Initializing better-sqlite3 database...');
        initDb();
        fastify.log.info('Database initialized and migrated successfully.');

        printConfig();

        // Initial ingestion
        fastify.log.info('Starting initial data ingestion...');
        const total = await ingestAll();
        fastify.log.info(`Ingested ${total} total sessions from ${registry.getAdapters().length} adapters.`);

        await fastify.listen({ port: config.port, host: '0.0.0.0' });
        fastify.log.info(`\n  AI Productivity Dashboard v5.0\n  Open: http://localhost:${config.port}\n`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
