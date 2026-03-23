import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAll = vi.fn(() => []);
const mockGet = vi.fn(() => null);
const mockRun = vi.fn();

vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            all: mockAll,
            get: mockGet,
            run: mockRun,
        }),
    }),
}));

import { checkActiveSession, getSessionHealthCheck } from '../src/engine/session-coach.js';

describe('checkActiveSession', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockAll.mockReset();
    });

    it('returns empty array when no active session', () => {
        mockGet.mockReturnValueOnce(null);
        const result = checkActiveSession();
        expect(result).toEqual([]);
    });

    it('flags long sessions with >80 turns', () => {
        mockGet.mockReturnValueOnce({
            id: 's1', tool_id: 'claude-code', total_turns: 100,
            error_count: 0, cache_hit_pct: 70, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        const longSession = result.find(n => n.id === 'long-session');
        expect(longSession).toBeDefined();
        expect(longSession!.severity).toBe('warning');
        expect(longSession!.message).toContain('100 turns');
    });

    it('flags low cache hit rate <30% with >5 turns', () => {
        mockGet.mockReturnValueOnce({
            id: 's2', tool_id: 'cursor', total_turns: 10,
            error_count: 0, cache_hit_pct: 15, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        const lowCache = result.find(n => n.id === 'low-cache');
        expect(lowCache).toBeDefined();
        expect(lowCache!.severity).toBe('tip');
    });

    it('flags high error rate >40%', () => {
        mockGet.mockReturnValueOnce({
            id: 's3', tool_id: 'claude-code', total_turns: 10,
            error_count: 5, cache_hit_pct: 70, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        const errorSpike = result.find(n => n.id === 'error-spike');
        expect(errorSpike).toBeDefined();
        expect(errorSpike!.severity).toBe('warning');
    });

    it('flags high token burn >500K with >10 turns', () => {
        mockGet.mockReturnValueOnce({
            id: 's4', tool_id: 'claude-code', total_turns: 20,
            total_input_tokens: 300000, total_output_tokens: 300000,
            error_count: 0, cache_hit_pct: 70, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        const highBurn = result.find(n => n.id === 'high-token-burn');
        expect(highBurn).toBeDefined();
    });

    it('does not flag healthy sessions', () => {
        mockGet.mockReturnValueOnce({
            id: 's5', tool_id: 'claude-code', total_turns: 15,
            total_input_tokens: 5000, total_output_tokens: 10000,
            error_count: 0, cache_hit_pct: 80, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        expect(result).toEqual([]);
    });

    it('flags poor cache in active session (<20% with >10 turns)', () => {
        mockGet.mockReturnValueOnce({
            id: 's6', tool_id: 'cursor', total_turns: 15,
            error_count: 0, cache_hit_pct: 10, started_at: Date.now() - 60000,
        });
        const result = checkActiveSession();
        const ids = result.map(n => n.id);
        expect(ids).toContain('low-cache');
        expect(ids).toContain('poor-cache-active');
    });
});

describe('getSessionHealthCheck', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns healthy with no active session', () => {
        mockGet.mockReturnValue(null);
        const result = getSessionHealthCheck();
        expect(result.status).toBe('healthy');
        expect(result.suggested_action).toBe('continue');
        expect(result.current.turns).toBe(0);
    });

    it('returns critical when turns exceed 1.3x quality drop threshold', () => {
        // First call: active session — 70 turns, well past 1.3x of 50 = 65
        mockGet.mockReturnValueOnce({
            id: 's1', tool_id: 'claude-code', total_turns: 70,
            total_input_tokens: 100000, total_output_tokens: 100000,
            cache_hit_pct: 50, error_count: 2, quality_score: 40,
            started_at: Date.now() - 3600000,
        });
        // Second call: quality drop avg (threshold 50 → 1.3x = 65, session has 70)
        mockGet.mockReturnValueOnce({ avg_turns: 50 });
        // Third call: historical averages
        mockGet.mockReturnValueOnce({ avg_cache: 60, avg_quality: 70 });
        // Fourth call: today stats
        mockGet.mockReturnValueOnce({ count: 5, tokens: 500000 });
        // Fifth call: daily average
        mockGet.mockReturnValueOnce({ avg: 400000 });

        const result = getSessionHealthCheck();
        expect(result.status).toBe('critical');
        expect(result.suggested_action).toBe('new_session');
        expect(result.nudges.length).toBeGreaterThan(0);
    });

    it('returns critical when tokens exceed 800K', () => {
        mockGet.mockReturnValueOnce({
            id: 's2', tool_id: 'cursor', total_turns: 20,
            total_input_tokens: 500000, total_output_tokens: 400000,
            cache_hit_pct: 60, error_count: 0, quality_score: 50,
            started_at: Date.now() - 1800000,
        });
        mockGet.mockReturnValueOnce({ avg_turns: null }); // no quality drop data
        mockGet.mockReturnValueOnce({ avg_cache: 65, avg_quality: 72 });
        mockGet.mockReturnValueOnce({ count: 3, tokens: 900000 });
        mockGet.mockReturnValueOnce({ avg: 300000 });

        const result = getSessionHealthCheck();
        expect(result.status).toBe('critical');
        expect(result.suggested_action).toBe('new_session');
    });

    it('returns degrading when approaching quality drop zone', () => {
        mockGet.mockReturnValueOnce({
            id: 's3', tool_id: 'claude-code', total_turns: 42,
            total_input_tokens: 80000, total_output_tokens: 80000,
            cache_hit_pct: 55, error_count: 1, quality_score: 65,
            started_at: Date.now() - 2400000,
        });
        // Quality drops at ~50 → 0.8x = 40, session has 42 turns
        mockGet.mockReturnValueOnce({ avg_turns: 50 });
        mockGet.mockReturnValueOnce({ avg_cache: 60, avg_quality: 70 });
        mockGet.mockReturnValueOnce({ count: 4, tokens: 400000 });
        mockGet.mockReturnValueOnce({ avg: 350000 });

        const result = getSessionHealthCheck();
        expect(result.status).toBe('degrading');
        expect(result.suggested_action).toBe('compact');
    });

    it('populates cross-session baselines correctly', () => {
        mockGet.mockReturnValueOnce({
            id: 's4', tool_id: 'aider', total_turns: 10,
            total_input_tokens: 20000, total_output_tokens: 30000,
            cache_hit_pct: 70, error_count: 0, quality_score: 80,
            started_at: Date.now() - 600000,
        });
        mockGet.mockReturnValueOnce({ avg_turns: 45 });
        mockGet.mockReturnValueOnce({ avg_cache: 62, avg_quality: 73 });
        mockGet.mockReturnValueOnce({ count: 8, tokens: 600000 });
        mockGet.mockReturnValueOnce({ avg: 250000 });

        const result = getSessionHealthCheck();
        expect(result.cross_session.avg_turns_before_quality_drop).toBe(45);
        expect(result.cross_session.avg_cache_hit_pct).toBe(62);
        expect(result.cross_session.avg_quality_score).toBe(73);
        expect(result.cross_session.sessions_today).toBe(8);
        expect(result.cross_session.tokens_today_k).toBe(600);
        expect(result.cross_session.daily_avg_tokens_k).toBe(250);
    });

    it('flags daily budget overshoot', () => {
        mockGet.mockReturnValueOnce({
            id: 's5', tool_id: 'claude-code', total_turns: 5,
            total_input_tokens: 5000, total_output_tokens: 5000,
            cache_hit_pct: 80, error_count: 0, quality_score: 85,
            started_at: Date.now() - 300000,
        });
        mockGet.mockReturnValueOnce({ avg_turns: null }); // no drop data
        mockGet.mockReturnValueOnce({ avg_cache: 70, avg_quality: 75 });
        // Today: 900K tokens, daily avg: 300K → 3x overshoot
        mockGet.mockReturnValueOnce({ count: 10, tokens: 900000 });
        mockGet.mockReturnValueOnce({ avg: 300000 });

        const result = getSessionHealthCheck();
        expect(result.nudges.some(n => n.includes('daily average'))).toBe(true);
    });
});
