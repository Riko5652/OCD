// ── PM Dashboard Error Bridge ─────────────────────────────────────────────────
// Surfaces production errors from PM Dashboard at session start.
// Strategy: HTTP first (hits running PM Dashboard API), falls back to direct PG.

export interface ProductionErrors {
    total: number;
    bySeverity: Record<string, number>;
    topMessages: Array<{ severity: string; message: string }>;
}

const PM_DASHBOARD_URL = process.env.PM_DASHBOARD_URL || 'http://localhost:3030';

export async function getProductionErrors(): Promise<ProductionErrors | null> {
    // Try HTTP first (works when PM Dashboard is running, no auth needed for /api/health)
    const httpResult = await getErrorsViaHttp();
    if (httpResult) return httpResult;

    // Fallback to direct PostgreSQL if configured
    return getErrorsViaPg();
}

async function getErrorsViaHttp(): Promise<ProductionErrors | null> {
    try {
        const res = await fetch(`${PM_DASHBOARD_URL}/api/health/error-summary`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        if (!data.total) return null;

        return {
            total: data.total,
            bySeverity: data.bySeverity || {},
            topMessages: (data.recent || []).slice(0, 3).map((e: any) => ({
                severity: e.severity || 'medium',
                message: (e.message || '').slice(0, 80),
            })),
        };
    } catch {
        return null;
    }
}

async function getErrorsViaPg(): Promise<ProductionErrors | null> {
    const connStr = process.env.PM_DASHBOARD_DB_URL;
    if (!connStr) return null;

    let Pool: any;
    try {
        const pg = await import('pg');
        Pool = pg.default?.Pool ?? pg.Pool;
    } catch {
        return null;
    }

    const pool = new Pool({
        connectionString: connStr,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 1000,
        max: 1,
        statement_timeout: '3000',
    });

    try {
        const statsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
                COUNT(*) FILTER (WHERE severity = 'high') AS high,
                COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
                COUNT(*) FILTER (WHERE severity = 'low') AS low,
                COUNT(*) AS total
            FROM error_logs
            WHERE detected_at > NOW() - INTERVAL '24 hours'
        `);

        const row = statsResult.rows[0];
        const total = parseInt(row.total, 10) || 0;
        if (total === 0) return { total: 0, bySeverity: {}, topMessages: [] };

        const topResult = await pool.query(`
            SELECT DISTINCT ON (LEFT(error_message, 80))
                severity, LEFT(error_message, 80) AS msg
            FROM error_logs
            WHERE detected_at > NOW() - INTERVAL '24 hours'
            ORDER BY LEFT(error_message, 80),
                CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                detected_at DESC
            LIMIT 3
        `);

        return {
            total,
            bySeverity: {
                critical: parseInt(row.critical, 10) || 0,
                high: parseInt(row.high, 10) || 0,
                medium: parseInt(row.medium, 10) || 0,
                low: parseInt(row.low, 10) || 0,
            },
            topMessages: topResult.rows.map((r: any) => ({ severity: r.severity, message: r.msg })),
        };
    } catch {
        return null;
    } finally {
        await pool.end().catch(() => {});
    }
}
