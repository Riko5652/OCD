import fs from 'fs';
import path from 'path';
import os from 'os';
import { register } from './registry.js';

const TOOL_ID = 'continue';

function getContinueSessionsDir() {
  return process.env.CONTINUE_SESSIONS_DIR ||
    path.join(os.homedir(), '.continue', 'sessions');
}

function parseContinueSession(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const history = raw.history || [];
    const userMessages = history.filter(h => h.role === 'user');
    const model = history.find(h => h.model)?.model || 'unknown';

    let inputTokens = 0, outputTokens = 0;
    for (const msg of history) {
      if (msg.role === 'user') inputTokens += (msg.content || '').length / 4; // rough estimate
      if (msg.role === 'assistant') outputTokens += (msg.content || '').length / 4;
    }

    return {
      id: `continue-${path.basename(filePath, '.json')}`,
      tool: TOOL_ID,
      title: raw.title || path.basename(filePath, '.json'),
      started_at: raw.dateCreated ? new Date(raw.dateCreated).getTime() : fs.statSync(filePath).birthtimeMs,
      ended_at: raw.dateUpdated ? new Date(raw.dateUpdated).getTime() : fs.statSync(filePath).mtimeMs,
      total_turns: userMessages.length,
      total_input_tokens: Math.round(inputTokens),
      total_output_tokens: Math.round(outputTokens),
      primary_model: model,
      status: 'resolved',
      raw_data: JSON.stringify({ sessionId: raw.sessionId, continueFile: filePath }),
      _turns: history.filter(h => h.content).map((h, i) => ({
        id: `continue-${path.basename(filePath, '.json')}-t${i}`,
        session_id: `continue-${path.basename(filePath, '.json')}`,
        turn_index: i,
        role: h.role,
        label: (h.content || '').slice(0, 200),
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: null,
        tools_used: '[]',
        is_error: 0,
      })),
    };
  } catch { return null; }
}

export const adapter = {
  id: TOOL_ID,
  name: 'Continue.dev',
  getSessions: async () => {
    const dir = getContinueSessionsDir();
    if (!fs.existsSync(dir)) return [];

    const sessions = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = parseContinueSession(path.join(dir, file));
      if (parsed && parsed.total_turns > 0) sessions.push(parsed);
    }
    return sessions;
  },
  getTurns: async () => [],
};

register(adapter);
