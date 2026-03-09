// Cursor adapter — reads ai-code-tracking.db + state.vscdb + team-usage-events CSV
// Supports importing state.vscdb from other machines (drop into cursor-imports/)
// Team usage events CSV provides cloud-level per-request data across all machines
import Database from 'better-sqlite3';
import { existsSync, statSync, readdirSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { TOOL_IDS } from './types.js';

import { config } from '../config.js';

const AI_TRACKING_DB = config.cursor.trackingDb;
const STATE_DB = config.cursor.stateDb;
const IMPORT_DIR = config.cursor.importDir;
const CSV_DIR = config.cursor.csvDir;


let trackingDb = null;
let stateDb = null;
const importedDbs = []; // { db, label }

function getTrackingDb() {
  if (trackingDb) return trackingDb;
  if (!existsSync(AI_TRACKING_DB)) return null;
  try {
    trackingDb = new Database(AI_TRACKING_DB, { readonly: true, fileMustExist: true });
    return trackingDb;
  } catch (e) {
    console.error('[cursor] Failed to open tracking DB:', e.message);
    return null;
  }
}

function getStateDb() {
  if (stateDb) return stateDb;
  if (!existsSync(STATE_DB)) return null;
  try {
    stateDb = new Database(STATE_DB, { readonly: true, fileMustExist: true });
    return stateDb;
  } catch (e) {
    console.error('[cursor] Failed to open state DB:', e.message);
    return null;
  }
}

// Recursively find all .vscdb / .db / .sqlite files under a directory
function findDbFiles(dir, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findDbFiles(full, results);
    } else if (entry.name.endsWith('.vscdb') || entry.name.endsWith('.db') || entry.name.endsWith('.sqlite')) {
      results.push(full);
    }
  }
  return results;
}

// Load imported state.vscdb files from cursor-imports/ directory (scans recursively)
function getImportedDbs() {
  if (importedDbs.length > 0) return importedDbs;
  if (!existsSync(IMPORT_DIR)) {
    mkdirSync(IMPORT_DIR, { recursive: true });
    return [];
  }

  for (const dbPath of findDbFiles(IMPORT_DIR)) {
    const file = dbPath.split(/[\\/]/).pop();
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      // Verify it has the expected table
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.some(t => t.name === 'cursorDiskKV')) {
        const label = file.replace(/\.(vscdb|db|sqlite)$/, '');
        importedDbs.push({ db, label });
        console.log(`[cursor] Loaded imported DB: ${dbPath}`);
      } else {
        db.close();
      }
    } catch (e) {
      console.error(`[cursor] Failed to open imported DB ${file}:`, e.message);
    }
  }
  return importedDbs;
}

// Get all state DBs (local + imported)
function getAllStateDbs() {
  const dbs = [];
  const localDb = getStateDb();
  if (localDb) dbs.push({ db: localDb, label: 'local' });
  dbs.push(...getImportedDbs());
  return dbs;
}

