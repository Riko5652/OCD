import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDb, getDb, escapeLike } from './db/index.js';
import { VectorService, getEmbeddingStatus } from './lib/vector-store.js';
import { computeOverview, computeCostAnalysis, computePersonalInsights } from './engine/analytics.js';
import { normalizeModel, estimateCost as estimateModelCost } from './engine/model-normalizer.js';
import { getAgenticLeaderboard } from './engine/agentic-scorer.js';
import { getNegativeConstraints } from './engine/anti-pattern-graph.js';
import { makeArbitrageDecision, getArbitrageSummary } from './engine/token-arbiter.js';
import { getShareableEmbeddings, getKnownPeers } from './engine/p2p-sync.js';
import { submitTrace } from './engine/ide-interceptor.js';
import { computeEffectSizes, getAttributionReport } from './engine/prompt-coach.js';
import { computeTokenBudget } from './engine/token-budget.js';
import { getSessionHealthCheck, getDirective } from './engine/session-coach.js';
import { runTraceAudit, getAuditHistory } from './engine/trace-auditor.js';
import { getProductionErrors } from './engine/error-bridge.js';
import { listTemplates } from './engine/audit-templates.js';
import { getSessionGuardReport, recordToolCall } from './engine/session-guard.js';

initDb();

// Project-awareness: when OCD_PROJECT is set, tools filter results to that project.
// Set via .mcp.json env or CLI: OCD_PROJECT=pm-dashboard
const ACTIVE_PROJECT = process.env.OCD_PROJECT || null;

/** Build a SQL WHERE clause fragment that filters sessions to the active project (if set). */
function projectFilter(alias = ''): { clause: string; params: string[] } {
    if (!ACTIVE_PROJECT) return { clause: '', params: [] };
    const col = alias ? `${alias}.raw_data` : 'raw_data';
    return { clause: ` AND ${col} LIKE ? ESCAPE '\\'`, params: [`%"project":"${escapeLike(ACTIVE_PROJECT)}"%`] };
}

/** Check if billing_actuals table exists (CSV import) and query real costs from it. */
function hasBillingActuals(): boolean {
    try {
        const db = getDb();
        const row = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='billing_actuals'").get() as any;
        return row?.cnt > 0;
    } catch { return false; }
}

function getBillingCostsByModel(): { model: string; requests: number; input_tokens: number; cache_tokens: number; output_tokens: number; total_tokens: number; cost: number }[] {
    if (!hasBillingActuals()) return [];
    const db = getDb();
    return db.prepare(`
        SELECT model_normalized as model, COUNT(*) as requests,
            SUM(input_tokens_no_cache) as input_tokens, SUM(cache_read_tokens) as cache_tokens,
            SUM(output_tokens) as output_tokens, SUM(total_tokens) as total_tokens,
            ROUND(SUM(cost_usd), 2) as cost
        FROM billing_actuals GROUP BY model_normalized ORDER BY cost DESC
    `).all() as any[];
}

function getBillingCostsDaily(days = 7): { date: string; cost: number; requests: number; models: Record<string, number> }[] {
    if (!hasBillingActuals()) return [];
    const db = getDb();
    const rows = db.prepare(`
        SELECT date, model_normalized as model, ROUND(SUM(cost_usd), 2) as cost, COUNT(*) as requests
        FROM billing_actuals
        WHERE date >= date('now', '-' || ? || ' days')
        GROUP BY date, model_normalized ORDER BY date
    `).all(days) as any[];

    const daily: Record<string, { date: string; cost: number; requests: number; models: Record<string, number> }> = {};
    for (const r of rows) {
        if (!daily[r.date]) daily[r.date] = { date: r.date, cost: 0, requests: 0, models: {} };
        daily[r.date].cost += r.cost;
        daily[r.date].requests += r.requests;
        daily[r.date].models[r.model] = (daily[r.date].models[r.model] || 0) + r.cost;
    }
    return Object.values(daily);
}

const server = new McpServer({
    name: 'AI Productivity Engine',
    version: '5.4.0',
});

const vectorService = new VectorService();

// ---- Tool 1: get_similar_solutions ----
server.tool(
    'get_similar_solutions',
    'Search the semantic memory bank for successful code implementations from past coding sessions. Uses real vector similarity (ONNX/Ollama/OpenAI) — results labeled as semantic or keyword match.',
    {
        query: z.string().describe('The coding problem, error message, or feature to search for.'),
        limit: z.number().optional().describe('Max results (default: 3)'),
    },
    async ({ query, limit = 3 }) => {
        try {
            const results = await vectorService.searchSimilarSessions(query, limit);
            if (!results.length) {
                return { content: [{ type: 'text' as const, text: 'No relevant past solutions found in memory.' }] };
            }
            const db = getDb();
            const matchType = results[0]?.matchType || 'keyword';
            let response = `Relevant solutions from past sessions (${matchType} match):\n\n`;
            for (const res of results) {
                const row = db.prepare('SELECT title, tldr, code_lines_added, quality_score, primary_model, tool_id FROM sessions WHERE id = ?').get(res.session_id) as any;
                if (row) {
                    response += `--- ${row.title || 'Unknown'} (${(res.similarity * 100).toFixed(1)}% ${matchType} match) ---\n`;
                    response += `Tool: ${row.tool_id} | Model: ${row.primary_model} | Quality: ${row.quality_score || 'N/A'}\n`;
                    response += `TLDR: ${row.tldr || 'No summary'} | Lines: +${row.code_lines_added}\n\n`;
                }
            }
            return { content: [{ type: 'text' as const, text: response }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: 'Error: ' + e.message }], isError: true };
        }
    }
);

