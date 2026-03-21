import { getDb } from '../db/index.js';

const TOPIC_SIGNALS: Record<string, RegExp[]> = {
    'db-work': [/sql|postgres|migration|schema|query|pgvector|memgraph|sqlite|database/i],
    'frontend': [/react|tsx|jsx|css|component|ui|modal|button|tailwind|html|style/i],
    'debugging': [/error|exception|crash|fix|bug|traceback|undefined|null pointer|stack trace/i],
    'devops': [/docker|ci.?cd|deploy|nginx|ec2|container|pipeline|github.?action|gitlab|k8s/i],
    'writing': [/docs?|readme|confluence|jira|ticket|markdown|blog|notion|comment/i],
    'planning': [/plan|design|architect|spec|brainstorm|roadmap|requirement|user.?stor/i],
    'testing': [/test|spec|vitest|jest|coverage|mock|assert|e2e|integration.?test/i],
    'api': [/api|endpoint|route|rest|graphql|webhook|openapi|swagger/i],
};

export function detectTopic(session: any): string {
    const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
    const topTools = (() => { try { return JSON.parse(session.top_tools || '[]'); } catch { return []; } })();
    const toolNames = topTools.map(([t]: any) => (t || '').toLowerCase()).join(' ');

    const corpus = [session.title || '', session.tldr || '', toolNames,
    (raw.filesEdited || []).join(' '), raw.project || ''].join(' ').toLowerCase();

    let bestTopic = 'general';
    let bestScore = 0;
    for (const [topic, patterns] of Object.entries(TOPIC_SIGNALS)) {
        let score = 0;
        for (const pattern of patterns) {
            score += (corpus.match(new RegExp(pattern.source, 'gi')) || []).length;
        }
        if (score > bestScore) { bestScore = score; bestTopic = topic; }
    }
    return bestTopic;
}

export function scoreProjectRelevance(session: any, projectName: string | null): number {
    if (!projectName) return 0.5;
    const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
    const corpus = [session.title || '', session.tldr || '', (raw.filesEdited || []).join(' ')].join(' ').toLowerCase();

    // Use simple string matching instead of dynamic regex to avoid ReDoS
    const normalizedProject = projectName.toLowerCase().replace(/[-_]/g, '');
    const normalizedCorpus = corpus.replace(/[-_]/g, '');
    if (normalizedCorpus.includes(normalizedProject)) return 0.9;
    if ((raw.filesEdited || []).some((f: string) => f.toLowerCase().includes(projectName.toLowerCase()))) return 0.85;
    const topic = detectTopic(session);
    if (['writing', 'planning'].includes(topic) && (raw.filesEdited || []).length === 0) return 0.2;
    return 0.5;
}

export function classifyAllSessionTopics(): number {
    const db = getDb();
    const sessions = db.prepare(`SELECT id, title, tldr, raw_data, top_tools, tool_id FROM sessions WHERE topic IS NULL LIMIT 2000`).all() as any[];
    const update = db.prepare('UPDATE sessions SET topic = ?, project_relevance_score = ? WHERE id = ?');
    db.transaction(() => {
        for (const s of sessions) {
            update.run(detectTopic(s), scoreProjectRelevance(s, null), s.id);
        }
    })();
    return sessions.length;
}

export function getTopicBreakdown(projectName: string) {
    const db = getDb();
    const sessions = db.prepare(`
        SELECT id, tool_id, primary_model, topic, started_at, total_turns, total_input_tokens,
            total_output_tokens, quality_score, project_relevance_score, raw_data, title
        FROM sessions WHERE raw_data LIKE ? ORDER BY started_at DESC LIMIT 200
    `).all(`%${projectName}%`) as any[];

    const byTopic: Record<string, { sessions: any[]; total_tokens: number; low_relevance_count: number }> = {};
    for (const s of sessions) {
        const topic = s.topic || detectTopic(s);
        const relevance = s.project_relevance_score ?? scoreProjectRelevance(s, projectName);
        if (!byTopic[topic]) byTopic[topic] = { sessions: [], total_tokens: 0, low_relevance_count: 0 };
        byTopic[topic].sessions.push({ ...s, project_relevance_score: relevance });
        byTopic[topic].total_tokens += (s.total_input_tokens || 0) + (s.total_output_tokens || 0);
        if (relevance < 0.3) byTopic[topic].low_relevance_count++;
    }
    return byTopic;
}

export async function getTopicSummary(projectName: string, topic: string) {
    const db = getDb();
    const cached = db.prepare(`SELECT summary, generated_at FROM topic_clusters WHERE project_name = ? AND topic = ? AND summary IS NOT NULL AND generated_at > ?`)
        .get(projectName, topic, Date.now() - 7 * 24 * 60 * 60 * 1000) as any;
    if (cached) return { summary: cached.summary, cached: true };

    const breakdown = getTopicBreakdown(projectName);
    const group = breakdown[topic];
    if (!group || group.sessions.length === 0) return { summary: null, cached: false };

    const sessions = group.sessions;
    const totalTokens = group.total_tokens;
    const tools = [...new Set(sessions.map((s: any) => s.tool_id))].join(', ');
    const dateRange = {
        start: new Date(Math.min(...sessions.map((s: any) => s.started_at))).toISOString().slice(0, 10),
        end: new Date(Math.max(...sessions.map((s: any) => s.started_at))).toISOString().slice(0, 10),
    };
    const avgQuality = sessions.reduce((s: number, x: any) => s + (x.quality_score || 0), 0) / sessions.length;

    const summary = [
        `${sessions.length} session${sessions.length !== 1 ? 's' : ''} on ${topic} work`,
        `from ${dateRange.start} to ${dateRange.end}`, `using ${tools}.`,
        `Total tokens: ${totalTokens.toLocaleString()}.`, `Average quality: ${Math.round(avgQuality)}/100.`,
        group.low_relevance_count > 0 ? `${group.low_relevance_count} session(s) may not be directly related.` : '',
    ].filter(Boolean).join(' ');

    const existing = db.prepare('SELECT id FROM topic_clusters WHERE project_name = ? AND topic = ?').get(projectName, topic) as any;
    if (existing) {
        db.prepare('UPDATE topic_clusters SET summary = ?, total_tokens = ?, total_sessions = ?, generated_at = ? WHERE project_name = ? AND topic = ?')
            .run(summary, totalTokens, sessions.length, Date.now(), projectName, topic);
    } else {
        db.prepare('INSERT INTO topic_clusters (project_name, topic, session_ids, summary, total_tokens, total_sessions, date_range_start, date_range_end, generated_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(projectName, topic, JSON.stringify(sessions.map((s: any) => s.id).slice(0, 50)), summary, totalTokens, sessions.length,
                Math.min(...sessions.map((s: any) => s.started_at)), Math.max(...sessions.map((s: any) => s.started_at)), Date.now());
    }
    return { summary, cached: false };
}
