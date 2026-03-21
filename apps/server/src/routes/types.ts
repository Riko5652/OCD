// Shared types for route modules
export interface CacheStore {
    get<T>(key: string, fn: () => T): T;
    invalidate(): void;
}

export interface LlmRateLimiter {
    check(ip: string, windowMs?: number): string | null;
}
