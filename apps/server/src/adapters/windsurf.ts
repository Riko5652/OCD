// Windsurf adapter — reads Codeium's local SQLite DB
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn } from './types.js';

export class WindsurfAdapter implements IAiAdapter {
    readonly id: ToolId = 'windsurf';
    readonly name = 'Windsurf';

    private getDb(): ReturnType<typeof Database> | null {
        const dbPath = config.windsurf.dbPath;
        if (!existsSync(dbPath)) return null;
        try {
            return new Database(dbPath, { readonly: true, fileMustExist: true });
        } catch {
            return null;
        }
    }

    async getSessions(): Promise<UnifiedSession[]> {
        const db = this.getDb();
        if (!db) return [];

        try {
            const sessions = db.prepare(`
                SELECT id, title, model, created_at, updated_at,
                       message_count, total_tokens_sent, total_tokens_received
                FROM chat_sessions ORDER BY updated_at DESC LIMIT 500
            `).all() as any[];

            return sessions.map(s => ({
                id: `windsurf-${s.id}`,
                tool_id: 'windsurf' as ToolId,
                title: s.title || 'Windsurf session',
                started_at: s.created_at,
                ended_at: s.updated_at,
                total_turns: Math.max(1, Math.floor((s.message_count || 0) / 2)),
                total_input_tokens: s.total_tokens_sent || 0,
                total_output_tokens: s.total_tokens_received || 0,
                total_cache_read: 0,
                total_cache_create: 0,
                primary_model: s.model || 'windsurf-default',
                models_used: [s.model || 'windsurf-default'],
                code_lines_added: 0,
                code_lines_removed: 0,
                files_touched: 0,
                error_count: 0,
                raw: { windsurfId: s.id },
            }));
        } catch {
            return [];
        } finally {
            if (db.open) db.close();
        }
    }

    async getTurns(_sessionId: string): Promise<UnifiedTurn[]> {
        return [];
    }
}
