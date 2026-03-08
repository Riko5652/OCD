// Antigravity adapter — Google's local IDE
// Conversation .pb files are encrypted, so we parse:
// 1. annotations/*.pbtxt — last_user_view_time per conversation
// 2. brain/*/metadata.json — artifact types, summaries, versions, timestamps
// 3. code_tracker/active/*/ — generated code files
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { TOOL_IDS } from './types.js';
import { config } from '../config.js';

const GEMINI_DIR = config.antigravity.dir;
const ANNOTATIONS_DIR = join(GEMINI_DIR, 'annotations');
const BRAIN_DIR = join(GEMINI_DIR, 'brain');
const CODE_TRACKER_DIR = join(GEMINI_DIR, 'code_tracker', 'active');
const CONVERSATIONS_DIR = join(GEMINI_DIR, 'conversations');
const SCRATCH_DIR = join(GEMINI_DIR, 'scratch');

// Parse annotations/*.pbtxt for conversation timestamps
function parseAnnotations() {
  if (!existsSync(ANNOTATIONS_DIR)) return new Map();
  const timestamps = new Map(); // conversationId -> lastViewTime (unix ms)

  for (const file of readdirSync(ANNOTATIONS_DIR)) {
    if (!file.endsWith('.pbtxt')) continue;
    const id = file.replace('.pbtxt', '');
    try {
      const text = readFileSync(join(ANNOTATIONS_DIR, file), 'utf-8');
      // Format: last_user_view_time:{seconds:1771740338 nanos:801000000}
      const match = text.match(/seconds:(\d+)/);
      if (match) {
        timestamps.set(id, parseInt(match[1]) * 1000);
      }
    } catch { /* skip */ }
  }
  return timestamps;
}

