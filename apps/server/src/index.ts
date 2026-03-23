import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { timingSafeEqual } from 'crypto';
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
import { computeOverview, computeToolComparison, computeModelUsage, computeCodeGeneration, computeInsights, computeCostAnalysis, computePersonalInsights, rebuildDailyStats } from './engine/analytics.js';
import { scanAndScoreGitCommits } from './engine/git-scanner.js';
import { scoreAndSave } from './engine/scorer.js';
import { scoreAllSessions } from './engine/agentic-scorer.js';
import { detectProvider, buildDailyPickPrompt, callAzure } from './engine/llm-analyzer.js';
import { classifyAndSave } from './engine/cross-tool-router.js';
import { classifyAllSessionTopics } from './engine/topic-segmenter.js';
import { analyzePromptMetrics } from './engine/prompt-analyzer.js';
import { runOptimizer } from './engine/optimizer.js';
import { startWatchers, stopWatchers } from './engine/watcher.js';
import { buildGraph } from './lib/knowledge-graph.js';
import { embedSession } from './lib/vector-store.js';
import { checkActiveSession } from './engine/session-coach.js';
import { startIdeInterceptor } from './engine/ide-interceptor.js';
import { startAntiPatternAnalysis, stopAntiPatternAnalysis } from './engine/anti-pattern-graph.js';
import { startP2pSync, stopP2pSync } from './engine/p2p-sync.js';
import { computeProfile, computeTrends, computePromptMetrics } from './engine/insights.js';
import type { IAiAdapter, UnifiedSession } from './adapters/types.js';
import type { CacheStore, LlmRateLimiter } from './routes/types.js';
import { validateEnv } from './env.js';

// Route modules
import analyticsRoutes from './routes/analytics.js';
import sessionRoutes from './routes/sessions.js';
import intelligenceRoutes from './routes/intelligence.js';

// ---- Pino structured logging ----
const loggerConfig = process.env.NODE_ENV === 'production'
    ? {
        level: process.env.LOG_LEVEL || 'info',
        serializers: {
            req(request: any) {
                return { method: request.method, url: request.url, hostname: request.hostname };
            },
            res(reply: any) {
                return { statusCode: reply.statusCode };
            },
        },
    }
    : {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
    };

const fastify = Fastify({ logger: loggerConfig, requestIdLogLabel: 'reqId', genReqId: () => crypto.randomUUID().slice(0, 8) });

// ---- Global rate limiting ----
await fastify.register(fastifyRateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
    keyGenerator: (request) => request.ip,
});

// ---- Swagger API docs ----
await fastify.register(fastifySwagger, {
    openapi: {
        info: {
            title: 'OCD — Omni Coder Dashboard API',
            description: 'AI memory engine with real semantic embeddings (ONNX), 18 MCP tools, cross-tool routing, proactive IDE interception, and a Memory dashboard. Learns from your coding sessions across 7 tools. 100% local, zero API keys required.',
            version: '5.4.0',
            license: { name: 'AGPL-3.0-or-later', url: 'https://www.gnu.org/licenses/agpl-3.0.en.html' },
        },
        servers: [{ url: `http://localhost:${config.port}`, description: 'Local development' }],
        tags: [
            { name: 'health', description: 'Health & version checks' },
            { name: 'analytics', description: 'Cross-tool analytics, KPIs, cost analysis' },
            { name: 'sessions', description: 'Session CRUD, import, upload' },
            { name: 'intelligence', description: 'Routing, prompt coaching, topic analysis' },
            { name: 'ide', description: 'Proactive IDE interception' },
            { name: 'arbitrage', description: 'Token arbitrage & cost routing' },
            { name: 'p2p', description: 'P2P secure team memory sync' },
        ],
    },
});

await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
});

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
        const tokenBuf = Buffer.from(token);
        const secretBuf = Buffer.from(AUTH_TOKEN);
        if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
            reply.status(401).send({ error: 'Unauthorized — set Authorization: Bearer <AUTH_TOKEN>' });
            return;
        }
        done();
    });
}

