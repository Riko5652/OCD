// Gatekeeper routes — Task focus management & parking lot for the OCD dashboard
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

const VALID_STATUSES = ['active', 'paused', 'completed'] as const;

export default async function gatekeeperRoutes(fastify: FastifyInstance) {
    // GET /api/gatekeeper/task — current active task
    fastify.get('/api/gatekeeper/task', async () => {
        const db = getDb();
        const task = db.prepare(
            `SELECT * FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get();
        return { task: task || null };
    });

    // GET /api/gatekeeper/tasks — all tasks
    fastify.get('/api/gatekeeper/tasks', async (req) => {
        const db = getDb();
        const { status } = req.query as { status?: string };
        let sql = 'SELECT * FROM ocd_tasks';
        const params: string[] = [];
        if (status) {
            if (!VALID_STATUSES.includes(status as any)) {
                return { error: `status must be one of: ${VALID_STATUSES.join(', ')}` };
            }
            sql += ' WHERE status = ?';
            params.push(status);
        }
        sql += ' ORDER BY updated_at DESC LIMIT 50';
        const tasks = db.prepare(sql).all(...params);
        return { tasks };
    });

    // POST /api/gatekeeper/task — create new active task
    fastify.post('/api/gatekeeper/task', async (req) => {
        const db = getDb();
        const { title, description, project } = req.body as { title?: string; description?: string; project?: string };
        if (!title || typeof title !== 'string') {
            return { error: 'title is required' };
        }
        const now = Date.now();
        const result = db.transaction(() => {
            db.prepare(`UPDATE ocd_tasks SET status = 'paused', updated_at = ? WHERE status = 'active'`).run(now);
            return db.prepare(
                `INSERT INTO ocd_tasks (title, description, project, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`
            ).run(title, description || null, project || null, now, now);
        })();
        return { id: result.lastInsertRowid, title, status: 'active' };
    });

    // PATCH /api/gatekeeper/task/:id — update task status
    fastify.patch('/api/gatekeeper/task/:id', async (req) => {
        const db = getDb();
        const { id } = req.params as { id: string };
        const { status } = req.body as { status?: string };
        if (!status || !VALID_STATUSES.includes(status as any)) {
            return { error: `status must be one of: ${VALID_STATUSES.join(', ')}` };
        }
        const now = Date.now();
        if (status === 'active') {
            db.transaction(() => {
                db.prepare(`UPDATE ocd_tasks SET status = 'paused', updated_at = ? WHERE status = 'active' AND id != ?`).run(now, id);
                db.prepare(
                    `UPDATE ocd_tasks SET status = ?, updated_at = ? WHERE id = ?`
                ).run(status, now, id);
            })();
        } else {
            const completedAt = status === 'completed' ? now : null;
            db.prepare(
                `UPDATE ocd_tasks SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`
            ).run(status, now, completedAt, id);
        }
        return { id, status };
    });

    // GET /api/gatekeeper/parking — all parked ideas
    fastify.get('/api/gatekeeper/parking', async () => {
        const db = getDb();
        const ideas = db.prepare(
            `SELECT p.*, t.title as task_title FROM ocd_parking_lot p
             LEFT JOIN ocd_tasks t ON t.id = p.parked_during_task_id
             ORDER BY p.created_at DESC LIMIT 50`
        ).all();
        return { ideas };
    });

    // POST /api/gatekeeper/parking — manually park an idea
    fastify.post('/api/gatekeeper/parking', async (req) => {
        const db = getDb();
        const { idea, source_tool } = req.body as { idea?: string; source_tool?: string };
        if (!idea || typeof idea !== 'string') {
            return { error: 'idea is required' };
        }
        const activeTask = db.prepare(
            `SELECT id FROM ocd_tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get() as { id: number } | undefined;
        const result = db.prepare(
            `INSERT INTO ocd_parking_lot (idea, source_tool, parked_during_task_id, created_at) VALUES (?, ?, ?, ?)`
        ).run(idea, source_tool || null, activeTask?.id || null, Date.now());
        return { id: result.lastInsertRowid };
    });

    // PATCH /api/gatekeeper/parking/:id/promote — promote idea to task
    fastify.patch('/api/gatekeeper/parking/:id/promote', async (req) => {
        const db = getDb();
        const { id } = req.params as { id: string };
        const idea = db.prepare(`SELECT * FROM ocd_parking_lot WHERE id = ?`).get(id) as { id: number; idea: string } | undefined;
        if (!idea) return { error: 'Idea not found' };

        const now = Date.now();
        const result = db.transaction(() => {
            db.prepare(`UPDATE ocd_parking_lot SET promoted = 1 WHERE id = ?`).run(id);
            return db.prepare(
                `INSERT INTO ocd_tasks (title, description, status, created_at, updated_at) VALUES (?, ?, 'paused', ?, ?)`
            ).run(idea.idea, `Promoted from parking lot`, now, now);
        })();
        return { task_id: result.lastInsertRowid, promoted: true };
    });
}
