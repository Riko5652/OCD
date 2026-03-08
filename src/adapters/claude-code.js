// Claude Code adapter — parses .jsonl session files
// Auto-discovers all project directories under ~/.claude/projects/
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { config } from '../config.js';
import { TOOL_IDS } from './types.js';

// Cache: filename -> { mtime, sessions, turns }
const fileCache = new Map();

function parseSessionFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const turns = [];
  let prevTs = null;

  // Track code edits for first-attempt success calculation
  const fileEditOrder = []; // { file, turnIndex }

  // Track tool errors across all line types
  let sessionErrorCount = 0;
  // Ordered list of tool outcomes: true = success, false = error
  const toolOutcomeSequence = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Parse user messages for tool_result errors (Claude Code puts tool results in user lines)
    if (obj.type === 'user' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          if (block.is_error === true) {
            sessionErrorCount++;
            toolOutcomeSequence.push(false);
          } else {
            toolOutcomeSequence.push(true);
          }
        }
      }
      continue;
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue;

    const u = obj.message.usage;
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;
    const turnIndex = turns.length;

    // Extract tools, label, thinking length, and code generation metrics from content blocks
    const tools = [];
    let label = '';
    let turnLinesAdded = 0;
    let turnLinesRemoved = 0;
    const turnFiles = new Set();
    let thinkingLength = 0;

    for (const block of obj.message.content || []) {
      if (block.type === 'tool_use' && block.name) {
        tools.push(block.name);

        // Track Write tool — all lines are new
        if (block.name === 'Write' && block.input?.content) {
          const newLines = block.input.content.split('\n').length;
          turnLinesAdded += newLines;
          if (block.input.file_path) {
            turnFiles.add(block.input.file_path);
            fileEditOrder.push({ file: block.input.file_path, turnIndex });
          }
        }

        // Track Edit tool — diff between old and new
        if (block.name === 'Edit' && block.input) {
          const oldLines = (block.input.old_string || '').split('\n').length;
          const newLines = (block.input.new_string || '').split('\n').length;
          turnLinesAdded += Math.max(0, newLines - oldLines);
          turnLinesRemoved += Math.max(0, oldLines - newLines);
          if (block.input.file_path) {
            turnFiles.add(block.input.file_path);
            fileEditOrder.push({ file: block.input.file_path, turnIndex });
          }
        }
      }
      if (!label && block.type === 'text' && block.text) {
        label = block.text.slice(0, 100);
      }
      if (block.type === 'thinking' && block.thinking) {
        thinkingLength += block.thinking.length;
        if (!label) {
          label = block.thinking.slice(0, 100);
        }
      }
    }

    // Calculate latency from previous turn
    let latencyMs = null;
    let tokPerSec = null;
    if (ts && prevTs) {
      latencyMs = ts - prevTs;
      if (latencyMs > 0 && u.output_tokens) {
        tokPerSec = u.output_tokens / (latencyMs / 1000);
      }
    }

    turns.push({
      timestamp: ts,
      model: obj.message.model || null,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_create: u.cache_creation_input_tokens || 0,
      latency_ms: latencyMs,
      tok_per_sec: tokPerSec,
      tools_used: tools,
      stop_reason: obj.message.stop_reason || null,
      label,
      type: 2, // assistant
      code_lines_added: turnLinesAdded,
      code_lines_removed: turnLinesRemoved,
      files_touched: turnFiles.size,
      thinking_length: thinkingLength,
    });

    if (ts) prevTs = ts;
  }

  // Compute first-attempt success: files edited only once vs files edited multiple times
  const fileEditCounts = new Map();
  for (const { file } of fileEditOrder) {
    fileEditCounts.set(file, (fileEditCounts.get(file) || 0) + 1);
  }
  const totalFiles = fileEditCounts.size;
  const singleEditFiles = [...fileEditCounts.values()].filter(c => c === 1).length;
  const firstAttemptPct = totalFiles > 0 ? (singleEditFiles / totalFiles) * 100 : null;

  // Compute thinking stats
  const thinkingLengths = turns.map(t => t.thinking_length).filter(v => v > 0);
  const totalThinkingChars = thinkingLengths.reduce((s, v) => s + v, 0);
  const avgThinkingLength = thinkingLengths.length > 0
    ? totalThinkingChars / thinkingLengths.length : null;

  // Compute error recovery percentage
  // An error is "recovered" if there is a successful tool outcome after it in the sequence
  let recoveredErrors = 0;
  let totalErrors = 0;
  for (let i = 0; i < toolOutcomeSequence.length; i++) {
    if (toolOutcomeSequence[i] === false) {
      totalErrors++;
      // Check if any subsequent outcome is a success
      for (let j = i + 1; j < toolOutcomeSequence.length; j++) {
        if (toolOutcomeSequence[j] === true) {
          recoveredErrors++;
          break;
        }
      }
    }
  }
  const errorRecoveryPct = totalErrors > 0
    ? (recoveredErrors / totalErrors) * 100 : null;

  // Compute thinking-to-output ratio
  const totalOutputTokens = turns.reduce((s, t) => s + t.output_tokens, 0);
  const thinkingToOutputRatio = totalOutputTokens > 0
    ? totalThinkingChars / totalOutputTokens : null;

  // Attach session-level code stats
  turns._codeStats = {
    totalLinesAdded: turns.reduce((s, t) => s + (t.code_lines_added || 0), 0),
    totalLinesRemoved: turns.reduce((s, t) => s + (t.code_lines_removed || 0), 0),
    totalFilesTouched: totalFiles,
    firstAttemptPct,
    avgThinkingLength,
    errorCount: sessionErrorCount,
    errorRecoveryPct,
    thinkingToOutputRatio,
  };

  return turns;
}

