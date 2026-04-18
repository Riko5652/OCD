import { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { Shield, Plus, ParkingCircle, CheckCircle, Pause, Play, Sparkles, Loader2, Activity } from 'lucide-react';

interface OcdTask {
    id: number;
    title: string;
    description: string | null;
    project: string | null;
    status: 'active' | 'paused' | 'completed';
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

interface ParkedIdea {
    id: number;
    idea: string;
    source_tool: string | null;
    parked_during_task_id: number | null;
    task_title: string | null;
    created_at: number;
    promoted: number;
}

interface LiveSession {
    id: string;
    tool_id: string;
    title: string | null;
    tldr: string | null;
    topic: string | null;
    started_at: number;
    ended_at: number | null;
    total_turns: number;
    total_output_tokens: number;
    primary_model: string | null;
    quality_score: number | null;
}

type Tab = 'focus' | 'parking' | 'history';

export default function Gatekeeper() {
    const [tab, setTab] = useState<Tab>('focus');
    const [newTitle, setNewTitle] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newProject, setNewProject] = useState('');
    const [newIdea, setNewIdea] = useState('');
    const [busy, setBusy] = useState(false);

    const { data: activeData, refetch: refetchActive } = useApi<{ task: OcdTask | null }>('/api/gatekeeper/task');
    const { data: allTasksData, refetch: refetchTasks } = useApi<{ tasks: OcdTask[] }>('/api/gatekeeper/tasks');
    const { data: parkingData, refetch: refetchParking } = useApi<{ ideas: ParkedIdea[] }>('/api/gatekeeper/parking');
    const { data: activityData, refetch: refetchActivity } = useApi<{ sessions: LiveSession[]; has_active_task: boolean }>('/api/gatekeeper/activity');

    const refetchAll = useCallback(() => {
        refetchActive();
        refetchTasks();
        refetchParking();
        refetchActivity();
    }, [refetchActive, refetchTasks, refetchParking, refetchActivity]);

    const activeTask = activeData?.task || null;
    const allTasks = allTasksData?.tasks || [];
    const parkedIdeas = parkingData?.ideas || [];
    const unpromoted = parkedIdeas.filter(i => !i.promoted);
    const completedTasks = allTasks.filter(t => t.status === 'completed');
    const pausedTasks = allTasks.filter(t => t.status === 'paused');
    const liveSessions = activityData?.sessions || [];

    async function promoteSession(s: LiveSession) {
        const title = s.title?.trim() || s.topic?.trim() || `Session from ${s.tool_id}`;
        const description = s.tldr?.trim() || undefined;
        await apiPost('/api/gatekeeper/task', { title, description, project: s.tool_id });
    }

    async function apiPost(url: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            refetchAll();
        } finally {
            setBusy(false);
        }
    }

    async function apiPatch(url: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            refetchAll();
        } finally {
            setBusy(false);
        }
    }

    async function createTask() {
        if (!newTitle.trim()) return;
        await apiPost('/api/gatekeeper/task', { title: newTitle.trim(), description: newDesc.trim() || undefined, project: newProject.trim() || undefined });
        setNewTitle('');
        setNewDesc('');
        setNewProject('');
    }

    async function parkIdea() {
        if (!newIdea.trim()) return;
        await apiPost('/api/gatekeeper/parking', { idea: newIdea.trim() });
        setNewIdea('');
    }

    const TABS: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
        { id: 'focus', label: 'Focus', icon: <Shield className="w-4 h-4" /> },
        { id: 'parking', label: 'Parking Lot', icon: <ParkingCircle className="w-4 h-4" />, badge: unpromoted.length || undefined },
        { id: 'history', label: 'History', icon: <CheckCircle className="w-4 h-4" />, badge: completedTasks.length || undefined },
    ];

    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-brand to-neonPink">
                        Gatekeeper
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">Task focus & scope management for AI agents</p>
                </div>
                {activeTask && (
                    <div className="flex items-center gap-2">
                        <span className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neonGreen opacity-75" />
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-neonGreen" />
                        </span>
                        <span className="text-xs text-neonGreen font-mono uppercase tracking-wider">Active</span>
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="glass-panel p-1.5 flex gap-1.5">
                {TABS.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                        className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                            tab === t.id
                                ? 'bg-brand/20 text-brand border border-brand/50 shadow-neon-brand'
                                : 'text-zinc-500 hover:text-white border border-transparent hover:bg-[#111]'
                        }`}>
                        {t.icon} {t.label}
                        {t.badge ? <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-brand/20 text-brand">{t.badge}</span> : null}
                    </button>
                ))}
            </div>

            {/* Focus Tab */}
            {tab === 'focus' && (
                <div className="space-y-6">
                    {/* Live activity — what OCD is seeing across all ingested tools */}
                    {liveSessions.length > 0 && (
                        <div className="glass-panel p-5">
                            <p className="text-xs font-bold text-neonBlue uppercase tracking-wider mb-3 flex items-center gap-2">
                                <Activity className="w-3.5 h-3.5" /> Live Activity — last 24h
                                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-neonBlue/10 text-neonBlue border border-neonBlue/20">{liveSessions.length}</span>
                            </p>
                            <div className="space-y-2">
                                {liveSessions.slice(0, 5).map(s => {
                                    const isLive = !s.ended_at || Date.now() - s.ended_at < 10 * 60 * 1000;
                                    return (
                                        <div key={s.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0a] border border-[#1a1a1a] hover:border-neonBlue/30 transition-colors group">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    {isLive && (
                                                        <span className="relative flex h-2 w-2">
                                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neonGreen opacity-75" />
                                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-neonGreen" />
                                                        </span>
                                                    )}
                                                    <span className="text-[10px] text-zinc-500 font-mono uppercase">{s.tool_id}</span>
                                                    <span className="text-[10px] text-zinc-600">{s.total_turns} turns · {Math.round(s.total_output_tokens / 1000)}K out</span>
                                                    {s.primary_model && <span className="text-[10px] text-zinc-600 font-mono">{s.primary_model}</span>}
                                                </div>
                                                <p className="text-sm font-medium text-white truncate mt-1">{s.title || s.topic || '(untitled session)'}</p>
                                                {s.tldr && <p className="text-[11px] text-zinc-500 truncate mt-0.5">{s.tldr}</p>}
                                            </div>
                                            <button onClick={() => promoteSession(s)} disabled={busy}
                                                className="ml-3 px-3 py-1.5 rounded-md text-[10px] font-bold bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1 disabled:opacity-50 shrink-0">
                                                <Sparkles className="w-3 h-3" /> Set as task
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                            {!activityData?.has_active_task && (
                                <p className="text-[10px] text-zinc-600 mt-3">
                                    OCD sees this activity from ingested transcripts. Set one as the active task, or ignore and OCD will keep observing.
                                </p>
                            )}
                        </div>
                    )}

                    {/* Current active task */}
                    {activeTask ? (
                        <div className="glass-panel p-6 border-l-4 border-l-neonGreen">
                            <div className="flex items-start justify-between">
                                <div className="flex-1">
                                    <p className="text-[10px] text-neonGreen font-mono uppercase tracking-widest mb-2">Current Task</p>
                                    <h3 className="text-xl font-bold text-white">{activeTask.title}</h3>
                                    {activeTask.description && <p className="text-sm text-slate-400 mt-1">{activeTask.description}</p>}
                                    {activeTask.project && (
                                        <p className="text-xs text-neonBlue mt-2 font-mono">
                                            Project: {activeTask.project}
                                        </p>
                                    )}
                                    <p className="text-[10px] text-zinc-600 mt-3">
                                        Started {new Date(activeTask.created_at).toLocaleString()}
                                    </p>
                                </div>
                                <div className="flex gap-2 ml-4 shrink-0">
                                    <button onClick={() => apiPatch(`/api/gatekeeper/task/${activeTask.id}`, { status: 'paused' })}
                                        disabled={busy}
                                        className="px-3 py-2 rounded-lg text-xs font-bold bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/20 transition-all flex items-center gap-1.5 disabled:opacity-50">
                                        <Pause className="w-3.5 h-3.5" /> Pause
                                    </button>
                                    <button onClick={() => apiPatch(`/api/gatekeeper/task/${activeTask.id}`, { status: 'completed' })}
                                        disabled={busy}
                                        className="px-3 py-2 rounded-lg text-xs font-bold bg-neonGreen/10 text-neonGreen border border-neonGreen/30 hover:bg-neonGreen/20 transition-all flex items-center gap-1.5 disabled:opacity-50">
                                        <CheckCircle className="w-3.5 h-3.5" /> Complete
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="glass-panel p-8 text-center border border-dashed border-zinc-700">
                            <Shield className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                            <p className="text-zinc-400 text-sm">No active task. Agents are running without scope constraints.</p>
                            <p className="text-zinc-600 text-xs mt-1">
                                {liveSessions.length > 0
                                    ? 'Promote a Live Activity above, or create a new task below.'
                                    : 'Set a task below to enable the Gatekeeper.'}
                            </p>
                        </div>
                    )}

                    {/* New task form */}
                    <div className="glass-panel p-5">
                        <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <Plus className="w-3.5 h-3.5" /> New Task
                        </p>
                        <div className="space-y-3">
                            <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
                                placeholder="Task title..."
                                className="w-full px-4 py-2.5 rounded-lg bg-[#0a0a0a] border border-[#222] text-white text-sm placeholder-zinc-600 focus:border-brand/50 focus:outline-none transition-colors"
                                onKeyDown={e => e.key === 'Enter' && createTask()} />
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
                                    placeholder="Description (optional)"
                                    className="px-4 py-2 rounded-lg bg-[#0a0a0a] border border-[#222] text-white text-sm placeholder-zinc-600 focus:border-brand/50 focus:outline-none transition-colors" />
                                <input value={newProject} onChange={e => setNewProject(e.target.value)}
                                    placeholder="Project (optional)"
                                    className="px-4 py-2 rounded-lg bg-[#0a0a0a] border border-[#222] text-white text-sm placeholder-zinc-600 focus:border-brand/50 focus:outline-none transition-colors" />
                            </div>
                            <button onClick={createTask} disabled={busy || !newTitle.trim()}
                                className="px-5 py-2.5 rounded-lg text-sm font-bold bg-brand/10 text-brand border border-brand/50 hover:bg-brand/20 hover:shadow-neon-brand transition-all disabled:opacity-30 flex items-center gap-2">
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                Set Active Task
                            </button>
                        </div>
                    </div>

                    {/* Paused tasks */}
                    {pausedTasks.length > 0 && (
                        <div className="glass-panel p-5">
                            <p className="text-xs font-bold text-yellow-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                                <Pause className="w-3.5 h-3.5" /> Paused Tasks ({pausedTasks.length})
                            </p>
                            <div className="space-y-2">
                                {pausedTasks.map(t => (
                                    <div key={t.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0a] border border-[#1a1a1a] hover:border-yellow-500/30 transition-colors group">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-white truncate">{t.title}</p>
                                            {t.project && <p className="text-[10px] text-zinc-500 font-mono">{t.project}</p>}
                                        </div>
                                        <button onClick={() => apiPatch(`/api/gatekeeper/task/${t.id}`, { status: 'active' })}
                                            disabled={busy}
                                            className="px-2.5 py-1.5 rounded-md text-[10px] font-bold bg-neonGreen/10 text-neonGreen border border-neonGreen/20 hover:bg-neonGreen/20 transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1 disabled:opacity-50">
                                            <Play className="w-3 h-3" /> Resume
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Parking Lot Tab */}
            {tab === 'parking' && (
                <div className="space-y-6">
                    {/* Park new idea */}
                    <div className="glass-panel p-5">
                        <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <ParkingCircle className="w-3.5 h-3.5" /> Park an Idea
                        </p>
                        <div className="flex gap-3">
                            <input value={newIdea} onChange={e => setNewIdea(e.target.value)}
                                placeholder="Out-of-scope idea to park for later..."
                                className="flex-1 px-4 py-2.5 rounded-lg bg-[#0a0a0a] border border-[#222] text-white text-sm placeholder-zinc-600 focus:border-brand/50 focus:outline-none transition-colors"
                                onKeyDown={e => e.key === 'Enter' && parkIdea()} />
                            <button onClick={parkIdea} disabled={busy || !newIdea.trim()}
                                className="px-4 py-2.5 rounded-lg text-sm font-bold bg-neonBlue/10 text-neonBlue border border-neonBlue/30 hover:bg-neonBlue/20 transition-all disabled:opacity-30 flex items-center gap-2 shrink-0">
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ParkingCircle className="w-4 h-4" />}
                                Park
                            </button>
                        </div>
                    </div>

                    {/* Parked ideas list */}
                    {unpromoted.length > 0 ? (
                        <div className="space-y-2">
                            {unpromoted.map(idea => (
                                <div key={idea.id} className="glass-panel p-4 flex items-start justify-between group hover:border-neonBlue/30 transition-colors">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-white">{idea.idea}</p>
                                        <div className="flex items-center gap-3 mt-1.5">
                                            {idea.task_title && (
                                                <span className="text-[10px] text-zinc-500">
                                                    During: <span className="text-zinc-400">{idea.task_title}</span>
                                                </span>
                                            )}
                                            {idea.source_tool && (
                                                <span className="text-[10px] text-zinc-500 font-mono">{idea.source_tool}</span>
                                            )}
                                            <span className="text-[10px] text-zinc-600">{new Date(idea.created_at).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                    <button onClick={() => apiPatch(`/api/gatekeeper/parking/${idea.id}/promote`, {})}
                                        disabled={busy}
                                        className="ml-3 px-3 py-1.5 rounded-md text-[10px] font-bold bg-brand/10 text-brand border border-brand/20 hover:bg-brand/20 transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1 disabled:opacity-50 shrink-0">
                                        <Sparkles className="w-3 h-3" /> Promote to Task
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="glass-panel p-8 text-center border border-dashed border-zinc-700">
                            <ParkingCircle className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                            <p className="text-zinc-400 text-sm">No parked ideas.</p>
                            <p className="text-zinc-600 text-xs mt-1">When agents encounter out-of-scope suggestions, they'll park them here.</p>
                        </div>
                    )}
                </div>
            )}

            {/* History Tab */}
            {tab === 'history' && (
                <div className="space-y-2">
                    {completedTasks.length > 0 ? (
                        completedTasks.map(t => (
                            <div key={t.id} className="glass-panel p-4 flex items-center gap-4 opacity-70 hover:opacity-100 transition-opacity">
                                <CheckCircle className="w-5 h-5 text-neonGreen shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-white truncate">{t.title}</p>
                                    {t.description && <p className="text-xs text-zinc-500 truncate">{t.description}</p>}
                                </div>
                                {t.project && <span className="text-[10px] text-neonBlue font-mono shrink-0">{t.project}</span>}
                                <span className="text-[10px] text-zinc-600 shrink-0">
                                    {t.completed_at ? new Date(t.completed_at).toLocaleDateString() : ''}
                                </span>
                            </div>
                        ))
                    ) : (
                        <div className="glass-panel p-8 text-center border border-dashed border-zinc-700">
                            <CheckCircle className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                            <p className="text-zinc-400 text-sm">No completed tasks yet.</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