// Parse composerData from state.vscdb cursorDiskKV table
function parseComposerSessions(db) {
  const sessions = [];
  try {
    const rows = db.prepare(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 5000`
    ).all();

    for (const row of rows) {
      try {
        const composerId = row.key.replace('composerData:', '');
        const data = JSON.parse(row.value);

        // Extract conversation structure
        const headers = data.fullConversationHeadersOnly || data.allConversationHeaders || [];
        let userTurns = 0;
        let assistantTurns = 0;
        const bubbleIds = [];

        for (const h of headers) {
          if (h.type === 1) userTurns++;
          if (h.type === 2) assistantTurns++;
          if (h.bubbleId) bubbleIds.push(h.bubbleId);
        }

        // Model lives in modelConfig.modelName
        const model = data.modelSlug || data.model
          || data.modelConfig?.modelName || data.modelConfig?.modelSlug || null;

        sessions.push({
          composerId,
          mode: 'composer',
          model,
          createdAt: data.createdAt || null,
          userTurns,
          assistantTurns,
          totalTurns: Math.max(userTurns + assistantTurns, bubbleIds.length),
          bubbleIds,
          capabilities: data.capabilities || [],
          linesAdded: data.totalLinesAdded || 0,
          linesRemoved: data.totalLinesRemoved || 0,
        });
      } catch { /* skip unparseable */ }
    }
  } catch (e) {
    console.error('[cursor] Failed to read composerData:', e.message);
  }
  return sessions;
}

// Parse agent-mode sessions from agentKv data
// Agent mode stores data as hex-encoded content-addressable blobs
function parseAgentSessions(db) {
  const sessions = [];
  try {
    // Get all unique session IDs from checkpoint and bubbleCheckpoint keys
    const cpRows = db.prepare(
      "SELECT key FROM cursorDiskKV WHERE key LIKE 'agentKv:checkpoint:%'"
    ).all();
    const bcRows = db.prepare(
      "SELECT key FROM cursorDiskKV WHERE key LIKE 'agentKv:bubbleCheckpoint:%'"
    ).all();

    const agentMap = new Map(); // sessionId -> { bubbleIds: [], checkpointHash }
    for (const r of cpRows) {
      const sessionId = r.key.split(':')[2];
      if (!agentMap.has(sessionId)) agentMap.set(sessionId, { bubbleIds: [], checkpointHash: null });
      const val = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(r.key);
      if (val) agentMap.get(sessionId).checkpointHash = val.value;
    }
    for (const r of bcRows) {
      const parts = r.key.split(':');
      const sessionId = parts[2];
      const bubbleId = parts[3];
      if (!agentMap.has(sessionId)) agentMap.set(sessionId, { bubbleIds: [], checkpointHash: null });
      agentMap.get(sessionId).bubbleIds.push(bubbleId);
    }

    // For each agent session, try to extract message data from blobs
    for (const [sessionId, session] of agentMap) {
      let userCount = 0;
      let assistantCount = 0;
      let toolCount = 0;
      let estimatedOutput = 0;
      let earliestTs = null;
      let latestTs = null;
      let model = null;

      // Decode bubble hashes -> resolve to blobs -> extract JSON messages
      for (const bubbleId of session.bubbleIds) {
        const bcKey = `agentKv:bubbleCheckpoint:${sessionId}:${bubbleId}`;
        const hashRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(bcKey);
        if (!hashRow) continue;

        const blobKey = `agentKv:blob:${hashRow.value}`;
        const blobRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(blobKey);
        if (!blobRow) continue;

        try {
          const decoded = Buffer.from(blobRow.value, 'hex').toString('utf-8');
          // Try to find JSON in the decoded data
          const jsonStart = decoded.indexOf('{');
          if (jsonStart >= 0) {
            try {
              const data = JSON.parse(decoded.slice(jsonStart));
              if (data.role === 'user') userCount++;
              if (data.role === 'assistant') {
                assistantCount++;
                // Estimate output from content
                const content = typeof data.content === 'string'
                  ? data.content
                  : JSON.stringify(data.content || '');
                estimatedOutput += Math.round(content.length / 4);
              }
              if (data.role === 'tool') toolCount++;
              if (data.model && !model) model = data.model;
            } catch { /* not valid JSON */ }
          }
          // Even if not JSON, estimate from decoded text content
          if (decoded.length > 10 && jsonStart < 0) {
            estimatedOutput += Math.round(decoded.length / 4);
          }
        } catch { /* hex decode failed */ }
      }

      const totalTurns = userCount + assistantCount + toolCount;
      // Only include if there's any meaningful data
      if (totalTurns > 0 || session.bubbleIds.length > 0) {
        sessions.push({
          composerId: sessionId,
          mode: 'agent',
          model: model || 'claude-3.5-sonnet', // agent mode typically uses sonnet
          createdAt: earliestTs,
          userTurns: userCount,
          assistantTurns: assistantCount,
          totalTurns: Math.max(totalTurns, session.bubbleIds.length),
          bubbleIds: session.bubbleIds,
          capabilities: ['agent'],
          linesAdded: 0,
          linesRemoved: 0,
          estimatedOutput,
        });
      }
    }
  } catch (e) {
    console.error('[cursor] Failed to read agentKv:', e.message);
  }
  return sessions;
}

// Scan all agentKv:blob entries for decodable JSON messages to estimate total agent usage
function estimateAgentBlobUsage(db) {
  try {
    // Count total blobs and sample for JSON messages
    const totalCount = db.prepare(
      "SELECT count(*) as c FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'"
    ).get().c;

    if (totalCount === 0) return { totalBlobs: 0, estimatedMessages: 0, estimatedOutput: 0 };

    // Sample a portion for estimation
    const sampleSize = Math.min(2000, totalCount);
    const sampleRows = db.prepare(
      `SELECT value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' AND length(value) > 50 LIMIT ?`
    ).all(sampleSize);

    let jsonCount = 0;
    let totalOutput = 0;
    for (const row of sampleRows) {
      try {
        const decoded = Buffer.from(row.value, 'hex').toString('utf-8');
        const jsonStart = decoded.indexOf('{');
        if (jsonStart >= 0) {
          try {
            const data = JSON.parse(decoded.slice(jsonStart));
            jsonCount++;
            if (data.role === 'assistant') {
              const content = typeof data.content === 'string'
                ? data.content : JSON.stringify(data.content || '');
              totalOutput += Math.round(content.length / 4);
            }
          } catch { /* not parseable JSON */ }
        }
      } catch { /* decode failed */ }
    }

    // Extrapolate from sample
    const ratio = totalCount / sampleSize;
    return {
      totalBlobs: totalCount,
      estimatedMessages: Math.round(jsonCount * ratio),
      estimatedOutput: Math.round(totalOutput * ratio),
    };
  } catch {
    return { totalBlobs: 0, estimatedMessages: 0, estimatedOutput: 0 };
  }
}

