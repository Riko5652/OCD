import { getDb } from '../db.js';
import { sanitizeForPrompt } from '../lib/sanitize.js';

const TOPIC_SIGNALS = {
  'db-work':   [/sql|postgres|migration|schema|query|pgvector|memgraph|sqlite|database/i],
  'frontend':  [/react|tsx|jsx|css|component|ui|modal|button|tailwind|html|style/i],
  'debugging': [/error|exception|crash|fix|bug|traceback|undefined|null pointer|stack trace/i],
  'devops':    [/docker|ci.?cd|deploy|nginx|ec2|container|pipeline|github.?action|gitlab|k8s/i],
  'writing':   [/docs?|readme|confluence|jira|ticket|markdown|blog|notion|comment/i],
  'planning':  [/plan|design|architect|spec|brainstorm|roadmap|requirement|user.?stor/i],
  'testing':   [/test|spec|vitest|jest|coverage|mock|assert|e2e|integration.?test/i],
  'api':       [/api|endpoint|route|rest|graphql|webhook|openapi|swagger/i],
};

/**
 * Detects topic from a session's turn labels, top_tools, and raw_data.
 */
export function detectTopic(session) {
  const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
  const topTools = (() => { try { return JSON.parse(session.top_tools || '[]'); } catch { return []; } })();
  const toolNames = topTools.map(([t]) => (t || '').toLowerCase()).join(' ');

  // Build text corpus from available session data
  const corpus = [
    session.title || '',
    session.tldr || '',
    toolNames,
    (raw.filesEdited || []).join(' '),
    raw.project || '',
  ].join(' ').toLowerCase();

  let bestTopic = 'general';
  let bestScore = 0;

  for (const [topic, patterns] of Object.entries(TOPIC_SIGNALS)) {
    let score = 0;
    for (const pattern of patterns) {
      const matches = (corpus.match(new RegExp(pattern.source, 'gi')) || []).length;
      score += matches;
    }
    if (score > bestScore) { bestScore = score; bestTopic = topic; }
  }

  return bestTopic;
}

/**
 * Scores how relevant a session is to its project folder.
 * 0.0 = completely unrelated, 1.0 = clearly about the project.
 */
export function scoreProjectRelevance(session, projectName) {
  if (!projectName) return 0.5;
  const raw = (() => { try { return JSON.parse(session.raw_data || '{}'); } catch { return {}; } })();
  const topTools = (() => { try { return JSON.parse(session.top_tools || '[]'); } catch { return []; } })();
  const toolNames = topTools.map(([t]) => (t || '').toLowerCase()).join(' ');

  const corpus = [
    session.title || '',
    session.tldr || '',
    toolNames,
    (raw.filesEdited || []).join(' '),
  ].join(' ').toLowerCase();

  // Escape special regex characters to prevent regex injection, then allow flexible separators
  const escaped = projectName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const projectKey = escaped.replace(/[-_]/g, '[\\-_]?');
  const projectPattern = new RegExp(projectKey, 'i');

  // Direct mention
  if (projectPattern.test(corpus)) return 0.9;

  // Files are in the project directory
  const files = raw.filesEdited || [];
  if (files.some(f => f.toLowerCase().includes(projectName.toLowerCase()))) return 0.85;

  // Writing/planning topics are more likely to be unrelated
  const topic = detectTopic(session);
  if (['writing', 'planning'].includes(topic) && files.length === 0) return 0.2;

  // Default moderate relevance
  return 0.5;
}

/**
 * Classifies all unclassified sessions and writes topic + relevance to DB.
 */
