// Analytics routes — overview, comparison, costs, insights
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import {
    computeOverview, computeToolComparison, computeModelUsage,
    computeCodeGeneration, computeInsights, computeCostAnalysis,
    computePersonalInsights, dbGetCommitScores,
} from '../engine/analytics.js';
import { computeSavingsReport } from '../engine/savings-report.js';
import { computeTokenBudget } from '../engine/token-budget.js';
import { computeProfile, computeTrends, computePromptMetrics } from '../engine/insights.js';
import { getAgenticLeaderboard } from '../engine/agentic-scorer.js';
import { computeGuardEffectiveness } from '../engine/guard-effectiveness.js';
import type { CacheStore } from './types.js';

export default async function analyticsRoutes(fastify: FastifyInstance, opts: { cache: CacheStore; historyDays: number }) {
    const { cache, historyDays } = opts;

    fastify.get('/api/overview', async () => cache.get('overview', computeOverview));
    fastify.get('/api/compare', async () => cache.get('compare', computeToolComparison));
    fastify.get('/api/models', async () => cache.get('models', computeModelUsage));
    fastify.get('/api/code-generation', async () => cache.get('codegen', computeCodeGeneration));
    fastify.get('/api/insights', async () => cache.get('insights', computeInsights));
    fastify.get('/api/costs', async () => cache.get('costs', computeCostAnalysis));
    fastify.get('/api/personal-insights', async () => cache.get('personal', computePersonalInsights));
    fastify.get('/api/savings-report', async () => cache.get('savings', computeSavingsReport));
    fastify.get('/api/token-budget', async () => cache.get('token-budget', computeTokenBudget));

    fastify.get('/api/commits', async (request) => {
        const limit = (request.query as any).limit || 100;
        return cache.get(`commits:${limit}`, () => dbGetCommitScores(limit));
    });

    fastify.get('/api/efficiency', async () => {
        return getDb().prepare('SELECT * FROM efficiency_log ORDER BY date DESC LIMIT 500').all();
    });

    fastify.get('/api/daily-stats', async () => {
        return getDb().prepare('SELECT * FROM daily_stats ORDER BY date DESC LIMIT 365').all();
    });

    fastify.get('/api/daily', async (request) => {
        const days = (request.query as any).days ? parseInt((request.query as any).days) : historyDays;
        if (!days || days <= 0) return getDb().prepare('SELECT * FROM daily_stats ORDER BY date, tool_id').all();
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        return getDb().prepare('SELECT * FROM daily_stats WHERE date >= ? ORDER BY date, tool_id').all(cutoff);
    });

    fastify.get('/api/agentic/scores', async (request) => {
        const { days } = request.query as any;
        const clampedDays = days ? Math.max(1, Math.min(3650, parseInt(days) || 90)) : null;
        return { leaderboard: getAgenticLeaderboard({ days: clampedDays }) };
    });

    fastify.get('/api/models/performance', async (request) => {
        const { tool, model, days } = request.query as any;
        const db = getDb();
        let sql = 'SELECT * FROM model_performance WHERE 1=1';
        const params: any[] = [];
        if (tool) { sql += ' AND tool_id = ?'; params.push(tool); }
        if (model) { sql += ' AND model = ?'; params.push(model); }
        if (days) {
            const d = Math.max(1, Math.min(3650, parseInt(days) || 90));
            sql += ' AND date > ?';
            params.push(new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
        }
        sql += ' ORDER BY date DESC';
        return { models: db.prepare(sql).all(...params) };
    });

    fastify.get('/api/commit-scores', async () => {
        return getDb().prepare('SELECT * FROM commit_scores ORDER BY scored_at DESC LIMIT 200').all();
    });

    // Insight routes
    fastify.get('/api/insights/profile', async () => {
        return cache.get('ins:profile', computeProfile);
    });

    fastify.get('/api/insights/trends', async (request) => {
        const days = (request.query as any).days ? parseInt((request.query as any).days) : historyDays;
        return cache.get(`ins:trends:${days}`, () => computeTrends(days));
    });

    fastify.get('/api/insights/prompt-metrics', async () => {
        return cache.get('ins:prompt-metrics', computePromptMetrics);
    });

    fastify.get('/api/guard-effectiveness', async (request) => {
        const days = (request.query as any).days ? parseInt((request.query as any).days) : 30;
        return computeGuardEffectiveness(days);
    });
}