// Parse team-usage-events CSV from Cursor's team admin dashboard
// Groups individual API events into sessions (30-min inactivity gap = new session)
function parseTeamUsageEvents() {
  // Find CSV files matching team-usage-events-*.csv
  const csvFiles = [];
  if (existsSync(CSV_DIR)) {
    for (const f of readdirSync(CSV_DIR)) {
      if (f.startsWith('team-usage-events') && f.endsWith('.csv')) {
        csvFiles.push(join(CSV_DIR, f));
      }
    }
  }
  if (csvFiles.length === 0) return [];

  const allEvents = [];
  for (const csvPath of csvFiles) {
    try {
      const csv = readFileSync(csvPath, 'utf-8');
      const lines = csv.trim().split('\n').slice(1); // skip header

      for (const line of lines) {
        // Parse CSV with quoted field support
        const fields = [];
        let field = '', inQuote = false;
        for (const ch of line) {
          if (ch === '"') { inQuote = !inQuote; continue; }
          if (ch === ',' && !inQuote) { fields.push(field); field = ''; continue; }
          field += ch;
        }
        fields.push(field);

        const [date, user, kind, model, maxMode, inputWCache, inputWoCache, cacheRead, output, total, cost] = fields;
        const ts = new Date(date).getTime();
        if (isNaN(ts)) continue;
        // Skip errored/no-charge events with no tokens
        if (kind === 'Errored, No Charge' && !output) continue;

        allEvents.push({
          timestamp: ts,
          user,
          kind,
          model: model || 'auto',
          maxMode: maxMode === 'Yes',
          inputTokens: parseInt(inputWoCache) || 0,
          outputTokens: parseInt(output) || 0,
          cacheRead: parseInt(cacheRead) || 0,
          totalTokens: parseInt(total) || 0,
        });
      }
    } catch (e) {
      console.error(`[cursor] Failed to parse CSV ${csvPath}:`, e.message);
    }
  }

  if (allEvents.length === 0) return [];

  // Sort by timestamp ascending
  allEvents.sort((a, b) => a.timestamp - b.timestamp);

  // Group into sessions: 30-min gap = new session
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const sessions = [];
  let currentSession = null;

  for (const event of allEvents) {
    if (!currentSession || event.timestamp - currentSession.lastTs > SESSION_GAP_MS) {
      // Start new session
      if (currentSession) sessions.push(currentSession);
      currentSession = {
        firstTs: event.timestamp,
        lastTs: event.timestamp,
        events: [],
        models: new Set(),
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        maxModeCount: 0,
      };
    }
    currentSession.lastTs = event.timestamp;
    currentSession.events.push(event);
    currentSession.models.add(event.model);
    currentSession.totalInput += event.inputTokens;
    currentSession.totalOutput += event.outputTokens;
    currentSession.totalCacheRead += event.cacheRead;
    if (event.maxMode) currentSession.maxModeCount++;
  }
  if (currentSession) sessions.push(currentSession);

  console.log(`[cursor] Team usage CSV: ${allEvents.length} events -> ${sessions.length} sessions`);
  return sessions;
}

