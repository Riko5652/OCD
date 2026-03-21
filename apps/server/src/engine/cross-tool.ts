import { getDb } from '../db/index.js';

export function detectToolSwitches(): number {
    const db = getDb();
    const sessions = db.prepare(`
        SELECT id, tool_id, started_at, ended_at, error_count, total_turns, error_recovery_pct
        FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1000
    `).all() as any[];

    const links: any[] = [];
    const WINDOW_MS = 30 * 60 * 1000;
    for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
            const a = sessions[i], b = sessions[j];
            if (a.tool_id === b.tool_id) continue;
            const gap = Math.abs((a.ended_at || a.started_at) - (b.ended_at || b.started_at));
            if (gap > WINDOW_MS) continue;
            const errorDrop = (a.error_count || 0) > 0 && (b.error_count || 0) < (a.error_count || 0);
            links.push({ session_a: a.id, session_b: b.id, link_type: 'tool_switch', quality_score: errorDrop ? 75 : 50, shared_files: 0, detected_at: Date.now() });
        }
    }

    const stmt = db.prepare('INSERT OR IGNORE INTO session_links (session_a, session_b, link_type, quality_score, shared_files, detected_at) VALUES (?,?,?,?,?,?)');
    db.transaction(() => { for (const r of links) stmt.run(r.session_a, r.session_b, r.link_type, r.quality_score, r.shared_files, r.detected_at); })();
    return links.length;
}

export function getCrossToolStats() {
    const db = getDb();
    return db.prepare(`
        SELECT sl.link_type, sl.quality_score, sa.tool_id as from_tool, sb.tool_id as to_tool,
            COUNT(*) as count, AVG(sl.quality_score) as avg_quality
        FROM session_links sl JOIN sessions sa ON sa.id = sl.session_a JOIN sessions sb ON sb.id = sl.session_b
        GROUP BY sl.link_type, sa.tool_id, sb.tool_id ORDER BY count DESC
    `).all();
}
