// Antigravity adapter — Google's Gemini local IDE
// Parses annotations/*.pbtxt, brain/*/metadata.json, and code_tracker/active/
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { config } from '../config.js';
import type { IAiAdapter, ToolId, UnifiedSession, UnifiedTurn, AiFile } from './types.js';

interface BrainArtifact {
    type: string;
    summary: string | null;
    version: number;
    updatedAt: number | null;
    contentSize: number;  // actual artifact file size in bytes
    logSize: number;      // conversation log size in bytes
}

interface CodeTrackerFile {
    project: string;
    file: string;
    size: number;
    mtime: number;
    ext: string;
}

export class AntigravityAdapter implements IAiAdapter {
    readonly id: ToolId = 'antigravity';
    readonly name = 'Antigravity';

    private getAllDirs(): string[] {
        return [
            config.antigravity.dir,
            ...config.antigravity.importedDirs,
        ].filter(d => existsSync(d));
    }

    private parseAnnotations(): Map<string, number> {
        const timestamps = new Map<string, number>();
        for (const baseDir of this.getAllDirs()) {
            const annotDir = join(baseDir, 'annotations');
            if (!existsSync(annotDir)) continue;
            for (const file of readdirSync(annotDir)) {
                if (!file.endsWith('.pbtxt')) continue;
                const id = file.replace('.pbtxt', '');
                if (timestamps.has(id)) continue;
                try {
                    const text = readFileSync(join(annotDir, file), 'utf-8');
                    const match = text.match(/seconds:(\d+)/);
                    if (match) timestamps.set(id, parseInt(match[1]) * 1000);
                } catch { /* skip */ }
            }
        }
        return timestamps;
    }

    private parseBrainArtifacts(): Map<string, BrainArtifact[]> {
        const artifacts = new Map<string, BrainArtifact[]>();
        for (const baseDir of this.getAllDirs()) {
            const brainDir = join(baseDir, 'brain');
            if (!existsSync(brainDir)) continue;
            for (const dir of readdirSync(brainDir)) {
                if (artifacts.has(dir)) continue;
                const brainPath = join(brainDir, dir);
                try { if (!statSync(brainPath).isDirectory()) continue; } catch { continue; }

                const conversationArtifacts: BrainArtifact[] = [];
                for (const file of readdirSync(brainPath)) {
                    if (!file.endsWith('.metadata.json')) continue;
                    try {
                        const metaPath = join(brainPath, file);
                        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                        // Try to read actual artifact file for real size-based token estimate
                        let contentSize = 0;
                        const artifactFile = file.replace('.metadata.json', '');
                        const artifactPath = join(brainPath, artifactFile);
                        if (existsSync(artifactPath)) {
                            try { contentSize = statSync(artifactPath).size; } catch { /* skip */ }
                        }
                        // Also check .system_generated/logs for conversation log size
                        let logSize = 0;
                        const logPath = join(brainPath, '.system_generated', 'logs');
                        if (existsSync(logPath)) {
                            try {
                                for (const lf of readdirSync(logPath)) {
                                    logSize += statSync(join(logPath, lf)).size;
                                }
                            } catch { /* skip */ }
                        }
                        conversationArtifacts.push({
                            type: meta.artifactType || 'unknown',
                            summary: meta.summary || null,
                            version: parseInt(meta.version || '1'),
                            updatedAt: meta.updatedAt ? new Date(meta.updatedAt).getTime() : null,
                            contentSize,
                            logSize,
                        });
                    } catch { /* skip */ }
                }
                if (conversationArtifacts.length > 0) {
                    artifacts.set(dir, conversationArtifacts);
                }
            }
        }
        return artifacts;
    }