function buildSession(filename, turns, projectDir) {
  const id = `cc-${filename.replace('.jsonl', '')}`;
  const timestamps = turns.filter(t => t.timestamp).map(t => t.timestamp);
  const models = [...new Set(turns.map(t => t.model).filter(Boolean))];

  const totalInput = turns.reduce((s, t) => s + t.input_tokens, 0);
  const totalOutput = turns.reduce((s, t) => s + t.output_tokens, 0);
  const totalCacheRead = turns.reduce((s, t) => s + t.cache_read, 0);
  const totalCacheCreate = turns.reduce((s, t) => s + t.cache_create, 0);

  const cacheTotal = totalInput + totalCacheCreate + totalCacheRead;
  const cacheHitPct = cacheTotal > 0 ? (totalCacheRead / cacheTotal) * 100 : 0;

  const latencies = turns.map(t => t.latency_ms).filter(v => v != null && v > 0);
  const avgLatency = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  // Top tools by frequency
  const toolCounts = {};
  for (const t of turns) {
    for (const tool of t.tools_used || []) {
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    }
  }
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Primary model = most frequent
  const modelCounts = {};
  for (const t of turns) {
    if (t.model) modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
  }
  const primaryModel = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Code generation stats from parsed Write/Edit tool calls
  const codeStats = turns._codeStats || {};

  // Group turns by model for per-model performance tracking
  const byModel = {};
  for (const t of turns) {
    const m = t.model || primaryModel || 'unknown';
    if (!byModel[m]) byModel[m] = { turns: 0, input: 0, output: 0, cache: 0, latencies: [], errors: 0 };
    byModel[m].turns++;
    byModel[m].input  += t.input_tokens  || 0;
    byModel[m].output += t.output_tokens || 0;
    byModel[m].cache  += t.cache_read    || 0;
    if (t.latency_ms != null && t.latency_ms > 0) byModel[m].latencies.push(t.latency_ms);
    if (t.stop_reason === 'error' || t.label === 'error') byModel[m].errors++;
  }
  const _modelPerf = Object.entries(byModel).map(([model, s]) => ({
    model,
    turns: s.turns,
    input_tokens:  s.input,
    output_tokens: s.output,
    cache_read:    s.cache,
    avg_latency_ms: s.latencies.length
      ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length
      : null,
    error_count: s.errors,
  }));

  return {
    id,
    tool_id: TOOL_IDS.CLAUDE_CODE,
    title: turns[0]?.label || filename,
    started_at: timestamps[0] || null,
    ended_at: timestamps[timestamps.length - 1] || null,
    total_turns: turns.length,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read: totalCacheRead,
    total_cache_create: totalCacheCreate,
    primary_model: primaryModel,
    models_used: models,
    cache_hit_pct: cacheHitPct,
    avg_latency_ms: avgLatency,
    top_tools: topTools,
    code_lines_added: codeStats.totalLinesAdded || 0,
    code_lines_removed: codeStats.totalLinesRemoved || 0,
    files_touched: codeStats.totalFilesTouched || 0,
    first_attempt_pct: codeStats.firstAttemptPct ?? null,
    avg_thinking_length: codeStats.avgThinkingLength || null,
    error_count: codeStats.errorCount || 0,
    error_recovery_pct: codeStats.errorRecoveryPct ?? null,
    _modelPerf,
    raw: {
      project: projectDir,
      thinking_to_output_ratio: codeStats.thinkingToOutputRatio ?? null,
    },
  };
}