// Parse bubble messages for token counts and content
function parseBubbles(db, composerId, bubbleIds) {
  const turns = [];
  if (!bubbleIds?.length) return turns;

  const batchSize = 50;
  for (let i = 0; i < bubbleIds.length; i += batchSize) {
    const batch = bubbleIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const keys = batch.map(bid => `bubbleId:${composerId}:${bid}`);

    try {
      const rows = db.prepare(
        `SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`
      ).all(...keys);

      for (const row of rows) {
        try {
          const data = JSON.parse(row.value);
          const tc = data.tokenCount || {};
          const model = data.modelInfo?.modelName || data.model || null;
          const timing = data.timingInfo || {};

          let inputTokens = tc.inputTokens || 0;
          let outputTokens = tc.outputTokens || 0;
          if (outputTokens === 0 && data.type === 2 && data.text) {
            outputTokens = Math.round(data.text.length / 4);
          }

          const latencyMs = timing.clientEndTime && timing.clientRpcSendTime
            ? timing.clientEndTime - timing.clientRpcSendTime : null;

          turns.push({
            session_id: `cur-${composerId}`,
            timestamp: data.createdAt || timing.clientRpcSendTime || null,
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            tools_used: (data.toolResults || []).map(t => t.toolName).filter(Boolean),
            type: data.type || null,
            label: (data.text || '').slice(0, 100),
            latency_ms: latencyMs,
            tok_per_sec: latencyMs > 0 && outputTokens > 0
              ? Math.round(outputTokens / (latencyMs / 1000)) : null,
          });
        } catch { /* skip */ }
      }
    } catch { /* skip batch */ }
  }

  return turns;
}

// Parse deeper insights from bubble data (suggestions, lint, thinking, agentic signals)
function parseSessionInsights(db, composerId, bubbleIds) {
  const result = {
    suggestionCount: 0,
    suggestionsAccepted: 0,
    lintErrorsBefore: 0,
    lintErrorsAfter: 0,
    thinkingDurationMs: 0,
    isAgentic: false,
    filesReferenced: new Set(),
  };
  if (!bubbleIds?.length) return result;

  const batchSize = 50;
  for (let i = 0; i < bubbleIds.length; i += batchSize) {
    const batch = bubbleIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const keys = batch.map(bid => `bubbleId:${composerId}:${bid}`);

    try {
      const rows = db.prepare(
        `SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`
      ).all(...keys);

      for (const row of rows) {
        try {
          const data = JSON.parse(row.value);

          // 1. Suggestion count — bubbles with non-empty suggestedCodeBlocks
          const codeBlocks = data.suggestedCodeBlocks;
          if (Array.isArray(codeBlocks) && codeBlocks.length > 0) {
            result.suggestionCount++;
          }

          // 2. Suggestions accepted — count accepted entries in userResponsesToSuggestedCodeBlocks
          const responses = data.userResponsesToSuggestedCodeBlocks;
          if (responses) {
            if (Array.isArray(responses)) {
              result.suggestionsAccepted += responses.filter(
                r => r === 'accepted' || r === true || r?.accepted === true || r?.status === 'accepted'
              ).length;
            } else if (typeof responses === 'object') {
              // Object keyed by block index
              for (const val of Object.values(responses)) {
                if (val === 'accepted' || val === true || val?.accepted === true || val?.status === 'accepted') {
                  result.suggestionsAccepted++;
                }
              }
            }
          }

          // 3 & 4. Lint errors — before (user type=1), after (assistant type=2)
          const lintErrors = data.approximateLintErrors;
          if (typeof lintErrors === 'number' && lintErrors >= 0) {
            if (data.type === 1) {
              result.lintErrorsBefore += lintErrors;
            } else if (data.type === 2) {
              result.lintErrorsAfter += lintErrors;
            }
          }

          // 5. Thinking duration — sum across assistant bubbles
          const thinkingMs = data.thinkingDurationMs;
          if (typeof thinkingMs === 'number' && thinkingMs > 0) {
            result.thinkingDurationMs += thinkingMs;
          }

          // 6. Agentic indicators
          if (!result.isAgentic) {
            if (data.isAgentic === true) {
              result.isAgentic = true;
            } else if (typeof data.capabilityType === 'string') {
              const ct = data.capabilityType.toLowerCase();
              if (ct.includes('agent') || ct.includes('autonomous') || ct.includes('tool_use')) {
                result.isAgentic = true;
              }
            }
          }

          // 7. Files referenced — unique files from relevantFiles arrays
          const relevantFiles = data.relevantFiles;
          if (Array.isArray(relevantFiles)) {
            for (const f of relevantFiles) {
              const filePath = typeof f === 'string' ? f : (f?.path || f?.uri || f?.fileName || null);
              if (filePath) result.filesReferenced.add(filePath);
            }
          }
        } catch { /* skip unparseable bubble */ }
      }
    } catch { /* skip batch */ }
  }

  return result;
}

