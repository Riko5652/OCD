import fs from 'fs';
import path from 'path';
import os from 'os';
import { register } from './registry.js';

const TOOL_ID = 'aider';

function parseAiderHistory(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }

  const turns = [];
  const filesEdited = new Set();
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let currentRole = null;
  let currentLines = [];

  for (const line of content.split('\n')) {
    if (line.startsWith('#### ')) {
      if (currentLines.length && currentRole) turns.push({ role: currentRole, content: currentLines.join('\n').trim() });
      currentRole = 'user';
      currentLines = [line.slice(5).trim()];
    } else if (line.startsWith('# aider: edited ')) {
      filesEdited.add(line.replace('# aider: edited ', '').trim());
    } else if (/^Model: (.+)/.test(line)) {
      model = line.match(/^Model: (.+)/)[1].trim();
    } else if (/Tokens: (\d+) sent, (\d+) received/.test(line)) {
      const [, s, r] = line.match(/Tokens: (\d+) sent, (\d+) received/);
      inputTokens += parseInt(s); outputTokens += parseInt(r);
    } else if (/Cost: \$([0-9.]+)/.test(line)) {
      cost += parseFloat(line.match(/Cost: \$([0-9.]+)/)[1]);
    } else if (currentRole && line.trim()) {
      if (currentRole === 'user' && line === '---') { currentRole = 'assistant'; currentLines = []; }
      else currentLines.push(line);
    }
  }
  if (currentLines.length && currentRole) turns.push({ role: currentRole, content: currentLines.join('\n').trim() });

  return { turns: turns.filter(t => t.content), model, inputTokens, outputTokens, cost, filesEdited: [...filesEdited] };
}

function scanForHistoryFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.git') && !entry.name.includes('node_modules')) {
        scanForHistoryFiles(full, results);
      } else if (entry.name === '.aider.chat.history.md') {
        results.push(full);
      }
    }
  } catch (_) {}
  return results;
}

export const adapter = {
  id: TOOL_ID,
  name: 'Aider',
  getSessions: async () => {
    const searchDirs = [
      process.cwd(),
      path.join(os.homedir(), 'Projects'),
      path.join(os.homedir(), 'projects'),
      path.join(os.homedir(), 'dev'),
      path.join(os.homedir(), 'code'),
    ].filter(fs.existsSync);

    const historyFiles = [];
    for (const dir of searchDirs) scanForHistoryFiles(dir, historyFiles);

    const sessions = [];
    for (const filePath of historyFiles) {
      try {
        const stat = fs.statSync(filePath);
        const parsed = parseAiderHistory(filePath);
        if (!parsed || !parsed.turns.length) continue;

        const userTurns = parsed.turns.filter(t => t.role === 'user');
        const id = `aider-${Buffer.from(filePath).toString('base64url').slice(0, 20)}-${stat.mtimeMs.toFixed(0)}`;

        sessions.push({
          id,
          tool_id: TOOL_ID,
          title: path.basename(path.dirname(filePath)),
          started_at: stat.birthtimeMs || stat.mtimeMs - userTurns.length * 30000,
          ended_at: stat.mtimeMs,
          total_turns: userTurns.length,
          total_input_tokens: parsed.inputTokens,
          total_output_tokens: parsed.outputTokens,
          primary_model: parsed.model,
          code_lines_added: 0,
          files_touched: parsed.filesEdited.length,
          status: 'resolved',
          raw_data: JSON.stringify({
            filesEdited: parsed.filesEdited,
            cost: parsed.cost,
            historyFile: filePath,
          }),
        });
      } catch (_) {}
    }
    return sessions;
  },
  getTurns: async () => [],
};

register(adapter);
