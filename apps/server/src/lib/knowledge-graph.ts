// Semantic memory: in-memory knowledge graph built from session data
// Adjacency-list representation using nested Maps

import { getDb } from '../db/index.js';

const SEQUENTIAL_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

type NodeType = 'session' | 'tool' | 'model' | 'project' | 'error_pattern' | 'task_type';
type EdgeType = 'same_project' | 'same_tool' | 'same_model' | 'similar_error' | 'sequential' | 'same_task_type';

interface GraphNode {
    id: string;
    type: NodeType;
    props: Record<string, any>;
}

interface GraphEdge {
    target: string;
    type: EdgeType;
    weight: number;
}

class KnowledgeGraph {
    nodes = new Map<string, GraphNode>();
    adjacency = new Map<string, Map<string, GraphEdge[]>>();
    built = false;

    private _addNode(id: string, type: NodeType, props: Record<string, any> = {}) {
        if (!this.nodes.has(id)) {
            this.nodes.set(id, { id, type, props });
            this.adjacency.set(id, new Map());
        } else {
            Object.assign(this.nodes.get(id)!.props, props);
        }
    }

    private _addEdge(sourceId: string, targetId: string, type: EdgeType, weight = 1.0) {
        if (!this.adjacency.has(sourceId)) this.adjacency.set(sourceId, new Map());
        const neighbors = this.adjacency.get(sourceId)!;
        if (!neighbors.has(targetId)) neighbors.set(targetId, []);
        const existing = neighbors.get(targetId)!;
        const dup = existing.find(e => e.type === type);
        if (dup) { dup.weight = Math.max(dup.weight, weight); }
        else { existing.push({ target: targetId, type, weight }); }

        // Bidirectional
        if (!this.adjacency.has(targetId)) this.adjacency.set(targetId, new Map());
        const reverse = this.adjacency.get(targetId)!;
        if (!reverse.has(sourceId)) reverse.set(sourceId, []);
        const revExisting = reverse.get(sourceId)!;
        const revDup = revExisting.find(e => e.type === type);
        if (revDup) { revDup.weight = Math.max(revDup.weight, weight); }
        else { revExisting.push({ target: sourceId, type, weight }); }
    }

    buildGraph(): number {
        this.nodes.clear();
        this.adjacency.clear();

        const db = getDb();
        const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at ASC').all() as any[];

        const byProject = new Map<string, string[]>();
        const byTool = new Map<string, string[]>();
        const byModel = new Map<string, string[]>();
        const byTaskType = new Map<string, string[]>();
        const errorIndex = new Map<string, string[]>();
        const chronological: Array<{ id: string; started_at: number }> = [];

        let taskMap = new Map<string, any>();
        try {
            const tasks = db.prepare('SELECT * FROM task_classifications').all() as any[];
            for (const t of tasks) taskMap.set(t.session_id, t);
        } catch { /* table may not exist */ }

        for (const s of sessions) {
            const sid = `session:${s.id}`;
            this._addNode(sid, 'session', {
                quality_score: s.quality_score, turns: s.total_turns, model: s.primary_model,
                tool: s.tool_id, started_at: s.started_at, title: s.title, tldr: s.tldr,
                error_count: s.error_count,
            });
            chronological.push({ id: sid, started_at: s.started_at });

            if (s.tool_id) {
                const toolId = `tool:${s.tool_id}`;
                this._addNode(toolId, 'tool', { name: s.tool_id });
                this._addEdge(sid, toolId, 'same_tool');
                if (!byTool.has(s.tool_id)) byTool.set(s.tool_id, []);
                byTool.get(s.tool_id)!.push(sid);
            }

            if (s.primary_model) {
                const modelId = `model:${s.primary_model}`;
                this._addNode(modelId, 'model', { name: s.primary_model });
                this._addEdge(sid, modelId, 'same_model');
                if (!byModel.has(s.primary_model)) byModel.set(s.primary_model, []);
                byModel.get(s.primary_model)!.push(sid);
            }

            const project = extractProject(s);
            if (project) {
                const projId = `project:${project}`;
                this._addNode(projId, 'project', { name: project });
                this._addEdge(sid, projId, 'same_project');
                if (!byProject.has(project)) byProject.set(project, []);
                byProject.get(project)!.push(sid);
            }

            const tc = taskMap.get(s.id);
            if (tc?.task_type) {
                const ttId = `task_type:${tc.task_type}`;
                this._addNode(ttId, 'task_type', { name: tc.task_type });
                this._addEdge(sid, ttId, 'same_task_type');
                if (!byTaskType.has(tc.task_type)) byTaskType.set(tc.task_type, []);
                byTaskType.get(tc.task_type)!.push(sid);
            }

            try {
                const turns = db.prepare(
                    "SELECT DISTINCT label FROM turns WHERE session_id = ? AND label IS NOT NULL AND label LIKE '%error%'"
                ).all(s.id) as any[];
                for (const t of turns) {
                    const pattern = normalizeError(t.label);
                    const errId = `error_pattern:${pattern}`;
                    this._addNode(errId, 'error_pattern', { pattern });
                    this._addEdge(sid, errId, 'similar_error');
                    if (!errorIndex.has(pattern)) errorIndex.set(pattern, []);
                    errorIndex.get(pattern)!.push(sid);
                }
            } catch { /* turns query may fail */ }
        }

        this._buildCrossEdges(byProject, 'same_project');
        this._buildCrossEdges(byTool, 'same_tool');
        this._buildCrossEdges(byModel, 'same_model');
        this._buildCrossEdges(byTaskType, 'same_task_type');
        this._buildCrossEdges(errorIndex, 'similar_error');

        for (let i = 1; i < chronological.length; i++) {
            const prev = chronological[i - 1];
            const curr = chronological[i];
            if (prev.started_at && curr.started_at) {
                const gap = curr.started_at - prev.started_at;
                if (gap >= 0 && gap <= SEQUENTIAL_WINDOW_MS) {
                    this._addEdge(prev.id, curr.id, 'sequential', 1.0 - (gap / SEQUENTIAL_WINDOW_MS));
                }
            }
        }

        this.built = true;
        return this.nodes.size;
    }

