import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
import { streamDeepAnalysis, streamSessionAnalysis, getInsightDebugPayload, detectProvider, buildDailyPickPrompt, callAzure } from './engine/llm-analyzer.js';
import { computeSavingsReport } from './engine/savings-report.js';
import { computeProfile, computeTrends, computePromptMetrics } from './engine/insights.js';
import { computeAllProjects, computeProjectInsights } from './engine/project-insights.js';
import { classifySession, classifyAndSave } from './engine/cross-tool-router.js';
import { computeToolModelWinRates, getRoutingRecommendation } from './engine/cross-tool-router.js';
import { detectToolSwitches, getCrossToolStats } from './engine/cross-tool.js';
import { checkActiveSession } from './engine/session-coach.js';
import { getOptimalPromptStructure, suggestImprovements, extractPromptTemplates } from './engine/prompt-coach.js';
import { classifyAllSessionTopics, getTopicBreakdown, getTopicSummary, detectTopic, scoreProjectRelevance } from './engine/topic-segmenter.js';
import { analyzePromptMetrics } from './engine/prompt-analyzer.js';
import { runOptimizer } from './engine/optimizer.js';
import { startWatchers, stopWatchers } from './engine/watcher.js';
import { buildGraph } from './lib/knowledge-graph.js';
import { embedSession } from './lib/vector-store.js';
import { getBookmarkletCode } from './lib/bookmarklet.js';
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

// ---- Security headers ----
fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    done();
});

// ---- Optional auth token ----
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
if (AUTH_TOKEN) {
    fastify.addHook('onRequest', (request, reply, done) => {
        if (request.url === '/api/health') return done();
        if (!request.url.startsWith('/api/')) return done();
        const header = request.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (token !== AUTH_TOKEN) {
            reply.status(401).send({ error: 'Unauthorized — set Authorization: Bearer <AUTH_TOKEN>' });
            return;
        }
        done();
    });
}

// ---- General API rate limiter ----
// Limits each IP to a max number of requests per time window.
const apiRateBuckets = new Map<string, { count: number; resetAt: number }>();
const API_RATE_WINDOW_MS = 60_000;
const API_RATE_MAX = 120; // 120 requests per minute per IP

fastify.addHook('onRequest', (request, reply, done) => {
    if (!request.url.startsWith('/api/')) return done();
    // Exempt health check from rate limiting
    if (request.url === '/api/health') return done();

    const ip = request.ip || 'local';
    const now = Date.now();
    let bucket = apiRateBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + API_RATE_WINDOW_MS };
        apiRateBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > API_RATE_MAX) {
        const retryIn = Math.ceil((bucket.resetAt - now) / 1000);
        reply.status(429).send({ error: `Rate limited — ${API_RATE_MAX} requests/min exceeded. Retry in ${retryIn}s.` });
        return;
    }
    done();
});

// Periodically clean up stale rate limit buckets
setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of apiRateBuckets) {
        if (now >= bucket.resetAt) apiRateBuckets.delete(ip);
    }
}, 60_000);

// ---- LLM rate limiter (stricter, for expensive endpoints) ----
const llmCallTimestamps = new Map<string, number>();
function checkLlmRateLimit(ip: string, windowMs = 60_000): string | null {
    const now = Date.now();
    const last = llmCallTimestamps.get(ip) || 0;
    if (now - last < windowMs) {
        const retryIn = Math.ceil((windowMs - (now - last)) / 1000);
        return `Rate limited — wait ${retryIn}s before retrying.`;
    }
    llmCallTimestamps.set(ip, now);
    return null;
}

const HISTORY_DAYS = process.env.HISTORY_DAYS ? parseInt(process.env.HISTORY_DAYS) : 0;

