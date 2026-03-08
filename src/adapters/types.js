// Unified data types for all AI tool adapters
// Each adapter normalizes its tool-specific format into these structures.

/** @typedef {'claude-code'|'cursor'|'antigravity'} ToolId */

/**
 * @typedef {Object} UnifiedSession
 * @property {string} id - Tool-specific session ID
 * @property {ToolId} tool_id
 * @property {string} [title]
 * @property {string} [tldr]
 * @property {number} started_at - Unix ms
 * @property {number} [ended_at] - Unix ms
 * @property {number} total_turns
 * @property {number} total_input_tokens
 * @property {number} total_output_tokens
 * @property {number} [total_cache_read]
 * @property {number} [total_cache_create]
 * @property {string} [primary_model]
 * @property {string[]} models_used
 * @property {number} [cache_hit_pct]
 * @property {number} [avg_latency_ms]
 * @property {Array<[string, number]>} [top_tools] - [toolName, count]
 * @property {Object} [raw] - Tool-specific extra data
 */

/**
 * @typedef {Object} UnifiedTurn
 * @property {string} session_id
 * @property {number} timestamp - Unix ms
 * @property {string} [model]
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} [cache_read]
 * @property {number} [cache_create]
 * @property {number} [latency_ms]
 * @property {number} [tok_per_sec]
 * @property {string[]} [tools_used]
 * @property {string} [stop_reason]
 * @property {string} [label] - First 100 chars preview
 * @property {number} [type] - 1=user, 2=assistant
 */

/**
 * @typedef {Object} CommitScore
 * @property {string} commit_hash
 * @property {string} branch
 * @property {ToolId} tool_id
 * @property {number} scored_at
 * @property {number} lines_added
 * @property {number} lines_deleted
 * @property {number} ai_lines_added
 * @property {number} ai_lines_deleted
 * @property {number} human_lines_added
 * @property {number} human_lines_deleted
 * @property {number} ai_percentage
 * @property {string} [commit_message]
 * @property {string} [commit_date]
 */

/**
 * @typedef {Object} AiFile
 * @property {ToolId} tool_id
 * @property {string} [session_id]
 * @property {string} file_path
 * @property {string} [file_extension]
 * @property {string} [model]
 * @property {'created'|'modified'|'deleted'} action
 * @property {number} created_at
 */

/**
 * @typedef {Object} Adapter
 * @property {ToolId} id
 * @property {string} name
 * @property {() => Promise<UnifiedSession[]>} getSessions
 * @property {(sessionId: string) => Promise<UnifiedTurn[]>} getTurns
 * @property {() => Promise<CommitScore[]>} [getCommitScores]
 * @property {() => Promise<AiFile[]>} [getAiFiles]
 * @property {() => Promise<Object>} [getDailyStats]
 */

export const TOOL_IDS = /** @type {const} */ ({
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  ANTIGRAVITY: 'antigravity',
});
