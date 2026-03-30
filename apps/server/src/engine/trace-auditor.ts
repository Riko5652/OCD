/**
 * Trace-to-Evidence Audit Engine
 *
 * Accepts an audit question, orchestrates parallel evidence gathering from
 * multiple sources (code grep, session memory, anti-patterns, config), and
 * produces a structured report stored in the audit_runs / audit_evidence tables.
 *
 * Designed to automate the manual tracing work that dominates long sessions:
 *   field -> DB table -> seed script -> production value -> verify match
 */

import { execFileSync } from 'child_process';
import { getDb } from '../db/index.js';
import { getTemplate, extractAuditEntities } from './audit-templates.js';
import { getNegativeConstraints } from './anti-pattern-graph.js';
import { embedText, cosineSimilarity } from '../lib/vector-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuditEvidence {
    evidence_type: string;
    status: 'verified' | 'broken' | 'missing' | 'degraded';
    source: string;
    description: string;
    file_path?: string;
    line_number?: number;
    raw_content?: string;
    confidence: number;
}

export interface AuditResult {
    id: string;
    question: string;
    template_key: string | null;
    project: string | null;
    status: 'completed' | 'failed';
    evidence: AuditEvidence[];
    verified_count: number;
    broken_count: number;
    missing_count: number;
    suggestions_count: number;
    duration_ms: number;
    report: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Run ripgrep on a project directory using execFileSync (no shell injection). */
function grepProject(
    projectPath: string,
    pattern: string,
    globs: string[],
    maxResults = 20,
): Array<{ file: string; line: number; content: string }> {
    const results: Array<{ file: string; line: number; content: string }> = [];

    const args: string[] = [
        '-n',
        '--no-heading',
        '--max-count', String(maxResults),
    ];
    for (const g of globs) {
        args.push('--glob', g);
    }
    args.push('--fixed-strings', pattern, projectPath);

    try {
        const output = execFileSync('rg', args, {
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 1024 * 1024,
        }).trim();

        if (!output) return results;

        for (const line of output.split('\n').slice(0, maxResults)) {
            // rg output: file:line:content
            const match = line.match(/^(.+?):(\d+):(.*)$/);
            if (match) {
                results.push({
                    file: match[1].replace(projectPath, '').replace(/^[/\\]/, ''),
                    line: parseInt(match[2], 10),
                    content: match[3].trim().slice(0, 200),
                });
            }
        }
    } catch {
        // rg not available, returned non-zero (no matches), or timeout
    }

    return results;
}

// ─── Evidence Gatherers ─────────────────────────────────────────────────────

async function gatherCodeEvidence(
    projectPath: string,
    patterns: string[],
    globs: string[],
): Promise<AuditEvidence[]> {
    const evidence: AuditEvidence[] = [];

    for (const pattern of patterns) {
        const hits = grepProject(projectPath, pattern, globs);

        if (hits.length > 0) {
            for (const hit of hits.slice(0, 5)) {
                evidence.push({
                    evidence_type: 'code_path',
                    status: 'verified',
                    source: `grep:${hit.file}`,
                    description: `Pattern "${pattern}" found in ${hit.file}:${hit.line}`,
                    file_path: hit.file,
                    line_number: hit.line,
                    raw_content: hit.content,
                    confidence: 1.0,
                });
            }
        } else {
            evidence.push({
                evidence_type: 'code_path',
                status: 'missing',
                source: `grep:${pattern}`,
                description: `Pattern "${pattern}" not found in project (searched ${globs.join(', ')})`,
                confidence: 0.8,
            });
        }
    }

    return evidence;
}

async function gatherSessionEvidence(question: string): Promise<AuditEvidence[]> {
    const evidence: AuditEvidence[] = [];
    const db = getDb();

    try {
        const queryVec = await embedText(question.slice(0, 512));
        const rows = db.prepare(
            'SELECT session_id, embedding FROM session_embeddings ORDER BY created_at DESC LIMIT 500'
        ).all() as any[];

        const matches: Array<{ session_id: string; similarity: number }> = [];
        for (const row of rows) {
            try {
                const stored = JSON.parse(row.embedding) as number[];
                const sim = cosineSimilarity(queryVec, stored);
                if (sim >= 0.45) {
                    matches.push({ session_id: row.session_id, similarity: sim });
                }
            } catch { /* skip malformed */ }
        }

        matches.sort((a, b) => b.similarity - a.similarity);

        for (const match of matches.slice(0, 5)) {
            const session = db.prepare(
                'SELECT title, tldr, quality_score, tool_id, primary_model FROM sessions WHERE id = ?'
            ).get(match.session_id) as any;

            if (session) {
                const isHighQuality = (session.quality_score || 0) >= 60;
                evidence.push({
                    evidence_type: 'session_match',
                    status: isHighQuality ? 'verified' : 'degraded',
                    source: `session:${match.session_id}`,
                    description: `${(match.similarity * 100).toFixed(0)}% match -- "${session.title || 'Untitled'}" (${session.tool_id}, Q:${session.quality_score || '?'})`,
                    raw_content: session.tldr || undefined,
                    confidence: match.similarity,
                });
            }
        }
    } catch {
        // Embedding service unavailable -- not fatal
    }

    return evidence;
}

function gatherAntiPatternEvidence(question: string): AuditEvidence[] {
    const evidence: AuditEvidence[] = [];
    const constraints = getNegativeConstraints(question, 5);

    for (const c of constraints) {
        evidence.push({
            evidence_type: 'anti_pattern',
            status: 'degraded',
            source: `anti_pattern:${c.pattern_key}`,
            description: c.constraint_text,
            confidence: Math.min(1.0, c.failure_count / 5),
        });
    }

    return evidence;
}

function gatherConfigEvidence(
    projectPath: string,
    patterns: string[],
): AuditEvidence[] {
    const evidence: AuditEvidence[] = [];
    const configGlobs = ['.env*', '*.config.*', 'docker-compose*.yml', 'package.json'];

    for (const pattern of patterns) {
        const hits = grepProject(projectPath, pattern, configGlobs, 5);
        for (const hit of hits) {
            evidence.push({
                evidence_type: 'config_value',
                status: 'verified',
                source: `config:${hit.file}`,
                description: `Config "${pattern}" found in ${hit.file}:${hit.line}`,
                file_path: hit.file,
                line_number: hit.line,
                raw_content: hit.content,
                confidence: 1.0,
            });
        }
    }

    return evidence;
}

function gatherHandoffEvidence(question: string): AuditEvidence[] {
    const evidence: AuditEvidence[] = [];
    const db = getDb();

    try {
        const rows = db.prepare(
            `SELECT key, result FROM insight_cache WHERE key LIKE 'handoff_%' ORDER BY created_at DESC LIMIT 20`
        ).all() as any[];

        const questionLower = question.toLowerCase();
        const keywords = questionLower.split(/\s+/).filter(w => w.length > 3);

        for (const row of rows) {
            const content = (row.result || '').toLowerCase();
            const matchCount = keywords.filter(k => content.includes(k)).length;
            if (matchCount >= 2) {
                evidence.push({
                    evidence_type: 'handoff_note',
                    status: 'verified',
                    source: `handoff:${row.key}`,
                    description: `Handoff note matches ${matchCount} keywords from audit question`,
                    raw_content: (row.result || '').slice(0, 300),
                    confidence: Math.min(1.0, matchCount / keywords.length),
                });
            }
        }
    } catch { /* table may not have handoff entries */ }

    return evidence;
}

// ─── Report Builder ─────────────────────────────────────────────────────────

function buildReport(question: string, evidence: AuditEvidence[], templateName?: string): string {
    const verified = evidence.filter(e => e.status === 'verified');
    const broken = evidence.filter(e => e.status === 'broken');
    const missing = evidence.filter(e => e.status === 'missing');
    const degraded = evidence.filter(e => e.status === 'degraded');

    const lines: string[] = [];
    lines.push(`## Trace Audit: "${question}"`);
    if (templateName) lines.push(`**Template**: ${templateName}`);
    lines.push(`**Evidence**: ${evidence.length} items | Verified: ${verified.length} | Broken: ${broken.length} | Missing: ${missing.length} | Degraded: ${degraded.length}`);
    lines.push('');

    if (verified.length) {
        lines.push(`### Verified Paths (${verified.length})`);
        for (const e of verified) {
            const loc = e.file_path ? `\`${e.file_path}${e.line_number ? ':' + e.line_number : ''}\`` : '';
            lines.push(`- ${loc ? loc + ' -- ' : ''}${e.description}`);
            if (e.raw_content) lines.push(`  > \`${e.raw_content.slice(0, 120)}\``);
        }
        lines.push('');
    }

    if (broken.length) {
        lines.push(`### Broken Links (${broken.length})`);
        for (const e of broken) {
            lines.push(`- **${e.status.toUpperCase()}**: ${e.description}`);
        }
        lines.push('');
    }

    if (missing.length) {
        lines.push(`### Not Found (${missing.length})`);
        for (const e of missing) {
            lines.push(`- ${e.description}`);
        }
        lines.push('');
    }

    if (degraded.length) {
        lines.push(`### Degraded / Warnings (${degraded.length})`);
        for (const e of degraded) {
            lines.push(`- ${e.description}`);
            if (e.raw_content) lines.push(`  > ${e.raw_content.slice(0, 150)}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ─── Main Audit Runner ──────────────────────────────────────────────────────

export async function runTraceAudit(opts: {
    question: string;
    template?: string;
    project_path?: string;
    scope_globs?: string[];
}): Promise<AuditResult> {
    const startTime = Date.now();
    const id = generateId();
    const db = getDb();

    // Resolve template or build ad-hoc patterns
    const template = opts.template ? getTemplate(opts.template) : null;
    const { patterns, globs } = template
        ? { patterns: template.grep_patterns, globs: opts.scope_globs || template.file_globs }
        : extractAuditEntities(opts.question);

    // Resolve project path
    const projectPath = opts.project_path || process.cwd();
    const projectName = projectPath.split(/[/\\]/).pop() || 'unknown';

    // Insert running audit
    db.prepare(
        `INSERT INTO audit_runs (id, question, template_key, project, project_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`
    ).run(id, opts.question, opts.template || null, projectName, projectPath, startTime);

    let allEvidence: AuditEvidence[] = [];

    try {
        // Determine which evidence sources to query
        const sources = template?.evidence_sources || ['code_grep', 'session_search', 'anti_patterns', 'config_check'];

        // Run evidence gatherers in parallel
        const gatherers: Promise<AuditEvidence[]>[] = [];

        if (sources.includes('code_grep')) {
            gatherers.push(gatherCodeEvidence(projectPath, patterns, globs));
        }
        if (sources.includes('session_search')) {
            gatherers.push(gatherSessionEvidence(opts.question));
        }
        if (sources.includes('anti_patterns')) {
            gatherers.push(Promise.resolve(gatherAntiPatternEvidence(opts.question)));
        }
        if (sources.includes('config_check')) {
            gatherers.push(Promise.resolve(gatherConfigEvidence(projectPath, patterns)));
        }

        // Always check handoff notes
        gatherers.push(Promise.resolve(gatherHandoffEvidence(opts.question)));

        const results = await Promise.allSettled(gatherers);
        for (const result of results) {
            if (result.status === 'fulfilled') {
                allEvidence.push(...result.value);
            }
        }

        // Deduplicate evidence by source
        const seen = new Set<string>();
        allEvidence = allEvidence.filter(e => {
            const key = `${e.source}::${e.file_path || ''}::${e.line_number || ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Sort: verified first, then by confidence
        allEvidence.sort((a, b) => {
            const statusOrder: Record<string, number> = { verified: 0, degraded: 1, broken: 2, missing: 3 };
            const diff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
            return diff !== 0 ? diff : b.confidence - a.confidence;
        });

        const verified = allEvidence.filter(e => e.status === 'verified').length;
        const broken = allEvidence.filter(e => e.status === 'broken').length;
        const missing = allEvidence.filter(e => e.status === 'missing').length;
        const degraded = allEvidence.filter(e => e.status === 'degraded').length;
        const durationMs = Date.now() - startTime;

        const report = buildReport(opts.question, allEvidence, template?.name);

        // Persist evidence items
        const insertEvidence = db.prepare(
            `INSERT INTO audit_evidence (audit_id, evidence_type, status, source, description, file_path, line_number, raw_content, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        db.transaction(() => {
            for (const e of allEvidence) {
                insertEvidence.run(
                    id, e.evidence_type, e.status, e.source, e.description,
                    e.file_path || null, e.line_number || null,
                    e.raw_content || null, e.confidence, Date.now(),
                );
            }
        })();

        // Update audit run
        db.prepare(
            `UPDATE audit_runs SET status = 'completed', evidence_summary = ?, verified_count = ?,
             broken_count = ?, missing_count = ?, suggestions_count = ?, duration_ms = ?
             WHERE id = ?`
        ).run(report, verified, broken, missing, degraded, durationMs, id);

        return {
            id,
            question: opts.question,
            template_key: opts.template || null,
            project: projectName,
            status: 'completed',
            evidence: allEvidence,
            verified_count: verified,
            broken_count: broken,
            missing_count: missing,
            suggestions_count: degraded,
            duration_ms: durationMs,
            report,
        };
    } catch (err: any) {
        const durationMs = Date.now() - startTime;
        db.prepare(
            `UPDATE audit_runs SET status = 'failed', evidence_summary = ?, duration_ms = ? WHERE id = ?`
        ).run(`Error: ${err.message}`, durationMs, id);

        return {
            id,
            question: opts.question,
            template_key: opts.template || null,
            project: projectName,
            status: 'failed',
            evidence: allEvidence,
            verified_count: 0,
            broken_count: 0,
            missing_count: 0,
            suggestions_count: 0,
            duration_ms: durationMs,
            report: `Audit failed: ${err.message}`,
        };
    }
}

// ─── Audit History ──────────────────────────────────────────────────────────

export interface AuditHistoryEntry {
    id: string;
    question: string;
    template_key: string | null;
    project: string | null;
    status: string;
    verified_count: number;
    broken_count: number;
    missing_count: number;
    suggestions_count: number;
    duration_ms: number;
    created_at: number;
    evidence_summary: string | null;
}

export function getAuditHistory(opts: {
    question_search?: string;
    limit?: number;
    status_filter?: 'verified' | 'broken' | 'all';
}): AuditHistoryEntry[] {
    const db = getDb();
    const limit = opts.limit || 10;

    let sql = 'SELECT * FROM audit_runs WHERE 1=1';
    const params: any[] = [];

    if (opts.question_search) {
        sql += ' AND question LIKE ?';
        params.push(`%${opts.question_search}%`);
    }

    if (opts.status_filter === 'verified') {
        sql += ' AND verified_count > 0';
    } else if (opts.status_filter === 'broken') {
        sql += ' AND (broken_count > 0 OR missing_count > 0)';
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return db.prepare(sql).all(...params) as AuditHistoryEntry[];
}