// ---- Input validation helpers ----
function clampInt(val: any, min: number, max: number, fallback: number): number {
    const n = parseInt(val);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function sanitizeString(val: any, maxLen = 200): string {
    return typeof val === 'string' ? val.replace(/[\x00-\x1f]/g, '').slice(0, maxLen) : '';
}

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

// ---- Periodic session coach: emit coaching nudges every 60s ----
setInterval(() => {
    try {
        const nudges = checkActiveSession();
        if (nudges.length > 0) {
            const data = JSON.stringify({ nudges });
            for (const client of sseClients) {
                try { client.write(`event: coach\ndata: ${data}\n\n`); } catch { sseClients.delete(client); }
            }
        }
    } catch { /* never crash the interval */ }
}, 60000);

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

    // Score and classify sessions
    for (const s of sessions) {
        try { scoreAndSave(s as any); } catch { /* skip */ }
        try { classifyAndSave(s as any); } catch { /* skip */ }
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
                // Analyze prompt metrics for this session
                try { analyzePromptMetrics(s.id); } catch { /* skip */ }
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
    try { runOptimizer(); } catch { /* skip */ }
    // Scan git repos and correlate commits to AI sessions
    try {
        const gitResult = scanAndScoreGitCommits();
        fastify.log.info(`[git-scanner] Scanned ${gitResult.repos} repos, scored ${gitResult.commits} new commits`);
    } catch (e: any) {
        fastify.log.error(`[git-scanner] Failed: ${e.message}`);
    }
    broadcast('refresh');

    // Embed high-quality sessions for semantic memory (async, non-blocking)
    setImmediate(async () => {
        try {
            const db = getDb();
            const unembedded = db.prepare(`
                SELECT s.id FROM sessions s
                LEFT JOIN session_embeddings se ON se.session_id = s.id
                WHERE se.session_id IS NULL AND s.quality_score > 50
                ORDER BY s.started_at DESC LIMIT 50
            `).all() as any[];
            if (unembedded.length > 0) {
                fastify.log.info(`[embed] Embedding ${unembedded.length} sessions...`);
                for (const { id } of unembedded) {
                    try { await embedSession(id); } catch { /* skip */ }
                }
                fastify.log.info('[embed] Done');
            }
        } catch (e: any) {
            fastify.log.warn(`[embed] Skipped: ${e.message}`);
        }
    });

    // Pre-warm cache
    setImmediate(() => {
        try {
            cached('overview', computeOverview);
            cached('compare', computeToolComparison);
            cached('models', computeModelUsage);
            cached('codegen', computeCodeGeneration);
            cached('insights', computeInsights);
            cached('costs', computeCostAnalysis);
            cached('personal', computePersonalInsights);
            cached('ins:profile', computeProfile);
            cached('ins:trends:0', () => computeTrends(0));
            cached('ins:prompt-metrics', computePromptMetrics);
            fastify.log.info('[cache] Pre-warmed');
        } catch { /* skip */ }
    });

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
    params.push(clampInt(limit, 1, 1000, 100));
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
    return { leaderboard: getAgenticLeaderboard({ days: days ? clampInt(days, 1, 3650, 90) : null }) };
});

