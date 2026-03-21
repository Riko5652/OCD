import { getDb } from '../db/index.js';
import { z } from 'zod';

// For this rewrite, we leverage better-sqlite3 and simple brute force cosine similarity 
// directly in TS using Float32Array for speed without WASM overhead.

export const EmbeddingProviderSchema = z.enum(['ollama', 'openai', 'hash']);
export type EmbeddingProvider = z.infer<typeof EmbeddingProviderSchema>;

export class VectorService {
    /**
     * Generates a basic deterministic hash-based embedding for fallback semantic search
     */
    static generateHashEmbedding(text: string, dimensions = 512): number[] {
        const vector = new Array(dimensions).fill(0);
        const words = text.toLowerCase().match(/\b(\w+)\b/g);
        if (!words) return vector;

        for (const word of words) {
            let hash = 0;
            for (let i = 0; i < word.length; i++) {
                hash = ((hash << 5) - hash) + word.charCodeAt(i);
                hash |= 0;
            }
            const index = Math.abs(hash) % dimensions;
            vector[index] += 1;
        }

        // Normalize
        const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
        if (magnitude > 0) {
            for (let i = 0; i < dimensions; i++) {
                vector[i] /= magnitude;
            }
        }
        return vector;
    }

    /**
     * Fast cosine similarity between two numeric arrays
     */
    static cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        const fb = new Float32Array(b); // Simulate fast memory alignment

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            const valA = a[i];
            const valB = fb[i];
            dotProduct += valA * valB;
            normA += valA * valA;
            normB += valB * valB;
        }

        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Save an embedding for a session
     */
    async saveSessionEmbedding(sessionId: string, text: string, provider: EmbeddingProvider = 'hash') {
        const db = getDb();

        // Default to the fast hash fallback for now unless Ollama/OpenAI is explicitly hooked up
        const vector = VectorService.generateHashEmbedding(text);

        const stmt = db.prepare(`
      INSERT OR REPLACE INTO session_embeddings (session_id, embedding, provider, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

        stmt.run(
            sessionId,
            JSON.stringify(vector),
            provider,
            vector.length,
            Date.now()
        );
    }

    /**
     * Search for similar sessions using brutal force Float32Array
     */
    async searchSimilarSessions(queryText: string, limit = 5, matchThreshold = 0.5) {
        const db = getDb();

        const queryVector = VectorService.generateHashEmbedding(queryText);

        // In better-sqlite3, we can load all vectors instantly
        const stmt = db.prepare(`SELECT session_id, embedding FROM session_embeddings`);
        const rows = stmt.all() as { session_id: string, embedding: string }[];

        const results = [];

        for (const row of rows) {
            try {
                const storedVector = JSON.parse(row.embedding) as number[];
                const similarity = VectorService.cosineSimilarity(queryVector, storedVector);

                if (similarity >= matchThreshold) {
                    results.push({
                        session_id: row.session_id,
                        similarity
                    });
                }
            } catch (e) {
                // Skip malformed vectors
            }
        }

        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }
}
