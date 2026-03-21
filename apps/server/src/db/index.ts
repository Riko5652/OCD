import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { migrate } from './schema.js';

const DB_DIR = join(process.cwd(), '.data');
if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = join(DB_DIR, 'ai-productivity.db');

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