// ---- LLM rate limiter ----
const llmCallTimestamps = new Map<string, number>();
const llmRateLimit: LlmRateLimiter = {
    check(ip: string, windowMs = 60_000): string | null {
        const now = Date.now();
        const last = llmCallTimestamps.get(ip) || 0;
        if (now - last < windowMs) {
            const retryIn = Math.ceil((windowMs - (now - last)) / 1000);
            return `Rate limited — wait ${retryIn}s before retrying.`;
        }
        llmCallTimestamps.set(ip, now);
        return null;
    },
};

const HISTORY_DAYS = process.env.HISTORY_DAYS ? parseInt(process.env.HISTORY_DAYS) : 0;

// ---- In-memory result cache ----
const RC: Record<string, any> = {};
const cache: CacheStore = {
    get<T>(key: string, fn: () => T): T {
        if (RC[key] !== undefined) return RC[key];
        RC[key] = fn();
        return RC[key];
    },
    invalidate() { for (const key of Object.keys(RC)) delete RC[key]; },
};

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

function broadcast(event = 'refresh', extra?: Record<string, unknown>) {
    const data = JSON.stringify({ event, ts: Date.now(), ...extra });
    for (const client of sseClients) {
        try { client.write(`event: ${event}\ndata: ${data}\n\n`); } catch { sseClients.delete(client); }
    }
}