export function classifyAllSessionTopics() {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT id, title, tldr, raw_data, top_tools, tool_id
    FROM sessions
    WHERE topic IS NULL
    LIMIT 2000
  `).all();

  const update = db.prepare(`UPDATE sessions SET topic = ?, project_relevance_score = ? WHERE id = ?`);
  const updateAll = db.transaction((rows) => {
    for (const s of rows) {
      const topic = detectTopic(s);
      const relevance = scoreProjectRelevance(s, null); // project-agnostic pass
      update.run(topic, relevance, s.id);
    }
  });
  updateAll(sessions);
  return sessions.length;
}

/**
 * Groups sessions by topic for a given project name.
 * Returns: { topic: { sessions: [], total_tokens: N, ... } }
 */
export function getTopicBreakdown(projectName) {
  const db = getDb();

  const sessions = db.prepare(`
    SELECT id, tool_id, primary_model, topic, started_at, total_turns,
           total_input_tokens, total_output_tokens, quality_score, project_relevance_score,
           raw_data, title
    FROM sessions
    WHERE raw_data LIKE ?
    ORDER BY started_at DESC
    LIMIT 200
  `).all(`%${projectName}%`);

  const byTopic = {};
  for (const s of sessions) {
    const topic = s.topic || detectTopic(s);
    const relevance = s.project_relevance_score ?? scoreProjectRelevance(s, projectName);
    if (!byTopic[topic]) byTopic[topic] = { sessions: [], total_tokens: 0, low_relevance_count: 0 };
    byTopic[topic].sessions.push({ ...s, project_relevance_score: relevance });
    byTopic[topic].total_tokens += (s.total_input_tokens || 0) + (s.total_output_tokens || 0);
    if (relevance < 0.3) byTopic[topic].low_relevance_count++;
  }

  return byTopic;
}

/**
 * Generates or retrieves a cached executive summary for a topic cluster.
 * Uses LLM if available, falls back to template-based summary.
 */
export async function getTopicSummary(projectName, topic) {
  const db = getDb();

  // Check cache (< 7 days old)
  const cached = db.prepare(`
    SELECT summary, generated_at FROM topic_clusters
    WHERE project_name = ? AND topic = ? AND summary IS NOT NULL
      AND generated_at > ?
  `).get(projectName, topic, Date.now() - 7 * 24 * 60 * 60 * 1000);

  if (cached) return { summary: cached.summary, cached: true };

  // Get sessions for this topic
  const breakdown = getTopicBreakdown(projectName);
  const group = breakdown[topic];
  if (!group || group.sessions.length === 0) return { summary: null, cached: false };

  const sessions = group.sessions;
  const totalTokens = group.total_tokens;
  const tools = [...new Set(sessions.map(s => s.tool_id))].join(', ');

  // Template summary (no LLM needed)
  const dateRange = sessions.length > 0 ? {
    start: new Date(Math.min(...sessions.map(s => s.started_at))).toISOString().slice(0, 10),
    end: new Date(Math.max(...sessions.map(s => s.started_at))).toISOString().slice(0, 10),
  } : { start: 'unknown', end: 'unknown' };

  const avgQuality = sessions.reduce((s, x) => s + (x.quality_score || 0), 0) / sessions.length;

  const summary = [
    `${sessions.length} session${sessions.length !== 1 ? 's' : ''} on ${topic} work`,
    `from ${dateRange.start} to ${dateRange.end}`,
    `using ${tools}.`,
    `Total tokens: ${totalTokens.toLocaleString()}.`,
    `Average quality score: ${Math.round(avgQuality)}/100.`,
    group.low_relevance_count > 0
      ? `${group.low_relevance_count} session${group.low_relevance_count > 1 ? 's' : ''} may not be directly related to project ${projectName}.`
      : '',
  ].filter(Boolean).join(' ');

  // Cache it
  const existing = db.prepare(`SELECT id FROM topic_clusters WHERE project_name = ? AND topic = ?`).get(projectName, topic);
  if (existing) {
    db.prepare(`UPDATE topic_clusters SET summary = ?, total_tokens = ?, total_sessions = ?, generated_at = ? WHERE project_name = ? AND topic = ?`)
      .run(summary, totalTokens, sessions.length, Date.now(), projectName, topic);
  } else {
    db.prepare(`INSERT INTO topic_clusters (project_name, topic, session_ids, summary, total_tokens, total_sessions, date_range_start, date_range_end, generated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        projectName, topic,
        JSON.stringify(sessions.map(s => s.id).slice(0, 50)),
        summary, totalTokens, sessions.length,
        sessions.length > 0 ? Math.min(...sessions.map(s => s.started_at)) : null,
        sessions.length > 0 ? Math.max(...sessions.map(s => s.started_at)) : null,
        Date.now()
      );
  }

  return { summary, cached: false };
}