fastify.get('/api/models/performance', async (request) => {
    const { tool, model, days } = request.query as any;
    const db = getDb();
    let sql = 'SELECT * FROM model_performance WHERE 1=1';
    const params: any[] = [];
    if (tool) { sql += ' AND tool_id = ?'; params.push(tool); }
    if (model) { sql += ' AND model = ?'; params.push(model); }
    if (days) { sql += ' AND date > ?'; params.push(new Date(Date.now() - clampInt(days, 1, 3650, 90) * 86400000).toISOString().slice(0, 10)); }
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

// ---- Version check ----
const CURRENT_VERSION = '5.0.0';
let latestVersionCache = { version: null as string | null, checkedAt: 0 };
fastify.get('/api/version-check', async () => {
    const ONE_HOUR = 3600_000;
    if (latestVersionCache.version && Date.now() - latestVersionCache.checkedAt < ONE_HOUR) {
        return { current: CURRENT_VERSION, latest: latestVersionCache.version, updateAvailable: latestVersionCache.version !== CURRENT_VERSION };
    }
    try {
        const resp = await fetch('https://registry.npmjs.org/ai-productivity-dashboard/latest', {
            headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
            const data = await resp.json() as any;
            latestVersionCache = { version: data.version, checkedAt: Date.now() };
            return { current: CURRENT_VERSION, latest: data.version, updateAvailable: data.version !== CURRENT_VERSION };
        }
    } catch { /* network error */ }
    return { current: CURRENT_VERSION, latest: null, updateAvailable: false };
});

// ---- Recommendations ----
fastify.get('/api/recommendations', async (request) => {
    const all = (request.query as any).all === 'true';
    const db = getDb();
    const sql = all ? 'SELECT * FROM recommendations ORDER BY created_at DESC' : 'SELECT * FROM recommendations WHERE dismissed = 0 ORDER BY created_at DESC';
    return db.prepare(sql).all();
});

fastify.post('/api/recommendations/:id/dismiss', async (request) => {
    const { id } = request.params as any;
    getDb().prepare('UPDATE recommendations SET dismissed = 1 WHERE id = ?').run(id);
    return { ok: true };
});

// ---- Daily stats with configurable range ----
fastify.get('/api/daily', async (request) => {
    const days = (request.query as any).days ? parseInt((request.query as any).days) : HISTORY_DAYS;
    if (!days || days <= 0) return getDb().prepare('SELECT * FROM daily_stats ORDER BY date, tool_id').all();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return getDb().prepare('SELECT * FROM daily_stats WHERE date >= ? ORDER BY date, tool_id').all(cutoff);
});

// ---- Insight routes ----
fastify.get('/api/insights/profile', async () => {
    return cached('ins:profile', computeProfile);
});

fastify.get('/api/insights/trends', async (request) => {
    const days = (request.query as any).days ? parseInt((request.query as any).days) : HISTORY_DAYS;
    return cached(`ins:trends:${days}`, () => computeTrends(days));
});

fastify.get('/api/insights/prompt-metrics', async () => {
    return cached('ins:prompt-metrics', computePromptMetrics);
});

fastify.get('/api/ollama/status', async () => {
    try { return await detectProvider(); }
    catch (e: any) { return { available: false, error: e.message }; }
});

fastify.get('/api/insights/deep-analyze', async (request, reply) => {
    const rateLimitErr = checkLlmRateLimit(request.ip);
    if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    if ((request.query as any).refresh === '1') {
        getDb().prepare("DELETE FROM insight_cache WHERE key='deep-analyze-default'").run();
    }
    await streamDeepAnalysis(reply.raw);
});

// ---- Daily Pick ----
const DAILY_PICK_KEY = 'daily-pick';

async function generateDailyPick() {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const cachedPick = db.prepare('SELECT result, created_at FROM insight_cache WHERE key = ?').get(DAILY_PICK_KEY) as any;
    if (cachedPick) {
        try { const parsed = JSON.parse(cachedPick.result); if (parsed.date === today) return; } catch { /* regenerate */ }
    }
    const { provider, available } = await detectProvider();
    if (!available) return;

    const sessions = db.prepare(`
        SELECT s.*, t.label as first_label FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id AND t.rowid = (SELECT MIN(rowid) FROM turns WHERE session_id = s.id)
        ORDER BY s.started_at DESC LIMIT 20
    `).all() as any[];
    if (!sessions.length) return;

    const prompt = buildDailyPickPrompt(sessions);
    let text = '';
    try {
        if (provider === 'azure') {
            text = await callAzure(prompt);
        } else if (provider === 'openai') {
            const r = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
                signal: AbortSignal.timeout(60000),
            });
            const json = await r.json() as any;
            text = json.choices?.[0]?.message?.content || '';
        } else if (provider === 'anthropic') {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: prompt }], max_tokens: 400 }),
                signal: AbortSignal.timeout(60000),
            });
            const json = await r.json() as any;
            text = json.content?.[0]?.text || '';
        } else if (provider === 'ollama') {
            const r = await fetch(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/generate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'gemma2:2b', prompt, stream: false }),
                signal: AbortSignal.timeout(60000),
            });
            const json = await r.json() as any;
            text = json.response || '';
        }
        if (text) {
            db.prepare('INSERT OR REPLACE INTO insight_cache (key, result, created_at) VALUES (?,?,?)').run(DAILY_PICK_KEY, JSON.stringify({ date: today, text, provider }), Date.now());
        }
    } catch (e: any) { fastify.log.error(`[daily-pick] Error: ${e.message}`); }
}

