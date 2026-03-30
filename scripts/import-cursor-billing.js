#!/usr/bin/env node
// Import Cursor team-usage-events CSV into OCD's billing_actuals table.
// Usage: node scripts/import-cursor-billing.js <csv-path>
//
// Creates a billing_actuals table (if not exists) and inserts per-request
// rows with real token counts and costs from Cursor's billing export.

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const csvPath = process.argv[2];

if (!csvPath) {
    console.error('Usage: node scripts/import-cursor-billing.js <csv-path>');
    process.exit(1);
}

const DB_PATH = process.env.DB_PATH || join(dirname(__filename), '..', 'apps', 'server', '.data', 'ai-productivity.db');
console.log(`DB: ${DB_PATH}`);
console.log(`CSV: ${csvPath}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create billing_actuals table
db.exec(`
    CREATE TABLE IF NOT EXISTS billing_actuals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL,
        user TEXT,
        kind TEXT,
        model_raw TEXT NOT NULL,
        model_normalized TEXT NOT NULL,
        max_mode TEXT,
        input_tokens_with_cache INTEGER DEFAULT 0,
        input_tokens_no_cache INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        source TEXT DEFAULT 'cursor-csv',
        imported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_date ON billing_actuals(date);
    CREATE INDEX IF NOT EXISTS idx_billing_model ON billing_actuals(model_normalized);
    CREATE INDEX IF NOT EXISTS idx_billing_ts ON billing_actuals(timestamp);
`);

// Model normalizer (matching OCD's model-normalizer.ts)
function normalizeModel(raw) {
    if (!raw) return 'unknown';
    const stripped = raw.replace(/^premium\s*\(([^)]+)\)$/i, '$1').trim();
    const cleaned = stripped
        .replace(/-thinking$/i, '')
        .replace(/-high$/i, '')
        .replace(/-(xhigh|low|fast|medium)(-fast)?$/i, '');

    const rules = [
        [/^claude.*opus.*4[.-]?6/i, 'claude-opus-4-6'],
        [/^claude.*4[.]?5.*opus/i, 'claude-opus-4-5'],
        [/^claude.*4[.]?6.*opus/i, 'claude-opus-4-6'],
        [/^claude.*sonnet.*4[.-]?6/i, 'claude-sonnet-4-6'],
        [/^claude.*4[.]?5.*sonnet/i, 'claude-sonnet-4-5'],
        [/^claude.*haiku/i, 'claude-haiku-4-5'],
        [/^gpt-5\.3/i, 'gpt-5.3-codex'],
        [/^gpt-5\.2/i, 'gpt-5.2'],
        [/^gpt-5\.1/i, 'gpt-5.1-codex-max'],
        [/^o3/i, 'o3'],
        [/^composer-2/i, 'composer-2'],
        [/^composer-1\.5/i, 'composer-1.5'],
        [/^composer-1/i, 'composer-1'],
        [/kimi[- ]?k2\.?5|kimi-k2p5/i, 'kimi-k2.5'],
        [/kimi/i, 'kimi-k2.5'],
        [/^gemini-3/i, 'gemini-3-pro'],
        [/^gemini/i, 'gemini'],
        [/^grok/i, 'grok-code-fast-1'],
        [/^auto$/i, 'auto'],
        [/^default$/i, 'default'],
        [/^premium$/i, 'premium'],
    ];

    for (const [pattern, canonical] of rules) {
        if (pattern.test(cleaned) || pattern.test(stripped)) return canonical;
    }
    return cleaned || 'unknown';
}

// Parse CSV line handling quoted fields
function parseCsvLine(line) {
    const cols = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
        cur += ch;
    }
    cols.push(cur);
    return cols;
}

const raw = readFileSync(csvPath, 'utf-8').trim();
const lines = raw.split('\n');
const header = parseCsvLine(lines[0]);
console.log(`Header: ${header.join(' | ')}`);
console.log(`Data rows: ${lines.length - 1}`);

const now = Date.now();
const insert = db.prepare(`
    INSERT INTO billing_actuals
    (timestamp, date, user, kind, model_raw, model_normalized, max_mode,
     input_tokens_with_cache, input_tokens_no_cache, cache_read_tokens,
     output_tokens, total_tokens, cost_usd, source, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

// Clear existing data from same source to allow re-import
const existingCount = db.prepare("SELECT COUNT(*) as cnt FROM billing_actuals WHERE source = 'cursor-csv'").get();
if (existingCount.cnt > 0) {
    console.log(`Clearing ${existingCount.cnt} existing cursor-csv rows...`);
    db.prepare("DELETE FROM billing_actuals WHERE source = 'cursor-csv'").run();
}

let imported = 0, skipped = 0;
const importRows = db.transaction((dataLines) => {
    for (const line of dataLines) {
        const cols = parseCsvLine(line);
        if (cols.length < 11) { skipped++; continue; }

        const [dateStr, user, kind, model, maxMode, inWithCache, inNoCache, cacheRead, output, total, cost] = cols;
        const ts = new Date(dateStr).getTime();
        if (isNaN(ts)) { skipped++; continue; }

        const date = dateStr.slice(0, 10);
        const normalized = normalizeModel(model);

        insert.run(
            ts, date, user, kind, model, normalized, maxMode,
            parseInt(inWithCache) || 0,
            parseInt(inNoCache) || 0,
            parseInt(cacheRead) || 0,
            parseInt(output) || 0,
            parseInt(total) || 0,
            parseFloat(cost) || 0,
            'cursor-csv',
            now,
        );
        imported++;
    }
});

importRows(lines.slice(1));

// Summary
const summary = db.prepare(`
    SELECT model_normalized as model, COUNT(*) as requests,
        SUM(total_tokens) as tokens, ROUND(SUM(cost_usd), 2) as cost
    FROM billing_actuals
    GROUP BY model_normalized ORDER BY cost DESC
`).all();

const totalCost = summary.reduce((s, r) => s + r.cost, 0);

console.log(`\nImported: ${imported} rows, Skipped: ${skipped}`);
console.log(`Total cost: $${totalCost.toFixed(2)}\n`);
console.log('By model (normalized):');
for (const r of summary) {
    const pct = totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : '0';
    console.log(`  ${r.model}: $${r.cost.toFixed(2)} (${pct}%) — ${r.requests} requests, ${(r.tokens || 0).toLocaleString()} tokens`);
}

// Daily summary
const daily = db.prepare(`
    SELECT date, ROUND(SUM(cost_usd), 2) as cost, COUNT(*) as requests
    FROM billing_actuals GROUP BY date ORDER BY date
`).all();
console.log('\nDaily:');
for (const d of daily) {
    console.log(`  ${d.date}: $${d.cost.toFixed(2)} (${d.requests} requests)`);
}

db.close();
console.log('\nDone. Run OCD dashboard to see the data.');