export function getDataPaths() {
  return config.claudeCode.dirs;
}

export async function getSessions() {
  const dirs = config.claudeCode.dirs;
  if (dirs.length === 0) return [];

  const sessions = [];
  const seenIds = new Set();

  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const file of files) {
      const filePath = join(dir, file);
      const id = `cc-${file.replace('.jsonl', '')}`;
      if (seenIds.has(id)) continue; // deduplicate across projects
      seenIds.add(id);

      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;

      // Use cache if file hasn't changed
      const cached = fileCache.get(filePath);
      if (cached && cached.mtime === mtime) {
        sessions.push(cached.session);
        continue;
      }

      const turns = parseSessionFile(filePath);
      if (turns.length === 0) continue;

      const session = buildSession(file, turns, dir);

      // Filter ghost sessions: 0 output tokens = abandoned/empty (auto-complete pings, etc.)
      if (session.total_output_tokens === 0) continue;
      fileCache.set(filePath, { mtime, session, turns });
      sessions.push(session);
    }
  }

  return sessions;
}

export async function getTurns(sessionId) {
  // sessionId format: cc-<filename>
  const filename = sessionId.replace('cc-', '') + '.jsonl';

  // Search all project dirs
  for (const dir of config.claudeCode.dirs) {
    const filePath = join(dir, filename);
    const cached = fileCache.get(filePath);
    if (cached) return cached.turns;

    try {
      return parseSessionFile(filePath);
    } catch { /* file not in this dir */ }
  }
  return [];
}

// ---- Git commit cross-referencing for AI authorship ----

// Convert Claude project dir name back to filesystem path
// e.g. "C--Projects-pm-dashboard" → "C:/Projects/pm-dashboard" (Windows)
// e.g. "-home-user-project" → "/home/user/project" (Linux/Mac)
function dirNameToRepoPath(dirName) {
  const platform = process.platform;
  if (platform === 'win32') {
    // "C--Projects-pm-dashboard" → "C:/Projects/pm-dashboard"
    // First "--" is drive separator, rest are path separators
    const parts = dirName.split('-');
    if (parts.length < 2) return null;
    // Reconstruct: first part is drive letter, rest joined with /
    // But single hyphens in dir names are literal, double hyphens are not used
    // Claude uses the raw directory path with / replaced by -
    // e.g. C:\Projects\pm-dashboard → C--Projects-pm-dashboard
    // So split on first -- to get drive, then replace remaining - with /
    // But this is ambiguous for dirs with actual hyphens...
    // Better approach: try the path directly
    const match = dirName.match(/^([A-Z])--(.*)/);
    if (match) {
      const drive = match[1];
      const rest = match[2].replace(/-/g, '/');
      return `${drive}:/${rest}`;
    }
    return null;
  }
  // Unix: "-home-user-project" → "/home/user/project"
  return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
}

let commitCache = { ts: 0, scores: [] };
const COMMIT_CACHE_TTL = 60_000; // 1 minute

