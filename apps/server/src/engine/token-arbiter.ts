/**
 * Automated Token Arbitrage & Cost Routing
 *
 * Evolves `get_routing_recommendation` into an active local proxy.
 * When an AI agent (via the Fastify /api/proxy/completion endpoint) requests
 * a completion, the arbiter:
 *   1. Classifies the task type from the prompt.
 *   2. Looks up the historical success rate for this task type.
 *   3. If ≥ 95% success rate with a local model → routes to Ollama.
 *   4. If the task historically required deep reasoning → allows through to
 *      the premium model originally requested.
 *   5. Logs every routing decision to `arbitrage_log` for audit + savings report.
 */

import { getDb } from '../db/index.js';

// ─── Model tiers ──────────────────────────────────────────────────────────────

export interface ModelSpec {
    id: string;
    tier: 'local' | 'cheap' | 'premium';
    inputCostPer1M: number;
    outputCostPer1M: number;
    ollamaModel?: string; // set for local models to call via Ollama
}

export const MODEL_REGISTRY: ModelSpec[] = [
    // Local (free)
    { id: 'llama3', tier: 'local', inputCostPer1M: 0, outputCostPer1M: 0, ollamaModel: 'llama3' },
    { id: 'llama3.1', tier: 'local', inputCostPer1M: 0, outputCostPer1M: 0, ollamaModel: 'llama3.1' },
    { id: 'codellama', tier: 'local', inputCostPer1M: 0, outputCostPer1M: 0, ollamaModel: 'codellama' },
    { id: 'deepseek-coder', tier: 'local', inputCostPer1M: 0, outputCostPer1M: 0, ollamaModel: 'deepseek-coder' },
    { id: 'qwen2.5-coder', tier: 'local', inputCostPer1M: 0, outputCostPer1M: 0, ollamaModel: 'qwen2.5-coder' },
    // Cheap cloud
    { id: 'claude-haiku-4-5-20251001', tier: 'cheap', inputCostPer1M: 0.80, outputCostPer1M: 4.00 },
    { id: 'gemini-flash', tier: 'cheap', inputCostPer1M: 0.075, outputCostPer1M: 0.30 },
    { id: 'gpt-4o-mini', tier: 'cheap', inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
    // Premium
    { id: 'claude-sonnet-4-6', tier: 'premium', inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
    { id: 'claude-opus-4-6', tier: 'premium', inputCostPer1M: 15.00, outputCostPer1M: 75.00 },
    { id: 'gpt-4o', tier: 'premium', inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
    { id: 'gpt-5.1-codex-max', tier: 'premium', inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
    { id: 'gemini-pro', tier: 'premium', inputCostPer1M: 1.25, outputCostPer1M: 5.00 },
];

const modelById = new Map(MODEL_REGISTRY.map(m => [m.id, m]));

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const LOCAL_ARBITRAGE_MODEL = process.env.LOCAL_ARBITRAGE_MODEL || 'llama3';
const LOCAL_SUCCESS_THRESHOLD = parseFloat(process.env.LOCAL_SUCCESS_THRESHOLD || '0.92');

// ─── Task classification (mirrors cross-tool-router signals) ──────────────────

const TASK_SIGNALS: Record<string, RegExp[]> = {
    migration: [/migrat|schema\.sql|alembic|flyway|db\.exec|CREATE TABLE/i],
    component: [/\.tsx|\.jsx|react|useState|useEffect|styled|tailwind/i],
    debug: [/error|exception|crash|traceback|undefined is not|cannot read/i],
    refactor: [/refactor|rename|extract|clean up|reorganize/i],
    test: [/test|spec|vitest|jest|describe\(|it\(|expect\(/i],
    api: [/endpoint|route|handler|app\.get|app\.post|router\./i],
    devops: [/docker|nginx|ci|deploy|pipeline|Dockerfile/i],
    boilerplate: [/scaffold|template|boilerplate|starter|init|create.+project/i],
    documentation: [/readme|docstring|jsdoc|comment|explain|summarize/i],
};

function classifyPrompt(prompt: string): string {
    const lower = prompt.toLowerCase();
    for (const [type, patterns] of Object.entries(TASK_SIGNALS)) {
        if (patterns.some(p => p.test(lower))) return type;
    }
    return 'general';
}

// ─── Historical success lookup ─────────────────────────────────────────────────

interface SuccessStats {
    taskType: string;
    localSuccessRate: number;
    avgTurnsWithLocal: number;
    sampleSize: number;
}

function getLocalSuccessStats(taskType: string): SuccessStats {
    const db = getDb();

    // Count sessions where a local/cheap model was used for this task type
    // and resulted in high quality (proxy for "success")
    const rows = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN s.quality_score >= 70 AND s.error_count = 0 THEN 1 ELSE 0 END) AS successes,
            AVG(s.total_turns) AS avg_turns
        FROM sessions s
        JOIN task_classifications tc ON tc.session_id = s.id
        WHERE tc.task_type = ?
          AND s.primary_model IN (${MODEL_REGISTRY.filter(m => m.tier === 'local').map(() => '?').join(',')})
    `).get(taskType, ...MODEL_REGISTRY.filter(m => m.tier === 'local').map(m => m.id)) as any;

    const total = rows?.total || 0;
    const successes = rows?.successes || 0;

    return {
        taskType,
        localSuccessRate: total > 0 ? successes / total : 0,
        avgTurnsWithLocal: rows?.avg_turns || 0,
        sampleSize: total,
    };
}

// ─── Arbitrage decision ───────────────────────────────────────────────────────

export interface ArbitrageDecision {
    originalModel: string;
    routedModel: string;
    routeToLocal: boolean;
    taskType: string;
    complexity: string;
    localSuccessRate: number;
    sampleSize: number;
    estimatedSavingsUsd: number;
    reason: string;
}

const COMPLEXITY_THRESHOLDS = {
    simple: 500,      // prompt length < 500 chars → simple
    moderate: 2000,   // < 2000 → moderate
};

function assessComplexity(prompt: string): string {
    const len = prompt.length;
    if (len < COMPLEXITY_THRESHOLDS.simple) return 'simple';
    if (len < COMPLEXITY_THRESHOLDS.moderate) return 'moderate';
    return 'complex';
}

export function makeArbitrageDecision(prompt: string, requestedModel: string): ArbitrageDecision {
    const taskType = classifyPrompt(prompt);
    const complexity = assessComplexity(prompt);
    const stats = getLocalSuccessStats(taskType);

    const requested = modelById.get(requestedModel) || MODEL_REGISTRY.find(m => requestedModel.includes(m.id)) || MODEL_REGISTRY.find(m => m.id === 'claude-sonnet-4-6')!;
    const localModel = MODEL_REGISTRY.find(m => m.ollamaModel === LOCAL_ARBITRAGE_MODEL)!;

    // Criteria for local routing:
    // 1. Task type has high local success rate OR is boilerplate/documentation
    // 2. Complexity is simple or moderate
    // 3. Ollama is likely available (we don't ping here to keep this sync)
    const isBoilerplate = ['boilerplate', 'documentation', 'test'].includes(taskType);
    const highLocalSuccess = stats.sampleSize >= 3 && stats.localSuccessRate >= LOCAL_SUCCESS_THRESHOLD;
    const notComplex = complexity !== 'complex';

    const routeToLocal = notComplex && (highLocalSuccess || isBoilerplate);

    const effectiveModel = routeToLocal ? localModel : requested;

    // Estimate savings (tokens unknown, assume ~500 in + ~500 out for simple)
    const estInputTokens = Math.min(Math.ceil(prompt.length / 4), 4000);
    const estOutputTokens = 500;
    const originalCost = ((estInputTokens / 1_000_000) * requested.inputCostPer1M) +
        ((estOutputTokens / 1_000_000) * requested.outputCostPer1M);
    const routedCost = ((estInputTokens / 1_000_000) * effectiveModel.inputCostPer1M) +
        ((estOutputTokens / 1_000_000) * effectiveModel.outputCostPer1M);
    const estimatedSavingsUsd = Math.max(0, originalCost - routedCost);

    let reason: string;
    if (routeToLocal) {
        reason = isBoilerplate
            ? `Task type "${taskType}" is boilerplate — routing to local model for zero cost.`
            : `Local models resolve "${taskType}" tasks at ${(stats.localSuccessRate * 100).toFixed(0)}% success rate (${stats.sampleSize} samples) — routing locally.`;
    } else {
        reason = stats.sampleSize < 3
            ? `Insufficient local history for "${taskType}" — keeping premium model.`
            : complexity === 'complex'
                ? `Complex prompt (${prompt.length} chars) — keeping premium model for deep reasoning.`
                : `Local success rate ${(stats.localSuccessRate * 100).toFixed(0)}% below threshold — keeping premium model.`;
    }

    return {
        originalModel: requestedModel,
        routedModel: effectiveModel.id,
        routeToLocal,
        taskType,
        complexity,
        localSuccessRate: stats.localSuccessRate,
        sampleSize: stats.sampleSize,
        estimatedSavingsUsd,
        reason,
    };
}

// ─── Log decision ──────────────────────────────────────────────────────────────

export function logArbitrageDecision(decision: ArbitrageDecision) {
    const db = getDb();
    db.prepare(`
        INSERT INTO arbitrage_log
          (logged_at, task_type, complexity, original_model, routed_model,
           routed_to_local, historical_success_rate, estimated_cost_original, estimated_cost_routed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        Date.now(),
        decision.taskType,
        decision.complexity,
        decision.originalModel,
        decision.routedModel,
        decision.routeToLocal ? 1 : 0,
        decision.localSuccessRate,
        null,  // actual cost tracked separately
        null,
    );
}

// ─── Ollama proxy forward ─────────────────────────────────────────────────────

export interface CompletionRequest {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    [key: string]: unknown;
}

export interface CompletionResponse {
    routed_model: string;
    original_model: string;
    route_to_local: boolean;
    decision_reason: string;
    estimated_savings_usd: number;
    response: any;
}

export async function proxyCompletion(req: CompletionRequest): Promise<CompletionResponse> {
    const promptText = req.messages.map(m => m.content).join('\n');
    const decision = makeArbitrageDecision(promptText, req.model);
    logArbitrageDecision(decision);

    let response: any;

    if (decision.routeToLocal) {
        const ollamaModel = MODEL_REGISTRY.find(m => m.id === decision.routedModel)?.ollamaModel || LOCAL_ARBITRAGE_MODEL;
        // Forward to Ollama chat endpoint
        const ollamaReq = {
            model: ollamaModel,
            messages: req.messages,
            stream: false,
            options: {
                temperature: req.temperature ?? 0.2,
                num_predict: req.max_tokens ?? 2048,
            },
        };
        const ollamaResp = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaReq),
            signal: AbortSignal.timeout(120_000),
        });
        if (!ollamaResp.ok) {
            throw new Error(`Ollama proxy failed: ${ollamaResp.status} ${await ollamaResp.text()}`);
        }
        response = await ollamaResp.json();
    } else {
        // Pass-through signal: return the decision so the client forwards to its
        // preferred cloud provider.  We do not hold API keys here by design.
        response = {
            pass_through: true,
            message: 'Forward to your preferred cloud provider with the original model.',
            model: decision.routedModel,
        };
    }

    return {
        routed_model: decision.routedModel,
        original_model: decision.originalModel,
        route_to_local: decision.routeToLocal,
        decision_reason: decision.reason,
        estimated_savings_usd: decision.estimatedSavingsUsd,
        response,
    };
}

// ─── Savings summary ──────────────────────────────────────────────────────────

export function getArbitrageSummary() {
    const db = getDb();

    const overall = db.prepare(`
        SELECT
            COUNT(*) AS total_requests,
            SUM(routed_to_local) AS local_requests,
            SUM(CASE WHEN routed_to_local = 0 THEN 1 ELSE 0 END) AS premium_requests,
            AVG(historical_success_rate) AS avg_local_success_rate
        FROM arbitrage_log
    `).get() as any;

    const byTask = db.prepare(`
        SELECT task_type, COUNT(*) AS requests, SUM(routed_to_local) AS local_count,
               AVG(historical_success_rate) AS avg_success
        FROM arbitrage_log
        GROUP BY task_type ORDER BY requests DESC LIMIT 10
    `).all() as any[];

    return {
        overall: {
            total: overall?.total_requests || 0,
            local: overall?.local_requests || 0,
            premium: overall?.premium_requests || 0,
            localRatio: overall?.total_requests
                ? ((overall.local_requests || 0) / overall.total_requests)
                : 0,
            avgLocalSuccess: overall?.avg_local_success_rate || 0,
        },
        byTask,
    };
}
