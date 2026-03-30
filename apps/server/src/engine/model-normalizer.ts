// Model normalizer — maps Cursor/IDE model slugs to canonical names + accurate pricing
// Solves: model fragmentation (kimi-k2.5 vs accounts/fireworks/models/kimi-k2p5),
// missing pricing for GPT-5.3-codex, Kimi, Composer, and duplicate slug entries.

/** Canonical model family → pricing per 1M tokens (USD) */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    // Anthropic
    'claude-opus-4-6':           { input: 15.00, output: 75.00 },
    'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
    'claude-sonnet-4-5':         { input: 3.00,  output: 15.00 },
    'claude-haiku-4-5':          { input: 0.80,  output: 4.00 },
    'claude-opus-4-5':           { input: 15.00, output: 75.00 },

    // OpenAI
    'gpt-5.3-codex':             { input: 2.50,  output: 10.00 },
    'gpt-5.2':                   { input: 2.50,  output: 10.00 },
    'gpt-5.1-codex-max':         { input: 2.50,  output: 10.00 },
    'o3':                        { input: 10.00, output: 40.00 },

    // Cursor proprietary
    'composer-2':                { input: 2.00,  output: 8.00 },
    'composer-1.5':              { input: 1.50,  output: 6.00 },
    'composer-1':                { input: 1.00,  output: 4.00 },

    // Kimi / Moonshot (via Fireworks)
    'kimi-k2.5':                 { input: 0.39,  output: 1.56 },
    'kimi-k2':                   { input: 0.30,  output: 1.20 },

    // Google
    'gemini-3-pro':              { input: 1.25,  output: 5.00 },
    'gemini':                    { input: 0.15,  output: 0.60 },

    // xAI
    'grok-code-fast-1':          { input: 3.00,  output: 15.00 },

    // Cursor special slugs
    'auto':                      { input: 1.00,  output: 4.00 },
    'default':                   { input: 1.00,  output: 4.00 },
    'premium':                   { input: 3.00,  output: 12.00 },

    // Fallback
    '_default':                  { input: 1.00,  output: 4.00 },
};

/**
 * Normalization rules: regex pattern → canonical model name.
 * Order matters — first match wins.
 */
const NORMALIZATION_RULES: [RegExp, string][] = [
    // Anthropic — normalize version suffixes and thinking variants
    [/^claude-opus-4-6/i,                              'claude-opus-4-6'],
    [/^claude[- ]?4\.5[- ]?opus/i,                     'claude-opus-4-5'],
    [/^claude-sonnet-4-6/i,                            'claude-sonnet-4-6'],
    [/^claude[- ]?4\.5[- ]?sonnet/i,                   'claude-sonnet-4-5'],
    [/^claude-sonnet-4-5/i,                            'claude-sonnet-4-5'],
    [/^claude[- ]?4\.5[- ]?haiku/i,                    'claude-haiku-4-5'],
    [/^claude-haiku-4-5/i,                             'claude-haiku-4-5'],

    // OpenAI — normalize quality tiers (xhigh, low, fast)
    [/^gpt-5\.3-codex/i,                               'gpt-5.3-codex'],
    [/^gpt-5\.2/i,                                     'gpt-5.2'],
    [/^gpt-5\.1-codex/i,                               'gpt-5.1-codex-max'],
    [/^o3/i,                                           'o3'],

    // Cursor Composer — normalize fast/slow variants
    [/^composer-2/i,                                   'composer-2'],
    [/^composer-1\.5/i,                                'composer-1.5'],
    [/^composer-1/i,                                   'composer-1'],

    // Kimi — normalize Fireworks proxy path and variants
    [/kimi[- ]?k2\.?5|kimi-k2p5/i,                    'kimi-k2.5'],
    [/kimi[- ]?k2[- ]?instruct/i,                      'kimi-k2'],
    [/kimi/i,                                          'kimi-k2.5'],

    // Google
    [/^gemini-3/i,                                     'gemini-3-pro'],
    [/^gemini/i,                                       'gemini'],

    // xAI
    [/^grok/i,                                         'grok-code-fast-1'],

    // Cursor meta-models
    [/^auto$/i,                                        'auto'],
    [/^default$/i,                                     'default'],
    [/^premium$/i,                                     'premium'],
];

/**
 * Normalize a raw model slug to its canonical name.
 * Handles: repeated slugs ("gpt-5.1-codex-max,gpt-5.1-codex-max,..."),
 * Fireworks proxy paths ("accounts/fireworks/models/kimi-k2p5"),
 * quality tiers ("gpt-5.3-codex-xhigh"), and thinking suffixes.
 */
export function normalizeModel(raw: string | null | undefined): string {
    if (!raw) return 'unknown';

    // Strip repeated comma-separated duplicates (Cursor bug: "model,model,model")
    const deduped = raw.includes(',') ? raw.split(',')[0].trim() : raw.trim();

    // Strip Fireworks/provider proxy paths
    const stripped = deduped.includes('/') ? deduped.split('/').pop()! : deduped;

    // Strip common suffixes that don't affect identity
    const cleaned = stripped
        .replace(/-thinking$/i, '')
        .replace(/-high$/i, '')
        .replace(/-(xhigh|low|fast|medium)(-fast)?$/i, '');

    // Match against normalization rules
    for (const [pattern, canonical] of NORMALIZATION_RULES) {
        if (pattern.test(cleaned) || pattern.test(stripped)) {
            return canonical;
        }
    }

    return cleaned || 'unknown';
}

/**
 * Get pricing for a model (normalized or raw).
 */
export function pricingFor(model: string | null): { input: number; output: number } {
    const canonical = normalizeModel(model);
    return MODEL_PRICING[canonical] || MODEL_PRICING['_default'];
}

/**
 * Estimate cost for a model + token counts.
 */
export function estimateCost(
    model: string | null,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
): { inputCost: number; outputCost: number; cacheSavings: number; totalCost: number } {
    const pricing = pricingFor(model);
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheSavings = (cacheReadTokens / 1_000_000) * pricing.input * 0.9;
    return { inputCost, outputCost, cacheSavings, totalCost: inputCost + outputCost };
}
