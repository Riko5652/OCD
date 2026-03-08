/**
 * AI Productivity Dashboard — MCP Universal Brain Server
 *
 * Exposes 7 tools so any MCP-compatible AI agent can query live dashboard data.
 *
 * Run standalone:  node src/mcp-handoff.js
 * Register in Claude Code .mcp.json:
 *   {
 *     "mcpServers": {
 *       "ai-brain": {
 *         "command": "node",
 *         "args": ["C:/Projects/ai-productivity-dashboard/src/mcp-handoff.js"]
 *       }
 *     }
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from './db.js';
import { getRoutingRecommendation, computeToolModelWinRates } from './engine/cross-tool-router.js';
import { computeAllProjects } from './engine/project-insights.js';

// ── Sanitize DB text before LLM/tool exposure ──────────────────────────────
function sanitize(str, maxLen = 300) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/g, '')
    .replace(/ignore (all |previous |prior )?instructions?/gi, '[filtered]')
    .replace(/system:/gi, '[filtered]')
    .slice(0, maxLen);
}

const server = new Server(
  { name: 'ai-productivity-brain', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'get_last_session_context',
    description: "Get context from your most recent session in a DIFFERENT AI tool. Use when switching tools mid-task to avoid re-explaining the problem.",
    inputSchema: {
      type: 'object',
      properties: {
        exclude_tool: { type: 'string', description: "Your current tool name (claude-code, cursor, aider, windsurf, copilot). Returns context from any OTHER tool." },
        limit: { type: 'number', description: 'Number of recent turn labels to include (default 3, max 10)' },
      },
      required: ['exclude_tool'],
    },
  },
  {
    name: 'get_routing_recommendation',
    description: "Get a data-driven recommendation for which AI tool + model to use for a specific task, based on your historical performance.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Describe the task (e.g. "fix postgres migration", "build React component", "debug TypeScript error")' },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_efficiency_snapshot',
    description: "Get your recent AI coding efficiency: cache hit rate, first-attempt %, error recovery, session count.",
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Lookback window in days (default 7)' } },
      required: [],
    },
  },
  {
    name: 'get_active_recommendations',
    description: "Get unresolved optimization recommendations from the dashboard (low cache hit, long sessions, tool overuse, etc.).",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project_stats',
    description: "Get AI usage stats for a project: total tokens, dominant tool+model, monthly velocity.",
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name (partial match OK)' } },
      required: ['project'],
    },
  },
  {
    name: 'get_model_comparison',
    description: "Compare AI models (claude-sonnet-4-6 vs gpt-4o vs gemini) on your actual sessions: win rate, avg turns, cache hit.",
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', description: 'Filter by: migration, component, debug, refactor, api, test, devops' },
      },
      required: [],
    },
  },
  {
    name: 'push_handoff_note',
    description: "Write a context note to your current session so the next AI tool can pick it up via get_last_session_context.",
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What you were doing, what failed, what to try next.' },
        tool: { type: 'string', description: 'Your current tool name (for labeling).' },
      },
      required: ['note'],
    },
  },
  {
    name: 'get_optimal_prompt_structure',
    description: "Get the optimal prompt structure for a task type, based on your highest-quality historical sessions. Returns example prompts, tips, and recommended tool+model.",
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', description: 'Task type: migration, component, debug, refactor, test, api, general' },
      },
      required: ['task_type'],
    },
  },
  {
    name: 'get_topic_summary',
    description: "Get an executive summary of what was worked on for a specific topic within a project (e.g., 'What db-work was done in pm-dashboard?'). Detects unrelated sessions automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name' },
        topic: { type: 'string', description: 'Topic: db-work, frontend, debugging, devops, writing, planning, testing, api, general' },
      },
      required: ['project', 'topic'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = getDb();

  try {
    // ── get_last_session_context ────────────────────────────────────────────
    if (name === 'get_last_session_context') {
      const limit = Math.min(args?.limit || 3, 10);
      const last = db.prepare(`
        SELECT id, tool_id, primary_model, total_turns, quality_score,
               error_count, raw_data, ended_at
        FROM sessions
        WHERE tool_id != ?
        ORDER BY ended_at DESC LIMIT 1
      `).get(args.exclude_tool);

      if (!last) return { content: [{ type: 'text', text: 'No recent sessions found from other tools.' }] };

      const turns = db.prepare(`
        SELECT label, is_error FROM turns
        WHERE session_id = ? ORDER BY turn_index DESC LIMIT ?
      `).all(last.id, limit);

      let handoffNote = null;
      try { handoffNote = JSON.parse(last.raw_data || '{}')._handoffNote; } catch (_) {}

      const lines = [
        `## Handoff from ${last.tool_id}`,
        `- Model: ${last.primary_model || 'unknown'}`,
        `- Turns: ${last.total_turns} | Quality: ${Math.round(last.quality_score || 0)}/100 | Errors: ${last.error_count || 0}`,
        handoffNote ? `- Note: ${sanitize(handoffNote)}` : null,
        ``,
        `### Last ${turns.length} prompts:`,
        ...turns.map((t, i) => `${i + 1}. ${t.is_error ? '❌ ' : ''}${sanitize(t.label)}`),
      ].filter(l => l !== null);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── get_routing_recommendation ──────────────────────────────────────────
    if (name === 'get_routing_recommendation') {
      const rec = getRoutingRecommendation(args?.task || '');
      const text = rec.recommendation
        ? [
            `## Recommendation: ${rec.recommendation.tool} + ${rec.recommendation.model}`,
            ``,
            rec.reason,
            ``,
            `### Top win rates:`,
            ...(rec.win_rates || []).slice(0, 5).map(r =>
              `- ${r.tool_id} / ${r.model}: ${r.win_rate}% win rate, avg ${(r.avg_turns || 0).toFixed(1)} turns (${r.sessions} sessions)`
            ),
          ].join('\n')
        : rec.reason;
      return { content: [{ type: 'text', text }] };
    }

    // ── get_efficiency_snapshot ─────────────────────────────────────────────
    if (name === 'get_efficiency_snapshot') {
      const days = args?.days || 7;
      const since = Date.now() - days * 86400000;
      const s = db.prepare(`
        SELECT COUNT(*) as sessions,
               AVG(cache_hit_pct)       as cache,
               AVG(first_attempt_pct)   as fa,
               AVG(error_recovery_pct)  as recovery,
               SUM(total_turns)         as turns,
               SUM(total_output_tokens) as output
        FROM sessions WHERE started_at > ?
      `).get(since);

      return { content: [{ type: 'text', text: [
        `## Efficiency (last ${days} days)`,
        `- Sessions: ${s.sessions || 0}`,
        `- Cache hit: ${(s.cache || 0).toFixed(1)}%`,
        `- First-attempt: ${(s.fa || 0).toFixed(1)}%`,
        `- Error recovery: ${(s.recovery || 0).toFixed(1)}%`,
        `- Total turns: ${s.turns || 0}`,
        `- Output tokens: ${(s.output || 0).toLocaleString()}`,
      ].join('\n') }] };
    }

    // ── get_active_recommendations ──────────────────────────────────────────
    if (name === 'get_active_recommendations') {
      const recs = db.prepare(`
        SELECT category, severity, title, description, metric_value
        FROM recommendations WHERE dismissed = 0
        ORDER BY severity DESC LIMIT 5
      `).all();
      if (!recs.length) return { content: [{ type: 'text', text: 'No active recommendations — all good!' }] };
      const text = `## Active Recommendations\n\n` +
        recs.map(r => `### [${(r.severity || '').toUpperCase()}] ${r.title}\n${r.description}\nMetric: ${r.metric_value}`).join('\n\n');
      return { content: [{ type: 'text', text }] };
    }

    // ── get_project_stats ───────────────────────────────────────────────────
    if (name === 'get_project_stats') {
      const all = computeAllProjects();
      const p = all.find(p => p.name.toLowerCase().includes((args?.project || '').toLowerCase()));
      if (!p) return { content: [{ type: 'text', text: `No project matching "${args?.project}". Known: ${all.slice(0, 8).map(x => x.name).join(', ')}` }] };
      return { content: [{ type: 'text', text: [
        `## Project: ${p.name}`,
        `- Sessions: ${p.session_count}`,
        `- Total tokens: ${p.total_tokens.toLocaleString()}`,
        `- Lines added: ${p.total_lines_added.toLocaleString()}`,
        `- Dominant tool: ${p.dominant_tool || '?'}`,
        `- Dominant model: ${p.dominant_model || '?'}`,
        `- Tools: ${JSON.stringify(p.tool_breakdown)}`,
        `- Models: ${JSON.stringify(p.model_breakdown)}`,
      ].join('\n') }] };
    }

    // ── get_model_comparison ────────────────────────────────────────────────
    if (name === 'get_model_comparison') {
      const rates = computeToolModelWinRates({ taskType: args?.task_type });
      if (!rates.length) return { content: [{ type: 'text', text: 'Not enough data yet. Complete more sessions.' }] };

      const byModel = {};
      for (const r of rates) {
        if (!byModel[r.model]) byModel[r.model] = { sessions: 0, winRates: [], tools: [] };
        byModel[r.model].sessions += r.sessions;
        byModel[r.model].winRates.push(r.win_rate);
        byModel[r.model].tools.push(r.tool_id);
      }

      const lines = [`## Model Comparison${args?.task_type ? ` — ${args.task_type}` : ''}\n`];
      const sorted = Object.entries(byModel).sort((a, b) =>
        Math.max(...b[1].winRates) - Math.max(...a[1].winRates));
      for (const [model, m] of sorted) {
        const avg = Math.round(m.winRates.reduce((a, b) => a + b, 0) / m.winRates.length);
        lines.push(`**${model}** — avg win rate: ${avg}% | sessions: ${m.sessions} | tools: ${[...new Set(m.tools)].join(', ')}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── push_handoff_note ───────────────────────────────────────────────────
    if (name === 'push_handoff_note') {
      const tool = args?.tool || 'claude-code';
      const last = db.prepare(`
        SELECT id, raw_data FROM sessions WHERE tool_id = ?
        ORDER BY ended_at DESC LIMIT 1
      `).get(tool);
      if (!last) return { content: [{ type: 'text', text: `No session found for tool "${tool}".` }] };

      let raw = {};
      try { raw = JSON.parse(last.raw_data || '{}'); } catch (_) {}
      raw._handoffNote = sanitize(args?.note || '', 500);
      raw._handoffAt = Date.now();
      db.prepare(`UPDATE sessions SET raw_data = ? WHERE id = ?`).run(JSON.stringify(raw), last.id);

      return { content: [{ type: 'text', text: `Handoff note saved. Retrieve it with get_last_session_context from another tool.` }] };
    }

    // ── get_optimal_prompt_structure ────────────────────────────────────────
    if (name === 'get_optimal_prompt_structure') {
      const { getOptimalPromptStructure } = await import('./engine/prompt-coach.js');
      const result = getOptimalPromptStructure(args.task_type || 'general');
      const text = result.available
        ? [
            `## Optimal Prompt Structure for ${result.task_type}`,
            `- Best tool: ${result.best_tool} / ${result.best_model}`,
            `- Avg turns: ${result.avg_turns} | Cache hit: ${result.avg_cache_hit}%`,
            `- Based on ${result.example_count} high-quality sessions`,
            ``,
            `### Tips:`,
            ...(result.tips || []).map(t => `- ${t}`),
          ].join('\n')
        : result.reason;
      return { content: [{ type: 'text', text }] };
    }

    // ── get_topic_summary ───────────────────────────────────────────────────
    if (name === 'get_topic_summary') {
      const { getTopicSummary, getTopicBreakdown } = await import('./engine/topic-segmenter.js');
      const summaryData = await getTopicSummary(args.project, args.topic);
      const breakdown = getTopicBreakdown(args.project);
      const group = breakdown[args.topic];

      if (!group || group.sessions.length === 0) {
        return { content: [{ type: 'text', text: `No ${args.topic} sessions found in project ${args.project}.` }] };
      }

      const text = [
        `## ${args.topic} Topic Summary — ${args.project}`,
        summaryData.summary || 'Summary not available.',
        ``,
        `Sessions: ${group.sessions.length} | Tokens: ${group.total_tokens.toLocaleString()}`,
        group.low_relevance_count > 0 ? `⚠ ${group.low_relevance_count} session(s) may not be project-related` : '',
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text', text }] };
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
