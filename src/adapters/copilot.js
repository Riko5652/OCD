import { openDatabase } from '../lib/sqlite-compat.js';
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

/**
 * Parse Copilot Chat conversations from the VS Code state database.
 * The copilot-chat extension stores conversation data in state.vscdb (SQLite).
 */
function getChatSessions(vsStoragePath) {
  const chatDbPath = path.join(vsStoragePath, 'github.copilot-chat', 'state.vscdb');
  const sessions = [];
  let chatDb;

  try {
    chatDb = openDatabase(chatDbPath, { fileMustExist: true, readonly: true });

    // state.vscdb stores key-value pairs in ItemTable
    const rows = chatDb.prepare(`
      SELECT key, value FROM ItemTable
      WHERE key LIKE 'copilot-chat-%' OR key LIKE 'chat.panel.%'
    `).all();

    for (const row of rows) {
      try {
        const data = JSON.parse(row.value);
        // Handle different storage formats
        const conversations = Array.isArray(data) ? data : data?.conversations || data?.threads || [data];

        for (const conv of conversations) {
          if (!conv || !conv.turns && !conv.messages && !conv.exchanges) continue;

          const messages = conv.turns || conv.messages || conv.exchanges || [];
          if (messages.length === 0) continue;

          const id = `copilot-chat-${conv.id || conv.conversationId || row.key}-${messages.length}`;
          const userMsgs = messages.filter(m => m.role === 'user' || m.type === 'user' || m.author === 'user');
          const assistantMsgs = messages.filter(m => m.role === 'assistant' || m.type === 'assistant' || m.author === 'assistant');

          const title = conv.title
            || conv.name
            || (userMsgs[0]?.content || userMsgs[0]?.text || '').slice(0, 80)
            || 'Copilot Chat';

          const startTs = conv.createdAt || conv.timestamp || conv.created || Date.now();
          const endTs = conv.updatedAt || conv.lastModified || startTs;

          // Estimate tokens from content length (rough: 1 token ~= 4 chars)
          const totalInput = userMsgs.reduce((s, m) => s + ((m.content || m.text || '').length / 4), 0);
          const totalOutput = assistantMsgs.reduce((s, m) => s + ((m.content || m.text || '').length / 4), 0);

          const model = conv.model || conv.agentId || messages.find(m => m.model)?.model || 'copilot-chat';

          sessions.push({
            id,
            tool_id: TOOL_ID,
            title: `Copilot Chat — ${title}`,
            started_at: typeof startTs === 'number' ? startTs : new Date(startTs).getTime(),
            ended_at: typeof endTs === 'number' ? endTs : new Date(endTs).getTime(),
            total_turns: messages.length,
            total_input_tokens: Math.round(totalInput),
            total_output_tokens: Math.round(totalOutput),
            primary_model: model,
            status: 'resolved',
            raw: { source: 'copilot-chat', messageCount: messages.length },
            _chatTurns: messages,
          });
        }
      } catch (_) {
        // Skip malformed entries
      }
    }
  } catch (_) {
    // Chat DB not available — Copilot Chat extension may not be installed
  } finally {
    chatDb?.close();
  }

  return sessions;
}

export const adapter = {
  id: TOOL_ID,
  name: 'GitHub Copilot',
  getSessions: async () => {
    const vsStoragePath = process.env.COPILOT_STORAGE_DIR || getVSCodeStoragePath();
    const telemetryPath = path.join(vsStoragePath, 'github.copilot', 'telemetry.db');

    let telDb;
    const sessions = [];

    // 1. Telemetry DB — suggestion acceptance stats grouped by day+model
    try {
      telDb = openDatabase(telemetryPath, { fileMustExist: true, readonly: true });
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

    // 2. Copilot Chat conversations from state.vscdb
    const chatSessions = getChatSessions(vsStoragePath);
    sessions.push(...chatSessions);

    return sessions;
  },
  getTurns: async (sessionId) => {
    // Return chat turns if this is a chat session
    if (!sessionId?.startsWith('copilot-chat-')) return [];

    const vsStoragePath = process.env.COPILOT_STORAGE_DIR || getVSCodeStoragePath();
    const chatSessions = getChatSessions(vsStoragePath);
    const session = chatSessions.find(s => s.id === sessionId);
    if (!session?._chatTurns) return [];

    return session._chatTurns.map((m, i) => ({
      timestamp: session.started_at + i * 1000,
      model: m.model || session.primary_model,
      input_tokens: m.role === 'user' ? Math.round((m.content || m.text || '').length / 4) : 0,
      output_tokens: m.role === 'assistant' ? Math.round((m.content || m.text || '').length / 4) : 0,
      label: (m.content || m.text || '').slice(0, 120),
      type: m.role === 'user' ? 1 : 2,
    }));
  },
};

register(adapter);
