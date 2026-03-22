// Intelligence routes — routing, cross-tool, prompt coach, topics, IDE, anti-patterns, arbitrage, P2P
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { computeToolModelWinRates, getRoutingRecommendation } from '../engine/cross-tool-router.js';
import { detectToolSwitches, getCrossToolStats } from '../engine/cross-tool.js';
import { getOptimalPromptStructure, suggestImprovements, extractPromptTemplates, computeEffectSizes, getAttributionReport } from '../engine/prompt-coach.js';
import { getTopicBreakdown, getTopicSummary } from '../engine/topic-segmenter.js';
import { computeAllProjects, computeProjectInsights } from '../engine/project-insights.js';
import { streamDeepAnalysis, getInsightDebugPayload, detectProvider, buildDailyPickPrompt, callAzure } from '../engine/llm-analyzer.js';
import { submitTrace } from '../engine/ide-interceptor.js';
import { getNegativeConstraints } from '../engine/anti-pattern-graph.js';
import { makeArbitrageDecision, logArbitrageDecision, proxyCompletion, getArbitrageSummary } from '../engine/token-arbiter.js';
import {
    getKnownPeers, getShareableEmbeddings, syncWithAllPeers,
    validatePeerRequest, getNodeId_, getP2pSecurityStatus,
} from '../engine/p2p-sync.js';
import { discoverRepos } from '../engine/git-scanner.js';
import { AntigravityAdapter } from '../adapters/antigravity.js';
import { registry } from '../adapters/registry.js';
import { getBookmarkletCode } from '../lib/bookmarklet.js';
import { getEmbeddingStatus, findSimilar } from '../lib/vector-store.js';
import type { CacheStore, LlmRateLimiter } from './types.js';

