import { z } from 'zod';

export const ToolIdSchema = z.enum([
    'claude-code',
    'cursor',
    'antigravity',
    'aider',
    'windsurf',
    'copilot',
    'continue',
    'manual-import'
]);

export type ToolId = z.infer<typeof ToolIdSchema>;

export const UnifiedSessionSchema = z.object({
    id: z.string(),
    tool_id: ToolIdSchema,
    title: z.string().optional(),
    tldr: z.string().optional(),
    started_at: z.number(), // Unix ms
    ended_at: z.number().optional(), // Unix ms
    total_turns: z.number().default(0),
    total_input_tokens: z.number().default(0),
    total_output_tokens: z.number().default(0),
    total_cache_read: z.number().default(0),
    total_cache_create: z.number().default(0),
    primary_model: z.string().optional(),
    models_used: z.array(z.string()).default([]),
    cache_hit_pct: z.number().optional(),
    avg_latency_ms: z.number().optional(),
    top_tools: z.array(z.tuple([z.string(), z.number()])).optional(), // [toolName, count]
    raw: z.record(z.any()).optional(),

    // Custom metrics for agentic workflow tracking
    quality_score: z.number().optional(),
    agentic_score: z.number().optional(), // Represents autonomy level
    code_lines_added: z.number().default(0),
    code_lines_removed: z.number().default(0),
    files_touched: z.number().default(0),
    error_count: z.number().default(0),
});

export type UnifiedSession = z.infer<typeof UnifiedSessionSchema>;

export const UnifiedTurnSchema = z.object({
    session_id: z.string(),
    timestamp: z.number(), // Unix ms
    model: z.string().optional(),
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_read: z.number().default(0),
    cache_create: z.number().default(0),
    latency_ms: z.number().optional(),
    tok_per_sec: z.number().optional(),
    tools_used: z.array(z.string()).optional(),
    stop_reason: z.string().optional(),
    label: z.string().optional(), // First 100 chars
    type: z.number().optional(), // 1=user, 2=assistant
});

export type UnifiedTurn = z.infer<typeof UnifiedTurnSchema>;

export const AiFileSchema = z.object({
    tool_id: ToolIdSchema,
    session_id: z.string().optional(),
    file_path: z.string(),
    file_extension: z.string().optional(),
    model: z.string().optional(),
    action: z.enum(['created', 'modified', 'deleted']),
    created_at: z.number(),
});

export type AiFile = z.infer<typeof AiFileSchema>;

export const CommitScoreSchema = z.object({
    commit_hash: z.string(),
    branch: z.string(),
    tool_id: ToolIdSchema.default('cursor'),
    scored_at: z.number(),
    lines_added: z.number().default(0),
    lines_deleted: z.number().default(0),
    ai_lines_added: z.number().default(0),
    ai_lines_deleted: z.number().default(0),
    human_lines_added: z.number().default(0),
    human_lines_deleted: z.number().default(0),
    ai_percentage: z.number().optional(),
    commit_message: z.string().optional(),
    commit_date: z.string().optional(),
});

export type CommitScore = z.infer<typeof CommitScoreSchema>;

/**
 * Strategy Pattern Interface for AI Tool Adapters
 */
export interface IAiAdapter {
    readonly id: ToolId;
    readonly name: string;

    getSessions(): Promise<UnifiedSession[]>;
    getTurns(sessionId: string): Promise<UnifiedTurn[]>;
    getCommitScores?(): Promise<CommitScore[]>;
    getAiFiles?(): Promise<AiFile[]>;
    getDailyStats?(): Promise<Record<string, any>>;
}
