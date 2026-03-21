import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDb, getDb } from './db/index.js';
import { VectorService } from './lib/vector-store.js';
import { computeOverview, computeCostAnalysis, computePersonalInsights } from './engine/analytics.js';
import { getAgenticLeaderboard } from './engine/agentic-scorer.js';

initDb();

const server = new McpServer({
    name: 'AI Productivity Engine',
    version: '5.0.0',
});

const vectorService = new VectorService();

// ---- Tool 1: get_similar_solutions ----
server.tool(
    'get_similar_solutions',
    'Search the universal memory bank for successful code implementations from past coding sessions.',
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
            let response = 'Relevant solutions from past sessions:\n\n';
            for (const res of results) {
                const row = db.prepare('SELECT title, tldr, code_lines_added, quality_score, primary_model, tool_id FROM sessions WHERE id = ?').get(res.session_id) as any;
                if (row) {
                    response += `--- ${row.title || 'Unknown'} (${(res.similarity * 100).toFixed(1)}% match) ---\n`;
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
        const clusters = db.prepare(`
            SELECT topic, summary, total_sessions, total_tokens
            FROM topic_clusters WHERE topic LIKE ? ORDER BY total_sessions DESC LIMIT 5
        `).all(`%${topic}%`) as any[];

        const sessions = db.prepare(`
            SELECT id, title, tool_id, primary_model, quality_score, code_lines_added
            FROM sessions WHERE topic LIKE ? OR title LIKE ?
            ORDER BY quality_score DESC LIMIT 10
        `).all(`%${topic}%`, `%${topic}%`) as any[];

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
    'Get which AI tool + model is statistically best for your current task type.',
    { task_type: z.string().describe('e.g., "refactoring", "debugging", "scaffolding", "testing"') },
    async ({ task_type }) => {
        const db = getDb();
        const rows = db.prepare(`
            SELECT s.tool_id, s.primary_model, COUNT(*) as sessions,
                AVG(s.quality_score) as avg_quality, AVG(s.agentic_score) as avg_agentic,
                AVG(s.total_turns) as avg_turns
            FROM sessions s
            JOIN task_classifications tc ON tc.session_id = s.id
            WHERE tc.task_type = ?
            GROUP BY s.tool_id, s.primary_model ORDER BY avg_quality DESC LIMIT 5
        `).all(task_type) as any[];

        if (!rows.length) {
            return { content: [{ type: 'text' as const, text: `No historical data for task type "${task_type}". Using default: claude-code with claude-sonnet-4-6.` }] };
        }

        const best = rows[0];
        let response = `Routing Recommendation for "${task_type}":\n\n`;
        response += `🏆 Best: ${best.tool_id} / ${best.primary_model}\n`;
        response += `   Quality: ${(best.avg_quality || 0).toFixed(1)} | Agentic: ${(best.avg_agentic || 0).toFixed(0)} | Avg Turns: ${(best.avg_turns || 0).toFixed(0)}\n\n`;
        response += 'Alternatives:\n';
        for (const r of rows.slice(1)) {
            response += `  • ${r.tool_id}/${r.primary_model}: Q=${(r.avg_quality || 0).toFixed(0)}, ${r.sessions} sessions\n`;
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
        const overview = computeOverview();
        const costs = computeCostAnalysis();
        const g = overview.global as any;

        let response = 'Efficiency Snapshot:\n';
        response += `  Sessions: ${g.total_sessions} | Turns: ${g.total_turns}\n`;
        response += `  Output Tokens: ${g.total_output} | Cache Hit: ${(g.avg_cache_hit || 0).toFixed(1)}%\n`;
        response += `  Lines Generated: ${g.total_lines_added} | Files Touched: ${g.total_files_touched}\n`;
        response += `  Avg Quality: ${(g.avg_quality || 0).toFixed(0)}\n`;
        response += `  Estimated Cost: $${costs.totalCost.toFixed(2)} | Cache Savings: $${costs.totalSavings.toFixed(2)}\n`;
        response += `\nTools: ${overview.tools.map((t: any) => `${t.tool_id}(${t.sessions})`).join(', ')}\n`;
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
        const p = db.prepare('SELECT * FROM project_index WHERE name LIKE ?').get(`%${project}%`) as any;
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
    'Compare AI model performance across your sessions.',
    { models: z.array(z.string()).optional().describe('Specific models to compare (default: all)') },
    async ({ models }) => {
        const db = getDb();
        let sql = `SELECT primary_model as model, COUNT(*) as sessions, AVG(quality_score) as avg_quality,
            AVG(agentic_score) as avg_agentic, SUM(total_output_tokens) as total_output,
            AVG(cache_hit_pct) as avg_cache FROM sessions WHERE primary_model IS NOT NULL`;
        const params: any[] = [];
        if (models?.length) {
            sql += ` AND primary_model IN (${models.map(() => '?').join(',')})`;
            params.push(...models);
        }
        sql += ' GROUP BY primary_model ORDER BY avg_quality DESC';
        const rows = db.prepare(sql).all(...params) as any[];

        let response = 'Model Comparison:\n\n';
        for (const r of rows) {
            response += `${r.model}:\n  Sessions: ${r.sessions} | Quality: ${(r.avg_quality || 0).toFixed(0)}`;
            response += ` | Agentic: ${(r.avg_agentic || 0).toFixed(0)} | Cache: ${(r.avg_cache || 0).toFixed(0)}%\n`;
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
        if (project) { sql += ' AND raw_data LIKE ?'; params.push(`%${project}%`); }
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

async function startMcp() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('AI Productivity Engine MCP Server v5.0 running on stdio');
}

startMcp().catch(console.error);