function clampInt(val: any, min: number, max: number, fallback: number): number {
    const n = parseInt(val);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function sanitizeString(val: any, maxLen = 200): string {
    return typeof val === 'string' ? val.replace(/[\x00-\x1f]/g, '').slice(0, maxLen) : '';
}

export default async function intelligenceRoutes(fastify: FastifyInstance, opts: {
    cache: CacheStore;
    llmRateLimit: LlmRateLimiter;
    broadcast: (event?: string, extra?: Record<string, unknown>) => void;
    generateDailyPick: () => Promise<void>;
}) {
    const { cache, llmRateLimit, broadcast, generateDailyPick } = opts;

    // Deep analysis (SSE)
    fastify.get('/api/insights/deep', async (request, reply) => {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        await streamDeepAnalysis(reply.raw);
    });

    fastify.get('/api/insights/debug', async () => getInsightDebugPayload());

    fastify.get('/api/ollama/status', async () => {
        try { return await detectProvider(); }
        catch (e: any) { return { available: false, error: e.message }; }
    });

    // Embedding / vector memory status
    fastify.get('/api/embedding/status', async () => {
        const db = getDb();
        const status = await getEmbeddingStatus();
        const totalSessions = (db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any).cnt;
        const embeddedSessions = (db.prepare('SELECT COUNT(*) as cnt FROM session_embeddings').get() as any).cnt;
        const providers = db.prepare('SELECT provider, COUNT(*) as cnt FROM session_embeddings GROUP BY provider').all() as any[];
        return {
            ...status,
            totalSessions,
            embeddedSessions,
            coveragePct: totalSessions > 0 ? Math.round((embeddedSessions / totalSessions) * 100) : 0,
            providerBreakdown: providers,
        };
    });

    // Live similarity search
    fastify.get('/api/embedding/search', async (request) => {
        const query = sanitizeString((request.query as any).q, 500);
        if (!query) return { results: [] };
        const results = await findSimilar(query, clampInt((request.query as any).limit, 1, 20, 5));
        return {
            results: results.map(r => ({
                session_id: r.session_id,
                similarity: r.similarity,
                matchType: r.matchType,
                title: r.session?.title || 'Unknown',
                tldr: r.session?.tldr || '',
                quality: r.session?.quality_score || null,
            })),
        };
    });

    fastify.get('/api/insights/deep-analyze', async (request, reply) => {
        const rateLimitErr = llmRateLimit.check(request.ip);
        if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        if ((request.query as any).refresh === '1') {
            getDb().prepare("DELETE FROM insight_cache WHERE key='deep-analyze-default'").run();
        }
        await streamDeepAnalysis(reply.raw);
    });

    // Daily pick
    const DAILY_PICK_KEY = 'daily-pick';

    fastify.get('/api/insights/daily-pick', async () => {
        const today = new Date().toISOString().split('T')[0];
        const cached = getDb().prepare('SELECT result FROM insight_cache WHERE key = ?').get(DAILY_PICK_KEY) as any;
        if (cached) {
            try { const parsed = JSON.parse(cached.result); if (parsed.date === today) return { text: parsed.text, provider: parsed.provider, date: today }; } catch { /* old format */ }
        }
        return { text: null, date: today };
    });

    fastify.post('/api/insights/daily-pick/refresh', async (request, reply) => {
        const rateLimitErr = llmRateLimit.check(request.ip);
        if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
        getDb().prepare('DELETE FROM insight_cache WHERE key=?').run(DAILY_PICK_KEY);
        generateDailyPick().catch(e => fastify.log.error(`[daily-pick] refresh error: ${e.message}`));
        return { ok: true };
    });

    // Routing / Win Rates
    fastify.get('/api/routing/win-rates', async (request) => {
        const { task_type, language } = request.query as any;
        return { win_rates: computeToolModelWinRates({ taskType: task_type, language }) };
    });

    fastify.get('/api/routing/recommend', async (request) => {
        return getRoutingRecommendation((request.query as any).task || '');
    });

    // Cross-tool
    fastify.get('/api/cross-tool', async () => {
        detectToolSwitches();
        return { switches: getCrossToolStats() };
    });

    // Projects
    fastify.get('/api/projects', async () => {
        return getDb().prepare('SELECT * FROM project_index ORDER BY last_active DESC').all();
    });

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

    // Topics
    fastify.get('/api/topics/summary', async () => {
        return getDb().prepare(`
            SELECT topic, COUNT(*) as session_count, AVG(project_relevance_score) as avg_relevance
            FROM sessions WHERE topic IS NOT NULL GROUP BY topic ORDER BY session_count DESC
        `).all();
    });

    // Prompt coach
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

    // Prompt science: effect sizes
    fastify.get('/api/prompt-coach/effects', async () => {
        return { effects: computeEffectSizes() };
    });

    // Attribution report
    fastify.get('/api/attribution-report', async (request) => {
        const { project, branch, days } = request.query as any;
        return getAttributionReport({
            project: project ? sanitizeString(project, 200) : undefined,
            branch: branch ? sanitizeString(branch, 200) : undefined,
            days: days ? clampInt(days, 1, 365, 30) : undefined,
        });
    });

    // Recommendations
    fastify.get('/api/recommendations', async (request) => {
        const all = (request.query as any).all === 'true';
        const sql = all ? 'SELECT * FROM recommendations ORDER BY created_at DESC' : 'SELECT * FROM recommendations WHERE dismissed = 0 ORDER BY created_at DESC';
        return getDb().prepare(sql).all();
    });

    fastify.post('/api/recommendations/:id/dismiss', async (request) => {
        const { id } = request.params as any;
        getDb().prepare('UPDATE recommendations SET dismissed = 1 WHERE id = ?').run(id);
        return { ok: true };
    });

    // Cursor deep + daily stats
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

    fastify.get('/api/cursor-daily', async () => {
        const adapter = registry.getAdapter('cursor') as any;
        if (!adapter?.getDailyStats) return [];
        try { return await adapter.getDailyStats(); } catch { return []; }
    });

    // Repos
    fastify.get('/api/repos', async () => {
        const db = getDb();
        const repos = discoverRepos();
        const commitCounts = db.prepare('SELECT commit_hash FROM commit_scores').all().length;
        return {
            discovered: repos.map(r => ({ name: r.name, path: r.path })),
            total_commits_scored: commitCounts,
        };
    });

    // Antigravity
    fastify.get('/api/antigravity-stats', async () => {
        const adapter = registry.getAdapter('antigravity');
        if (!adapter || !('getStats' in adapter)) return {};
        return (adapter as AntigravityAdapter).getStats();
    });

    // Bookmarklet
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

    // IDE interception
    fastify.post('/api/ide/submit-trace', async (request, reply) => {
        const rateLimitErr = llmRateLimit.check(`ide:${request.ip}`, 5000);
        if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
        const { trace } = request.body as { trace: string };
        if (!trace || typeof trace !== 'string') { reply.status(400); return { error: 'trace (string) is required' }; }
        return await submitTrace(trace.slice(0, 8192));
    });

    fastify.get('/api/ide/interceptions', async (request) => {
        const limit = clampInt((request.query as any).limit, 1, 200, 50);
        return getDb().prepare(`
            SELECT i.*, s.title, s.tldr FROM ide_interceptions i
            LEFT JOIN sessions s ON s.id = i.matched_session_id
            ORDER BY i.detected_at DESC LIMIT ?
        `).all(limit);
    });

    // Anti-patterns
    fastify.get('/api/anti-patterns', async (request) => {
        const { task, limit } = request.query as any;
        if (task) {
            return { constraints: getNegativeConstraints(sanitizeString(task), clampInt(limit, 1, 20, 5)) };
        }
        return getDb().prepare('SELECT * FROM anti_patterns ORDER BY failure_count DESC LIMIT 100').all();
    });

    // Token arbitrage
    fastify.post('/api/arbitrage/recommend', async (request, reply) => {
        const { prompt, requested_model } = request.body as any;
        if (!prompt || typeof prompt !== 'string') { reply.status(400); return { error: 'prompt (string) is required' }; }
        const decision = makeArbitrageDecision(prompt.slice(0, 8192), sanitizeString(requested_model, 80) || 'claude-sonnet-4-6');
        logArbitrageDecision(decision);
        return decision;
    });

    fastify.post('/api/arbitrage/proxy', async (request, reply) => {
        const rateLimitErr = llmRateLimit.check(`arb:${request.ip}`, 2000);
        if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
        const body = request.body as any;
        if (!body?.messages || !Array.isArray(body.messages)) { reply.status(400); return { error: 'messages array is required' }; }
        try {
            return await proxyCompletion(body);
        } catch (e: any) {
            reply.status(502);
            return { error: `Proxy error: ${e.message}` };
        }
    });

    fastify.get('/api/arbitrage/summary', async () => getArbitrageSummary());

    // P2P
    fastify.get('/api/p2p/peers', async () => ({
        node_id: getNodeId_(),
        peers: getKnownPeers(),
        security: getP2pSecurityStatus(),
    }));

    fastify.post('/api/p2p/embeddings', async (request, reply) => {
        const rawBody = JSON.stringify(request.body);
        const sig = (request.headers as any)['x-ocd-sig'] || '';
        if (!validatePeerRequest(rawBody, sig)) {
            reply.status(401);
            return { error: 'Invalid peer signature — ensure P2P_SECRET matches across all nodes.' };
        }
        return { node_id: getNodeId_(), items: getShareableEmbeddings() };
    });

    fastify.post('/api/p2p/sync', async () => {
        const nodeId = getNodeId_();
        if (!nodeId) return { error: 'P2P not enabled — set P2P_SECRET to activate.' };
        const results = await syncWithAllPeers(nodeId);
        return { synced: results, peers_contacted: results.length };
    });

    fastify.post('/api/p2p/hello', async (request) => {
        const { peer_id, host, port } = request.body as any;
        if (peer_id && host && port) {
            fastify.log.info(`[p2p] Hello from peer ${peer_id} at ${host}:${port}`);
            syncWithAllPeers(getNodeId_()).catch(() => { /* non-critical */ });
        }
        return { node_id: getNodeId_(), ok: true };
    });

    // Version check
    const CURRENT_VERSION = '5.2.1';
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

    // Webhook
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

    fastify.post('/api/webhook/session', async (request, reply) => {
        const rateLimitErr = llmRateLimit.check(`webhook:${request.ip}`, 5000);
        if (rateLimitErr) { reply.status(429); return { error: rateLimitErr }; }
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
            cache.invalidate();
            broadcast('refresh');
            return { ok: true, id };
        } catch (e: any) {
            reply.status(400);
            return { error: e.message };
        }
    });
}
