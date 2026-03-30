// Antigravity adapter — Google's Gemini local IDE
// Parses annotations/*.pbtxt, brain/*/metadata.json, and code_tracker/active/
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { gunzipSync, inflateSync } from 'zlib';
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

interface ResolvedEntry {
    path: string;
    artifactName: string;
    version: number;
    timestamp: number;
    size: number;
}

type TurnIntent = 'plan' | 'implement' | 'verify' | 'rollback' | 'investigate' | 'unknown';

interface DeltaStats {
    added: number;
    removed: number;
    changed: number;
}

interface FileImpact {
    total_unique_files: number;
    by_extension: Record<string, number>;
    by_module: Record<string, number>;
    sample_files: string[];
}

interface ResolvedBuildResult {
    turns: UnifiedTurn[];
    intentCounts: Record<TurnIntent, number>;
    deltaSummary: {
        pairs: number;
        added: number;
        removed: number;
        changed: number;
    };
    fileImpact: FileImpact;
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

    private getBrainDirPath(id: string): string | null {
        for (const baseDir of this.getAllDirs()) {
            const brainPath = join(baseDir, 'brain', id);
            if (!existsSync(brainPath)) continue;
            try {
                if (statSync(brainPath).isDirectory()) return brainPath;
            } catch { /* skip */ }
        }
        return null;
    }

    private getResolvedEntries(id: string): ResolvedEntry[] {
        const brainDir = this.getBrainDirPath(id);
        if (!brainDir) return [];

        const byArtifact = new Map<string, ResolvedEntry[]>();
        for (const file of readdirSync(brainDir)) {
            const match = file.match(/^(.+)\.resolved(?:\.(\d+))?$/);
            if (!match) continue;
            const artifactName = match[1];
            const version = match[2] ? parseInt(match[2], 10) : -1;
            const fullPath = join(brainDir, file);
            try {
                const stat = statSync(fullPath);
                if (!stat.isFile()) continue;
                const bucket = byArtifact.get(artifactName) || [];
                bucket.push({
                    path: fullPath,
                    artifactName,
                    version,
                    timestamp: stat.mtimeMs,
                    size: stat.size,
                });
                byArtifact.set(artifactName, bucket);
            } catch { /* skip unreadable files */ }
        }

        const selected: ResolvedEntry[] = [];
        for (const [, entries] of byArtifact) {
            const numeric = entries.filter(e => e.version >= 0).sort((a, b) => a.version - b.version);
            if (numeric.length > 0) selected.push(...numeric);
            else selected.push(...entries.filter(e => e.version === -1));
        }

        return selected.sort((a, b) => a.timestamp - b.timestamp);
    }

