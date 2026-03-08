import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { register } from './registry.js';

const TOOL_ID = 'copilot';

function getVSCodeStoragePath() {
  const bases = {
    win32:  path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    linux:  path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'),
  };
  return bases[process.platform] || bases.linux;
}

export const adapter = {
  id: TOOL_ID,
  name: 'GitHub Copilot',
  getSessions: async () => {
    const vsStoragePath = process.env.COPILOT_STORAGE_DIR || getVSCodeStoragePath();
    const telemetryPath = path.join(vsStoragePath, 'github.copilot', 'telemetry.db');

    let telDb;
    const sessions = [];

    // Try telemetry DB for suggestion stats grouped by day+model
    try {
      telDb = new Database(telemetryPath, { readonly: true });
      const rows = telDb.prepare(`
        SELECT
          DATE(timestamp/1000, 'unixepoch') as day,
          MAX(timestamp) as latest_ts,
          COUNT(*) as shown,
          SUM(CASE WHEN event = 'ghostTextAccepted' THEN 1 ELSE 0 END) as accepted,
          model_id
        FROM copilot_telemetry
        GROUP BY day, model_id
        ORDER BY day DESC LIMIT 180
      `).all();

      for (const r of rows) {
        const ts = new Date(r.day).getTime();
        sessions.push({
          id: `copilot-${r.day}-${(r.model_id || 'default').replace(/[^a-z0-9]/gi, '-')}`,
          tool_id: TOOL_ID,
          title: `Copilot inline — ${r.day}`,
          started_at: ts,
          ended_at:   r.latest_ts || ts + 86400000,
          total_turns: r.accepted || 0,
          total_input_tokens:  0,
          total_output_tokens: 0,
          suggestion_acceptance_pct: r.shown > 0 ? (r.accepted / r.shown) * 100 : 0,
          primary_model: r.model_id || 'github-copilot',
          status: 'resolved',
          raw_data: JSON.stringify({ shown: r.shown, accepted: r.accepted }),
        });
      }
    } catch (_) {
      // Telemetry DB not available or schema differs
    } finally {
      telDb?.close();
    }

    return sessions;
  },
  getTurns: async () => [],
};

register(adapter);
