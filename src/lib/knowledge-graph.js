// Phase B — Semantic memory: in-memory knowledge graph built from session data
// Adjacency-list representation using nested Maps

import { getDb } from '../db.js';

const SEQUENTIAL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── Graph structure ────────────────────────────────────────────────────────

/** @typedef {'session'|'tool'|'model'|'project'|'error_pattern'|'task_type'} NodeType */
/** @typedef {'same_project'|'same_tool'|'same_model'|'similar_error'|'sequential'|'same_task_type'} EdgeType */

/**
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {NodeType} type
 * @property {object} props  Arbitrary properties (quality_score, turns, model, tool, etc.)
 */

/**
 * @typedef {object} GraphEdge
 * @property {string} target
 * @property {EdgeType} type
 * @property {number} weight
 */

class KnowledgeGraph {
  constructor() {
    /** @type {Map<string, GraphNode>} */
    this.nodes = new Map();
    /** @type {Map<string, Map<string, GraphEdge[]>>} Adjacency list: source -> target -> edges */
    this.adjacency = new Map();
    this.built = false;
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  _addNode(id, type, props = {}) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, type, props });
      this.adjacency.set(id, new Map());
    } else {
      // Merge props
      Object.assign(this.nodes.get(id).props, props);
    }
  }

  _addEdge(sourceId, targetId, type, weight = 1.0) {
    if (!this.adjacency.has(sourceId)) {
      this.adjacency.set(sourceId, new Map());
    }
    const neighbors = this.adjacency.get(sourceId);
    if (!neighbors.has(targetId)) {
      neighbors.set(targetId, []);
    }
    // Avoid duplicate edge types between same pair
    const existing = neighbors.get(targetId);
    const dup = existing.find(e => e.type === type);
    if (dup) {
      dup.weight = Math.max(dup.weight, weight);
    } else {
      existing.push({ target: targetId, type, weight });
    }

    // Bidirectional
    if (!this.adjacency.has(targetId)) {
      this.adjacency.set(targetId, new Map());
    }
    const reverse = this.adjacency.get(targetId);
    if (!reverse.has(sourceId)) {
      reverse.set(sourceId, []);
    }
    const revExisting = reverse.get(sourceId);
    const revDup = revExisting.find(e => e.type === type);
    if (revDup) {
      revDup.weight = Math.max(revDup.weight, weight);
    } else {
      revExisting.push({ target: sourceId, type, weight });
    }
  }

  // ─── Build ──────────────────────────────────────────────────────────────

  /**
   * Build the full graph from the SQLite database.
   * Reads sessions, turns, task_classifications, and project_index tables.
   * Safe to call multiple times — rebuilds from scratch each time.
   * @returns {number} Total number of nodes in the graph.
   */
  buildGraph() {
    this.nodes.clear();
    this.adjacency.clear();

    const db = getDb();
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at ASC').all();

    // Index structures for edge detection
    const byProject = new Map();  // project name -> session ids
    const byTool = new Map();     // tool_id -> session ids
    const byModel = new Map();    // model -> session ids
    const byTaskType = new Map(); // task_type -> session ids
    const errorIndex = new Map(); // error pattern -> session ids
    const chronological = [];     // [{ id, started_at }]

    // Load task classifications
    let taskMap = new Map();
    try {
      const tasks = db.prepare('SELECT * FROM task_classifications').all();
      for (const t of tasks) taskMap.set(t.session_id, t);
    } catch (_) { /* table may not exist */ }

    for (const s of sessions) {
      const sid = `session:${s.id}`;

      // Session node
      this._addNode(sid, 'session', {
        quality_score: s.quality_score,
        turns: s.total_turns,
        model: s.primary_model,
        tool: s.tool_id,
        started_at: s.started_at,
        title: s.title,
        tldr: s.tldr,
        error_count: s.error_count,
      });

      chronological.push({ id: sid, started_at: s.started_at });

      // Tool node + edge
      if (s.tool_id) {
        const toolId = `tool:${s.tool_id}`;
        this._addNode(toolId, 'tool', { name: s.tool_id });
        this._addEdge(sid, toolId, 'same_tool');
        if (!byTool.has(s.tool_id)) byTool.set(s.tool_id, []);
        byTool.get(s.tool_id).push(sid);
      }

      // Model node + edge
      if (s.primary_model) {
        const modelId = `model:${s.primary_model}`;
        this._addNode(modelId, 'model', { name: s.primary_model });
        this._addEdge(sid, modelId, 'same_model');
        if (!byModel.has(s.primary_model)) byModel.set(s.primary_model, []);
        byModel.get(s.primary_model).push(sid);
      }

      // Project node + edge (extract from title heuristic or project_index)
      const project = extractProject(s);
      if (project) {
        const projId = `project:${project}`;
        this._addNode(projId, 'project', { name: project });
        this._addEdge(sid, projId, 'same_project');
        if (!byProject.has(project)) byProject.set(project, []);
        byProject.get(project).push(sid);
      }

      // Task type node + edge
      const tc = taskMap.get(s.id);
      if (tc && tc.task_type) {
        const ttId = `task_type:${tc.task_type}`;
        this._addNode(ttId, 'task_type', { name: tc.task_type });
        this._addEdge(sid, ttId, 'same_task_type');
        if (!byTaskType.has(tc.task_type)) byTaskType.set(tc.task_type, []);
        byTaskType.get(tc.task_type).push(sid);
      }

      // Error pattern nodes from turn labels
      try {
        const turns = db.prepare(
          "SELECT DISTINCT label FROM turns WHERE session_id = ? AND label IS NOT NULL AND label LIKE '%error%'"
        ).all(s.id);
        for (const t of turns) {
          const pattern = normalizeError(t.label);
          const errId = `error_pattern:${pattern}`;
          this._addNode(errId, 'error_pattern', { pattern });
          this._addEdge(sid, errId, 'similar_error');
          if (!errorIndex.has(pattern)) errorIndex.set(pattern, []);
          errorIndex.get(pattern).push(sid);
        }
      } catch (_) { /* turns query may fail */ }
    }

    // Build cross-session edges
    this._buildCrossEdges(byProject, 'same_project');
    this._buildCrossEdges(byTool, 'same_tool');
    this._buildCrossEdges(byModel, 'same_model');
    this._buildCrossEdges(byTaskType, 'same_task_type');
    this._buildCrossEdges(errorIndex, 'similar_error');

    // Sequential edges (sessions within 30 min of each other)
    for (let i = 1; i < chronological.length; i++) {
      const prev = chronological[i - 1];
      const curr = chronological[i];
      if (prev.started_at && curr.started_at) {
        const gap = curr.started_at - prev.started_at;
        if (gap >= 0 && gap <= SEQUENTIAL_WINDOW_MS) {
          const weight = 1.0 - (gap / SEQUENTIAL_WINDOW_MS);
          this._addEdge(prev.id, curr.id, 'sequential', weight);
        }
      }
    }

    this.built = true;
    return this.nodes.size;
  }

  /**
   * Build pairwise edges between all sessions sharing a grouping key.
   * Limits to 50 most recent per group to avoid quadratic blowup.
   */
  _buildCrossEdges(index, edgeType) {
    for (const sessionIds of index.values()) {
      const ids = sessionIds.slice(-50); // cap to avoid O(n^2)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          this._addEdge(ids[i], ids[j], edgeType, 0.5);
        }
      }
    }
  }

  // ─── Incremental update ─────────────────────────────────────────────────

  /**
   * Add a single session to the graph incrementally (avoids full rebuild).
   * @param {object} session  A full session row from the DB.
   */
  addSession(session) {
    const db = getDb();
    const sid = `session:${session.id}`;

    this._addNode(sid, 'session', {
      quality_score: session.quality_score,
      turns: session.total_turns,
      model: session.primary_model,
      tool: session.tool_id,
      started_at: session.started_at,
      title: session.title,
      tldr: session.tldr,
      error_count: session.error_count,
    });

    // Tool
    if (session.tool_id) {
      const toolId = `tool:${session.tool_id}`;
      this._addNode(toolId, 'tool', { name: session.tool_id });
      this._addEdge(sid, toolId, 'same_tool');
      this._linkToExistingByType(sid, 'tool', session.tool_id);
    }

    // Model
    if (session.primary_model) {
      const modelId = `model:${session.primary_model}`;
      this._addNode(modelId, 'model', { name: session.primary_model });
      this._addEdge(sid, modelId, 'same_model');
      this._linkToExistingByType(sid, 'model', session.primary_model);
    }

    // Project
    const project = extractProject(session);
    if (project) {
      const projId = `project:${project}`;
      this._addNode(projId, 'project', { name: project });
      this._addEdge(sid, projId, 'same_project');
    }

    // Task classification
    try {
      const tc = db.prepare('SELECT * FROM task_classifications WHERE session_id = ?').get(session.id);
      if (tc && tc.task_type) {
        const ttId = `task_type:${tc.task_type}`;
        this._addNode(ttId, 'task_type', { name: tc.task_type });
        this._addEdge(sid, ttId, 'same_task_type');
      }
    } catch (_) { /* ok */ }

    // Sequential: find nearest previous session
    if (session.started_at) {
      for (const [nodeId, node] of this.nodes) {
        if (node.type === 'session' && nodeId !== sid && node.props.started_at) {
          const gap = Math.abs(session.started_at - node.props.started_at);
          if (gap <= SEQUENTIAL_WINDOW_MS) {
            const weight = 1.0 - (gap / SEQUENTIAL_WINDOW_MS);
            this._addEdge(sid, nodeId, 'sequential', weight);
          }
        }
      }
    }
  }

  /** Link a new session node to existing sessions that share a property via their type node. */
  _linkToExistingByType(sid, nodeType, value) {
    const typeNodeId = `${nodeType}:${value}`;
    const neighbors = this.adjacency.get(typeNodeId);
    if (!neighbors) return;
    for (const [neighborId] of neighbors) {
      const node = this.nodes.get(neighborId);
      if (node && node.type === 'session' && neighborId !== sid) {
        this._addEdge(sid, neighborId, `same_${nodeType}`, 0.5);
      }
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  /**
   * Get the subgraph (nodes + edges) within `depth` hops of a session.
   * @param {string} sessionId  The raw session ID (without 'session:' prefix).
   * @param {number} [depth=2]  Maximum traversal depth.
   * @returns {{nodes: GraphNode[], edges: Array<{source: string, target: string, type: EdgeType, weight: number}>}}
   */
  getNeighborhood(sessionId, depth = 2) {
    const startId = `session:${sessionId}`;
    if (!this.nodes.has(startId)) {
      return { nodes: [], edges: [] };
    }

    const visited = new Set();
    const resultEdges = [];
    let frontier = [startId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const nextFrontier = [];
      for (const nodeId of frontier) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const neighbors = this.adjacency.get(nodeId);
        if (!neighbors) continue;
        for (const [targetId, edges] of neighbors) {
          for (const edge of edges) {
            resultEdges.push({
              source: nodeId,
              target: targetId,
              type: edge.type,
              weight: edge.weight,
            });
          }
          if (!visited.has(targetId)) {
            nextFrontier.push(targetId);
          }
        }
      }
      frontier = nextFrontier;
    }

    const resultNodes = [];
    for (const nodeId of visited) {
      const node = this.nodes.get(nodeId);
      if (node) resultNodes.push(node);
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  /**
   * Find sessions that resolved similar errors, ranked by quality_score.
   * Walks from error_pattern nodes to connected sessions.
   * @param {string} errorPattern  A string describing the error (e.g. "TypeError: cannot read property").
   * @param {object} [context]  Optional context: { tool, model, project }.
   * @returns {Array<{session: GraphNode, relevance: number}>}
   */
  getRelatedSolutions(errorPattern, context = {}) {
    const normalised = normalizeError(errorPattern);
    const candidates = [];

    // Find matching error_pattern nodes (substring match)
    for (const [nodeId, node] of this.nodes) {
      if (node.type !== 'error_pattern') continue;
      if (!node.props.pattern) continue;
      const overlap = errorOverlap(normalised, node.props.pattern);
      if (overlap < 0.3) continue;

      // Walk to connected sessions
      const neighbors = this.adjacency.get(nodeId);
      if (!neighbors) continue;
      for (const [targetId, edges] of neighbors) {
        const targetNode = this.nodes.get(targetId);
        if (!targetNode || targetNode.type !== 'session') continue;

        let relevance = overlap;
        // Boost for quality
        if (targetNode.props.quality_score) {
          relevance *= (0.5 + targetNode.props.quality_score / 200);
        }
        // Boost for context match
        if (context.tool && targetNode.props.tool === context.tool) relevance *= 1.3;
        if (context.model && targetNode.props.model === context.model) relevance *= 1.1;

        candidates.push({ session: targetNode, relevance });
      }
    }

    // Deduplicate by session id, keeping highest relevance
    const best = new Map();
    for (const c of candidates) {
      const existing = best.get(c.session.id);
      if (!existing || c.relevance > existing.relevance) {
        best.set(c.session.id, c);
      }
    }

    return [...best.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 10);
  }

  /**
   * Find the best tool/model path for a given task type in a project context.
   * Returns tool/model combinations ranked by average quality_score of matching sessions.
   * @param {string} taskType  The task type (e.g. "refactoring", "bug_fix").
   * @param {string} [project]  Optional project name to filter by.
   * @returns {Array<{tool: string, model: string, avgQuality: number, sessions: number}>}
   */
  getToolPath(taskType, project) {
    const ttId = `task_type:${taskType}`;
    const neighbors = this.adjacency.get(ttId);
    if (!neighbors) return [];

    // Collect sessions for this task type
    const sessionNodes = [];
    for (const [targetId] of neighbors) {
      const node = this.nodes.get(targetId);
      if (node && node.type === 'session') {
        // Optionally filter by project
        if (project) {
          const projId = `project:${project}`;
          const sessionNeighbors = this.adjacency.get(targetId);
          if (!sessionNeighbors || !sessionNeighbors.has(projId)) continue;
        }
        sessionNodes.push(node);
      }
    }

    // Aggregate by tool+model
    const combos = new Map();
    for (const s of sessionNodes) {
      const key = `${s.props.tool || 'unknown'}|${s.props.model || 'unknown'}`;
      if (!combos.has(key)) {
        combos.set(key, { tool: s.props.tool, model: s.props.model, totalQuality: 0, count: 0 });
      }
      const c = combos.get(key);
      c.totalQuality += (s.props.quality_score || 0);
      c.count += 1;
    }

    return [...combos.values()]
      .map(c => ({
        tool: c.tool,
        model: c.model,
        avgQuality: c.count > 0 ? c.totalQuality / c.count : 0,
        sessions: c.count,
      }))
      .sort((a, b) => b.avgQuality - a.avgQuality);
  }

  /** @returns {{nodes: number, edges: number}} Graph size stats. */
  get stats() {
    let edgeCount = 0;
    for (const neighbors of this.adjacency.values()) {
      for (const edges of neighbors.values()) {
        edgeCount += edges.length;
      }
    }
    return { nodes: this.nodes.size, edges: edgeCount / 2 }; // bidirectional, so halve
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────

/**
 * Extract a project name from a session row.
 * Uses title heuristics -- looks for path-like segments or known prefixes.
 */
function extractProject(session) {
  if (!session.title) return null;
  const title = session.title;

  // Match common patterns: "project-name: ...", "project-name/...", "[project-name] ..."
  const patterns = [
    /^\[([^\]]+)\]/,           // [project-name] ...
    /^([a-z0-9_-]+)\//i,      // project-name/...
    /^([a-z0-9_-]+):\s/i,     // project-name: ...
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m && m[1].length >= 2 && m[1].length <= 60) {
      return m[1].toLowerCase();
    }
  }
  return null;
}

/** Normalize an error string for fuzzy matching. */
function normalizeError(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compute word overlap ratio between two normalised error strings. */
function errorOverlap(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  return shared / Math.max(wordsA.size, wordsB.size);
}

// ─── Singleton ──────────────────────────────────────────────────────────────

const graph = new KnowledgeGraph();

/**
 * Build (or rebuild) the knowledge graph from the database.
 * @returns {number} Total node count.
 */
export function buildGraph() {
  return graph.buildGraph();
}

/**
 * Find sessions that resolved similar errors.
 * @param {string} errorPattern  Error description to match.
 * @param {object} [context]  Optional { tool, model, project }.
 * @returns {Array<{session: GraphNode, relevance: number}>}
 */
export function getRelatedSolutions(errorPattern, context) {
  return graph.getRelatedSolutions(errorPattern, context);
}

/**
 * Find the best tool/model combination for a task type.
 * @param {string} taskType  Task type string.
 * @param {string} [project]  Optional project filter.
 * @returns {Array<{tool: string, model: string, avgQuality: number, sessions: number}>}
 */
export function getToolPath(taskType, project) {
  return graph.getToolPath(taskType, project);
}

/**
 * Return the subgraph around a session up to the given depth.
 * @param {string} sessionId  Raw session ID.
 * @param {number} [depth=2]  Traversal depth.
 * @returns {{nodes: GraphNode[], edges: Array<{source: string, target: string, type: string, weight: number}>}}
 */
export function getNeighborhood(sessionId, depth = 2) {
  return graph.getNeighborhood(sessionId, depth);
}

/**
 * Incrementally add a session to the graph without full rebuild.
 * @param {object} session  Full session row.
 */
export function addSession(session) {
  return graph.addSession(session);
}

/** Get graph size statistics. */
export function getGraphStats() {
  return graph.stats;
}