    private extractPrimaryLine(content: string): string {
        const first = content
            .split('\n')
            .map(l => l.trim())
            .find(Boolean);
        return (first || 'artifact update').replace(/^#+\s*/, '').slice(0, 120);
    }

    private inferIntent(content: string, artifactName?: string): TurnIntent {
        const c = content.toLowerCase();
        const a = (artifactName || '').toLowerCase();

        if (/rollback|revert|backout|undo|restore/.test(c) || /rollback/.test(a)) return 'rollback';
        if (/verify|validation|test|assert|check|qa|inspection/.test(c) || /verification/.test(a)) return 'verify';
        if (/investigate|analy[sz]e|debug|root cause|diagnos/.test(c) || /analysis|gap/.test(a)) return 'investigate';
        if (/implement|build|create|write|code|patch|migration|activate|execution/.test(c) || /implementation/.test(a)) return 'implement';
        if (/plan|hld|design|approach|roadmap|todo|task/.test(c) || /task|plan|hld|walkthrough/.test(a)) return 'plan';
        return 'unknown';
    }

    private computeLineDelta(prevContent: string, nextContent: string): DeltaStats {
        const prev = new Set(prevContent.split('\n').map(l => l.trim()).filter(Boolean));
        const next = new Set(nextContent.split('\n').map(l => l.trim()).filter(Boolean));
        let added = 0;
        let removed = 0;

        for (const line of next) {
            if (!prev.has(line)) added++;
        }
        for (const line of prev) {
            if (!next.has(line)) removed++;
        }
        return { added, removed, changed: added + removed };
    }

    private extractFilePaths(content: string): string[] {
        const paths = new Set<string>();
        const cleanPath = (raw: string) => raw
            .replace(/\\/g, '/')
            .replace(/[?#].*$/, '')
            .trim();

        for (const m of content.matchAll(/file:\/\/\/([^\s)>\]]+)/g)) {
            const p = cleanPath(decodeURIComponent(m[1] || ''));
            if (p) paths.add(p);
        }
        for (const m of content.matchAll(/`((?:[A-Za-z]:)?[\\/][^`\n]+?\.[A-Za-z0-9]+)`/g)) {
            const p = cleanPath(m[1]);
            if (p) paths.add(p);
        }
        for (const m of content.matchAll(/`([^`\n]+?\.[A-Za-z0-9]+)`/g)) {
            const raw = m[1].trim();
            if (raw.includes('/') || raw.includes('\\')) paths.add(cleanPath(raw));
        }
        return [...paths];
    }

    private extractFileTools(content: string): string[] {
        const matches = [...content.matchAll(/file:\/\/\/([^\s)]+)/g)];
        if (matches.length === 0) return [];
        const tools = new Set<string>();
        for (const m of matches) {
            const full = m[1] || '';
            const name = full.split(/[\\/]/).pop() || full;
            tools.add(name.slice(0, 80));
            if (tools.size >= 8) break;
        }
        return [...tools];
    }

    private buildFileImpact(paths: string[]): FileImpact {
        const byExt: Record<string, number> = {};
        const byModule: Record<string, number> = {};
        const unique = [...new Set(paths.map(p => p.replace(/\\/g, '/')))];

        for (const p of unique) {
            const rawExt = extname(p).replace('.', '').toLowerCase();
            const ext = /^[a-z0-9]{1,6}$/.test(rawExt) ? rawExt : 'none';
            byExt[ext] = (byExt[ext] || 0) + 1;

            const segs = p.split('/').filter(Boolean);
            let module = 'root';
            const srcIdx = segs.findIndex(s => s.toLowerCase() === 'src');
            if (srcIdx >= 0 && segs[srcIdx + 1]) module = `src/${segs[srcIdx + 1]}`;
            else if (segs.length >= 2) module = `${segs[segs.length - 2]}`;
            else if (segs.length === 1) module = segs[0];
            byModule[module] = (byModule[module] || 0) + 1;
        }

        return {
            total_unique_files: unique.length,
            by_extension: byExt,
            by_module: byModule,
            sample_files: unique.slice(0, 20),
        };
    }

