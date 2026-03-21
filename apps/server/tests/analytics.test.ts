import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            all: () => [],
            get: () => ({}),
            run: () => {},
        }),
    }),
}));

import { estimateCost } from '../src/engine/analytics.js';

describe('estimateCost', () => {
    it('estimates cost for claude-opus-4-6', () => {
        const result = estimateCost('claude-opus-4-6', 1_000_000, 1_000_000);
        expect(result.inputCost).toBe(15.00);
        expect(result.outputCost).toBe(75.00);
        expect(result.totalCost).toBe(90.00);
    });

    it('estimates cost for claude-sonnet-4-6', () => {
        const result = estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
        expect(result.inputCost).toBe(3.00);
        expect(result.outputCost).toBe(15.00);
        expect(result.totalCost).toBe(18.00);
    });

    it('estimates cost for claude-haiku-4-5-20251001', () => {
        const result = estimateCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000);
        expect(result.inputCost).toBe(0.80);
        expect(result.outputCost).toBe(4.00);
        expect(result.totalCost).toBe(4.80);
    });

    it('falls back to _default pricing for unknown models', () => {
        const result = estimateCost('unknown-model', 1_000_000, 1_000_000);
        expect(result.inputCost).toBe(1.00);
        expect(result.outputCost).toBe(4.00);
        expect(result.totalCost).toBe(5.00);
    });

    it('handles null model', () => {
        const result = estimateCost(null, 1_000_000, 1_000_000);
        expect(result.totalCost).toBe(5.00);
    });

    it('calculates cache savings', () => {
        const result = estimateCost('claude-opus-4-6', 1_000_000, 500_000, 500_000);
        // cacheSavings = (500000 / 1M) * 15.00 * 0.9 = 6.75
        expect(result.cacheSavings).toBe(6.75);
    });

    it('handles zero tokens', () => {
        const result = estimateCost('claude-opus-4-6', 0, 0);
        expect(result.inputCost).toBe(0);
        expect(result.outputCost).toBe(0);
        expect(result.totalCost).toBe(0);
    });

    it('scales linearly with token count', () => {
        const half = estimateCost('claude-opus-4-6', 500_000, 500_000);
        const full = estimateCost('claude-opus-4-6', 1_000_000, 1_000_000);
        expect(full.totalCost).toBeCloseTo(half.totalCost * 2, 5);
    });
});