// ---- Tool 2: get_knowledge_context ----
server.tool(
    'get_knowledge_context',
    'Fetch architecture patterns, code conventions, and deep context from the Knowledge Graph.',
    { topic: z.string().describe('Domain/component name (e.g., "auth", "database", "ui")') },
    async ({ topic }) => {
        const db = getDb();
        const escaped = escapeLike(topic);
        const clusters = db.prepare(`
            SELECT topic, summary, total_sessions, total_tokens
            FROM topic_clusters WHERE topic LIKE ? ESCAPE '\\' ORDER BY total_sessions DESC LIMIT 5
        `).all(`%${escaped}%`) as any[];

        const sessions = db.prepare(`
            SELECT id, title, tool_id, primary_model, quality_score, code_lines_added
            FROM sessions WHERE topic LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
            ORDER BY quality_score DESC LIMIT 10
        `).all(`%${escaped}%`, `%${escaped}%`) as any[];

        if (!clusters.length && !sessions.length) {
            return { content: [{ type: 'text' as const, text: `No knowledge context found for "${topic}". Try a broader query.` }] };
        }

        let response = `Knowledge Context for "${topic}":\n\n`;
        if (clusters.length) {
            response += 'Topic Clusters:\n';
            for (const c of clusters) {
                response += `  • ${c.topic}: ${c.summary || 'No summary'} (${c.total_sessions} sessions, ${c.total_tokens} tokens)\n`;
            }
        }
        if (sessions.length) {
            response += '\nTop Sessions:\n';
            for (const s of sessions) {
                response += `  • [${s.tool_id}] ${s.title || s.id} — Q:${s.quality_score || '?'}, +${s.code_lines_added} lines, model: ${s.primary_model}\n`;
            }
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 3: get_last_session_context ----
server.tool(
    'get_last_session_context',
    'Get context from the most recent coding session for continuity.',
    {
        tool_id: z.string().optional().describe('Filter by tool (e.g., "cursor", "claude-code")'),
    },
    async ({ tool_id }) => {
        const db = getDb();
        let sql = 'SELECT * FROM sessions';
        const params: any[] = [];
        if (tool_id) { sql += ' WHERE tool_id = ?'; params.push(tool_id); }
        sql += ' ORDER BY started_at DESC LIMIT 1';
        const session = db.prepare(sql).get(...params) as any;
        if (!session) return { content: [{ type: 'text' as const, text: 'No recent sessions found.' }] };

        const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
        const topTools = (() => { try { return JSON.parse(session.top_tools || '[]'); } catch { return []; } })();

        let response = `Last Session Context:\n`;
        response += `  ID: ${session.id}\n  Tool: ${session.tool_id} | Model: ${session.primary_model}\n`;
        response += `  Title: ${session.title || 'Untitled'}\n`;
        response += `  Turns: ${session.total_turns} | Output: ${session.total_output_tokens} tokens\n`;
        response += `  Lines Added: ${session.code_lines_added} | Files: ${session.files_touched}\n`;
        response += `  Quality: ${session.quality_score || 'N/A'} | Agentic: ${session.agentic_score || 'N/A'}\n`;
        if (topTools.length) response += `  Top Tools: ${topTools.map(([t, c]: any) => `${t}(${c})`).join(', ')}\n`;
        if (raw.filesEdited?.length) response += `  Files Edited: ${raw.filesEdited.slice(0, 10).join(', ')}\n`;

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 4: get_routing_recommendation ----
server.tool(
    'get_routing_recommendation',
    'Get which AI tool + model is statistically best for your current task type. For single-tool users, provides model-level optimization and workflow tips instead of cross-tool routing.',
    { task_type: z.string().describe('e.g., "refactoring", "debugging", "scaffolding", "testing"') },
    async ({ task_type }) => {
        const db = getDb();

        // Detect if user is a single-tool user (most common case)
        const toolCounts = db.prepare(`
            SELECT tool_id, COUNT(*) as sessions FROM sessions
            WHERE started_at > ? GROUP BY tool_id ORDER BY sessions DESC
        `).all(Date.now() - 30 * 86400000) as any[];

        const isSingleTool = toolCounts.length === 1;
        const primaryTool = toolCounts[0]?.tool_id;

        const rows = db.prepare(`
            SELECT s.tool_id, s.primary_model, COUNT(*) as sessions,
                AVG(s.quality_score) as avg_quality, AVG(s.agentic_score) as avg_agentic,
                AVG(s.total_turns) as avg_turns,
                AVG(s.cache_hit_pct) as avg_cache,
                AVG(s.error_count) as avg_errors,
                AVG(CAST(s.total_input_tokens + s.total_output_tokens AS REAL) / NULLIF(s.quality_score, 0)) AS tokens_per_quality
            FROM sessions s
            JOIN task_classifications tc ON tc.session_id = s.id
            WHERE tc.task_type = ?
            GROUP BY s.tool_id, s.primary_model ORDER BY avg_quality DESC LIMIT 10
        `).all(task_type) as any[];

        if (!rows.length) {
            return { content: [{ type: 'text' as const, text: `No historical data for task type "${task_type}". Using default: claude-code with claude-sonnet-4-6.` }] };
        }

        let response: string;

        if (isSingleTool && primaryTool) {
            // Single-tool user: optimize model selection and workflow within their tool
            const toolRows = rows.filter((r: any) => r.tool_id === primaryTool);
            const best = toolRows[0] || rows[0];

            response = `Model Optimization for "${task_type}" (${primaryTool}):\n\n`;
            response += `Best Model: ${best.primary_model}\n`;
            response += `  Quality: ${(best.avg_quality || 0).toFixed(1)} | Avg Turns: ${(best.avg_turns || 0).toFixed(0)} | Cache: ${(best.avg_cache || 0).toFixed(0)}%\n`;
            response += `  Efficiency: ${Math.round(best.tokens_per_quality || 0)} tokens/quality point\n\n`;

            if (toolRows.length > 1) {
                response += 'Model Comparison (within your tool):\n';
                for (const r of toolRows) {
                    const label = r.primary_model === best.primary_model ? '  >> ' : '     ';
                    response += `${label}${r.primary_model}: Q=${(r.avg_quality || 0).toFixed(0)}, ${r.sessions} sessions, ${(r.avg_turns || 0).toFixed(0)} turns, ${Math.round(r.tokens_per_quality || 0)} tok/Q\n`;
                }
                response += '\n';
            }

            // Workflow patterns for single-tool users
            const patterns = db.prepare(`
                SELECT
                    CASE WHEN quality_score >= 70 THEN 'high' ELSE 'low' END AS tier,
                    AVG(total_turns) AS avg_turns, AVG(cache_hit_pct) AS avg_cache,
                    AVG(error_count) AS avg_errors, COUNT(*) AS sessions
                FROM sessions
                WHERE tool_id = ? AND quality_score IS NOT NULL AND started_at > ?
                GROUP BY tier
            `).all(primaryTool, Date.now() - 30 * 86400000) as any[];

            const high = patterns.find((p: any) => p.tier === 'high');
            const low = patterns.find((p: any) => p.tier === 'low');
            if (high && low) {
                response += 'Your Workflow Patterns:\n';
                response += `  High-quality sessions: ${Math.round(high.avg_turns)} turns, ${Math.round(high.avg_cache || 0)}% cache, ${(high.avg_errors || 0).toFixed(1)} errors (n=${high.sessions})\n`;
                response += `  Low-quality sessions:  ${Math.round(low.avg_turns)} turns, ${Math.round(low.avg_cache || 0)}% cache, ${(low.avg_errors || 0).toFixed(1)} errors (n=${low.sessions})\n\n`;
            }

            // Tool-specific tips
            response += 'Optimization Tips:\n';
            if (primaryTool === 'claude-code') {
                response += '  1. Use subagents for multi-file tasks to parallelize work\n';
                response += '  2. Stabilize CLAUDE.md to improve cache hit rates\n';
                response += '  3. Front-load context in first message for better first-attempt success\n';
            } else if (primaryTool === 'cursor') {
                response += '  1. Use Composer for multi-file edits, Tab for inline completions\n';
                response += '  2. Pin important files in context panel for relevance\n';
                response += '  3. Use @-mentions for specific file context\n';
            } else if (primaryTool === 'copilot') {
                response += '  1. Use @workspace for project-wide queries\n';
                response += '  2. Slash commands (/fix, /test, /doc) are faster than describing tasks\n';
                response += '  3. Open relevant files before chatting for better context\n';
            } else if (primaryTool === 'windsurf') {
                response += '  1. Use Cascade mode for complex multi-step tasks\n';
                response += '  2. Reference files with @ mentions for precise context\n';
                response += '  3. Keep sessions focused — break large tasks into sub-sessions\n';
            } else if (primaryTool === 'aider') {
                response += '  1. Use architect mode for planning, code mode for implementation\n';
                response += '  2. Add files explicitly with /add before editing\n';
                response += '  3. Keep chat focused on one feature per session\n';
            } else if (primaryTool === 'continue') {
                response += '  1. Use /edit for inline modifications with clear context\n';
                response += '  2. Configure model-per-task in config.json to save tokens\n';
                response += '  3. Provide context items with @ mentions for better accuracy\n';
            } else if (primaryTool === 'antigravity') {
                response += '  1. Use artifacts for iterative code development\n';
                response += '  2. Keep conversations focused on one artifact type\n';
                response += '  3. Review version history to reduce iteration depth\n';
            }
        } else {
            // Multi-tool user: original cross-tool routing
            const best = rows[0];
            response = `Routing Recommendation for "${task_type}":\n\n`;
            response += `Best: ${best.tool_id} / ${best.primary_model}\n`;
            response += `  Quality: ${(best.avg_quality || 0).toFixed(1)} | Agentic: ${(best.avg_agentic || 0).toFixed(0)} | Avg Turns: ${(best.avg_turns || 0).toFixed(0)}\n\n`;
            response += 'Alternatives:\n';
            for (const r of rows.slice(1)) {
                response += `  • ${r.tool_id}/${r.primary_model}: Q=${(r.avg_quality || 0).toFixed(0)}, ${r.sessions} sessions\n`;
            }
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 5: get_efficiency_snapshot ----
server.tool(
    'get_efficiency_snapshot',
    'Get a quick efficiency snapshot of your AI coding productivity.',
    {},
    async () => {
        const db = getDb();
        const pf = projectFilter();
        const scope = ACTIVE_PROJECT ? ` [project: ${ACTIVE_PROJECT}]` : '';

        const g = db.prepare(`
            SELECT COUNT(*) as total_sessions, SUM(total_turns) as total_turns,
                SUM(total_input_tokens) as total_input, SUM(total_output_tokens) as total_output,
                SUM(total_cache_read) as total_cache, AVG(cache_hit_pct) as avg_cache_hit,
                AVG(quality_score) as avg_quality, SUM(code_lines_added) as total_lines_added,
                SUM(files_touched) as total_files_touched
            FROM sessions WHERE 1=1${pf.clause}
        `).get(...pf.params) as any;

        const toolStats = db.prepare(`
            SELECT tool_id, COUNT(*) as sessions FROM sessions WHERE 1=1${pf.clause} GROUP BY tool_id
        `).all(...pf.params) as any[];

        // Cost analysis with project filter
        const byModel = db.prepare(`
            SELECT primary_model as model, SUM(total_input_tokens) as input_tokens,
                SUM(total_output_tokens) as output_tokens, SUM(total_cache_read) as cache_read,
                COUNT(*) as sessions
            FROM sessions WHERE primary_model IS NOT NULL${pf.clause}
            GROUP BY primary_model ORDER BY output_tokens DESC
        `).all(...pf.params) as any[];

        const grouped: Record<string, any> = {};
        for (const m of byModel) {
            const canonical = normalizeModel(m.model);
            if (!grouped[canonical]) grouped[canonical] = { model: canonical, input: 0, output: 0, cache: 0, sessions: 0 };
            grouped[canonical].input += m.input_tokens || 0;
            grouped[canonical].output += m.output_tokens || 0;
            grouped[canonical].cache += m.cache_read || 0;
            grouped[canonical].sessions += m.sessions;
        }
        const costs = Object.values(grouped).map((m: any) => {
            const c = estimateModelCost(m.model, m.input, m.output, m.cache);
            return { ...m, totalCost: c.totalCost, cacheSavings: c.cacheSavings };
        }).sort((a: any, b: any) => b.totalCost - a.totalCost);
        const totalCost = costs.reduce((s: number, c: any) => s + c.totalCost, 0);
        const totalSavings = costs.reduce((s: number, c: any) => s + c.cacheSavings, 0);

        let response = `Efficiency Snapshot${scope}:\n`;
        response += `  Sessions: ${g.total_sessions} | Turns: ${g.total_turns}\n`;
        response += `  Output Tokens: ${g.total_output} | Cache Hit: ${(g.avg_cache_hit || 0).toFixed(1)}%\n`;
        response += `  Lines Generated: ${g.total_lines_added} | Files Touched: ${g.total_files_touched}\n`;
        response += `  Avg Quality: ${(g.avg_quality || 0).toFixed(0)}\n`;

        // Prefer billing_actuals (real Cursor billing CSV) over session-based estimates
        const billingModels = getBillingCostsByModel();
        const useBilling = billingModels.length > 0;

        if (useBilling) {
            const billingTotal = billingModels.reduce((s, r) => s + r.cost, 0);
            response += `  Actual Cost (Cursor billing): $${billingTotal.toFixed(2)} — ${billingModels.reduce((s, r) => s + r.requests, 0)} requests\n`;
            response += `\nTools: ${toolStats.map((t: any) => `${t.tool_id}(${t.sessions})`).join(', ')}\n`;

            response += '\nTop Spenders (billing actuals):\n';
            for (const m of billingModels.slice(0, 7)) {
                const pct = billingTotal > 0 ? ((m.cost / billingTotal) * 100).toFixed(1) : '0';
                response += `  ${m.model}: $${m.cost.toFixed(2)} (${pct}%) — ${m.requests} requests, ${(m.total_tokens || 0).toLocaleString()} tokens\n`;
            }

            const billingDaily = getBillingCostsDaily(7);
            if (billingDaily.length > 0) {
                response += '\nDaily Spend (last 7 days, billing actuals):\n';
                for (const d of billingDaily) {
                    const topModel = Object.entries(d.models).sort((a, b) => b[1] - a[1])[0];
                    const topStr = topModel ? ` (top: ${topModel[0]} $${topModel[1].toFixed(2)})` : '';
                    response += `  ${d.date}: $${d.cost.toFixed(2)} (${d.requests} req)${topStr}\n`;
                }
            }
        } else {
            response += `  Estimated Cost: $${totalCost.toFixed(2)} | Cache Savings: $${totalSavings.toFixed(2)}\n`;
            response += `\nTools: ${toolStats.map((t: any) => `${t.tool_id}(${t.sessions})`).join(', ')}\n`;

            if (costs.length > 0) {
                response += '\nTop Spenders (estimated):\n';
                for (const m of costs.slice(0, 5)) {
                    const pct = totalCost > 0 ? ((m.totalCost / totalCost) * 100).toFixed(1) : '0';
                    response += `  ${m.model}: $${m.totalCost.toFixed(2)} (${pct}%) — ${m.sessions} sessions\n`;
                }
            }
        }

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 6: get_active_recommendations ----
server.tool(
    'get_active_recommendations',
    'Get active AI coaching recommendations to improve productivity.',
    {},
    async () => {
        const db = getDb();
        const recs = db.prepare('SELECT * FROM recommendations WHERE dismissed = 0 ORDER BY created_at DESC LIMIT 10').all() as any[];
        if (!recs.length) return { content: [{ type: 'text' as const, text: 'No active recommendations. Your workflow looks optimal!' }] };

        let response = 'Active Recommendations:\n\n';
        for (const r of recs) {
            response += `[${r.severity?.toUpperCase()}] ${r.title}\n  ${r.description}\n  Tool: ${r.tool_id} | Category: ${r.category}\n\n`;
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 7: get_project_stats ----
server.tool(
    'get_project_stats',
    'Get AI development statistics for a specific project.',
    { project: z.string().describe('Project name to look up') },
    async ({ project }) => {
        const db = getDb();
        const p = db.prepare("SELECT * FROM project_index WHERE name LIKE ? ESCAPE '\\'").get(`%${escapeLike(project)}%`) as any;
        if (!p) return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };

        let response = `Project: ${p.name}\n`;
        response += `  Sessions: ${p.session_count} | Tokens: ${p.total_tokens}\n`;
        response += `  Lines Added: ${p.total_lines_added} | Tool: ${p.dominant_tool} | Model: ${p.dominant_model}\n`;
        response += `  Last Active: ${p.last_active ? new Date(p.last_active).toISOString().slice(0, 10) : 'unknown'}\n`;
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 8: get_model_comparison ----
server.tool(
    'get_model_comparison',
    'Compare AI model performance and cost across your sessions. Models are normalized (e.g., kimi-k2.5 variants are merged).',
    { models: z.array(z.string()).optional().describe('Specific models to compare (default: all)') },
    async ({ models }) => {
        const db = getDb();
        const pf = projectFilter();
        const rows = db.prepare(`
            SELECT primary_model as model, COUNT(*) as sessions, AVG(quality_score) as avg_quality,
                AVG(agentic_score) as avg_agentic,
                SUM(total_input_tokens) as total_input, SUM(total_output_tokens) as total_output,
                SUM(total_cache_read) as total_cache, AVG(cache_hit_pct) as avg_cache
            FROM sessions WHERE primary_model IS NOT NULL${pf.clause}
            GROUP BY primary_model
        `).all(...pf.params) as any[];

        // Aggregate by normalized model name
        const grouped: Record<string, any> = {};
        for (const r of rows) {
            const canonical = normalizeModel(r.model);
            if (models?.length && !models.some(m => canonical.includes(m.toLowerCase()))) continue;
            if (!grouped[canonical]) {
                grouped[canonical] = { model: canonical, sessions: 0, quality_sum: 0, agentic_sum: 0, input: 0, output: 0, cache: 0, cache_hit_sum: 0, cache_hit_count: 0 };
            }
            const g = grouped[canonical];
            g.sessions += r.sessions;
            g.quality_sum += (r.avg_quality || 0) * r.sessions;
            g.agentic_sum += (r.avg_agentic || 0) * r.sessions;
            g.input += r.total_input || 0;
            g.output += r.total_output || 0;
            g.cache += r.total_cache || 0;
            if (r.avg_cache != null) { g.cache_hit_sum += r.avg_cache * r.sessions; g.cache_hit_count += r.sessions; }
        }

        const results = Object.values(grouped).map((g: any) => {
            const cost = estimateModelCost(g.model, g.input, g.output, g.cache);
            return {
                model: g.model, sessions: g.sessions,
                avg_quality: g.sessions > 0 ? g.quality_sum / g.sessions : 0,
                avg_agentic: g.sessions > 0 ? g.agentic_sum / g.sessions : 0,
                avg_cache: g.cache_hit_count > 0 ? g.cache_hit_sum / g.cache_hit_count : 0,
                cost: cost.totalCost,
                cost_per_session: g.sessions > 0 ? cost.totalCost / g.sessions : 0,
            };
        }).sort((a: any, b: any) => b.cost - a.cost);

        // Merge billing actuals with session data for comprehensive view
        const billingModels = getBillingCostsByModel();
        const billingMap = new Map(billingModels.map(b => [b.model, b]));
        const totalEstimated = results.reduce((s: number, r: any) => s + r.cost, 0);
        const totalBilled = billingModels.reduce((s, r) => s + r.cost, 0);
        const useBilling = totalBilled > 0;
        const totalCost = useBilling ? totalBilled : totalEstimated;
        const costLabel = useBilling ? 'billing actuals' : 'estimated';

        let response = `Model Comparison (${costLabel}, total: $${totalCost.toFixed(2)}):\n\n`;
        if (useBilling) {
            // Show billing actuals enriched with session quality data
            for (const b of billingModels) {
                if (models?.length && !models.some(m => b.model.includes(m.toLowerCase()))) continue;
                const sessionData = results.find((r: any) => r.model === b.model);
                const pct = totalCost > 0 ? ((b.cost / totalCost) * 100).toFixed(1) : '0';
                response += `${b.model}:\n`;
                response += `  Requests: ${b.requests} | Tokens: ${(b.total_tokens || 0).toLocaleString()} | Cost: $${b.cost.toFixed(2)} (${pct}%)\n`;
                if (sessionData) {
                    response += `  Sessions: ${sessionData.sessions} | Quality: ${sessionData.avg_quality.toFixed(0)} | Agentic: ${sessionData.avg_agentic.toFixed(0)}\n`;
                }
            }
        } else {
            for (const r of results) {
                const pct = totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : '0';
                response += `${r.model}:\n`;
                response += `  Sessions: ${r.sessions} | Quality: ${r.avg_quality.toFixed(0)} | Agentic: ${r.avg_agentic.toFixed(0)} | Cache: ${r.avg_cache.toFixed(0)}%\n`;
                response += `  Cost: $${r.cost.toFixed(2)} (${pct}%) | $/session: $${r.cost_per_session.toFixed(2)}\n`;
            }
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 9: push_handoff_note ----
server.tool(
    'push_handoff_note',
    'Save a critical handoff note or architectural decision for future AI agents.',
    {
        content: z.string().describe('The critical context to save'),
        category: z.string().describe('e.g., "architecture", "bug_fix", "refactor"'),
    },
    async ({ content, category }) => {
        const db = getDb();
        db.prepare(`
            INSERT INTO recommendations (created_at, tool_id, category, severity, title, description)
            VALUES (?, 'handoff', ?, 'info', ?, ?)
        `).run(Date.now(), category, `Handoff: ${category}`, content);
        return { content: [{ type: 'text' as const, text: `Saved handoff note to category "${category}". Future agents can access this via get_active_recommendations.` }] };
    }
);

// ---- Tool 10: get_optimal_prompt_structure ----
server.tool(
    'get_optimal_prompt_structure',
    'Get data-driven guidance on optimal prompt structure based on your history.',
    { task_type: z.string().optional().describe('Task type for contextual advice') },
    async ({ task_type }) => {
        const db = getDb();
        const metrics = db.prepare(`
            SELECT AVG(first_turn_tokens) as avg_first_turn, AVG(reask_rate) as avg_reask,
                AVG(turns_to_first_edit) as avg_to_edit, AVG(constraint_count) as avg_constraints,
                SUM(CASE WHEN has_file_context = 1 THEN 1 ELSE 0 END) as with_context,
                COUNT(*) as total
            FROM prompt_metrics
        `).get() as any;

        let response = 'Optimal Prompt Structure:\n\n';
        if (metrics && metrics.total > 0) {
            response += `Based on ${metrics.total} analyzed sessions:\n`;
            response += `  • Avg first-turn tokens: ${(metrics.avg_first_turn || 0).toFixed(0)}\n`;
            response += `  • Avg re-ask rate: ${((metrics.avg_reask || 0) * 100).toFixed(1)}%\n`;
            response += `  • Turns to first edit: ${(metrics.avg_to_edit || 0).toFixed(1)}\n`;
            response += `  • Sessions with file context: ${((metrics.with_context / metrics.total) * 100).toFixed(0)}%\n\n`;
        }

        // Effect sizes from prompt science engine
        try {
            const effects = computeEffectSizes();
            if (effects.length) {
                response += 'Evidence-Based Effect Sizes:\n';
                for (const e of effects) {
                    if (e.delta != null && e.delta_pct != null) {
                        response += `  • ${e.signal}: ${e.delta > 0 ? '+' : ''}${e.delta} quality points (${e.delta_pct > 0 ? '+' : ''}${e.delta_pct}%) — n=${e.sample_with}/${e.sample_without}\n`;
                    } else {
                        response += `  • ${e.signal}: avg quality ${e.with_avg} (n=${e.sample_with})\n`;
                    }
                }
                response += '\n';
            }
        } catch { /* effect sizes unavailable */ }

        response += 'Best Practices:\n';
        response += '  1. Include file context in first message (improves first-attempt success)\n';
        response += '  2. Use constraints (e.g., "keep under 50 lines") to reduce re-asks\n';
        response += '  3. Front-load requirements — sessions with detailed first prompts have 40% fewer turns\n';
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 11: get_topic_summary ----
server.tool(
    'get_topic_summary',
    'Get a summary of AI coding activity grouped by topic.',
    { project: z.string().optional().describe('Filter by project name') },
    async ({ project }) => {
        const db = getDb();
        let sql = `SELECT topic, COUNT(*) as sessions, SUM(total_output_tokens) as tokens,
            AVG(quality_score) as avg_quality FROM sessions WHERE topic IS NOT NULL`;
        const params: any[] = [];
        if (project) { sql += " AND raw_data LIKE ? ESCAPE '\\\\'"; params.push(`%${escapeLike(project)}%`); }
        sql += ' GROUP BY topic ORDER BY sessions DESC LIMIT 15';
        const rows = db.prepare(sql).all(...params) as any[];

        if (!rows.length) return { content: [{ type: 'text' as const, text: 'No topics classified yet.' }] };

        let response = 'Topic Summary:\n\n';
        for (const r of rows) {
            response += `  ${r.topic}: ${r.sessions} sessions, ${((r.tokens || 0) / 1000).toFixed(0)}K tokens, Q=${(r.avg_quality || 0).toFixed(0)}\n`;
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 12: get_negative_constraints (Anti-Hallucination) ----
server.tool(
    'get_negative_constraints',
    'Get explicit "DO NOT" constraints derived from historically failing sessions to prevent AI hallucination loops. Inject these into your system prompt before starting a task.',
    {
        task: z.string().describe('Describe the task you are about to perform (e.g., "migrate PostgreSQL schema with Prisma")'),
        limit: z.number().optional().describe('Max constraints to return (default: 5)'),
    },
    async ({ task, limit = 5 }) => {
        const constraints = getNegativeConstraints(task, limit);
        if (!constraints.length) {
            return { content: [{ type: 'text' as const, text: `No known anti-patterns for this task type. Proceed normally.` }] };
        }
        let response = `Anti-Hallucination Constraints for: "${task}"\n\n`;
        response += `Inject these into your system prompt to avoid known failure patterns:\n\n`;
        for (const c of constraints) {
            response += `• ${c.constraint_text}\n`;
            response += `  (Failed ${c.failure_count}x locally | Task: ${c.task_type}`;
            if (c.success_session_id) response += ` | See success in session: ${c.success_session_id}`;
            response += `)\n\n`;
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 13: get_arbitrage_recommendation ----
server.tool(
    'get_arbitrage_recommendation',
    'Get a cost-routing recommendation: should this task use a free local model (Ollama) or a premium cloud model? Returns mathematically proven savings estimate.',
    {
        prompt: z.string().describe('The prompt or task description you are about to send to an AI model'),
        requested_model: z.string().optional().describe('The model you intended to use (default: claude-sonnet-4-6)'),
    },
    async ({ prompt, requested_model = 'claude-sonnet-4-6' }) => {
        const decision = makeArbitrageDecision(prompt, requested_model);
        const summary = getArbitrageSummary();

        let response = `Token Arbitrage Decision:\n\n`;
        response += `  Task Type: ${decision.taskType} | Complexity: ${decision.complexity}\n`;
        response += `  Original Model: ${decision.originalModel}\n`;
        response += `  Recommended Model: ${decision.routedModel} (${decision.routeToLocal ? 'LOCAL — FREE' : 'CLOUD'})\n`;
        response += `  Est. Savings: $${decision.estimatedSavingsUsd.toFixed(4)} per request\n`;
        response += `  Historical Local Success Rate: ${(decision.localSuccessRate * 100).toFixed(0)}% (${decision.sampleSize} samples)\n\n`;
        response += `  Reason: ${decision.reason}\n\n`;

        if (summary.overall.total > 0) {
            const pct = (summary.overall.localRatio * 100).toFixed(0);
            response += `Lifetime Stats: ${summary.overall.total} routed requests, ${pct}% resolved locally.\n`;
        }

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 14: get_team_memory ----
server.tool(
    'get_team_memory',
    'Retrieve solutions that teammates on the same local network discovered in their OCD instances. Requires P2P_SECRET env var to be set on all nodes.',
    {
        query: z.string().describe('The problem or error to look up in team memory'),
        limit: z.number().optional().describe('Max results (default: 3)'),
    },
    async ({ query, limit = 3 }) => {
        const peers = getKnownPeers();
        if (!peers.length) {
            return { content: [{ type: 'text' as const, text: 'No peers discovered on the local network. Ensure P2P_SECRET is set and teammates are running OCD on the same network.' }] };
        }

        // Search local DB for p2p-sourced embeddings
        const vectorService = new VectorService();
        const results = await vectorService.searchSimilarSessions(query, limit * 2);
        const db = getDb();

        const p2pResults = results.filter(r => r.session_id.startsWith('p2p::'));
        if (!p2pResults.length) {
            return { content: [{ type: 'text' as const, text: `${peers.length} peer(s) known but no team solutions synced yet. Run POST /api/p2p/sync to pull team memory.` }] };
        }

        let response = `Team Memory Results (from ${peers.length} peer(s)):\n\n`;
        for (const res of p2pResults.slice(0, limit)) {
            const [, peerId, remoteId] = res.session_id.split('::');
            const row = db.prepare('SELECT title, tldr FROM sessions WHERE id = ?').get(res.session_id) as any;
            if (row) {
                response += `--- ${row.title || 'Team solution'} (${(res.similarity * 100).toFixed(0)}% match) ---\n`;
                response += `Peer: ${peerId} | Remote Session: ${remoteId}\n`;
                response += `Summary: ${row.tldr || 'No summary'}\n\n`;
            }
        }
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 15: submit_ide_trace ----
server.tool(
    'submit_ide_trace',
    'Manually submit a stack trace or error output for instant proactive analysis. OCD will search its memory and return the best matching past solution.',
    {
        trace: z.string().describe('The full stack trace, error output, or LSP diagnostic to analyze'),
    },
    async ({ trace }) => {
        const result = await submitTrace(trace);
        if (!result.matched) {
            return { content: [{ type: 'text' as const, text: 'No matching past solution found for this error. OCD will learn from this session if it is resolved successfully.' }] };
        }
        let response = `Proactive Match Found (${((result.similarity || 0) * 100).toFixed(0)}% similarity):\n\n`;
        response += `Session: ${result.session_id}\n`;
        response += `Title: ${result.title || 'Unknown'}\n`;
        response += `Summary: ${result.tldr || 'No summary available'}\n\n`;
        response += `Use get_similar_solutions with the error text for full context.`;
        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 16: get_attribution_report ----
server.tool(
    'get_attribution_report',
    'Get an AI vs. human code authorship breakdown for commits. Shows per-project, per-branch, and per-tool attribution percentages for engineering managers, compliance reporting, and velocity tracking.',
    {
        project: z.string().optional().describe('Filter by project name (matches branch names)'),
        branch: z.string().optional().describe('Filter by exact branch name'),
        days: z.number().optional().describe('Look back N days (default: all time)'),
    },
    async ({ project, branch, days }) => {
        try {
            const report = getAttributionReport({ project, branch, days });
            if (!report.summary || report.summary.total_commits === 0) {
                return { content: [{ type: 'text' as const, text: 'No commit attribution data available. Run the Git Scanner to score commits.' }] };
            }
            const s = report.summary;
            let response = `AI Attribution Report${project ? ` — ${project}` : ''}${branch ? ` (${branch})` : ''}${days ? ` (last ${days}d)` : ''}:\n\n`;
            response += `Summary:\n`;
            response += `  Commits: ${s.total_commits} | Avg AI: ${s.avg_ai_percentage}% | Range: ${s.min_ai_percentage}–${s.max_ai_percentage}%\n`;
            response += `  AI Lines: ${s.total_ai_lines} | Human Lines: ${s.total_human_lines} | AI Ratio: ${s.ai_ratio}%\n\n`;

            if (report.by_branch.length) {
                response += 'By Branch:\n';
                for (const b of report.by_branch) {
                    response += `  • ${b.branch}: ${b.commits} commits, ${b.avg_ai_pct}% AI (${b.ai_lines} AI / ${b.human_lines} human lines)\n`;
                }
                response += '\n';
            }

            if (report.by_tool.length) {
                response += 'By Tool:\n';
                for (const t of report.by_tool) {
                    response += `  • ${t.tool}: ${t.commits} commits, ${t.avg_ai_pct}% AI, ${t.ai_lines} AI lines\n`;
                }
            }

            return { content: [{ type: 'text' as const, text: response }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: 'Error: ' + e.message }], isError: true };
        }
    }
);

// ---- Tool 17: get_efficiency_tips ----
server.tool(
    'get_efficiency_tips',
    'Get personalized token-saving tips based on your usage patterns. Returns your daily burn rate, weekly forecast, top token consumers, and actionable quick wins to reduce waste.',
    {},
    async () => {
        try {
            const budget = computeTokenBudget();
            let response = 'Token Efficiency Report:\n\n';

            response += `Today: ${fmtTokenCount(budget.today.input_tokens + budget.today.output_tokens)} tokens, ${budget.today.sessions} sessions, ${budget.today.turns} turns\n`;
            response += `7-Day Avg: ${fmtTokenCount(budget.daily_avg.input_tokens + budget.daily_avg.output_tokens)}/day, ~$${budget.daily_avg.cost}/day\n`;
            response += `Weekly Forecast: ${fmtTokenCount(budget.weekly_forecast.tokens)} tokens, ~$${budget.weekly_forecast.cost}\n\n`;

            if (budget.quick_wins.length) {
                response += 'Quick Wins to Save Tokens:\n';
                for (const w of budget.quick_wins) {
                    response += `  ${w.priority}. ${w.tip}\n     Impact: ${w.impact}\n\n`;
                }
            }

            if (budget.efficiency_by_tool.length) {
                response += 'Efficiency by Tool (tokens per quality point — lower is better):\n';
                for (const t of budget.efficiency_by_tool) {
                    response += `  • ${t.tool}: ${t.tokens_per_quality_point} tokens/quality (Q=${t.avg_quality}, cache=${t.avg_cache}%, ${t.sessions} sessions)\n`;
                }
            }

            return { content: [{ type: 'text' as const, text: response }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: 'Error: ' + e.message }], isError: true };
        }
    }
);

// ---- Tool 18: get_session_health_check ----
server.tool(
    'get_session_health_check',
    'Check your current session health using cross-session patterns. Returns a status (healthy/degrading/critical), a suggested action (continue/compact/new_session), and context-aware nudges based on your historical usage patterns. Call this periodically to stay ahead of quality degradation.',
    {},
    async () => {
        try {
            const health = getSessionHealthCheck();

            let response = `Session Health: ${health.status.toUpperCase()}\n`;
            response += `Suggested Action: ${health.suggested_action}\n\n`;

            response += `Current Session:\n`;
            response += `  Turns: ${health.current.turns} | Tokens: ${health.current.tokens_k}K\n`;
            response += `  Cache Hit: ${health.current.cache_hit_pct}% | Error Rate: ${health.current.error_rate_pct}%\n`;
            response += `  Duration: ${health.current.duration_min} min\n\n`;

            response += `Cross-Session Baselines:\n`;
            const cs = health.cross_session;
            if (cs.avg_turns_before_quality_drop) {
                response += `  Quality drops after ~${cs.avg_turns_before_quality_drop} turns (your pattern)\n`;
            }
            if (cs.avg_cache_hit_pct) {
                response += `  Your avg cache hit: ${cs.avg_cache_hit_pct}% | Avg quality: ${cs.avg_quality_score}\n`;
            }
            response += `  Today: ${cs.sessions_today} sessions, ${cs.tokens_today_k}K tokens`;
            if (cs.daily_avg_tokens_k) {
                response += ` (daily avg: ${cs.daily_avg_tokens_k}K)`;
            }
            response += '\n';

            if (health.nudges.length) {
                response += `\nNudges:\n`;
                for (const nudge of health.nudges) {
                    response += `  ⚠ ${nudge}\n`;
                }
            }

            return { content: [{ type: 'text' as const, text: response }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: 'Error: ' + e.message }], isError: true };
        }
    }
);

// ---- Gatekeeper types ----
interface OcdTask {
    id: number;
    title: string;
    description: string | null;
    project: string | null;
    status: string;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

interface CountRow {
    cnt: number;
}

// ---- Tool 19: get_current_task (Gatekeeper) ----
server.tool(
    'get_current_task',
    'CRITICAL: Call this tool before starting any new action to understand the current scope. Returns the active task from OCD so you do not deviate or cause scope creep.',
    {},
    async () => {
        const db = getDb();
        const task = db.prepare(
            `SELECT id, title, description, project, status, created_at
             FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get() as OcdTask | undefined;

        if (!task) {
            return {
                content: [{
                    type: 'text' as const,
                    text: 'No active task defined in OCD. You may proceed freely, but consider asking the user to set a task for focused work.',
                }],
            };
        }

        const parkedCount = db.prepare(
            `SELECT COUNT(*) as cnt FROM ocd_parking_lot WHERE parked_during_task_id = ?`
        ).get(task.id) as CountRow | undefined;

        let response = `Current Active Task (OCD Gatekeeper):\n\n`;
        response += `  Task: ${task.title}\n`;
        if (task.description) response += `  Description: ${task.description}\n`;
        if (task.project) response += `  Project: ${task.project}\n`;
        response += `  Status: ${task.status}\n`;
        response += `  Parked Ideas: ${parkedCount?.cnt || 0}\n\n`;
        response += `IMPORTANT: Do not deviate from this task. If the user suggests something out of scope, use park_out_of_scope_idea to capture it without losing focus.`;

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 20: park_out_of_scope_idea (Gatekeeper) ----
server.tool(
    'park_out_of_scope_idea',
    'Call this when the user suggests an idea that does not directly contribute to the current active task. Parks the idea in OCD so it is not lost, then redirects focus back to the task.',
    {
        idea: z.string().describe('Description of the out-of-scope idea to park'),
        source_tool: z.string().optional().describe('Which tool captured this (e.g., "claude-code", "cursor")'),
    },
    async ({ idea, source_tool }) => {
        const db = getDb();
        const activeTask = db.prepare(
            `SELECT id, title FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get() as Pick<OcdTask, 'id' | 'title'> | undefined;

        db.prepare(
            `INSERT INTO ocd_parking_lot (idea, source_tool, parked_during_task_id, created_at)
             VALUES (?, ?, ?, ?)`
        ).run(idea, source_tool || null, activeTask?.id || null, Date.now());

        const taskRef = activeTask ? `"${activeTask.title}"` : 'your current work';
        return {
            content: [{
                type: 'text' as const,
                text: `Idea parked in OCD: "${idea}"\n\nInform the user: "I've parked this idea in OCD so we don't lose it. Let's stay focused on ${taskRef}."`,
            }],
        };
    }
);

// ---- Tool 21: update_task_status (Gatekeeper) ----
server.tool(
    'update_task_status',
    'Update the status of the current OCD task. Use this to mark tasks as completed, paused, or to set a new active task.',
    {
        action: z.enum(['complete', 'pause', 'new']).describe('"complete" finishes current task, "pause" puts it on hold, "new" creates a new active task'),
        title: z.string().optional().describe('Required when action is "new" — the title of the new task'),
        description: z.string().optional().describe('Optional description for new tasks'),
        project: z.string().optional().describe('Optional project name for new tasks'),
    },
    async ({ action, title, description, project }) => {
        const db = getDb();
        const now = Date.now();

        if (action === 'complete') {
            const updated = db.prepare(
                `UPDATE ocd_tasks SET status = 'completed', completed_at = ?, updated_at = ?
                 WHERE id = (SELECT id FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1)`
            ).run(now, now);
            if (!updated.changes) {
                return { content: [{ type: 'text' as const, text: 'No active task to complete.' }] };
            }
            const parked = db.prepare(
                `SELECT COUNT(*) as cnt FROM ocd_parking_lot WHERE promoted = 0`
            ).get() as CountRow | undefined;
            let response = 'Task marked as completed in OCD.';
            if (parked && parked.cnt > 0) {
                response += `\n\nYou have ${parked.cnt} parked idea(s) waiting for review. Consider promoting one to the next active task.`;
            }
            return { content: [{ type: 'text' as const, text: response }] };
        }

        if (action === 'pause') {
            db.prepare(
                `UPDATE ocd_tasks SET status = 'paused', updated_at = ?
                 WHERE id = (SELECT id FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1)`
            ).run(now);
            return { content: [{ type: 'text' as const, text: 'Active task paused in OCD.' }] };
        }

        if (action === 'new') {
            if (!title) {
                return { content: [{ type: 'text' as const, text: 'Error: title is required when creating a new task.' }], isError: true };
            }
            db.transaction(() => {
                db.prepare(
                    `UPDATE ocd_tasks SET status = 'paused', updated_at = ? WHERE status = 'active'`
                ).run(now);
                db.prepare(
                    `INSERT INTO ocd_tasks (title, description, project, status, created_at, updated_at)
                     VALUES (?, ?, ?, 'active', ?, ?)`
                ).run(title, description || null, project || null, now, now);
            })();
            return {
                content: [{
                    type: 'text' as const,
                    text: `New active task set in OCD: "${title}"\n\nAll connected agents will now scope their work to this task.`,
                }],
            };
        }

        return { content: [{ type: 'text' as const, text: 'Unknown action.' }], isError: true };
    }
);

// ---- Tool 22: run_trace_audit ----
server.tool(
    'run_trace_audit',
    'Run a Trace-to-Evidence audit: accepts a question (e.g. "Why is quality misreported?"), gathers evidence from code grep, session memory, anti-patterns, config, and handoff notes, then returns a structured report with verified paths, broken links, missing evidence, and degraded warnings. Results are persisted for cross-session recall.',
    {
        question: z.string().describe('The audit question, e.g. "Why is Antigravity quality misreported?" or "Where does the MAS seed data flow?"'),
        template: z.string().optional().describe('Template key: mapping_validation, ingestion_throttle, fallback_behavior (or omit for freeform)'),
        project_path: z.string().optional().describe('Project root to grep (defaults to cwd)'),
        scope_globs: z.array(z.string()).optional().describe('File patterns to limit search scope, e.g. ["src/services/**/*.ts"]'),
    },
    async ({ question, template, project_path, scope_globs }) => {
        try {
            const result = await runTraceAudit({ question, template, project_path, scope_globs });

            let response = result.report;
            response += `\n**Audit ID**: ${result.id} | **Duration**: ${result.duration_ms}ms | **Status**: ${result.status}`;

            return { content: [{ type: 'text' as const, text: response }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: 'Audit error: ' + e.message }], isError: true };
        }
    }
);

// ---- Tool 23: get_audit_templates ----
server.tool(
    'get_audit_templates',
    'List available audit templates for the Trace-to-Evidence system. Templates define evidence-gathering strategies for common audit patterns (mapping validation, ingestion throttling, fallback behavior).',
    {
        include_custom: z.boolean().optional().describe('Include user-created templates (default: true)'),
    },
    async ({ include_custom = true }) => {
        const templates = listTemplates(include_custom);
        if (!templates.length) {
            return { content: [{ type: 'text' as const, text: 'No audit templates found.' }] };
        }

        let response = 'Available Audit Templates:\n\n';
        for (const t of templates) {
            response += `**${t.key}** — ${t.name}${t.built_in ? ' (built-in)' : ''}\n`;
            response += `  ${t.description}\n`;
            response += `  Sources: ${t.evidence_sources.join(', ')}\n`;
            response += `  Patterns: ${t.grep_patterns.slice(0, 5).join(', ')}${t.grep_patterns.length > 5 ? '...' : ''}\n`;
            response += `  Globs: ${t.file_globs.join(', ')}\n\n`;
        }

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 24: get_audit_history ----
server.tool(
    'get_audit_history',
    'Retrieve past Trace-to-Evidence audit runs and their results. Useful for tracking recurring issues, comparing audit outcomes across sessions, and avoiding re-investigating solved problems.',
    {
        question_search: z.string().optional().describe('Search audit questions containing this text'),
        limit: z.number().optional().describe('Max results (default: 10)'),
        status_filter: z.enum(['verified', 'broken', 'all']).optional().describe('Filter: "verified" (had verified evidence), "broken" (had broken/missing evidence), "all" (default)'),
    },
    async ({ question_search, limit = 10, status_filter = 'all' }) => {
        const history = getAuditHistory({ question_search, limit, status_filter });
        if (!history.length) {
            return { content: [{ type: 'text' as const, text: 'No audit history found.' }] };
        }

        let response = `Audit History (${history.length} runs):\n\n`;
        for (const h of history) {
            const date = new Date(h.created_at).toISOString().split('T')[0];
            response += `**${h.id}** (${date}) — ${h.status}\n`;
            response += `  Q: "${h.question}"\n`;
            if (h.template_key) response += `  Template: ${h.template_key}\n`;
            response += `  Evidence: ${h.verified_count} verified, ${h.broken_count} broken, ${h.missing_count} missing, ${h.suggestions_count} degraded\n`;
            response += `  Duration: ${h.duration_ms}ms\n\n`;
        }

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

// ---- Tool 25: get_context_stitch (Unified Session Bootstrap) ----
server.tool(
    'get_context_stitch',
    'Single-call session bootstrap. Returns last session context, unfinished work (handoff notes), production errors, anti-pattern constraints, health baseline, and a DIRECTIVE (CONTINUE/REDIRECT/NEW_SESSION) with suggested prompt. Call this once at the start of every session instead of multiple individual tools.',
    {
        task_description: z.string().optional().describe('What you plan to work on — enables repeat-failure detection and scope checking'),
        tool_id: z.string().optional().describe('Filter sessions by tool (e.g., "claude-code", "cursor")'),
    },
    async ({ task_description, tool_id }) => {
        const db = getDb();
        const pf = projectFilter();
        const sections: string[] = ['═══ CONTEXT STITCH ═══\n'];

        // ── 1. Directive ─────────────────────────────────────────────────
        const dir = await getDirective(task_description);
        sections.push(`▸ DIRECTIVE: ${dir.directive}`);
        if (dir.reason) sections.push(`  ${dir.reason}`);
        if (dir.suggested_prompt) sections.push(`  Suggested: "${dir.suggested_prompt}"`);
        sections.push('');

        // ── 2. Last Session ──────────────────────────────────────────────
        let sessionSql = 'SELECT * FROM sessions';
        const sessionParams: any[] = [];
        const clauses: string[] = [];
        if (tool_id) { clauses.push('tool_id = ?'); sessionParams.push(tool_id); }
        if (pf.clause) { clauses.push(pf.clause.replace(/^ AND /, '')); sessionParams.push(...pf.params); }
        if (clauses.length) sessionSql += ' WHERE ' + clauses.join(' AND ');
        sessionSql += ' ORDER BY started_at DESC LIMIT 1';
        const session = db.prepare(sessionSql).get(...sessionParams) as any;

        if (session) {
            const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
            const dateStr = session.started_at ? new Date(session.started_at).toISOString().split('T')[0] : 'unknown';
            sections.push(`▸ LAST SESSION (${dateStr}, ${session.tool_id}, ${session.total_turns} turns)`);
            sections.push(`  Title: "${session.title || 'Untitled'}"`);
            if (raw.filesEdited?.length) {
                const files = raw.filesEdited.slice(0, 5);
                const extra = raw.filesEdited.length > 5 ? `, +${raw.filesEdited.length - 5}` : '';
                sections.push(`  Files: ${files.join(', ')}${extra}`);
            }
            sections.push(`  Quality: ${session.quality_score ?? 'N/A'} | Errors: ${session.error_count ?? 0} | Lines: +${session.code_lines_added ?? 0}/-${session.code_lines_removed ?? 0}`);
            sections.push('');
        }

        // ── 3. Unfinished Work (handoff notes) ──────────────────────────
        const handoffs = db.prepare(`
            SELECT title, description FROM recommendations
            WHERE tool_id = 'handoff' AND dismissed = 0
            ORDER BY created_at DESC LIMIT 5
        `).all() as any[];

        if (handoffs.length) {
            sections.push('▸ UNFINISHED WORK');
            for (const h of handoffs) {
                sections.push(`  - [handoff] ${(h.description || h.title).slice(0, 150)}`);
            }
            sections.push('');
        }

        // ── 4. Production Errors (PM Dashboard) ─────────────────────────
        const errors = await getProductionErrors();
        if (errors && errors.total > 0) {
            const parts: string[] = [];
            const sev = errors.bySeverity;
            if (sev.critical) parts.push(`${sev.critical} critical`);
            if (sev.high) parts.push(`${sev.high} high`);
            if (sev.medium) parts.push(`${sev.medium} med`);
            if (sev.low) parts.push(`${sev.low} low`);
            sections.push(`▸ ACTIVE ERRORS (24h): ${errors.total} total (${parts.join(', ')})`);
            for (const msg of errors.topMessages) {
                sections.push(`  - [${msg.severity}] ${msg.message}`);
            }
            sections.push('');
        }

        // ── 5. Anti-pattern Constraints ──────────────────────────────────
        const constraints = getNegativeConstraints(task_description || 'general', 3);
        if (constraints.length) {
            sections.push('▸ CONSTRAINTS');
            for (const c of constraints) {
                sections.push(`  - ${c.constraint_text}`);
            }
            sections.push('');
        }

        // ── 6. Health Baseline ───────────────────────────────────────────
        const health = getSessionHealthCheck();
        const cs = health.cross_session;
        const baselineParts: string[] = [];
        if (cs.avg_turns_before_quality_drop) baselineParts.push(`degrade after ~${cs.avg_turns_before_quality_drop} turns`);
        if (cs.avg_cache_hit_pct) baselineParts.push(`avg cache: ${cs.avg_cache_hit_pct}%`);
        baselineParts.push(`today: ${cs.sessions_today} sessions, ${cs.tokens_today_k}K tokens`);
        if (cs.daily_avg_tokens_k) baselineParts.push(`daily avg: ${cs.daily_avg_tokens_k}K`);
        sections.push(`▸ HEALTH BASELINE: ${baselineParts.join(' | ')}`);

        if (health.nudges.length) {
            for (const nudge of health.nudges) {
                sections.push(`  ⚠ ${nudge}`);
            }
        }

        return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    }
);

server.tool(
    'get_session_guard_verdict',
    'Check session health for overrun, tool call repetition, and anti-hallucination risks. Returns verdicts (allow/warn/block). Works from any IDE.',
    {
        session_id: z.string().optional().describe('Session ID (defaults to most recent)'),
    },
    async ({ session_id }) => {
        const report = getSessionGuardReport(session_id);
        let response = `Session Guard Report\n════════════════════\n`;
        response += `Status: ${report.session_status.toUpperCase()}\n`;
        response += `Turns: ${report.stats.turn_count} | Duration: ${report.stats.duration_min}min\n`;
        response += `Unique tools: ${report.stats.unique_tools} | Repeated calls: ${report.stats.repeated_calls}\n\n`;

        if (report.verdicts.length) {
            response += `Verdicts:\n`;
            for (const v of report.verdicts) {
                response += `  [${v.action.toUpperCase()}] ${v.category}: ${v.message}\n`;
            }
        } else {
            response += `No issues detected. Session is healthy.\n`;
        }

        if (report.stats.top_repetitions.length) {
            response += `\nTop Repetitions:\n`;
            for (const r of report.stats.top_repetitions) {
                response += `  ${r.tool_name}: ${r.args_summary} (${r.count}x)\n`;
            }
        }

        return { content: [{ type: 'text' as const, text: response }] };
    }
);

server.tool(
    'report_tool_call',
    'Log a tool call for repetition tracking. Use from IDEs without hook-based interception.',
    {
        session_id: z.string().describe('Current session ID'),
        tool_name: z.string().describe('Tool name (e.g., "Read", "Bash")'),
        args_fingerprint: z.string().describe('Stable hash of tool arguments'),
        args_summary: z.string().describe('Human-readable summary'),
    },
    async ({ session_id, tool_name, args_fingerprint, args_summary }) => {
        recordToolCall(session_id, tool_name, args_fingerprint, args_summary);
        return { content: [{ type: 'text' as const, text: `Recorded ${tool_name} call for session ${session_id}.` }] };
    }
);

function fmtTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
}

async function startMcp() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('AI Productivity Engine MCP Server v5.4.0 running on stdio');
}

startMcp().catch(console.error);