    private parseProtoVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
        let result = 0;
        let shift = 0;
        let i = offset;
        while (i < buf.length && shift < 35) {
            const b = buf[i];
            result |= (b & 0x7f) << shift;
            i++;
            if ((b & 0x80) === 0) return { value: result, next: i };
            shift += 7;
        }
        return null;
    }

    private maybeDecompress(data: Buffer): Buffer | null {
        try {
            if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) return gunzipSync(data);
            if (data.length > 2 && data[0] === 0x78) return inflateSync(data);
        } catch { /* ignore compressed parse failures */ }
        return null;
    }

    private extractTextCandidatesFromPb(buf: Buffer): string[] {
        const candidates: string[] = [];

        const pushCandidate = (b: Buffer) => {
            if (b.length < 20) return;
            const text = b.toString('utf8').replace(/[\x00-\x09\x0b-\x1f]/g, '').trim();
            if (text.length < 20) return;
            const printable = [...text].filter(ch => ch >= ' ' && ch <= '~').length;
            if (printable / text.length < 0.7) return;
            candidates.push(text);
        };

        let off = 0;
        while (off < buf.length) {
            const key = this.parseProtoVarint(buf, off);
            if (!key) break;
            off = key.next;
            const wireType = key.value & 0x7;

            if (wireType === 0) {
                const v = this.parseProtoVarint(buf, off);
                if (!v) break;
                off = v.next;
            } else if (wireType === 1) {
                off += 8;
            } else if (wireType === 2) {
                const lenVar = this.parseProtoVarint(buf, off);
                if (!lenVar) break;
                off = lenVar.next;
                const len = lenVar.value;
                if (len < 0 || off + len > buf.length) break;
                const payload = buf.subarray(off, off + len);
                pushCandidate(payload);
                const decomp = this.maybeDecompress(payload);
                if (decomp) pushCandidate(decomp);
                off += len;
            } else if (wireType === 5) {
                off += 4;
            } else {
                break;
            }
        }

        const deduped = [...new Set(candidates.map(s => s.trim()).filter(Boolean))];
        return deduped.slice(0, 400);
    }

    private buildConversationTurnsFromPb(id: string, sessionId: string): UnifiedTurn[] {
        let convPath: string | null = null;
        for (const baseDir of this.getAllDirs()) {
            const p = join(baseDir, 'conversations', `${id}.pb`);
            if (existsSync(p)) { convPath = p; break; }
        }
        if (!convPath) return [];

        try {
            const stat = statSync(convPath);
            const buf = readFileSync(convPath);
            const candidates = this.extractTextCandidatesFromPb(buf);
            if (candidates.length === 0) return [];

            const turns: UnifiedTurn[] = [];
            let prevType: 1 | 2 = 2;
            for (let i = 0; i < candidates.length; i++) {
                const text = candidates[i];
                const lower = text.toLowerCase();
                let type: 1 | 2;
                if (/^\s*(user|human)\s*[:\-]/.test(lower)) type = 1;
                else if (/^\s*(assistant|model|ai)\s*[:\-]/.test(lower)) type = 2;
                else type = prevType === 1 ? 2 : 1;
                prevType = type;

                const intent = this.inferIntent(text);
                const tools = this.extractFileTools(text);
                const tokenEstimate = Math.max(20, Math.round(text.length / 4));
                turns.push({
                    session_id: sessionId,
                    timestamp: stat.mtimeMs + i,
                    model: 'gemini',
                    input_tokens: type === 1 ? tokenEstimate : 0,
                    output_tokens: type === 2 ? tokenEstimate : 0,
                    cache_read: 0,
                    cache_create: 0,
                    tools_used: tools,
                    stop_reason: `intent:${intent}`,
                    label: text.replace(/\s+/g, ' ').slice(0, 100),
                    type,
                });
            }
            return turns.slice(0, 400);
        } catch {
            return [];
        }
    }

    private buildResolvedTurns(id: string, sessionId: string): ResolvedBuildResult {
        const entries = this.getResolvedEntries(id);
        if (entries.length === 0) {
            return {
                turns: [],
                intentCounts: { plan: 0, implement: 0, verify: 0, rollback: 0, investigate: 0, unknown: 0 },
                deltaSummary: { pairs: 0, added: 0, removed: 0, changed: 0 },
                fileImpact: { total_unique_files: 0, by_extension: {}, by_module: {}, sample_files: [] },
            };
        }

        const turns: UnifiedTurn[] = [];
        const allPaths: string[] = [];
        const intentCounts: Record<TurnIntent, number> = { plan: 0, implement: 0, verify: 0, rollback: 0, investigate: 0, unknown: 0 };
        let deltaPairs = 0;
        let deltaAdded = 0;
        let deltaRemoved = 0;
        let deltaChanged = 0;
        const prevContentByArtifact = new Map<string, string>();

        for (const entry of entries) {
            try {
                const content = readFileSync(entry.path, 'utf-8');
                const summary = this.extractPrimaryLine(content);
                const toolsUsed = this.extractFileTools(content);
                const intent = this.inferIntent(content, entry.artifactName);
                intentCounts[intent] = (intentCounts[intent] || 0) + 1;
                const paths = this.extractFilePaths(content);
                allPaths.push(...paths);
                const isTask = entry.artifactName.toLowerCase() === 'task.md';
                const tokenEstimate = Math.max(20, Math.round(content.length / 4));
                const prev = prevContentByArtifact.get(entry.artifactName);
                const delta = prev != null ? this.computeLineDelta(prev, content) : null;
                if (delta) {
                    deltaPairs++;
                    deltaAdded += delta.added;
                    deltaRemoved += delta.removed;
                    deltaChanged += delta.changed;
                }
                prevContentByArtifact.set(entry.artifactName, content);

                const deltaLabel = delta ? ` Δ+${delta.added}/-${delta.removed}` : '';

                turns.push({
                    session_id: sessionId,
                    timestamp: entry.timestamp,
                    model: 'gemini',
                    input_tokens: isTask ? tokenEstimate : 0,
                    output_tokens: isTask ? 0 : tokenEstimate,
                    cache_read: 0,
                    cache_create: 0,
                    tools_used: toolsUsed,
                    stop_reason: `intent:${intent}`,
                    label: `[${entry.artifactName}${entry.version >= 0 ? ` v${entry.version}` : ''}] ${summary}${deltaLabel}`.slice(0, 100),
                    type: isTask ? 1 : 2,
                });
            } catch { /* skip unreadable content */ }
        }
        return {
            turns,
            intentCounts,
            deltaSummary: { pairs: deltaPairs, added: deltaAdded, removed: deltaRemoved, changed: deltaChanged },
            fileImpact: this.buildFileImpact(allPaths),
        };
    }

    private listBrainSessionIds(): Set<string> {
        const ids = new Set<string>();
        for (const baseDir of this.getAllDirs()) {
            const brainDir = join(baseDir, 'brain');
            if (!existsSync(brainDir)) continue;
            for (const dir of readdirSync(brainDir)) {
                const brainPath = join(brainDir, dir);
                try {
                    if (statSync(brainPath).isDirectory()) ids.add(dir);
                } catch { /* skip unreadable dirs */ }
            }
        }
        return ids;
    }

    private getFallbackTimestamp(id: string): number | null {
        // Prefer conversation file mtime, then brain dir mtime.
        for (const baseDir of this.getAllDirs()) {
            const convPath = join(baseDir, 'conversations', `${id}.pb`);
            if (existsSync(convPath)) {
                try { return statSync(convPath).mtimeMs; } catch { /* skip */ }
            }
        }
        for (const baseDir of this.getAllDirs()) {
            const brainPath = join(baseDir, 'brain', id);
            if (existsSync(brainPath)) {
                try { return statSync(brainPath).mtimeMs; } catch { /* skip */ }
            }
        }
        return null;
    }

    private getTaskPreview(id: string): string | null {
        for (const baseDir of this.getAllDirs()) {
            const taskPath = join(baseDir, 'brain', id, 'task.md');
            if (!existsSync(taskPath)) continue;
            try {
                const content = readFileSync(taskPath, 'utf-8');
                const preview = content
                    .split('\n')
                    .map(l => l.trim())
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(' ')
                    .replace(/^#+\s*/, '')
                    .slice(0, 300);
                if (preview) return preview;
            } catch { /* skip */ }
        }
        return null;
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
        const brainIds = this.listBrainSessionIds();
        const scratchFiles = this.parseScratchFiles();
        const codeTracker = this.parseCodeTrackerDeep();
        const sessions: UnifiedSession[] = [];

        const allIds = new Set([...annotations.keys(), ...artifacts.keys(), ...brainIds]);

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
            const resolvedEntries = this.getResolvedEntries(id);
            const resolvedData = this.buildResolvedTurns(id, `ag-${id}`);

            const artTimestamps = arts.map(a => a.updatedAt).filter((v): v is number => v != null);
            const earliest = artTimestamps.length > 0 ? Math.min(...artTimestamps) : undefined;
            const latest = artTimestamps.length > 0 ? Math.max(...artTimestamps) : undefined;

            const typeCounts: Record<string, number> = {};
            for (const a of arts) {
                const shortType = a.type.replace('ARTIFACT_TYPE_', '').toLowerCase();
                typeCounts[shortType] = (typeCounts[shortType] || 0) + 1;
            }

            const totalVersions = arts.reduce((s, a) => s + a.version, 0);
            const resolvedTurnCount = resolvedData.turns.length || resolvedEntries.length;
            const resolvedSize = resolvedEntries.reduce((s, e) => s + e.size, 0);

            // Use conversation .pb file size as a token estimate fallback
            let convFileSize = 0;
            let convFileMtime: number | null = null;
            for (const baseDir of this.getAllDirs()) {
                const convPath = join(baseDir, 'conversations', `${id}.pb`);
                if (existsSync(convPath)) {
                    try {
                        const stat = statSync(convPath);
                        convFileSize = stat.size;
                        convFileMtime = stat.mtimeMs;
                    } catch { /* skip */ }
                    break;
                }
            }

            let brainDirMtime: number | null = null;
            for (const baseDir of this.getAllDirs()) {
                const brainPath = join(baseDir, 'brain', id);
                if (!existsSync(brainPath)) continue;
                try {
                    const stat = statSync(brainPath);
                    if (stat.isDirectory()) {
                        brainDirMtime = stat.mtimeMs;
                        break;
                    }
                } catch { /* skip */ }
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

            // Better fallback for artifact-only sessions that keep rich resolved histories.
            if (arts.length === 0 && resolvedTurnCount > 0 && convFileSize === 0) {
                const resolvedTokenEstimate = Math.round(resolvedSize / 4);
                totalInput = Math.round(resolvedTokenEstimate * 0.35);
                estimatedOutput = Math.round(resolvedTokenEstimate * 0.65);
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

            const fileImpact = resolvedData.fileImpact;
            const resolvedIntents = Object.entries(resolvedData.intentCounts)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1]);

            sessions.push({
                id: `ag-${id}`,
                tool_id: 'antigravity',
                title,
                started_at: earliest || lastView || convFileMtime || brainDirMtime || Date.now(),
                ended_at: latest || lastView || convFileMtime || brainDirMtime || undefined,
                total_turns: Math.max(arts.length, totalVersions, resolvedTurnCount) || (convFileSize > 0 ? 1 : 0),
                total_input_tokens: totalInput,
                total_output_tokens: estimatedOutput,
                total_cache_read: 0,
                total_cache_create: 0,
                models_used: ['gemini'],
                primary_model: 'gemini',
                code_lines_added: arts.length > 0 ? codeLinesPerSession : Math.round(resolvedData.deltaSummary.added * 0.8),
                code_lines_removed: 0,
                files_touched: fileImpact.total_unique_files > 0 ? fileImpact.total_unique_files : (arts.length > 0 ? codeFilesPerSession : 0),
                error_count: 0,
                top_tools: resolvedIntents.length > 0 ? resolvedIntents.slice(0, 5).map(([intent, count]) => [intent, count]) : undefined,
                raw: {
                    artifact_types: typeCounts,
                    total_versions: totalVersions,
                    has_annotation: !!lastView,
                    last_view: lastView,
                    source_parity: {
                        pb_conversation_exists: convFileSize > 0,
                        resolved_turns: resolvedTurnCount,
                        metadata_artifacts: arts.length,
                    },
                    file_impact: fileImpact,
                    delta_summary: resolvedData.deltaSummary,
                    intents: resolvedData.intentCounts,
                },
            });
        }

        return sessions;
    }

    async getTurns(sessionId: string): Promise<UnifiedTurn[]> {
        const id = sessionId.replace('ag-', '');
        const pbTurns = this.buildConversationTurnsFromPb(id, sessionId);
        if (pbTurns.length > 0) return pbTurns;

        const resolvedTurns = this.buildResolvedTurns(id, sessionId).turns;
        if (resolvedTurns.length > 0) return resolvedTurns;

        const arts = this.parseBrainArtifacts().get(id) || [];

        if (arts.length > 0) {
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

        // Fallback context for sessions that only have task.md/logs and no metadata artifacts.
        const taskPreview = this.getTaskPreview(id);
        const fallbackTs = this.getFallbackTimestamp(id) || Date.now();
        if (taskPreview) {
            return [{
                session_id: sessionId,
                timestamp: fallbackTs,
                model: 'gemini',
                input_tokens: 0,
                output_tokens: 0,
                cache_read: 0,
                cache_create: 0,
                tools_used: [],
                label: `[TASK] ${taskPreview}`.slice(0, 100),
                type: 1,
            }];
        }

        return [];
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