fastify.get('/api/insights/daily-pick', async () => {
    const today = new Date().toISOString().split('T')[0];
    const cached = getDb().prepare('SELECT result FROM insight_cache WHERE key = ?').get(DAILY_PICK_KEY) as any;
    if (cached) {
        try { const parsed = JSON.parse(cached.result); if (parsed.date === today) return { text: parsed.text, provider: parsed.provider, date: today }; } catch { /* old format */ }
    }
    return { text: null, date: today };
});

fastify.post('/api/insights/daily-pick/refresh', async (request, reply) => {
    const rateLimitErr = checkLlmRateLimit(request.ip);
    if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
    getDb().prepare('DELETE FROM insight_cache WHERE key=?').run(DAILY_PICK_KEY);
    generateDailyPick().catch(e => fastify.log.error(`[daily-pick] refresh error: ${e.message}`));
    return { ok: true };
});

// ---- Routing / Win Rates ----
fastify.get('/api/routing/win-rates', async (request) => {
    const { task_type, language } = request.query as any;
    return { win_rates: computeToolModelWinRates({ taskType: task_type, language }) };
});

fastify.get('/api/routing/recommend', async (request) => {
    return getRoutingRecommendation((request.query as any).task || '');
});

// ---- Cross-tool intelligence ----
fastify.get('/api/cross-tool', async () => {
    detectToolSwitches();
    return { switches: getCrossToolStats() };
});

// ---- Project routes ----
fastify.get('/api/projects/:projectName/insights', async (request) => {
    const { projectName } = request.params as any;
    const data = computeProjectInsights(projectName);
    if (!data) return { error: 'No sessions found for this project.' };
    return data;
});

fastify.get('/api/projects/:projectName/topics', async (request) => {
    const { projectName } = request.params as any;
    const breakdown = getTopicBreakdown(projectName);
    const result: Record<string, any> = {};
    for (const [topic, group] of Object.entries(breakdown)) {
        const summaryData = group.sessions.length >= 3 ? await getTopicSummary(projectName, topic) : { summary: null };
        result[topic] = {
            session_count: group.sessions.length, total_tokens: group.total_tokens,
            low_relevance_count: group.low_relevance_count, summary: summaryData.summary,
            sessions: group.sessions.slice(0, 10).map((s: any) => ({
                id: s.id, tool: s.tool_id, model: s.primary_model, turns: s.total_turns,
                quality: Math.round(s.quality_score || 0), relevance: Math.round((s.project_relevance_score || 0.5) * 100),
                date: new Date(s.started_at).toISOString().slice(0, 10),
            })),
        };
    }
    return { project: projectName, topics: result };
});

// ---- Prompt coach routes ----
fastify.get('/api/prompt-coach/templates', async (request) => {
    const minQuality = parseInt((request.query as any).min_quality || '70');
    return { templates: extractPromptTemplates({ minQuality }) };
});

fastify.get('/api/prompt-coach/optimal', async (request) => {
    return getOptimalPromptStructure((request.query as any).task_type || 'general');
});

fastify.get('/api/prompt-coach/improve', async (request) => {
    return suggestImprovements((request.query as any).task_type || 'general');
});

