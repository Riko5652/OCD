// Global git commit scanner — discovers repos and correlates commits to AI sessions
import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/index.js';

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['node_modules', '.pnpm', '.yarn', '.npm', 'dist', 'build', '__pycache__', '.venv', 'vendor', 'target', '.cache', 'coverage']);

/** Recursively find all git repos under a given root, up to maxDepth */
function findGitRepos(root: string, depth = 0): string[] {
    if (depth > MAX_DEPTH) return [];
    const repos: string[] = [];
    try {
        if (existsSync(join(root, '.git'))) {
            repos.push(root);
            return repos; // Don't recurse into git repos
        }
        const entries = readdirSync(root, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            repos.push(...findGitRepos(join(root, e.name), depth + 1));
        }
    } catch { /* skip unreadable */ }
    return repos;
}

/** Get all directories to scan from env or defaults */
function getScanRoots(): string[] {
    if (process.env.GIT_SCAN_PATHS) {
        return process.env.GIT_SCAN_PATHS.split(';').filter(p => existsSync(p));
    }
    const home = homedir();
    const candidates = [
        join(home, 'Documents'),
        join(home, 'source'),
        join(home, 'Projects'),
        join(home, 'dev'),
        join(home, 'repos'),
        join(home, 'code'),
        join(home, 'workspace'),
        join('C:', 'source'),
        join('C:', 'dev'),
        join('C:', 'projects'),
    ];
    return candidates.filter(p => existsSync(p));
}

export interface DiscoveredRepo {
    path: string;
    name: string;
}

export function discoverRepos(): DiscoveredRepo[] {
    const roots = getScanRoots();
    const seen = new Set<string>();
    const repos: DiscoveredRepo[] = [];

    for (const root of roots) {
        for (const repoPath of findGitRepos(root)) {
            if (seen.has(repoPath)) continue;
            seen.add(repoPath);
            repos.push({ path: repoPath, name: basename(repoPath) });
        }
    }
    return repos;
}

interface ParsedCommit {
    hash: string;
    date: string;
    ts: number;
    message: string;
    branch: string;
    additions: number;
    deletions: number;
    repoName: string;
}

function parseGitLog(repoPath: string): ParsedCommit[] {
    const commits: ParsedCommit[] = [];
    let raw: string;
    try {
        raw = execSync(
            'git log --format="%H|%ai|%s|%D" --numstat --since="180 days ago" --no-merges',
            { cwd: repoPath, timeout: 15_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
    } catch { return []; }

    const repoName = basename(repoPath);
    let current: ParsedCommit | null = null;

    for (const line of raw.split('\n')) {
        const cm = line.match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.*)$/);
        if (cm) {
            if (current && current.additions + current.deletions > 0) commits.push(current);
            const [, hash, dateStr, message, refs] = cm;
            const ts = new Date(dateStr).getTime();
            const branchMatch = refs.match(/HEAD -> ([^,]+)/);
            const branch = branchMatch
                ? branchMatch[1].trim()
                : (refs.split(',').find(r => !r.includes('HEAD') && r.trim()) || refs.split(',')[0] || 'unknown').trim().replace('origin/', '');
            current = { hash, date: dateStr, ts, message: message.slice(0, 200), branch, additions: 0, deletions: 0, repoName };
            continue;
        }
        if (current && /^\d/.test(line)) {
            const parts = line.split('\t');
            current.additions += parseInt(parts[0]) || 0;
            current.deletions += parseInt(parts[1]) || 0;
        }
    }
    if (current && current.additions + current.deletions > 0) commits.push(current);
    return commits;
}

/** Main entry point — discovers all repos, scans git logs, correlates to sessions, writes commit_scores */
export function scanAndScoreGitCommits(): { repos: number; commits: number } {
    const db = getDb();
    const repos = discoverRepos();

    if (repos.length === 0) return { repos: 0, commits: 0 };

    // Load all sessions with time windows for correlation
    const sessions = db.prepare(`
        SELECT id, tool_id, started_at, ended_at, code_lines_added, code_lines_removed
        FROM sessions
        WHERE started_at IS NOT NULL AND started_at > 0
        ORDER BY started_at
    `).all() as any[];

    const SESSION_WINDOW_MS = 10 * 60 * 1000; // ±10 minutes

    const upsert = db.prepare(`
        INSERT OR REPLACE INTO commit_scores
        (commit_hash, branch, tool_id, scored_at, lines_added, lines_deleted,
         ai_lines_added, ai_lines_deleted, human_lines_added, human_lines_deleted,
         ai_percentage, commit_message, commit_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const seenHashes = new Set<string>();
    let totalCommits = 0;

    // Load already-scored commits to skip re-processing
    const alreadyScored = db.prepare('SELECT commit_hash FROM commit_scores').all() as any[];
    for (const r of alreadyScored) seenHashes.add(r.commit_hash);

    for (const repo of repos) {
        const commits = parseGitLog(repo.path);

        db.transaction(() => {
            for (const c of commits) {
                if (seenHashes.has(c.hash)) continue;
                seenHashes.add(c.hash);

                // Find the best matching session within the time window
                const matchingSession = sessions.find(s => {
                    const start = (s.started_at || 0) - SESSION_WINDOW_MS;
                    const end = (s.ended_at || s.started_at || 0) + SESSION_WINDOW_MS;
                    return c.ts >= start && c.ts <= end;
                });

                let aiPct = 0;
                let toolId = 'cursor'; // default to most common
                if (matchingSession) {
                    // Calculate AI percentage based on session code generation vs commit size
                    const sessionTotal = (matchingSession.code_lines_added || 0) + (matchingSession.code_lines_removed || 0);
                    const commitTotal = c.additions + c.deletions;
                    const rawPct = commitTotal > 0 && sessionTotal > 0
                        ? Math.min(95, (sessionTotal / Math.max(sessionTotal, commitTotal)) * 100)
                        : 80; // if matched but no line data, assume 80%
                    aiPct = Math.round(rawPct);
                    toolId = matchingSession.tool_id;
                }

                const aiLinesAdded = Math.round(c.additions * aiPct / 100);
                const aiLinesDeleted = Math.round(c.deletions * aiPct / 100);

                upsert.run(
                    c.hash, c.branch, toolId, c.ts,
                    c.additions, c.deletions,
                    aiLinesAdded, aiLinesDeleted,
                    c.additions - aiLinesAdded, c.deletions - aiLinesDeleted,
                    aiPct, c.message, c.date
                );
                totalCommits++;
            }
        })();
    }

    return { repos: repos.length, commits: totalCommits };
}