export async function getCommitScores() {
  // Return cached if fresh
  if (Date.now() - commitCache.ts < COMMIT_CACHE_TTL && commitCache.scores.length > 0) {
    return commitCache.scores;
  }

  const dirs = config.claudeCode.dirs;
  if (dirs.length === 0) return [];

  // First, get all sessions with their time windows
  const sessions = await getSessions();
  const sessionWindows = sessions
    .filter(s => s.started_at && s.code_lines_added > 0)
    .map(s => ({
      start: s.started_at,
      end: (s.ended_at || s.started_at) + 600_000, // 10-min buffer after session
      linesAdded: s.code_lines_added,
      linesRemoved: s.code_lines_removed,
      filesEdited: s.files_touched,
    }));

  if (sessionWindows.length === 0) return [];

  const scores = [];
  const seenCommits = new Set();

  for (const dir of dirs) {
    const dirName = basename(dir);
    const repoPath = dirNameToRepoPath(dirName);
    if (!repoPath || !existsSync(repoPath)) continue;

    // Check if it's a git repo
    if (!existsSync(join(repoPath, '.git'))) continue;

    try {
      // Get commits from last 90 days
      const raw = execSync(
        'git log --format="%H|%ai|%s|%D" --numstat --since="90 days ago" --no-merges',
        { cwd: repoPath, timeout: 10_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      // Parse git log output
      let currentCommit = null;
      for (const line of raw.split('\n')) {
        const commitMatch = line.match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.*)$/);
        if (commitMatch) {
          // Save previous commit if it had stats
          if (currentCommit && currentCommit.additions > 0) {
            if (!seenCommits.has(currentCommit.hash)) {
              seenCommits.add(currentCommit.hash);
              scores.push(currentCommit);
            }
          }
          const [, hash, dateStr, message, refs] = commitMatch;
          const commitTs = new Date(dateStr).getTime();

          // Find if this commit falls within any Claude Code session window
          const matchingSession = sessionWindows.find(
            w => commitTs >= w.start && commitTs <= w.end
          );

          // Extract branch from refs (e.g. "HEAD -> main, origin/main")
          const branchMatch = refs.match(/HEAD -> ([^,]+)/);
          const branch = branchMatch ? branchMatch[1].trim() : (refs.split(',')[0] || '').trim().replace('origin/', '') || 'unknown';

          currentCommit = {
            hash,
            date: dateStr,
            message: message.slice(0, 200),
            branch,
            ts: commitTs,
            additions: 0,
            deletions: 0,
            aiSession: matchingSession,
          };
          continue;
        }

        // numstat line: "123\t45\tfile.js"
        if (currentCommit && line.match(/^\d/)) {
          const [add, del] = line.split('\t');
          currentCommit.additions += parseInt(add) || 0;
          currentCommit.deletions += parseInt(del) || 0;
        }
      }
      // Don't forget last commit
      if (currentCommit && currentCommit.additions > 0 && !seenCommits.has(currentCommit.hash)) {
        seenCommits.add(currentCommit.hash);
        scores.push(currentCommit);
      }
    } catch (e) {
      console.error(`[claude-code] git log failed for ${repoPath}: ${e.message}`);
    }
  }

  // Convert to commit_scores format
  const result = scores.map(c => {
    if (c.aiSession) {
      // Commit during active Claude Code session → estimate AI authorship
      // Use ratio of session's code output vs commit size, capped at 95%
      const sessionTotal = c.aiSession.linesAdded + c.aiSession.linesRemoved;
      const commitTotal = c.additions + c.deletions;
      // AI wrote most of it if session was producing code
      const rawPct = commitTotal > 0 && sessionTotal > 0
        ? Math.min(95, (sessionTotal / Math.max(sessionTotal, commitTotal)) * 100)
        : 80; // default: if session was active, assume 80% AI
      const aiPct = Math.round(rawPct);
      const aiLines = Math.round(c.additions * aiPct / 100);
      return {
        commit_hash: c.hash,
        branch: c.branch,
        tool_id: 'claude-code',
        scored_at: c.ts,
        lines_added: c.additions,
        lines_deleted: c.deletions,
        ai_lines_added: aiLines,
        ai_lines_deleted: Math.round(c.deletions * aiPct / 100),
        human_lines_added: c.additions - aiLines,
        human_lines_deleted: c.deletions - Math.round(c.deletions * aiPct / 100),
        ai_percentage: aiPct,
        commit_message: c.message,
        commit_date: c.date,
      };
    } else {
      // Commit NOT during a session → human-authored
      return {
        commit_hash: c.hash,
        branch: c.branch,
        tool_id: 'claude-code',
        scored_at: c.ts,
        lines_added: c.additions,
        lines_deleted: c.deletions,
        ai_lines_added: 0,
        ai_lines_deleted: 0,
        human_lines_added: c.additions,
        human_lines_deleted: c.deletions,
        ai_percentage: 0,
        commit_message: c.message,
        commit_date: c.date,
      };
    }
  });

  commitCache = { ts: Date.now(), scores: result };
  return result;
}

export const adapter = {
  id: TOOL_IDS.CLAUDE_CODE,
  name: 'Claude Code',
  getSessions,
  getTurns,
  getCommitScores,
};
