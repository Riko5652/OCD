import { describe, it, expect } from 'vitest';
import {
    UnifiedSessionSchema,
    UnifiedTurnSchema,
    AiFileSchema,
    CommitScoreSchema,
    ToolIdSchema,
} from '../src/adapters/types.js';

describe('ToolIdSchema', () => {
    it('accepts valid tool IDs', () => {
        const validIds = ['claude-code', 'cursor', 'antigravity', 'aider', 'windsurf', 'copilot', 'continue', 'manual-import'];
        for (const id of validIds) {
            expect(ToolIdSchema.parse(id)).toBe(id);
        }
    });

    it('rejects invalid tool IDs', () => {
        expect(() => ToolIdSchema.parse('invalid-tool')).toThrow();
        expect(() => ToolIdSchema.parse('')).toThrow();
        expect(() => ToolIdSchema.parse(123)).toThrow();
    });
});

describe('UnifiedSessionSchema', () => {
    const minSession = {
        id: 'test-session-1',
        tool_id: 'claude-code' as const,
        started_at: Date.now(),
    };

    it('parses a minimal session with defaults', () => {
        const result = UnifiedSessionSchema.parse(minSession);
        expect(result.id).toBe('test-session-1');
        expect(result.tool_id).toBe('claude-code');
        expect(result.total_turns).toBe(0);
        expect(result.total_input_tokens).toBe(0);
        expect(result.total_output_tokens).toBe(0);
        expect(result.code_lines_added).toBe(0);
        expect(result.files_touched).toBe(0);
        expect(result.error_count).toBe(0);
    });

    it('parses a full session', () => {
        const full = {
            ...minSession,
            title: 'Test Session',
            tldr: 'A test',
            ended_at: Date.now() + 60000,
            total_turns: 15,
            total_input_tokens: 5000,
            total_output_tokens: 10000,
            total_cache_read: 2000,
            total_cache_create: 500,
            primary_model: 'claude-opus-4-6',
            models_used: ['claude-opus-4-6'],
            cache_hit_pct: 75,
            avg_latency_ms: 1200,
            top_tools: [['Read', 5], ['Write', 3]] as [string, number][],
            quality_score: 85,
            agentic_score: 7,
            code_lines_added: 120,
            code_lines_removed: 30,
            files_touched: 8,
            error_count: 2,
        };
        const result = UnifiedSessionSchema.parse(full);
        expect(result.title).toBe('Test Session');
        expect(result.total_turns).toBe(15);
        expect(result.primary_model).toBe('claude-opus-4-6');
    });

    it('rejects sessions with missing required fields', () => {
        expect(() => UnifiedSessionSchema.parse({})).toThrow();
        expect(() => UnifiedSessionSchema.parse({ id: 'test' })).toThrow();
        expect(() => UnifiedSessionSchema.parse({ id: 'test', tool_id: 'claude-code' })).toThrow();
    });

    it('rejects invalid tool_id', () => {
        expect(() => UnifiedSessionSchema.parse({ ...minSession, tool_id: 'vim' })).toThrow();
    });
});

describe('UnifiedTurnSchema', () => {
    it('parses a minimal turn with defaults', () => {
        const result = UnifiedTurnSchema.parse({ session_id: 's1', timestamp: Date.now() });
        expect(result.session_id).toBe('s1');
        expect(result.input_tokens).toBe(0);
        expect(result.output_tokens).toBe(0);
        expect(result.cache_read).toBe(0);
    });

    it('parses a full turn', () => {
        const turn = {
            session_id: 's1',
            timestamp: Date.now(),
            model: 'claude-opus-4-6',
            input_tokens: 1000,
            output_tokens: 2000,
            cache_read: 500,
            cache_create: 100,
            latency_ms: 800,
            tok_per_sec: 150,
            tools_used: ['Read', 'Write'],
            stop_reason: 'end_turn',
            label: 'Initial prompt',
            type: 1,
        };
        const result = UnifiedTurnSchema.parse(turn);
        expect(result.model).toBe('claude-opus-4-6');
        expect(result.tools_used).toEqual(['Read', 'Write']);
    });
});

describe('AiFileSchema', () => {
    it('parses a valid file entry', () => {
        const file = {
            tool_id: 'cursor' as const,
            file_path: '/src/index.ts',
            action: 'modified' as const,
            created_at: Date.now(),
        };
        const result = AiFileSchema.parse(file);
        expect(result.action).toBe('modified');
    });

    it('rejects invalid actions', () => {
        expect(() => AiFileSchema.parse({
            tool_id: 'cursor', file_path: '/test', action: 'renamed', created_at: Date.now(),
        })).toThrow();
    });
});

describe('CommitScoreSchema', () => {
    it('parses a commit score with defaults', () => {
        const result = CommitScoreSchema.parse({
            commit_hash: 'abc123',
            branch: 'main',
            scored_at: Date.now(),
        });
        expect(result.tool_id).toBe('cursor'); // default
        expect(result.lines_added).toBe(0);
        expect(result.ai_lines_added).toBe(0);
    });

    it('parses a full commit score', () => {
        const score = {
            commit_hash: 'abc123',
            branch: 'feature/test',
            tool_id: 'claude-code' as const,
            scored_at: Date.now(),
            lines_added: 100,
            lines_deleted: 20,
            ai_lines_added: 80,
            ai_lines_deleted: 10,
            human_lines_added: 20,
            human_lines_deleted: 10,
            ai_percentage: 80,
            commit_message: 'feat: add tests',
            commit_date: '2026-03-21',
        };
        const result = CommitScoreSchema.parse(score);
        expect(result.ai_percentage).toBe(80);
        expect(result.tool_id).toBe('claude-code');
    });
});