// Parse brain/*/metadata.json for artifact data
function parseBrainArtifacts() {
  if (!existsSync(BRAIN_DIR)) return new Map();
  const artifacts = new Map(); // conversationId -> artifacts[]

  for (const dir of readdirSync(BRAIN_DIR)) {
    const brainPath = join(BRAIN_DIR, dir);
    try {
      if (!statSync(brainPath).isDirectory()) continue;
    } catch { continue; }

    const conversationArtifacts = [];
    for (const file of readdirSync(brainPath)) {
      if (!file.endsWith('.metadata.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(brainPath, file), 'utf-8'));
        conversationArtifacts.push({
          type: meta.artifactType || 'unknown',
          summary: meta.summary || null,
          version: parseInt(meta.version || '1'),
          updatedAt: meta.updatedAt ? new Date(meta.updatedAt).getTime() : null,
        });
      } catch { /* skip */ }
    }

    if (conversationArtifacts.length > 0) {
      artifacts.set(dir, conversationArtifacts);
    }
  }
  return artifacts;
}

// Parse code_tracker for generated files
function parseCodeTracker() {
  if (!existsSync(CODE_TRACKER_DIR)) return [];
  const files = [];

  for (const project of readdirSync(CODE_TRACKER_DIR)) {
    const projectPath = join(CODE_TRACKER_DIR, project);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch { continue; }

    for (const file of readdirSync(projectPath)) {
      try {
        const stat = statSync(join(projectPath, file));
        files.push({
          tool_id: TOOL_IDS.ANTIGRAVITY,
          file_path: `${project}/${file}`,
          file_extension: extname(file).replace('.', ''),
          action: 'created',
          created_at: stat.mtimeMs,
        });
      } catch { /* skip */ }
    }
  }
  return files;
}

// Count conversation .pb files for session count
function countConversations() {
  if (!existsSync(CONVERSATIONS_DIR)) return 0;
  return readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.pb')).length;
}

// Parse scratch files — working documents/outputs from sessions
function parseScratchFiles() {
  if (!existsSync(SCRATCH_DIR)) return [];
  const files = [];
  for (const f of readdirSync(SCRATCH_DIR)) {
    try {
      const fp = join(SCRATCH_DIR, f);
      const stat = statSync(fp);
      if (stat.isFile()) {
        files.push({ name: f, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch { /* skip */ }
  }
  return files;
}

// Count all code tracker files recursively with sizes
function parseCodeTrackerDeep() {
  if (!existsSync(CODE_TRACKER_DIR)) return { files: [], totalSize: 0 };
  const files = [];
  let totalSize = 0;
  for (const project of readdirSync(CODE_TRACKER_DIR)) {
    const projectPath = join(CODE_TRACKER_DIR, project);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
      for (const file of readdirSync(projectPath)) {
        try {
          const stat = statSync(join(projectPath, file));
          if (stat.isFile()) {
            files.push({ project, file, size: stat.size, mtime: stat.mtimeMs, ext: extname(file).replace('.', '') });
            totalSize += stat.size;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return { files, totalSize };
}

export async function getSessions() {
  const annotations = parseAnnotations();
  const artifacts = parseBrainArtifacts();
  const scratchFiles = parseScratchFiles();
  const codeTracker = parseCodeTrackerDeep();
  const sessions = [];

  // Get all known conversation IDs from annotations + brain artifacts + pb files
  const allIds = new Set([...annotations.keys(), ...artifacts.keys()]);

  // Also add pb files not in annotations (conversations without annotations)
  if (existsSync(CONVERSATIONS_DIR)) {
    for (const f of readdirSync(CONVERSATIONS_DIR)) {
      if (f.endsWith('.pb')) allIds.add(f.replace('.pb', ''));
    }
  }

  // Estimate total scratch output tokens (distribute across sessions with artifacts)
  const totalScratchTokens = scratchFiles.reduce((s, f) => s + Math.round(f.size / 4), 0);
  const totalCodeTokens = Math.round(codeTracker.totalSize / 4);
  const sessionsWithArtifacts = [...allIds].filter(id => (artifacts.get(id) || []).length > 0).length;
  const scratchPerSession = sessionsWithArtifacts > 0
    ? Math.round((totalScratchTokens + totalCodeTokens) / sessionsWithArtifacts) : 0;

  // Estimate code lines from code_tracker (distribute across sessions with code artifacts)
  const totalCodeLines = codeTracker.files.reduce((s, f) => s + Math.round(f.size / 40), 0); // ~40 bytes per line avg
  const totalCodeFiles = codeTracker.files.length;
  const codeLinesPerSession = sessionsWithArtifacts > 0
    ? Math.round(totalCodeLines / sessionsWithArtifacts) : 0;
  const codeFilesPerSession = sessionsWithArtifacts > 0
    ? Math.round(totalCodeFiles / sessionsWithArtifacts) : 0;

  for (const id of allIds) {
    const lastView = annotations.get(id);
    const arts = artifacts.get(id) || [];

    // Derive timestamps from artifacts if no annotation
    const artTimestamps = arts.map(a => a.updatedAt).filter(Boolean);
    const earliest = artTimestamps.length > 0 ? Math.min(...artTimestamps) : null;
    const latest = artTimestamps.length > 0 ? Math.max(...artTimestamps) : null;

    // Count artifact types
    const typeCounts = {};
    for (const a of arts) {
      const shortType = a.type.replace('ARTIFACT_TYPE_', '').toLowerCase();
      typeCounts[shortType] = (typeCounts[shortType] || 0) + 1;
    }

    // Total version churn — each version is an iteration (better turn proxy)
    const totalVersions = arts.reduce((s, a) => s + a.version, 0);

    // Estimate output tokens from artifact summaries + proportional scratch/code allocation
    let estimatedOutput = 0;
    for (const a of arts) {
      estimatedOutput += a.summary ? Math.round(a.summary.length / 4) : 50;
      estimatedOutput += a.version * 100; // each version iteration ~ 100 tokens
    }
    if (arts.length > 0) estimatedOutput += scratchPerSession;

    sessions.push({
      id: `ag-${id}`,
      tool_id: TOOL_IDS.ANTIGRAVITY,
      title: arts[0]?.summary || null,
      started_at: earliest || lastView || null,
      ended_at: latest || lastView || null,
      total_turns: Math.max(arts.length, totalVersions), // versions as better proxy
      total_input_tokens: 0, // Not available (encrypted)
      total_output_tokens: estimatedOutput,
      total_cache_read: 0,
      cache_hit_pct: null, // Not available (encrypted conversations)
      avg_latency_ms: null, // Not available (no timing data in metadata)
      code_lines_added: arts.length > 0 ? codeLinesPerSession : 0,
      code_lines_removed: 0,
      files_touched: arts.length > 0 ? codeFilesPerSession : 0,
      first_attempt_pct: null, // Not available (no edit tracking)
      primary_model: 'gemini',
      models_used: ['gemini'],
      raw: {
        artifact_types: typeCounts,
        total_versions: totalVersions,
        has_annotation: !!lastView,
        last_view: lastView,
      },
    });
  }

  return sessions;
}

export async function getTurns(sessionId) {
  // Antigravity turns are not available (encrypted PBs)
  // Return brain artifacts as pseudo-turns
  const id = sessionId.replace('ag-', '');
  const arts = parseBrainArtifacts().get(id) || [];

  return arts.map(a => ({
    session_id: sessionId,
    timestamp: a.updatedAt,
    model: 'gemini',
    input_tokens: 0,
    output_tokens: 0,
    tools_used: [],
    label: `[${a.type.replace('ARTIFACT_TYPE_', '')}] ${a.summary || ''}`.slice(0, 100),
    type: 2,
  }));
}

export async function getAiFiles() {
  return parseCodeTracker();
}

export function getStats() {
  const artifacts = parseBrainArtifacts();
  let totalArtifacts = 0;
  let totalVersions = 0;
  const typeCounts = {};

  for (const [, arts] of artifacts) {
    totalArtifacts += arts.length;
    for (const a of arts) {
      totalVersions += a.version;
      const t = a.type.replace('ARTIFACT_TYPE_', '').toLowerCase();
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }

  return {
    total_conversations: countConversations(),
    total_artifacts: totalArtifacts,
    total_versions: totalVersions,
    artifact_types: typeCounts,
  };
}

export const adapter = {
  id: TOOL_IDS.ANTIGRAVITY,
  name: 'Antigravity',
  getSessions,
  getTurns,
  getAiFiles,
};
