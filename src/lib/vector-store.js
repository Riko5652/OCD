// Phase B — Semantic memory: SQLite-backed vector embedding store
// Supports Ollama → OpenAI → fallback hash-based embeddings

import { getDb } from '../db.js';

const EMBEDDING_DIM = 512;
const MAX_TURN_LABELS = 20;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

let embeddingProvider = null; // resolved lazily

// ─── Table setup ────────────────────────────────────────────────────────────

/**
 * Creates the `session_embeddings` table if it does not already exist.
 * Call once at startup after `initDb()`.
 * @param {import('better-sqlite3').Database} [db] Optional db handle; defaults to getDb().
 */
export function initVectorStore(db) {
  const d = db || getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS session_embeddings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      embedding  TEXT NOT NULL,
      provider   TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_se_provider ON session_embeddings(provider);
  `);
}

// ─── Embedding providers ────────────────────────────────────────────────────

/**
 * Detect the best available embedding provider.
 * Tries Ollama first, then OpenAI, then falls back to hash-based embeddings.
 * @returns {Promise<string>} Provider name: 'ollama' | 'openai' | 'hash'
 */
async function resolveProvider() {
  if (embeddingProvider) return embeddingProvider;

  // Try Ollama (nomic-embed-text)
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'test' }),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      embeddingProvider = 'ollama';
      return embeddingProvider;
    }
  } catch (_) { /* not available */ }

  // Try OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const resp = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test' }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        embeddingProvider = 'openai';
        return embeddingProvider;
      }
    } catch (_) { /* not available */ }
  }

  embeddingProvider = 'hash';
  return embeddingProvider;
}

/**
 * Generate an embedding vector for the given text.
 * Tries providers in order: Ollama → OpenAI → hash fallback.
 * @param {string} text  The text to embed.
 * @returns {Promise<number[]>} Embedding vector (length depends on provider).
 */
export async function embedText(text) {
  const provider = await resolveProvider();

  if (provider === 'ollama') {
    return embedViaOllama(text);
  }
  if (provider === 'openai') {
    return embedViaOpenAI(text);
  }
  return hashEmbed(text);
}

async function embedViaOllama(text) {
  const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 8192) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    throw new Error(`Ollama embedding failed: ${resp.status}`);
  }
  const data = await resp.json();
  return data.embedding;
}

async function embedViaOpenAI(text) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8192) }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI embedding failed: ${resp.status}`);
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

/**
 * Fallback bag-of-words hash embedding for environments without an LLM.
 * Hashes each word to one of EMBEDDING_DIM buckets and normalises to a unit vector.
 * @param {string} text
 * @returns {number[]} Unit vector of length EMBEDDING_DIM.
 */
function hashEmbed(text) {
  const vec = new Float64Array(EMBEDDING_DIM);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  for (const word of words) {
    const h = simpleHash(word);
    const bucket = ((h % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM;
    // Use a second hash to decide sign, reducing collisions
    const sign = (simpleHash(word + '_s') % 2 === 0) ? 1 : -1;
    vec[bucket] += sign;
  }

  // Normalise to unit vector
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1;
  const result = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) result[i] = vec[i] / mag;
  return result;
}

/** DJB2 string hash. */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ─── Session embedding ──────────────────────────────────────────────────────

/**
 * Build a text representation of a session suitable for embedding.
 * @param {object} session  Row from the sessions table.
 * @param {object[]} turns  Rows from the turns table for this session.
 * @returns {string}
 */
function buildSessionText(session, turns) {
  const parts = [];

  if (session.title) parts.push(`Title: ${session.title}`);
  if (session.tldr) parts.push(`Summary: ${session.tldr}`);
  if (session.primary_model) parts.push(`Model: ${session.primary_model}`);
  if (session.tool_id) parts.push(`Tool: ${session.tool_id}`);

  // Top tools
  try {
    const topTools = JSON.parse(session.top_tools || '[]');
    if (topTools.length) parts.push(`Top tools: ${topTools.join(', ')}`);
  } catch (_) { /* ignore parse errors */ }

  // Error patterns from turns
  const errorLabels = turns
    .filter(t => t.label && /error|fail|retry|fix/i.test(t.label))
    .map(t => t.label);
  if (errorLabels.length) {
    const unique = [...new Set(errorLabels)];
    parts.push(`Error patterns: ${unique.join(', ')}`);
  }

  // First N turn labels for context
  const turnLabels = turns
    .slice(0, MAX_TURN_LABELS)
    .map(t => t.label)
    .filter(Boolean);
  if (turnLabels.length) {
    parts.push(`Turn labels: ${turnLabels.join(', ')}`);
  }

  // Task classification if available
  try {
    const db = getDb();
    const tc = db.prepare('SELECT task_type, language, framework FROM task_classifications WHERE session_id = ?')
      .get(session.id);
    if (tc) {
      if (tc.task_type) parts.push(`Task: ${tc.task_type}`);
      if (tc.language) parts.push(`Language: ${tc.language}`);
      if (tc.framework) parts.push(`Framework: ${tc.framework}`);
    }
  } catch (_) { /* table may not exist yet */ }

  return parts.join('\n');
}

/**
 * Embed a single session and store the result in session_embeddings.
 * Reads session + turns from DB, builds a text representation, generates the
 * embedding, and upserts into the session_embeddings table.
 * @param {string} sessionId  The session ID to embed.
 * @returns {Promise<{provider: string, dimensions: number}>} Metadata about the stored embedding.
 */
export async function embedSession(sessionId) {
  const db = getDb();

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const turns = db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY timestamp').all(sessionId);
  const text = buildSessionText(session, turns);

  if (!text.trim()) {
    throw new Error(`Session ${sessionId} produced empty text representation`);
  }

  const embedding = await embedText(text);
  const provider = await resolveProvider();
  const now = Date.now();

  db.prepare(`
    INSERT INTO session_embeddings (session_id, embedding, provider, dimensions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      embedding = excluded.embedding,
      provider = excluded.provider,
      dimensions = excluded.dimensions,
      updated_at = excluded.updated_at
  `).run(sessionId, JSON.stringify(embedding), provider, embedding.length, now, now);

  return { provider, dimensions: embedding.length };
}

// ─── Similarity search ──────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Value between -1 and 1.
 */
export function cosineSimilarity(a, b) {
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

/**
 * Find sessions most similar to a text query using cosine similarity.
 * Embeds the query, then performs brute-force comparison against all stored
 * session embeddings.
 * @param {string} query  Natural language query.
 * @param {number} [topK=5]  Number of results to return.
 * @returns {Promise<Array<{session_id: string, similarity: number, session: object}>>}
 *   Ranked results with similarity score and full session row.
 */
export async function findSimilar(query, topK = 5) {
  const db = getDb();
  const queryEmbedding = await embedText(query);

  const rows = db.prepare('SELECT session_id, embedding FROM session_embeddings').all();
  if (!rows.length) return [];

  const scored = [];
  for (const row of rows) {
    try {
      const stored = JSON.parse(row.embedding);
      const sim = cosineSimilarity(queryEmbedding, stored);
      scored.push({ session_id: row.session_id, similarity: sim });
    } catch (_) {
      // skip malformed embeddings
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, topK);

  // Hydrate with full session data
  const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return top.map(r => ({
    ...r,
    session: getSession.get(r.session_id) || null,
  }));
}