export async function getSessions() {
  const allDbs = getAllStateDbs();
  const seenIds = new Set();
  const allSessions = [];

  // 1. Local DB sessions (composer + agent mode)
  for (const { db, label } of allDbs) {
    const composerSessions = parseComposerSessions(db);
    for (const cs of composerSessions) {
      if (seenIds.has(cs.composerId)) continue;
      seenIds.add(cs.composerId);
      if (cs.totalTurns === 0 && cs.bubbleIds.length === 0) continue;
      cs._db = db;       // keep db ref for insight parsing
      cs._isLocal = true; // mark as local (has bubble data)
      allSessions.push(cs);
    }

    const agentSessions = parseAgentSessions(db);
    for (const as of agentSessions) {
      if (seenIds.has(as.composerId)) continue;
      seenIds.add(as.composerId);
      as._db = db;
      as._isLocal = true;
      allSessions.push(as);
    }

    if (label !== 'local') {
      console.log(`[cursor] Imported ${composerSessions.length + agentSessions.length} sessions from ${label}`);
    }
  }

  const localCount = allSessions.length;

  // 2. Team usage events CSV — fills in sessions from other machines + agent mode
  const teamSessions = parseTeamUsageEvents();

  // Build a timeline of local sessions for deduplication
  const localTimeRanges = allSessions
    .filter(s => s.createdAt)
    .map(s => ({
      start: s.createdAt - 60000, // 1 min buffer
      end: s.createdAt + (s.totalTurns * 30000) + 60000, // estimated duration
    }));

  let csvAdded = 0;
  for (let i = 0; i < teamSessions.length; i++) {
    const ts = teamSessions[i];

    // Check if this CSV session overlaps with a local session
    const overlaps = localTimeRanges.some(lr =>
      ts.firstTs <= lr.end && ts.lastTs >= lr.start
    );

    if (overlaps) {
      // Merge token data into the overlapping local session instead of creating duplicate
      // Find the local session that overlaps
      const localMatch = allSessions.find(s =>
        s.createdAt && Math.abs(s.createdAt - ts.firstTs) < 30 * 60 * 1000
      );
      if (localMatch && ts.totalOutput > (localMatch.estimatedOutput || 0)) {
        // Update local session with better token data from CSV
        localMatch.estimatedOutput = ts.totalOutput;
        localMatch.estimatedInput = ts.totalInput;
        localMatch.estimatedCacheRead = ts.totalCacheRead;
      }
      continue;
    }

    // New session not in local DB (from another machine or agent mode)
    const models = [...ts.models];
    const primaryModel = models.find(m => m !== 'auto') || models[0] || 'auto';

    allSessions.push({
      composerId: `csv-${ts.firstTs}`,
      mode: ts.maxModeCount > 0 ? 'agent' : 'composer',
      model: primaryModel,
      createdAt: ts.firstTs,
      userTurns: 0,
      assistantTurns: ts.events.length,
      totalTurns: ts.events.length,
      bubbleIds: [],
      capabilities: ts.maxModeCount > 0 ? ['agent', 'max-mode'] : [],
      linesAdded: 0,
      linesRemoved: 0,
      estimatedOutput: ts.totalOutput,
      estimatedInput: ts.totalInput,
      estimatedCacheRead: ts.totalCacheRead,
      modelsUsed: models,
      events: ts.events, // preserve for latency estimation
    });
    csvAdded++;
  }

  if (csvAdded > 0) {
    console.log(`[cursor] Added ${csvAdded} sessions from team-usage CSV (${localCount} local)`);
  }

  // Filter out sessions with no meaningful data.
  // Local sessions may not have estimatedOutput yet (computed later from bubbles),
  // so also keep sessions that have turns or bubble data.
  const validSessions = allSessions.filter(cs =>
    (cs.estimatedOutput || 0) > 0 || (cs.estimatedInput || 0) > 0 ||
    cs.totalTurns > 0 || (cs.bubbleIds && cs.bubbleIds.length > 0)
  );
  const filtered = allSessions.length - validSessions.length;
  if (filtered > 0) {
    console.log(`[cursor] Filtered ${filtered} sessions with 0 tokens (failed requests)`);
  }
  console.log(`[cursor] Total sessions: ${validSessions.length} (${localCount} local + ${csvAdded} CSV, ${filtered} filtered)`);

  return validSessions.map(cs => {
    // Compute cache hit percentage
    const input = cs.estimatedInput || 0;
    const cacheRead = cs.estimatedCacheRead || 0;
    const totalWithCache = input + cacheRead;
    const cacheHitPct = totalWithCache > 0 ? (cacheRead / totalWithCache) * 100 : null;

    // Estimate avg latency from CSV event timestamps (time gap between consecutive events)
    // Gaps > 60s are user think-time, not API latency
    let avgLatency = null;
    if (cs.events && cs.events.length > 1) {
      const gaps = [];
      for (let j = 1; j < cs.events.length; j++) {
        const gap = cs.events[j].timestamp - cs.events[j - 1].timestamp;
        if (gap > 0 && gap < 60000) gaps.push(gap);
      }
      if (gaps.length > 0) {
        avgLatency = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
      }
    }

    // Parse deeper insights and token data from bubble data (local sessions only)
    let insights = null;
    let bubbleOutputTokens = 0;
    let bubbleInputTokens = 0;
    if (cs._isLocal && cs._db && cs.bubbleIds.length > 0) {
      insights = parseSessionInsights(cs._db, cs.composerId, cs.bubbleIds);
      // Also parse bubbles for token counts if we don't have estimated tokens
      if (!cs.estimatedOutput) {
        const turns = parseBubbles(cs._db, cs.composerId, cs.bubbleIds);
        for (const t of turns) {
          bubbleOutputTokens += t.output_tokens || 0;
          bubbleInputTokens += t.input_tokens || 0;
        }
      }
    }

    // Use best available output estimate: CSV > bubble-parsed > turn-count heuristic
    const outputTokens = cs.estimatedOutput || bubbleOutputTokens ||
      (cs.assistantTurns > 0 ? cs.assistantTurns * 800 : 0); // ~800 tokens per assistant turn as fallback
    const inputTokens = input || bubbleInputTokens;

    // Compute derived insight metrics
    const suggestionAcceptancePct = insights && insights.suggestionCount > 0
      ? (insights.suggestionsAccepted / insights.suggestionCount * 100) : null;
    const lintImprovement = insights && insights.lintErrorsBefore > 0 && insights.lintErrorsAfter >= 0
      ? ((insights.lintErrorsBefore - insights.lintErrorsAfter) / insights.lintErrorsBefore * 100) : null;
    const thinkingDuration = insights?.thinkingDurationMs || null;
    const filesReferenced = insights ? insights.filesReferenced.size : 0;

    return {
      id: `cur-${cs.composerId}`,
      tool_id: TOOL_IDS.CURSOR,
      title: null,
      started_at: cs.createdAt || null,
      total_turns: cs.totalTurns,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      total_cache_read: cacheRead,
      cache_hit_pct: cacheHitPct,
      avg_latency_ms: avgLatency,
      primary_model: cs.model,
      models_used: cs.modelsUsed || (cs.model ? [cs.model] : []),
      code_lines_added: cs.linesAdded || 0,
      code_lines_removed: cs.linesRemoved || 0,
      files_touched: filesReferenced || 0,
      first_attempt_pct: null, // not available from Cursor data
      suggestion_acceptance_pct: suggestionAcceptancePct,
      lint_improvement: lintImprovement,
      thinking_duration_ms: thinkingDuration,
      raw: {
        mode: cs.mode,
        capabilities: cs.capabilities,
        bubbleCount: cs.bubbleIds.length,
        linesAdded: cs.linesAdded,
        linesRemoved: cs.linesRemoved,
        isAgentic: insights?.isAgentic || false,
        suggestionCount: insights?.suggestionCount || 0,
        suggestionsAccepted: insights?.suggestionsAccepted || 0,
        lintErrorsBefore: insights?.lintErrorsBefore || 0,
        lintErrorsAfter: insights?.lintErrorsAfter || 0,
        thinkingDurationMs: insights?.thinkingDurationMs || 0,
        filesReferenced,
      },
    };
  });
}