    private _buildCrossEdges(index: Map<string, string[]>, edgeType: EdgeType) {
        for (const sessionIds of index.values()) {
            const ids = sessionIds.slice(-50);
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    this._addEdge(ids[i], ids[j], edgeType, 0.5);
                }
            }
        }
    }

    addSession(session: any) {
        const db = getDb();
        const sid = `session:${session.id}`;
        this._addNode(sid, 'session', {
            quality_score: session.quality_score, turns: session.total_turns,
            model: session.primary_model, tool: session.tool_id,
            started_at: session.started_at, title: session.title, tldr: session.tldr,
            error_count: session.error_count,
        });

        if (session.tool_id) {
            const toolId = `tool:${session.tool_id}`;
            this._addNode(toolId, 'tool', { name: session.tool_id });
            this._addEdge(sid, toolId, 'same_tool');
        }
        if (session.primary_model) {
            const modelId = `model:${session.primary_model}`;
            this._addNode(modelId, 'model', { name: session.primary_model });
            this._addEdge(sid, modelId, 'same_model');
        }
        const project = extractProject(session);
        if (project) {
            const projId = `project:${project}`;
            this._addNode(projId, 'project', { name: project });
            this._addEdge(sid, projId, 'same_project');
        }
        try {
            const tc = db.prepare('SELECT * FROM task_classifications WHERE session_id = ?').get(session.id) as any;
            if (tc?.task_type) {
                const ttId = `task_type:${tc.task_type}`;
                this._addNode(ttId, 'task_type', { name: tc.task_type });
                this._addEdge(sid, ttId, 'same_task_type');
            }
        } catch { /* ok */ }
    }

    getNeighborhood(sessionId: string, depth = 2) {
        const startId = `session:${sessionId}`;
        if (!this.nodes.has(startId)) return { nodes: [] as GraphNode[], edges: [] as any[] };

        const visited = new Set<string>();
        const resultEdges: any[] = [];
        let frontier = [startId];

        for (let d = 0; d < depth && frontier.length > 0; d++) {
            const nextFrontier: string[] = [];
            for (const nodeId of frontier) {
                if (visited.has(nodeId)) continue;
                visited.add(nodeId);
                const neighbors = this.adjacency.get(nodeId);
                if (!neighbors) continue;
                for (const [targetId, edges] of neighbors) {
                    for (const edge of edges) {
                        resultEdges.push({ source: nodeId, target: targetId, type: edge.type, weight: edge.weight });
                    }
                    if (!visited.has(targetId)) nextFrontier.push(targetId);
                }
            }
            frontier = nextFrontier;
        }

        const resultNodes: GraphNode[] = [];
        for (const nodeId of visited) {
            const node = this.nodes.get(nodeId);
            if (node) resultNodes.push(node);
        }
        return { nodes: resultNodes, edges: resultEdges };
    }

    getRelatedSolutions(errorPattern: string, context: { tool?: string; model?: string } = {}) {
        const normalised = normalizeError(errorPattern);
        const candidates: Array<{ session: GraphNode; relevance: number }> = [];

        for (const [nodeId, node] of this.nodes) {
            if (node.type !== 'error_pattern' || !node.props.pattern) continue;
            const overlap = errorOverlap(normalised, node.props.pattern);
            if (overlap < 0.3) continue;

            const neighbors = this.adjacency.get(nodeId);
            if (!neighbors) continue;
            for (const [targetId] of neighbors) {
                const targetNode = this.nodes.get(targetId);
                if (!targetNode || targetNode.type !== 'session') continue;
                let relevance = overlap;
                if (targetNode.props.quality_score) relevance *= (0.5 + targetNode.props.quality_score / 200);
                if (context.tool && targetNode.props.tool === context.tool) relevance *= 1.3;
                if (context.model && targetNode.props.model === context.model) relevance *= 1.1;
                candidates.push({ session: targetNode, relevance });
            }
        }

        const best = new Map<string, { session: GraphNode; relevance: number }>();
        for (const c of candidates) {
            const existing = best.get(c.session.id);
            if (!existing || c.relevance > existing.relevance) best.set(c.session.id, c);
        }
        return [...best.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 10);
    }

    getToolPath(taskType: string, project?: string) {
        const ttId = `task_type:${taskType}`;
        const neighbors = this.adjacency.get(ttId);
        if (!neighbors) return [];

        const sessionNodes: GraphNode[] = [];
        for (const [targetId] of neighbors) {
            const node = this.nodes.get(targetId);
            if (node && node.type === 'session') {
                if (project) {
                    const projId = `project:${project}`;
                    const sn = this.adjacency.get(targetId);
                    if (!sn || !sn.has(projId)) continue;
                }
                sessionNodes.push(node);
            }
        }

        const combos = new Map<string, { tool: string; model: string; totalQuality: number; count: number }>();
        for (const s of sessionNodes) {
            const key = `${s.props.tool || 'unknown'}|${s.props.model || 'unknown'}`;
            if (!combos.has(key)) combos.set(key, { tool: s.props.tool, model: s.props.model, totalQuality: 0, count: 0 });
            const c = combos.get(key)!;
            c.totalQuality += (s.props.quality_score || 0);
            c.count += 1;
        }

        return [...combos.values()]
            .map(c => ({ tool: c.tool, model: c.model, avgQuality: c.count > 0 ? c.totalQuality / c.count : 0, sessions: c.count }))
            .sort((a, b) => b.avgQuality - a.avgQuality);
    }

    get stats() {
        let edgeCount = 0;
        for (const neighbors of this.adjacency.values()) {
            for (const edges of neighbors.values()) edgeCount += edges.length;
        }
        return { nodes: this.nodes.size, edges: edgeCount / 2 };
    }
}

function extractProject(session: any): string | null {
    if (!session.title) return null;
    const patterns = [/^\[([^\]]+)\]/, /^([a-z0-9_-]+)\//i, /^([a-z0-9_-]+):\s/i];
    for (const p of patterns) {
        const m = session.title.match(p);
        if (m && m[1].length >= 2 && m[1].length <= 60) return m[1].toLowerCase();
    }
    return null;
}

function normalizeError(str: string): string {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function errorOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
    const wordsB = new Set(b.split(' ').filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let shared = 0;
    for (const w of wordsA) { if (wordsB.has(w)) shared++; }
    return shared / Math.max(wordsA.size, wordsB.size);
}

// Singleton
const graph = new KnowledgeGraph();

export function buildGraph(): number { return graph.buildGraph(); }
export function getRelatedSolutions(errorPattern: string, context?: { tool?: string; model?: string }) { return graph.getRelatedSolutions(errorPattern, context); }
export function getToolPath(taskType: string, project?: string) { return graph.getToolPath(taskType, project); }
export function getNeighborhood(sessionId: string, depth = 2) { return graph.getNeighborhood(sessionId, depth); }
export function addSession(session: any) { return graph.addSession(session); }
export function getGraphStats() { return graph.stats; }
