import { openDatabase } from '../lib/sqlite-compat.js';
import path from 'path';
import os from 'os';
import { register } from './registry.js';

const TOOL_ID = 'windsurf';

function getDbPath() {
  const bases = {
    win32:  path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
    darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
    linux:  path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage', 'codeium.codeium', 'db'),
  };
  return path.join(bases[process.platform] || bases.linux, 'ai_usage.db');
}

export const adapter = {
  id: TOOL_ID,
  name: 'Windsurf',
  getSessions: async () => {
    const dbPath = process.env.WINDSURF_DB || getDbPath();
    let wsDb;
    try { wsDb = openDatabase(dbPath, { fileMustExist: true, readonly: true }); }
    catch (_) { return []; }

    try {
      const sessions = wsDb.prepare(`
        SELECT id, title, model, created_at, updated_at,
               message_count, total_tokens_sent, total_tokens_received
        FROM chat_sessions ORDER BY updated_at DESC LIMIT 500
      `).all();

      return sessions.map(s => ({
        id: `windsurf-${s.id}`,
        tool_id: TOOL_ID,
        title: s.title || 'Windsurf session',
        started_at: s.created_at,
        ended_at: s.updated_at,
        total_turns: Math.max(1, Math.floor((s.message_count || 0) / 2)),
        total_input_tokens:  s.total_tokens_sent     || 0,
        total_output_tokens: s.total_tokens_received || 0,
        primary_model: s.model || 'windsurf-default',
        status: 'resolved',
        raw_data: JSON.stringify({ windsurfId: s.id }),
      }));
    } catch (_) {
      return []; // Schema differs in this Windsurf version
    } finally {
      wsDb.close();
    }
  },
  getTurns: async () => [],
};

register(adapter);