    private parseCodeTracker(): AiFile[] {
        const dirs = this.getAllDirs();
        const files: AiFile[] = [];
        for (const baseDir of dirs) {
            const ctDir = join(baseDir, 'code_tracker', 'active');
            if (!existsSync(ctDir)) continue;
            for (const project of readdirSync(ctDir)) {
                const projectPath = join(ctDir, project);
                try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }
                for (const file of readdirSync(projectPath)) {
                    try {
                        const stat = statSync(join(projectPath, file));
                        files.push({
                            tool_id: 'antigravity',
                            file_path: `${project}/${file}`,
                            file_extension: extname(file).replace('.', ''),
                            action: 'created',
                            created_at: stat.mtimeMs,
                        });
                    } catch { /* skip */ }
                }
            }
        }
        return files;
    }

    private parseCodeTrackerDeep(): { files: CodeTrackerFile[]; totalSize: number } {
        const dirs = this.getAllDirs();
        const files: CodeTrackerFile[] = [];
        let totalSize = 0;
        for (const baseDir of dirs) {
            const ctDir = join(baseDir, 'code_tracker', 'active');
            if (!existsSync(ctDir)) continue;
            for (const project of readdirSync(ctDir)) {
                const projectPath = join(ctDir, project);
                try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }
                for (const file of readdirSync(projectPath)) {
                    try {
                        const stat = statSync(join(projectPath, file));
                        if (stat.isFile()) {
                            files.push({ project, file, size: stat.size, mtime: stat.mtimeMs, ext: extname(file).replace('.', '') });
                            totalSize += stat.size;
                        }
                    } catch { /* skip */ }
                }
            }
        }
        return { files, totalSize };
    }

    private parseScratchFiles(): { name: string; size: number; mtime: number }[] {
        const dirs = this.getAllDirs();
        const files: { name: string; size: number; mtime: number }[] = [];
        for (const baseDir of dirs) {
            const scratchDir = join(baseDir, 'scratch');
            if (!existsSync(scratchDir)) continue;
            for (const f of readdirSync(scratchDir)) {
                try {
                    const fp = join(scratchDir, f);
                    const stat = statSync(fp);
                    if (stat.isFile()) files.push({ name: f, size: stat.size, mtime: stat.mtimeMs });
                } catch { /* skip */ }
            }
        }
        return files;
    }

    private countConversations(): number {
        let count = 0;
        for (const baseDir of this.getAllDirs()) {
            const convDir = join(baseDir, 'conversations');
            if (!existsSync(convDir)) continue;
            count += readdirSync(convDir).filter(f => f.endsWith('.pb')).length;
        }
        return count;
    }

    async getSessions(): Promise<UnifiedSession[]> {
        const annotations = this.parseAnnotations();
        const artifacts = this.parseBrainArtifacts();
        const scratchFiles = this.parseScratchFiles();
        const codeTracker = this.parseCodeTrackerDeep();
        const sessions: UnifiedSession[] = [];

        const allIds = new Set([...annotations.keys(), ...artifacts.keys()]);

        for (const baseDir of this.getAllDirs()) {
            const convDir = join(baseDir, 'conversations');
            if (existsSync(convDir)) {
                for (const f of readdirSync(convDir)) {
                    if (f.endsWith('.pb')) allIds.add(f.replace('.pb', ''));
                }
            }
        }

        const totalScratchTokens = scratchFiles.reduce((s, f) => s + Math.round(f.size / 4), 0);
        const totalCodeTokens = Math.round(codeTracker.totalSize / 4);
        const sessionsWithArtifacts = [...allIds].filter(id => (artifacts.get(id) || []).length > 0).length;
        const scratchPerSession = sessionsWithArtifacts > 0
            ? Math.round((totalScratchTokens + totalCodeTokens) / sessionsWithArtifacts) : 0;

        const totalCodeLines = codeTracker.files.reduce((s, f) => s + Math.round(f.size / 40), 0);
        const totalCodeFiles = codeTracker.files.length;
        const codeLinesPerSession = sessionsWithArtifacts > 0 ? Math.round(totalCodeLines / sessionsWithArtifacts) : 0;
        const codeFilesPerSession = sessionsWithArtifacts > 0 ? Math.round(totalCodeFiles / sessionsWithArtifacts) : 0;

        for (const id of allIds) {
            const lastView = annotations.get(id);
            const arts = artifacts.get(id) || [];

            const artTimestamps = arts.map(a => a.updatedAt).filter((v): v is number => v != null);
            const earliest = artTimestamps.length > 0 ? Math.min(...artTimestamps) : undefined;
            const latest = artTimestamps.length > 0 ? Math.max(...artTimestamps) : undefined;

            const typeCounts: Record<string, number> = {};
            for (const a of arts) {
                const shortType = a.type.replace('ARTIFACT_TYPE_', '').toLowerCase();
                typeCounts[shortType] = (typeCounts[shortType] || 0) + 1;
            }

            const totalVersions = arts.reduce((s, a) => s + a.version, 0);

            // Use conversation .pb file size as a token estimate fallback
            let convFileSize = 0;
            for (const baseDir of this.getAllDirs()) {
                const convPath = join(baseDir, 'conversations', `${id}.pb`);
                if (existsSync(convPath)) {
                    try { convFileSize = statSync(convPath).size; } catch { /* skip */ }
                    break;
                }
            }

            let estimatedOutput = 0;
            for (const a of arts) {
                // Use actual file size if available (4 chars/token heuristic)
                if (a.contentSize > 0) {
                    estimatedOutput += Math.round(a.contentSize / 4);
                } else if (a.summary) {
                    estimatedOutput += Math.round(a.summary.length / 4);
                } else {
                    estimatedOutput += 50; // minimum stub
                }
                estimatedOutput += a.version * 150; // each version = ~150 output tokens of iteration
            }
            // Log files indicate real conversation depth — use log size to estimate input tokens
            const logTokens = arts.reduce((s, a) => s + Math.round(a.logSize / 4), 0);
            let totalInput = logTokens || (arts.length > 0 ? scratchPerSession : 0);
            if (arts.length > 0) estimatedOutput += scratchPerSession;

            // Fallback: use conversation .pb file size to estimate tokens when no artifacts exist
            // Encrypted .pb files are roughly 8 bytes per token (conservative estimate)
            if (convFileSize > 0 && arts.length === 0) {
                const convTokenEstimate = Math.round(convFileSize / 8);
                totalInput = Math.round(convTokenEstimate * 0.6);
                estimatedOutput = Math.round(convTokenEstimate * 0.4);
            }

            // Try to extract title from task.md if no summary available
            let title = arts[0]?.summary || undefined;
            if (!title) {
                for (const baseDir of this.getAllDirs()) {
                    const taskPath = join(baseDir, 'brain', id, 'task.md');
                    if (existsSync(taskPath)) {
                        try {
                            const content = readFileSync(taskPath, 'utf-8');
                            const firstLine = content.split('\n').find(l => l.trim().length > 0);
                            if (firstLine) title = firstLine.replace(/^#+\s*/, '').trim().slice(0, 200);
                        } catch { /* skip */ }
                        break;
                    }
                }
            }

            sessions.push({
                id: `ag-${id}`,
                tool_id: 'antigravity',
                title,
                started_at: earliest || lastView || Date.now(),
                ended_at: latest || lastView,
                total_turns: Math.max(arts.length, totalVersions) || (convFileSize > 0 ? 1 : 0),
                total_input_tokens: totalInput,
                total_output_tokens: estimatedOutput,
                total_cache_read: 0,
                total_cache_create: 0,
                models_used: ['gemini'],
                primary_model: 'gemini',
                code_lines_added: arts.length > 0 ? codeLinesPerSession : 0,
                code_lines_removed: 0,
                files_touched: arts.length > 0 ? codeFilesPerSession : 0,
                error_count: 0,
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

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const id = sessionId.replace('ag-', '');
        const arts = this.parseBrainArtifacts().get(id) || [];

        return arts.map(a => ({
            session_id: sessionId,
            timestamp: a.updatedAt || Date.now(),
            model: 'gemini',
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_create: 0,
            tools_used: [],
            label: `[${a.type.replace('ARTIFACT_TYPE_', '')}] ${a.summary || ''}`.slice(0, 100),
            type: 2,
        }));
    }

    async getAiFiles(): Promise<AiFile[]> {
        return this.parseCodeTracker();
    }

    getStats() {
        const artifacts = this.parseBrainArtifacts();
        let totalArtifacts = 0;
        let totalVersions = 0;
        const typeCounts: Record<string, number> = {};

        for (const [, arts] of artifacts) {
            totalArtifacts += arts.length;
            for (const a of arts) {
                totalVersions += a.version;
                const t = a.type.replace('ARTIFACT_TYPE_', '').toLowerCase();
                typeCounts[t] = (typeCounts[t] || 0) + 1;
            }
        }

        return {
            total_conversations: this.countConversations(),
            total_artifacts: totalArtifacts,
            total_versions: totalVersions,
            artifact_types: typeCounts,
        };
    }
}
