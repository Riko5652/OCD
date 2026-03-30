/**
 * Audit Templates — Built-in and custom template definitions
 *
 * Templates define the evidence-gathering strategy for common audit patterns:
 *   - Which sources to query (code grep, session search, anti-patterns, config)
 *   - What patterns to grep for
 *   - Which file globs to scope the search
 */

import { getDb } from '../db/index.js';

export interface AuditTemplate {
    key: string;
    name: string;
    description: string;
    evidence_sources: string[];
    grep_patterns: string[];
    file_globs: string[];
    built_in: boolean;
}

export function getTemplate(key: string): AuditTemplate | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM audit_templates WHERE key = ?').get(key) as any;
    if (!row) return null;
    return {
        key: row.key,
        name: row.name,
        description: row.description || '',
        evidence_sources: JSON.parse(row.evidence_sources),
        grep_patterns: JSON.parse(row.grep_patterns || '[]'),
        file_globs: JSON.parse(row.file_globs || '[]'),
        built_in: !!row.built_in,
    };
}

export function listTemplates(includeCustom = true): AuditTemplate[] {
    const db = getDb();
    const sql = includeCustom
        ? 'SELECT * FROM audit_templates ORDER BY built_in DESC, name'
        : 'SELECT * FROM audit_templates WHERE built_in = 1 ORDER BY name';
    const rows = db.prepare(sql).all() as any[];
    return rows.map(row => ({
        key: row.key,
        name: row.name,
        description: row.description || '',
        evidence_sources: JSON.parse(row.evidence_sources),
        grep_patterns: JSON.parse(row.grep_patterns || '[]'),
        file_globs: JSON.parse(row.file_globs || '[]'),
        built_in: !!row.built_in,
    }));
}

/**
 * Extract entities and keywords from a freeform audit question.
 * Used when no template is specified — builds ad-hoc grep patterns.
 */
export function extractAuditEntities(question: string): { patterns: string[]; globs: string[] } {
    const patterns: string[] = [];
    const globs: string[] = [];

    // Extract quoted strings as exact patterns
    const quoted = question.match(/"([^"]+)"|'([^']+)'/g);
    if (quoted) {
        for (const q of quoted) {
            patterns.push(q.replace(/["']/g, ''));
        }
    }

    // Extract file-like references (e.g. src/services/foo.ts, *.sql)
    const fileRefs = question.match(/\b[\w/.-]+\.(ts|js|sql|json|yml|yaml|env|css)\b/g);
    if (fileRefs) {
        for (const f of fileRefs) {
            globs.push(f.includes('*') ? f : `**/${f}`);
        }
    }

    // Extract PascalCase/camelCase identifiers likely to be class/function names
    const identifiers = question.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g);
    if (identifiers) {
        for (const id of identifiers) {
            if (!STOP_WORDS.has(id.toLowerCase())) {
                patterns.push(id);
            }
        }
    }

    // Extract snake_case identifiers (env vars, DB columns)
    const snakeCase = question.match(/\b[A-Z][A-Z0-9_]{2,}\b/g);
    if (snakeCase) {
        for (const sc of snakeCase) {
            if (!STOP_WORDS.has(sc.toLowerCase())) {
                patterns.push(sc);
            }
        }
    }

    // Fallback: use significant words from the question
    if (patterns.length === 0) {
        const words = question.toLowerCase().split(/\s+/).filter(w =>
            w.length > 3 && !STOP_WORDS.has(w)
        );
        patterns.push(...words.slice(0, 5));
    }

    // Default globs if none detected
    if (globs.length === 0) {
        globs.push('src/**/*.ts', 'scripts/**/*.ts', 'migrations/**/*.sql');
    }

    return { patterns, globs };
}

const STOP_WORDS = new Set([
    'this', 'that', 'what', 'when', 'where', 'which', 'there', 'their', 'about',
    'from', 'with', 'have', 'been', 'does', 'being', 'would', 'could', 'should',
    'into', 'also', 'then', 'than', 'they', 'will', 'each', 'make', 'like',
    'just', 'over', 'such', 'take', 'only', 'some', 'very', 'after', 'before',
    'other', 'know', 'most', 'much', 'well', 'back', 'even', 'want', 'because',
    'these', 'give', 'many', 'more', 'still', 'long', 'same', 'right', 'look',
    'think', 'come', 'find', 'here', 'thing', 'tell', 'help', 'every', 'good',
    'audit', 'check', 'verify', 'trace', 'investigate', 'debug', 'error',
]);