// ---- Periodic session coach ----
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

    for (const s of sessions) {
        try { scoreAndSave(s as any); } catch { /* skip */ }
        try { classifyAndSave(s as any); } catch { /* skip */ }
    }

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

    if (adapter.getTurns) {
        const insertTurn = db.prepare(`
            INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens, cache_read, cache_create, latency_ms, tok_per_sec, tools_used, stop_reason, label, type)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        for (const s of sessions) {
            try {
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
                try { analyzePromptMetrics(s.id); } catch { /* skip */ }
            } catch { /* skip this session's turns */ }
        }
    }

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
    cache.invalidate();
    scoreAllSessions();
    rebuildDailyStats();
    rebuildProjectIndex();
    try { runOptimizer(); } catch { /* skip */ }
    try {
        const gitResult = scanAndScoreGitCommits();
        fastify.log.info(`[git-scanner] Scanned ${gitResult.repos} repos, scored ${gitResult.commits} new commits`);
    } catch (e: any) {
        fastify.log.error(`[git-scanner] Failed: ${e.message}`);
    }
    broadcast('refresh');

    // Embed high-quality sessions (async, non-blocking)
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
            cache.get('overview', computeOverview);
            cache.get('compare', computeToolComparison);
            cache.get('models', computeModelUsage);
            cache.get('codegen', computeCodeGeneration);
            cache.get('insights', computeInsights);
            cache.get('costs', computeCostAnalysis);
            cache.get('personal', computePersonalInsights);
            cache.get('ins:profile', computeProfile);
            cache.get('ins:trends:0', () => computeTrends(0));
            cache.get('ins:prompt-metrics', computePromptMetrics);
            fastify.log.info('[cache] Pre-warmed');
        } catch { /* skip */ }
    });

    return total;
}

function rebuildProjectIndex() {
    const db = getDb();
    const sessions = db.prepare(`SELECT id, tool_id, title, primary_model, started_at, total_output_tokens, code_lines_added, raw_data FROM sessions`).all() as any[];
    const projects: Record<string, { sessions: number; tokens: number; lines: number; tools: Set<string>; models: Set<string>; last: number }> = {};

    for (const s of sessions) {
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

// ---- Daily pick generator ----
async function generateDailyPick() {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const DAILY_PICK_KEY = 'daily-pick';
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

// ---- Health route ----
fastify.get('/api/health', async () => {
    return { status: 'ok', version: '5.4.0', uptime: Math.round(process.uptime()) };
});

// ---- MCP config status route ----
fastify.get('/api/mcp-status', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const HOME = os.default.homedir();
    const SERVER_NAME = 'ai-brain';

    const configs = [
        { tool: 'Claude Code', paths: [path.join(HOME, '.claude', '.mcp.json'), path.join(HOME, '.claude', 'mcp.json')] },
        { tool: 'Cursor', paths: [path.join(HOME, '.cursor', 'mcp.json')] },
        { tool: 'Windsurf', paths: [path.join(HOME, '.windsurf', 'mcp.json'), path.join(HOME, '.codeium', 'windsurf', 'mcp.json')] },
    ];

    const results = configs.map(({ tool, paths: candidates }) => {
        for (const p of candidates) {
            try {
                const raw = fs.readFileSync(p, 'utf-8');
                const json = JSON.parse(raw);
                if (json?.mcpServers?.[SERVER_NAME]) {
                    return { tool, configured: true };
                }
            } catch (err) { fastify.log.debug(`MCP config check skipped for ${p}: ${err instanceof Error ? err.message : err}`); }
        }
        return { tool, configured: false };
    });

    return {
        tools: results,
        any_configured: results.some(r => r.configured),
        setup_command: 'npx omni-coder-dashboard --setup-mcp',
    };
});

// ---- Ingest / Refresh routes ----
fastify.post('/api/ingest', async () => {
    const total = await ingestAll();
    return { ok: true, sessions: total, timestamp: Date.now() };
});

fastify.post('/api/refresh', async () => {
    const total = await ingestAll();
    return { ok: true, sessions: total };
});

// ---- Register route modules ----
await fastify.register(analyticsRoutes, { cache, historyDays: HISTORY_DAYS });
await fastify.register(sessionRoutes, { cache, llmRateLimit, broadcast });
await fastify.register(intelligenceRoutes, { cache, llmRateLimit, broadcast, generateDailyPick });

// ---- CORS for import endpoints ----
fastify.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/api/sessions/import') || request.url.startsWith('/api/webhook/')) {
        const ALLOWED_ORIGINS = new Set([
            'http://localhost:3030',
            'https://chatgpt.com',
            'https://claude.ai',
            'https://gemini.google.com',
            'https://copilot.microsoft.com',
        ]);
        const reqOrigin = request.headers.origin || '';
        const allowedOrigin = ALLOWED_ORIGINS.has(reqOrigin) ? reqOrigin : 'http://localhost:3030';
        reply.header('Access-Control-Allow-Origin', allowedOrigin);
        reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
        if (request.method === 'OPTIONS') {
            reply.status(204).send();
            return;
        }
    }
    done();
});

// ---- Static file serving ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIST = join(__dirname, '..', '..', 'client', 'dist');

if (existsSync(CLIENT_DIST)) {
    fastify.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/' });
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
        validateEnv(fastify.log);

        fastify.log.info('Initializing better-sqlite3 database...');
        initDb();
        fastify.log.info('Database initialized and migrated successfully.');

        printConfig();

        if (BIND !== '127.0.0.1' && BIND !== 'localhost') {
            fastify.log.warn(`Server binding to ${BIND} (network accessible). Set AUTH_TOKEN env var to protect access.`);
        }

        await fastify.listen({ port: config.port, host: BIND });
        fastify.log.info(`\n  AI Productivity Dashboard v5.4.0\n  Open: http://localhost:${config.port}\n  API docs: http://localhost:${config.port}/docs\n`);

        fastify.log.info('Starting initial data ingestion...');
        const total = await ingestAll();
        fastify.log.info(`Ingested ${total} total sessions from ${registry.getAdapters().length} adapters.`);

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

        startIdeInterceptor((event, payload) => broadcast(event, payload));
        setTimeout(() => startAntiPatternAnalysis(), 15000);
        startP2pSync();
        setTimeout(() => generateDailyPick().catch(e => fastify.log.error(`[daily-pick] startup error: ${e.message}`)), 5000);
        setTimeout(() => scoreAllSessions(), 5000);
        setTimeout(() => {
            try { buildGraph(); fastify.log.info('[knowledge-graph] Built'); }
            catch (e: any) { fastify.log.warn(`[knowledge-graph] Skipped: ${e.message}`); }
        }, 10000);
        setTimeout(() => classifyAllSessionTopics(), 8000);

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

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    stopWatchers();
    stopAntiPatternAnalysis();
    stopP2pSync();
    process.exit(0);
});

start();
