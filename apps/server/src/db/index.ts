import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { migrate } from './schema.js';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), '.data', 'ai-productivity.db');
const DB_DIR = dirname(DB_PATH);
if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
}

let db: ReturnType<typeof Database> | null = null;

export function initDb() {
    if (db) return db;

    db = new Database(DB_PATH);

    // Performance Pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    migrate(db);

    return db;
}

export function getDb() {
    if (!db) {
        throw new Error('Database not initialized');
    }
    return db;
}

/** Escape LIKE metacharacters (%, _, \) for safe use in parameterized LIKE queries. */
export function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, '\\$&');
}
