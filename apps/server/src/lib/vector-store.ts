import { getDb } from '../db/index.js';

const EMBEDDING_DIM = 512;
const MAX_TURN_LABELS = 20;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

let embeddingProvider: string | null = null;

// ─── Provider resolution ────────────────────────────────────────────────────

async function resolveProvider(): Promise<string> {
    if (embeddingProvider) return embeddingProvider;
    try {
        const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'test' }),
            signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) { embeddingProvider = 'ollama'; return embeddingProvider; }
    } catch { /* not available */ }

    if (process.env.OPENAI_API_KEY) {
        try {
            const resp = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test' }),
                signal: AbortSignal.timeout(5000),
            });
            if (resp.ok) { embeddingProvider = 'openai'; return embeddingProvider; }
        } catch { /* not available */ }
    }

    embeddingProvider = 'hash';
    return embeddingProvider;
}

// ─── Embedding generators ───────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
    const provider = await resolveProvider();
    if (provider === 'ollama') return embedViaOllama(text);
    if (provider === 'openai') return embedViaOpenAI(text);
    return hashEmbed(text);
}

async function embedViaOllama(text: string): Promise<number[]> {
    const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 8192) }),
        signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`Ollama embedding failed: ${resp.status}`);
    const data = await resp.json() as any;
    return data.embedding;
}

async function embedViaOpenAI(text: string): Promise<number[]> {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8192) }),
    });
    if (!resp.ok) throw new Error(`OpenAI embedding failed: ${resp.status}`);
    const data = await resp.json() as any;
    return data.data[0].embedding;
}

function simpleHash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function hashEmbed(text: string): number[] {
    const vec = new Float64Array(EMBEDDING_DIM);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
        const h = simpleHash(word);
        const bucket = ((h % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM;
        const sign = (simpleHash(word + '_s') % 2 === 0) ? 1 : -1;
        vec[bucket] += sign;
    }
    let mag = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) mag += vec[i] * vec[i];
    mag = Math.sqrt(mag) || 1;
    const result = new Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) result[i] = vec[i] / mag;
    return result;
}

// ─── Session embedding ──────────────────────────────────────────────────────

function buildSessionText(session: any, turns: any[]): string {
    const parts: string[] = [];
    if (session.title) parts.push(`Title: ${session.title}`);
    if (session.tldr) parts.push(`Summary: ${session.tldr}`);
    if (session.primary_model) parts.push(`Model: ${session.primary_model}`);
    if (session.tool_id) parts.push(`Tool: ${session.tool_id}`);

    try {
        const topTools = JSON.parse(session.top_tools || '[]');
        if (topTools.length) parts.push(`Top tools: ${topTools.join(', ')}`);
    } catch { /* ignore */ }

    const errorLabels = turns.filter(t => t.label && /error|fail|retry|fix/i.test(t.label)).map(t => t.label);
    if (errorLabels.length) parts.push(`Error patterns: ${[...new Set(errorLabels)].join(', ')}`);

    const turnLabels = turns.slice(0, MAX_TURN_LABELS).map(t => t.label).filter(Boolean);
    if (turnLabels.length) parts.push(`Turn labels: ${turnLabels.join(', ')}`);

    try {
        const db = getDb();
        const tc = db.prepare('SELECT task_type, language, framework FROM task_classifications WHERE session_id = ?').get(session.id) as any;
        if (tc) {
            if (tc.task_type) parts.push(`Task: ${tc.task_type}`);
            if (tc.language) parts.push(`Language: ${tc.language}`);
            if (tc.framework) parts.push(`Framework: ${tc.framework}`);
        }
    } catch { /* table may not exist yet */ }

    return parts.join('\n');
}

export async function embedSession(sessionId: string): Promise<{ provider: string; dimensions: number }> {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp').all(sessionId) as any[];
    const text = buildSessionText(session, turns);
    if (!text.trim()) throw new Error(`Session ${sessionId} produced empty text representation`);

    const embedding = await embedText(text);
    const provider = await resolveProvider();
    const now = Date.now();

    db.prepare(`
        INSERT INTO session_embeddings (session_id, embedding, provider, dimensions, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            embedding = excluded.embedding, provider = excluded.provider,
            dimensions = excluded.dimensions, created_at = excluded.created_at
    `).run(sessionId, JSON.stringify(embedding), provider, embedding.length, now);

    return { provider, dimensions: embedding.length };
}

// ─── Similarity search ──────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

export async function findSimilar(query: string, topK = 5): Promise<Array<{ session_id: string; similarity: number; session: any }>> {
    const db = getDb();
    const queryEmbedding = await embedText(query);
    const rows = db.prepare('SELECT session_id, embedding FROM session_embeddings').all() as any[];
    if (!rows.length) return [];

    const scored: Array<{ session_id: string; similarity: number }> = [];
    for (const row of rows) {
        try {
            const stored = JSON.parse(row.embedding);
            const sim = cosineSimilarity(queryEmbedding, stored);
            scored.push({ session_id: row.session_id, similarity: sim });
        } catch { /* skip malformed */ }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return scored.slice(0, topK).map(r => ({ ...r, session: getSession.get(r.session_id) || null }));
}

// ─── Legacy-compatible VectorService class ──────────────────────────────────

export class VectorService {
    static generateHashEmbedding(text: string, dimensions = 512): number[] {
        return hashEmbed(text);
    }

    static cosineSimilarity(a: number[], b: number[]): number {
        return cosineSimilarity(a, b);
    }

    async saveSessionEmbedding(sessionId: string, text: string, provider = 'hash') {
        const db = getDb();
        const vector = hashEmbed(text);
        db.prepare(`INSERT OR REPLACE INTO session_embeddings (session_id, embedding, provider, dimensions, created_at)
            VALUES (?, ?, ?, ?, ?)`).run(sessionId, JSON.stringify(vector), provider, vector.length, Date.now());
    }

    async searchSimilarSessions(queryText: string, limit = 5, matchThreshold = 0.5) {
        const db = getDb();
        const queryVector = await embedText(queryText);
        const rows = db.prepare('SELECT session_id, embedding FROM session_embeddings ORDER BY created_at DESC LIMIT 1000').all() as any[];
        const results: Array<{ session_id: string; similarity: number }> = [];
        for (const row of rows) {
            try {
                const storedVector = JSON.parse(row.embedding) as number[];
                const similarity = cosineSimilarity(queryVector, storedVector);
                if (similarity >= matchThreshold) results.push({ session_id: row.session_id, similarity });
            } catch { /* skip */ }
        }
        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }
}