export async function getTurns(sessionId) {
  const allDbs = getAllStateDbs();
  if (allDbs.length === 0) return [];

  const composerId = sessionId.replace('cur-', '');

  for (const { db } of allDbs) {
    try {
      const row = db.prepare(
        `SELECT value FROM cursorDiskKV WHERE key = ?`
      ).get(`composerData:${composerId}`);

      if (row) {
        const data = JSON.parse(row.value);
        const bubbleIds = (data.fullConversationHeadersOnly || data.allConversationHeaders || [])
          .map(h => h.bubbleId)
          .filter(Boolean);
        return parseBubbles(db, composerId, bubbleIds);
      }
    } catch { /* try next DB */ }
  }

  return [];
}

export async function getCommitScores() {
  const db = getTrackingDb();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT commitHash, branchName, scoredAt, linesAdded, linesDeleted,
        tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted,
        humanLinesAdded, humanLinesDeleted, commitMessage, commitDate,
        v1AiPercentage, v2AiPercentage
      FROM scored_commits WHERE linesAdded IS NOT NULL
      ORDER BY scoredAt DESC
    `).all();

    return rows.map(r => ({
      commit_hash: r.commitHash,
      branch: r.branchName,
      tool_id: TOOL_IDS.CURSOR,
      scored_at: r.scoredAt,
      lines_added: r.linesAdded || 0,
      lines_deleted: r.linesDeleted || 0,
      ai_lines_added: (r.composerLinesAdded || 0) + (r.tabLinesAdded || 0),
      ai_lines_deleted: (r.composerLinesDeleted || 0) + (r.tabLinesDeleted || 0),
      human_lines_added: r.humanLinesAdded || 0,
      human_lines_deleted: r.humanLinesDeleted || 0,
      ai_percentage: parseFloat(r.v2AiPercentage || r.v1AiPercentage || '0'),
      commit_message: r.commitMessage,
      commit_date: r.commitDate,
    }));
  } catch (e) {
    console.error('[cursor] Failed to read commit scores:', e.message);
    return [];
  }
}

export async function getDailyStats() {
  const allDbs = getAllStateDbs();
  const allStats = [];
  const seenDates = new Set();

  for (const { db } of allDbs) {
    try {
      const rows = db.prepare(
        `SELECT key, value FROM ItemTable WHERE key LIKE 'aiCodeTracking.dailyStats%'`
      ).all();

      for (const r of rows) {
        try {
          const data = JSON.parse(r.value);
          if (seenDates.has(data.date)) continue; // deduplicate
          seenDates.add(data.date);
          allStats.push({
            date: data.date,
            tab_suggested: data.tabSuggestedLines || 0,
            tab_accepted: data.tabAcceptedLines || 0,
            composer_suggested: data.composerSuggestedLines || 0,
            composer_accepted: data.composerAcceptedLines || 0,
          });
        } catch { /* skip */ }
      }
    } catch { /* skip DB */ }
  }

  return allStats;
}

export async function getAiFiles() {
  const db = getTrackingDb();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT hash, source, fileExtension, fileName, conversationId, model, createdAt
      FROM ai_code_hashes ORDER BY createdAt DESC LIMIT 5000
    `).all();

    return rows.map(r => ({
      tool_id: TOOL_IDS.CURSOR,
      session_id: r.conversationId ? `cur-${r.conversationId}` : null,
      file_path: r.fileName,
      file_extension: r.fileExtension,
      model: r.model,
      action: 'modified',
      created_at: r.createdAt,
    }));
  } catch (e) {
    console.error('[cursor] Failed to read AI files:', e.message);
    return [];
  }
}

export function closeAll() {
  if (trackingDb) { trackingDb.close(); trackingDb = null; }
  if (stateDb) { stateDb.close(); stateDb = null; }
  for (const { db } of importedDbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  importedDbs.length = 0;
}

export const adapter = {
  id: TOOL_IDS.CURSOR,
  name: 'Cursor',
  getSessions,
  getTurns,
  getCommitScores,
  getDailyStats,
  getAiFiles,
  closeAll,
};