// ---- Session classification ----
fastify.get('/api/sessions/:id/classify', async (request) => {
    const { id } = request.params as any;
    const session = getDb().prepare('SELECT id, title, tldr, raw_data, top_tools FROM sessions WHERE id = ?').get(id) as any;
    if (!session) return { error: 'Session not found' };
    const topic = detectTopic(session);
    const relevance = scoreProjectRelevance(session, (request.query as any).project || '');
    return { id: session.id, topic, project_relevance_score: relevance };
});

// ---- Session upload (alias for import) ----
fastify.post('/api/sessions/upload', async (request, reply) => {
    try {
        const body = request.body as any;
        const data = Array.isArray(body) ? body : [body];
        const results = data.map((d: any) => importSessionData(d));
        invalidateCache();
        broadcast('refresh');
        return { ok: true, imported: results };
    } catch (e: any) {
        reply.status(400);
        return { error: e.message };
    }
});

// ---- Cursor daily stats ----
fastify.get('/api/cursor-daily', async () => {
    const adapter = registry.getAdapter('cursor') as any;
    if (!adapter?.getDailyStats) return [];
    try { return await adapter.getDailyStats(); } catch { return []; }
});

// ---- Bookmarklet ----
fastify.get('/api/bookmarklet', async (request, reply) => {
    try {
        const code = getBookmarkletCode();
        reply.type('text/html').send(`
            <!DOCTYPE html>
            <html><head><title>AI Dashboard Bookmarklet</title></head>
            <body style="font-family:system-ui;max-width:600px;margin:2em auto;padding:1em">
              <h1>Session Capture Bookmarklet</h1>
              <p>Drag this link to your bookmarks bar:</p>
              <p><a href="${code}" style="padding:8px 16px;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:bold">
                Capture AI Session
              </a></p>
              <h2>Supported platforms</h2>
              <ul><li>ChatGPT</li><li>Claude.ai</li><li>Google Gemini</li></ul>
            </body></html>
        `);
    } catch (e: any) {
        const safe = String(e.message).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        reply.type('text/html').send(`<p>Bookmarklet not available: ${safe}</p>`);
    }
});

// ---- Ingest (legacy alias) ----
fastify.post('/api/ingest', async () => {
    const total = await ingestAll();
    return { ok: true, sessions: total, timestamp: Date.now() };
});

