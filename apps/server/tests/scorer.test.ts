import { describe, it, expect, vi } from 'vitest';

// Mock the db dependency before importing
vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            get: () => ({ cnt: 3 }),
            run: () => {},
        }),
    }),
}));

import { scoreSession } from '../src/engine/scorer.js';

describe('scoreSession', () => {
    it('scores a low-token session correctly', () => {
        const session = { id: 'test-1', total_output_tokens: 500, total_turns: 10, total_input_tokens: 200 };
        const result = scoreSession(session);
        expect(result.O).toBe(2); // < 1000 tokens
        expect(result.Q).toBeGreaterThanOrEqual(1);
        expect(result.Q).toBeLessThanOrEqual(10);
        expect(result.S).toBe(6); // 3 files (mocked)
        expect(result.value).toBe(result.O * result.Q * result.S);
        expect(result.efficiency).toBeGreaterThan(0);
    });

    it('scores a high-token session correctly', () => {
        const session = { id: 'test-2', total_output_tokens: 60000, total_turns: 50, total_input_tokens: 10000 };
        const result = scoreSession(session);
        expect(result.O).toBe(10); // >= 50000 tokens
    });

    it('scores mid-range token buckets', () => {
        expect(scoreSession({ id: 'a', total_output_tokens: 2000, total_turns: 5 }).O).toBe(4);
        expect(scoreSession({ id: 'b', total_output_tokens: 10000, total_turns: 5 }).O).toBe(6);
        expect(scoreSession({ id: 'c', total_output_tokens: 30000, total_turns: 5 }).O).toBe(8);
    });

    it('applies quality bonuses for high cache hit', () => {
        const session = { id: 'test-3', total_output_tokens: 5000, cache_hit_pct: 85, total_turns: 30 };
        const result = scoreSession(session);
        // Base Q=5, +2 for cache >= 80, +1 for turns 20-150 = 8
        expect(result.Q).toBe(8);
    });

    it('applies quality penalties for low cache and high turns', () => {
        const session = { id: 'test-4', total_output_tokens: 5000, cache_hit_pct: 40, total_turns: 250 };
        const result = scoreSession(session);
        // Base Q=5, -1 for cache < 60, -2 for turns > 200 = 2
        expect(result.Q).toBe(2);
    });

    it('clamps Q to [1, 10]', () => {
        const session = { id: 'test-5', total_output_tokens: 5000, cache_hit_pct: 10, total_turns: 300 };
        const result = scoreSession(session);
        expect(result.Q).toBeGreaterThanOrEqual(1);
        expect(result.Q).toBeLessThanOrEqual(10);
    });

    it('computes contextTokens and efficiency', () => {
        const session = { id: 'test-6', total_output_tokens: 10000, total_input_tokens: 5000, total_turns: 30 };
        const result = scoreSession(session);
        expect(result.contextTokens).toBe(15000);
        expect(result.efficiency).toBe(result.value / 15000);
    });

    it('handles zero context tokens', () => {
        const session = { id: 'test-7', total_output_tokens: 0, total_input_tokens: 0, total_turns: 0 };
        const result = scoreSession(session);
        expect(result.efficiency).toBe(0);
    });
});
