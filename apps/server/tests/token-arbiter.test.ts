import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn(() => ({ total: 0, successes: 0, avg_turns: 0 }));
const mockAll = vi.fn(() => []);
const mockRun = vi.fn();

vi.mock('../src/db/index.js', () => ({
    getDb: () => ({
        prepare: () => ({
            get: mockGet,
            all: mockAll,
            run: mockRun,
        }),
    }),
}));

import { makeArbitrageDecision, getArbitrageSummary } from '../src/engine/token-arbiter.js';

describe('makeArbitrageDecision', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockAll.mockReset();
        mockGet.mockReturnValue({ total: 0, successes: 0, avg_turns: 0 });
    });

    it('routes boilerplate tasks to local model', () => {
        // "React" matches component regex first, so use a pure boilerplate prompt
        const decision = makeArbitrageDecision('scaffold a new starter template project', 'claude-sonnet-4-6');
        expect(decision.taskType).toBe('boilerplate');
        expect(decision.routeToLocal).toBe(true);
        expect(decision.estimatedSavingsUsd).toBeGreaterThan(0);
    });

    it('routes documentation tasks to local model', () => {
        const decision = makeArbitrageDecision('write a README for this project', 'claude-sonnet-4-6');
        expect(decision.taskType).toBe('documentation');
        expect(decision.routeToLocal).toBe(true);
    });

    it('routes test tasks to local model', () => {
        const decision = makeArbitrageDecision('write vitest tests for the scorer', 'claude-sonnet-4-6');
        expect(decision.taskType).toBe('test');
        expect(decision.routeToLocal).toBe(true);
    });

    it('keeps premium model for complex prompts even with high local success', () => {
        // Complex = prompt > 2000 chars
        mockGet.mockReturnValue({ total: 10, successes: 10, avg_turns: 5 });
        const longPrompt = 'a'.repeat(2500) + ' refactor the auth module';
        const decision = makeArbitrageDecision(longPrompt, 'claude-opus-4-6');
        expect(decision.complexity).toBe('complex');
        expect(decision.routeToLocal).toBe(false);
    });

    it('routes to local when historical success rate >= threshold', () => {
        // 10 samples, 10 successes = 100% success rate
        mockGet.mockReturnValue({ total: 10, successes: 10, avg_turns: 5 });
        const decision = makeArbitrageDecision('fix the crash bug', 'claude-sonnet-4-6');
        expect(decision.localSuccessRate).toBe(1.0);
        expect(decision.routeToLocal).toBe(true);
    });

    it('keeps premium model when local success rate is below threshold', () => {
        // 10 samples, 5 successes = 50% success rate
        mockGet.mockReturnValue({ total: 10, successes: 5, avg_turns: 8 });
        const decision = makeArbitrageDecision('debug the API endpoint', 'claude-sonnet-4-6');
        expect(decision.localSuccessRate).toBe(0.5);
        expect(decision.routeToLocal).toBe(false);
    });

    it('keeps premium model when insufficient samples', () => {
        // Only 2 samples (below threshold of 3)
        mockGet.mockReturnValue({ total: 2, successes: 2, avg_turns: 3 });
        const decision = makeArbitrageDecision('refactor auth module', 'claude-sonnet-4-6');
        expect(decision.sampleSize).toBe(2);
        expect(decision.routeToLocal).toBe(false);
        expect(decision.reason).toContain('Insufficient');
    });

    it('classifies task types correctly', () => {
        mockGet.mockReturnValue({ total: 0, successes: 0, avg_turns: 0 });

        expect(makeArbitrageDecision('CREATE TABLE users migration', 'claude-sonnet-4-6').taskType).toBe('migration');
        expect(makeArbitrageDecision('build a React component with useState', 'claude-sonnet-4-6').taskType).toBe('component');
        expect(makeArbitrageDecision('fix the crash error exception', 'claude-sonnet-4-6').taskType).toBe('debug');
        expect(makeArbitrageDecision('refactor the auth module', 'claude-sonnet-4-6').taskType).toBe('refactor');
        expect(makeArbitrageDecision('add a new REST endpoint route handler', 'claude-sonnet-4-6').taskType).toBe('api');
        expect(makeArbitrageDecision('setup Docker CI pipeline', 'claude-sonnet-4-6').taskType).toBe('devops');
    });

    it('classifies complexity by prompt length', () => {
        mockGet.mockReturnValue({ total: 0, successes: 0, avg_turns: 0 });

        const short = makeArbitrageDecision('fix bug', 'claude-sonnet-4-6');
        expect(short.complexity).toBe('simple');

        const medium = makeArbitrageDecision('a'.repeat(800) + ' refactor module', 'claude-sonnet-4-6');
        expect(medium.complexity).toBe('moderate');

        const long = makeArbitrageDecision('a'.repeat(2500) + ' complex task', 'claude-sonnet-4-6');
        expect(long.complexity).toBe('complex');
    });

    it('calculates positive savings when routing to local', () => {
        const decision = makeArbitrageDecision('scaffold a new template project', 'claude-opus-4-6');
        expect(decision.routeToLocal).toBe(true);
        expect(decision.estimatedSavingsUsd).toBeGreaterThan(0);
    });

    it('calculates zero savings when keeping premium', () => {
        mockGet.mockReturnValue({ total: 10, successes: 3, avg_turns: 10 });
        const decision = makeArbitrageDecision('debug a very complex issue', 'claude-sonnet-4-6');
        expect(decision.routeToLocal).toBe(false);
        expect(decision.estimatedSavingsUsd).toBe(0);
    });

    it('handles unknown model gracefully', () => {
        const decision = makeArbitrageDecision('test something', 'unknown-model-xyz');
        expect(decision.originalModel).toBe('unknown-model-xyz');
        // Should fall back to claude-sonnet-4-6 pricing
        expect(decision).toHaveProperty('routedModel');
    });

    it('includes meaningful reason text', () => {
        const boilerplate = makeArbitrageDecision('scaffold new project template', 'claude-sonnet-4-6');
        expect(boilerplate.reason).toContain('boilerplate');

        mockGet.mockReturnValue({ total: 1, successes: 1, avg_turns: 3 });
        const insufficient = makeArbitrageDecision('debug something', 'claude-sonnet-4-6');
        expect(insufficient.reason).toContain('Insufficient');
    });
});

describe('getArbitrageSummary', () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockAll.mockReset();
    });

    it('returns zero stats when no arbitrage history', () => {
        mockGet.mockReturnValue({ total_requests: 0, local_requests: 0, premium_requests: 0, avg_local_success_rate: 0 });
        mockAll.mockReturnValue([]);
        const summary = getArbitrageSummary();
        expect(summary.overall.total).toBe(0);
        expect(summary.overall.localRatio).toBe(0);
    });

    it('calculates local ratio correctly', () => {
        mockGet.mockReturnValue({ total_requests: 100, local_requests: 60, premium_requests: 40, avg_local_success_rate: 0.88 });
        mockAll.mockReturnValue([]);
        const summary = getArbitrageSummary();
        expect(summary.overall.total).toBe(100);
        expect(summary.overall.local).toBe(60);
        expect(summary.overall.localRatio).toBeCloseTo(0.6);
    });
});