// ---- Shared session import helper ----
function importSessionData(data: any) {
    if (!data || typeof data !== 'object') throw new Error('Invalid request body');
    if (!Array.isArray(data.turns) || data.turns.length === 0) throw new Error('turns must be a non-empty array');
    if (data.turns.length > 2000) throw new Error('Too many turns (max 2000)');
    // Validate and truncate individual turns
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

    // Insert turns
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

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
fastify.post('/api/webhook/session', async (request, reply) => {
    // Rate limit webhooks
    const rateLimitErr = checkLlmRateLimit(`webhook:${request.ip}`, 5000);
    if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
    // Validate webhook secret if configured
    if (WEBHOOK_SECRET) {
        const provided = (request.headers as any)['x-webhook-secret'] || '';
        if (provided !== WEBHOOK_SECRET) { reply.status(401); return { error: 'Invalid webhook secret' }; }
    }
    try {
        const body = request.body as any;
        if (!body || typeof body !== 'object') { reply.status(400); return { error: 'Invalid request body' }; }
        const db = getDb();
        const id = `webhook-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        db.prepare(`
            INSERT INTO sessions (id, tool_id, title, started_at, total_turns, total_input_tokens, total_output_tokens, primary_model)
            VALUES (?,?,?,?,?,?,?,?)
        `).run(id, sanitizeString(body.tool, 64) || 'manual-import', sanitizeString(body.title, 200) || 'Webhook Session',
               Date.now(), clampInt(body.turns?.length, 0, 2000, 0), 0, 0, sanitizeString(body.model, 64) || 'unknown');
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
    // Only allow CORS on import/webhook endpoints (bookmarklet sends from other origins)
    if (request.url.startsWith('/api/sessions/import') || request.url.startsWith('/api/webhook/')) {
        reply.header('Access-Control-Allow-Origin', request.headers.origin || 'http://localhost:3030');
        reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
        if (request.method === 'OPTIONS') {
            reply.status(204).send();
            return;
        }
    }
    done();
});

// ---- Static file serving (built client) ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIST = join(__dirname, '..', '..', 'client', 'dist');

if (existsSync(CLIENT_DIST)) {
    fastify.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/' });
    // SPA fallback: serve index.html for non-API routes
    fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) {
            reply.status(404).send({ error: 'Not found' });
        } else {
            reply.sendFile('index.html');
        }
    });
} else {
    fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) {
            reply.status(404).send({ error: 'Not found' });
        } else {
            reply.status(200).send('OCD Dashboard API is running. Build the client with: pnpm --filter @ocd/client run build');
        }
    });
}

// ---- Start ----
const BIND_RAW = process.env.BIND || '127.0.0.1';
const BIND = /^(\d{1,3}\.){3}\d{1,3}$/.test(BIND_RAW) || BIND_RAW === 'localhost' || BIND_RAW === '::' ? BIND_RAW : '127.0.0.1';

const start = async () => {
    try {
        fastify.log.info('Initializing better-sqlite3 database...');
        initDb();
        fastify.log.info('Database initialized and migrated successfully.');

        printConfig();

        if (BIND !== '127.0.0.1' && BIND !== 'localhost') {
            fastify.log.warn(`Server binding to ${BIND} (network accessible). Set AUTH_TOKEN env var to protect access.`);
        }

        // Initial ingestion
        fastify.log.info('Starting initial data ingestion...');
        const total = await ingestAll();
        fastify.log.info(`Ingested ${total} total sessions from ${registry.getAdapters().length} adapters.`);

        await fastify.listen({ port: config.port, host: BIND });
        fastify.log.info(`\n  AI Productivity Dashboard v5.0\n  Open: http://localhost:${config.port}\n`);

        // Start file watchers for real-time data updates
        startWatchers(
            () => {
                const a = registry.getAdapter('claude-code');
                if (a) { fastify.log.info('[watcher] Claude data changed'); ingestAdapter(a).then(() => broadcast()); }
            },
            () => {
                const a = registry.getAdapter('cursor');
                if (a) { fastify.log.info('[watcher] Cursor data changed'); ingestAdapter(a).then(() => broadcast()); }
            },
            () => {
                const a = registry.getAdapter('antigravity');
                if (a) { fastify.log.info('[watcher] Antigravity data changed'); ingestAdapter(a).then(() => broadcast()); }
            },
        );

        // Generate daily pick on startup
        setTimeout(() => generateDailyPick().catch(e => fastify.log.error(`[daily-pick] startup error: ${e.message}`)), 5000);

        // Score unscored sessions for agentic leaderboard
        setTimeout(() => scoreAllSessions(), 5000);

        // Build knowledge graph
        setTimeout(() => {
            try { buildGraph(); fastify.log.info('[knowledge-graph] Built'); }
            catch (e: any) { fastify.log.warn(`[knowledge-graph] Skipped: ${e.message}`); }
        }, 10000);

        // Classify session topics on startup
        setTimeout(() => classifyAllSessionTopics(), 8000);

        // Schedule daily pick at midnight
        const scheduleNextMidnight = () => {
            const now = new Date();
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
            const msUntilMidnight = tomorrow.getTime() - now.getTime();
            setTimeout(() => {
                generateDailyPick().catch(e => fastify.log.error(`[daily-pick] midnight error: ${e.message}`));
                scheduleNextMidnight();
            }, msUntilMidnight);
            fastify.log.info(`[daily-pick] Next run scheduled in ${Math.round(msUntilMidnight / 60000)}m`);
        };
        scheduleNextMidnight();

    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    stopWatchers();
    process.exit(0);
});

start();
