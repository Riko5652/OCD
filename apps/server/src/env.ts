// Environment variable validation — validates and parses all env vars at startup
import { z } from 'zod';

const portLike = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
    // Server
    PORT: portLike.default(3030),
    BIND: z.string().default('127.0.0.1'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    AUTH_TOKEN: z.string().optional(),
    HISTORY_DAYS: z.coerce.number().int().min(0).default(0),

    // Database
    DB_PATH: z.string().optional(),

    // LLM providers (all optional — local-first)
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    AZURE_OPENAI_ENDPOINT: z.string().optional(),
    AZURE_OPENAI_DEPLOYMENT_CHAT: z.string().default('gpt-5.2-chat'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().optional(),
    OLLAMA_HOST: z.string().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('gemma2:2b'),
    PREFERRED_LLM_PROVIDER: z.string().default(''),
    LOCAL_ARBITRAGE_MODEL: z.string().default('llama3'),
    LOCAL_SUCCESS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),

    // Tool paths (all optional — auto-detected)
    CURSOR_STATE_DB: z.string().optional(),
    CURSOR_TRACKING_DB: z.string().optional(),
    CURSOR_IMPORT_DIR: z.string().optional(),
    CURSOR_CSV_DIR: z.string().optional(),
    CLAUDE_PROJECT_DIR: z.string().optional(),
    ANTIGRAVITY_DIR: z.string().optional(),
    AIDER_LOGS_DIR: z.string().optional(),
    WINDSURF_DB: z.string().optional(),
    CONTINUE_SESSIONS_DIR: z.string().optional(),
    GIT_SCAN_PATHS: z.string().optional(),
    TERMINAL_LOG_PATHS: z.string().optional(),

    // P2P sync
    P2P_SECRET: z.string().default(''),
    P2P_DISCOVERY_PORT: portLike.default(39831),
    P2P_HTTP_PORT: portLike.default(39832),

    // Misc
    WEBHOOK_SECRET: z.string().default(''),
    UPDATE_CHECK: z.string().default(''),
}).passthrough();

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Parse and validate environment variables. Logs warnings for security-sensitive defaults.
 * Call once at startup before accessing env vars.
 */
export function validateEnv(logger?: { warn: (msg: string) => void }): Env {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        const issues = result.error.issues
            .map(i => `  ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid environment variables:\n${issues}`);
    }

    const env = result.data;
    const warn = logger?.warn ?? console.warn.bind(console);

    // Security: require AUTH_TOKEN when binding to non-localhost
    const isLocalhost = env.BIND === '127.0.0.1' || env.BIND === 'localhost' || env.BIND === '::1';
    if (!isLocalhost && !env.AUTH_TOKEN) {
        throw new Error(
            'AUTH_TOKEN is required when BIND is set to a non-localhost address. ' +
            'Set AUTH_TOKEN to a strong secret to protect API endpoints, or use BIND=127.0.0.1 for local-only access.'
        );
    }

    if (env.P2P_SECRET && env.P2P_SECRET.length < 32) {
        warn('P2P_SECRET is set but shorter than 32 characters. Use a stronger secret for peer sync.');
    }

    _env = env;
    return env;
}

/** Get validated env (throws if validateEnv() hasn't been called) */
export function getEnv(): Env {
    if (!_env) throw new Error('validateEnv() must be called before getEnv()');
    return _env;
}
