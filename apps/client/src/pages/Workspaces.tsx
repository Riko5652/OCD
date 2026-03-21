import React, { useState, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { Activity, Clock, Zap, Cpu, ChevronRight, ChevronDown, Brain, Search, Filter } from 'lucide-react';

// Lightweight inline markdown renderer — supports ## headings, **bold**, `code`, bullet lists
function MarkdownBlock({ text }: { text: string }) {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let listItems: React.ReactNode[] = [];

    const renderInline = (s: string, key: number) => {
        const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
            <span key={key}>
                {parts.map((p, i) => {
                    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-white font-bold">{p.slice(2, -2)}</strong>;
                    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="px-1.5 py-0.5 bg-slate-800 text-[#00f3ff] rounded text-[11px] font-mono">{p.slice(1, -1)}</code>;
                    return p;
                })}
            </span>
        );
    };

    const flushList = () => {
        if (listItems.length > 0) {
            elements.push(<ul key={`ul-${elements.length}`} className="space-y-1.5 pl-4 my-2">{listItems}</ul>);
            listItems = [];
        }
    };

    lines.forEach((line, i) => {
        if (line.startsWith('## ')) {
            flushList();
            elements.push(
                <h3 key={i} className="text-xs font-bold uppercase tracking-widest text-[#00f3ff] mt-5 mb-2 first:mt-0 flex items-center gap-2">
                    <span className="w-3 h-px bg-[#00f3ff]/40 inline-block" />
                    {line.slice(3)}
                </h3>
            );
        } else if (line.startsWith('### ')) {
            flushList();
            elements.push(<h4 key={i} className="text-[11px] font-bold text-slate-300 uppercase tracking-wider mt-3 mb-1">{line.slice(4)}</h4>);
        } else if (line.match(/^[-*] /)) {
            listItems.push(
                <li key={i} className="flex items-start gap-2 text-sm text-slate-300 leading-relaxed">
                    <span className="mt-1.5 w-1 h-1 rounded-full bg-[#00f3ff]/60 flex-shrink-0" />
                    <span>{renderInline(line.slice(2), i)}</span>
                </li>
            );
        } else if (line.trim() === '') {
            flushList();
        } else {
            flushList();
            elements.push(<p key={i} className="text-sm text-slate-300 leading-relaxed mt-1">{renderInline(line, i)}</p>);
        }
    });
    flushList();

    return <div className="space-y-1">{elements}</div>;
}

function SessionDetailsDrawer({ sessionId }: { sessionId: string }) {
    const { data, loading } = useApi<any>(`/api/sessions/${sessionId}`);
    const [insightText, setInsightText] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);

    const runAnalysis = () => {
        if (isAnalyzing || insightText) return;
        setIsAnalyzing(true);
        setInsightText('');
        const es = new EventSource(`/api/sessions/${sessionId}/insights`);
        let full = '';
        es.onmessage = (e) => {
            const parsed = JSON.parse(e.data);
            if (parsed.error) {
                setInsightText(prev => prev + '\n\n**Error**: ' + parsed.error);
                setIsAnalyzing(false);
                es.close();
            } else if (parsed.done) {
                setIsAnalyzing(false);
                es.close();
            } else if (parsed.token) {
                full += parsed.token;
                setInsightText(full);
            }
        };
        es.onerror = () => {
            setIsAnalyzing(false);
            es.close();
        };
    };

    if (loading) return <div className="p-8 text-center text-slate-500 text-sm animate-pulse">Scanning neural pathways...</div>;
    if (!data?.turns?.length) return <div className="p-8 text-center text-slate-600 text-sm">No interaction context found.</div>;

    return (
        <div className="bg-slate-900/40 p-6 border-t border-slate-800/80 shadow-[inset_0_4px_20px_rgba(0,0,0,0.2)]">
            <h4 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4 text-brand" />
                Session Telemetry Context
            </h4>
            <div className="space-y-4">
                {data.turns.map((t: any, i: number) => {
                    const tools = typeof t.tools_used === 'string' ? JSON.parse(t.tools_used || '[]') : (t.tools_used || []);
                    return (
                        <div key={i} className="flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-xl bg-surface border border-slate-800/60 hover:border-brand/30 transition-all shadow-md group">
                            <div className="flex-shrink-0 w-16 text-[10px] text-slate-500 font-mono mt-1 group-hover:text-brand transition-colors">
                                {new Date(t.timestamp).toLocaleTimeString([], { hour12: false })}
                            </div>

                            <div className="flex-1 min-w-0 space-y-3">
                                {/* Context/Prompt Label */}
                                <div className="text-sm text-slate-200 leading-relaxed font-medium">
                                    {t.label ? (
                                        <div className="whitespace-pre-wrap">{t.label}</div>
                                    ) : (
                                        <span className="text-slate-600 italic">Auto-generated / No context recorded</span>
                                    )}
                                </div>

                                {/* Metrics Bar */}
                                <div className="flex flex-wrap items-center gap-3 md:gap-5 pt-2 border-t border-slate-800/50 text-[10px] uppercase tracking-wider font-bold">
                                    {t.input_tokens > 0 && (
                                        <div className="flex items-center gap-1.5 text-blue-400 group-hover:text-blue-300" title="Input Tokens">
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.6)]"></div>
                                            IN: {t.input_tokens}
                                        </div>
                                    )}
                                    {t.cache_read > 0 && (
                                        <div className="flex items-center gap-1.5 text-emerald-400 group-hover:text-emerald-300" title="Cache Read">
                                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"></div>
                                            CR: {t.cache_read}
                                        </div>
                                    )}
                                    {t.output_tokens > 0 && (
                                        <div className="flex items-center gap-1.5 text-amber-400 group-hover:text-amber-300" title="Output Tokens">
                                            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]"></div>
                                            OUT: {t.output_tokens}
                                        </div>
                                    )}
                                    {t.latency_ms > 0 && (
                                        <div className="flex items-center gap-1.5 text-slate-400" title="Latency">
                                            <Clock className="w-3 h-3" />
                                            {(t.latency_ms / 1000).toFixed(1)}s
                                        </div>
                                    )}
                                    <div className="flex items-center gap-1.5 text-slate-500">
                                        <Zap className="w-3 h-3 text-purple-500" />
                                        {t.tok_per_sec || 0} TPS
                                    </div>
                                </div>
                            </div>

                            {/* Tools Used Box */}
                            {tools.length > 0 && (
                                <div className="flex-shrink-0 md:w-56 flex flex-wrap gap-1.5 justify-start md:justify-end mt-2 md:mt-0">
                                    {tools.slice(0, 6).map((tool: any, j: number) => {
                                        const name = Array.isArray(tool) ? tool[0] : (tool.name || tool);
                                        const cnt = Array.isArray(tool) ? tool[1] : '';
                                        return (
                                            <span key={j} className="px-2 py-1 bg-slate-900 border border-slate-700/50 rounded-md text-[9px] text-slate-300 flex items-center gap-1 hover:border-brand/40 transition-colors">
                                                <Cpu className="w-2.5 h-2.5 text-brand" />
                                                <span className="truncate max-w-[100px]">{String(name).replace('mcp__', '')}</span>
                                                {cnt ? <span className="opacity-50 font-mono ml-0.5">({cnt})</span> : ''}
                                            </span>
                                        );
                                    })}
                                    {tools.length > 6 && (
                                        <span className="px-1.5 py-1 bg-slate-800/40 rounded text-[9px] text-slate-500">
                                            +{tools.length - 6}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {/* Session Metadata max data */}
            {data.session && (
                <div className="mt-6 pt-4 border-t border-slate-800/60 flex flex-wrap items-center justify-between text-xs text-slate-500 gap-4">
                    <div className="flex items-center gap-3">
                        <span>Detailed Context Extracted</span>
                        <span>•</span>
                        <span className="font-mono">ID: {data.session.id?.slice(0, 12)}</span>
                    </div>
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-2">
                            <Clock className="w-3 h-3" />
                            Avg Latency: <span className="text-white font-mono">{(data.session.avg_latency_ms / 1000).toFixed(1)}s</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Activity className="w-3 h-3" />
                            Cache Success: <span className="text-emerald-400 font-mono font-bold">{Math.round(data.session.cache_hit_pct || 0)}%</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Context Insights */}
            <div className="mt-8 pt-6 border-t border-slate-800/60">
                <div className="flex items-center justify-between mb-4">
                    <h5 className="text-xs font-bold uppercase tracking-widest text-[#00f3ff] flex items-center gap-2">
                        <Brain className="w-3.5 h-3.5" /> Session Deep Dive Analysis
                    </h5>
                    {!insightText && !isAnalyzing && (
                        <button onClick={runAnalysis} className="px-3 py-1.5 bg-[#00f3ff]/10 text-[#00f3ff] hover:bg-[#00f3ff]/20 text-[10px] font-bold uppercase tracking-wider rounded border border-[#00f3ff]/30 transition-colors cursor-pointer shadow-[0_0_10px_rgba(0,243,255,0.2)] hover:shadow-[0_0_15px_rgba(0,243,255,0.4)]">
                            Run Insight Analysis
                        </button>
                    )}
                </div>

                {(insightText || isAnalyzing) && (
                    <div className="bg-[#050505] border border-slate-800 rounded-xl p-5 shadow-[inset_0_4px_20px_rgba(0,0,0,0.5)] relative overflow-hidden mt-3">
                        {isAnalyzing && (
                            <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-[#00f3ff] to-transparent animate-[pulse_2s_ease-in-out_infinite]"></div>
                        )}
                        <div className="prose prose-invert prose-sm max-w-none text-slate-300">
                            {insightText ? (
                                <MarkdownBlock text={insightText} />
                            ) : (
                                <span className="opacity-50 italic text-sm animate-pulse">Initializing neural analysis engine...</span>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function Workspaces() {
    const { data: projects } = useApi<any[]>('/api/projects');
    const { data: sessions } = useApi<any[]>('/api/sessions?limit=50');
    const { data: commits } = useApi<any[]>('/api/commit-scores');
    const { data: topics } = useApi<any[]>('/api/topics/summary');
    const { data: cursorStats } = useApi<any>('/api/cursor/deep');
    const { data: antigravityStats } = useApi<any>('/api/antigravity-stats');

    const [_selectedProject, setSelectedProject] = useState<string | null>(null);
    const [view, setView] = useState<'projects' | 'sessions' | 'commits' | 'topics' | 'telemetry'>('projects');
    const [expandedSession, setExpandedSession] = useState<string | null>(null);
    const [sessionSearch, setSessionSearch] = useState('');
    const [sessionToolFilter, setSessionToolFilter] = useState('');

    const filteredSessions = useMemo(() => {
        let s = sessions || [];
        if (sessionToolFilter) s = s.filter((x: any) => x.tool_id === sessionToolFilter);
        if (sessionSearch) {
            const q = sessionSearch.toLowerCase();
            s = s.filter((x: any) => (x.title || '').toLowerCase().includes(q) || (x.primary_model || '').toLowerCase().includes(q) || (x.id || '').toLowerCase().includes(q));
        }
        return s;
    }, [sessions, sessionSearch, sessionToolFilter]);

    const toolIds = useMemo(() => [...new Set((sessions || []).map((s: any) => s.tool_id))], [sessions]);

    const tabs = [
        { id: 'projects' as const, label: 'Projects', icon: '📁' },
        { id: 'sessions' as const, label: 'Sessions', icon: '💬' },
        { id: 'commits' as const, label: 'Commits', icon: '🔀' },
        { id: 'topics' as const, label: 'Topics', icon: '🏷️' },
        { id: 'telemetry' as const, label: 'IDE Telemetry', icon: '📡' },
    ];

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-extrabold text-white tracking-tight">Workspaces</h2>
                <p className="text-sm text-slate-400 mt-1">Projects, sessions, and knowledge topology</p>
            </div>

            <div className="flex gap-2 bg-surface/50 p-1 rounded-xl border border-slate-800 w-fit">
                {tabs.map(t => (
                    <button key={t.id} onClick={() => setView(t.id)}
                        className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${view === t.id ? 'bg-brand/10 text-brand border border-brand/20' : 'text-slate-500 hover:text-slate-300'}`}>
                        {t.icon} {t.label}
                    </button>
                ))}
            </div>

            {/* Projects */}
            {view === 'projects' && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {(projects || []).map((p: any) => (
                        <div key={p.name} className="bg-surface rounded-2xl p-5 border border-slate-800 hover:border-brand/30 transition-all cursor-pointer shadow-lg hover:shadow-xl hover:-translate-y-0.5"
                            onClick={() => setSelectedProject(p.name)}>
                            <div className="flex items-center gap-3 mb-3">
                                <div className="w-10 h-10 rounded-xl bg-brand/10 flex items-center justify-center text-brand font-black text-sm">
                                    {p.name?.charAt(0)?.toUpperCase() || '?'}
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-slate-200 truncate max-w-[180px]">{p.name}</h3>
                                    <p className="text-[10px] text-slate-500">{p.dominant_tool} / {p.dominant_model}</p>
                                </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div><p className="text-lg font-black text-white">{p.session_count}</p><p className="text-[9px] text-slate-500">sessions</p></div>
                                <div><p className="text-lg font-black text-brand">{((p.total_tokens || 0) / 1000).toFixed(0)}K</p><p className="text-[9px] text-slate-500">tokens</p></div>
                                <div><p className="text-lg font-black text-purple-400">{((p.total_lines_added || 0) / 1000).toFixed(1)}K</p><p className="text-[9px] text-slate-500">lines</p></div>
                            </div>
                        </div>
                    ))}
                    {(!projects || projects.length === 0) && (
                        <p className="text-slate-500 col-span-full text-center py-12">No projects indexed yet. Run a data refresh.</p>
                    )}
                </div>
            )}

            {/* Sessions List */}
            {view === 'sessions' && (
                <div className="bg-surface rounded-2xl border border-slate-800 shadow-lg overflow-hidden">
                    {/* Search & Filter Bar */}
                    <div className="flex items-center gap-3 p-4 border-b border-slate-800">
                        <div className="flex items-center gap-2 flex-1 bg-[#111] rounded-lg px-3 py-2 border border-[#222] focus-within:border-brand/50 transition-colors">
                            <Search className="w-4 h-4 text-zinc-500" />
                            <input value={sessionSearch} onChange={e => setSessionSearch(e.target.value)}
                                placeholder="Search sessions..." className="bg-transparent text-sm text-white placeholder:text-zinc-600 outline-none flex-1" />
                        </div>
                        <div className="flex items-center gap-2">
                            <Filter className="w-4 h-4 text-zinc-500" />
                            <select value={sessionToolFilter} onChange={e => setSessionToolFilter(e.target.value)}
                                className="bg-[#111] text-xs text-zinc-300 border border-[#222] rounded-lg px-3 py-2 outline-none">
                                <option value="">All tools</option>
                                {toolIds.map((t: string) => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <span className="text-[10px] text-zinc-500 font-mono">{filteredSessions.length} sessions</span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="border-b border-slate-700 text-[10px] text-slate-400 uppercase tracking-wider">
                                    <th className="px-4 py-3">Tool</th>
                                    <th className="px-4 py-3">Title</th>
                                    <th className="px-4 py-3">Model</th>
                                    <th className="px-4 py-3">Turns</th>
                                    <th className="px-4 py-3">Output</th>
                                    <th className="px-4 py-3">Quality</th>
                                    <th className="px-4 py-3">Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                                {filteredSessions.map((s: any) => (
                                    <React.Fragment key={s.id}>
                                        <tr
                                            onClick={() => setExpandedSession(expandedSession === s.id ? null : s.id)}
                                            className={`hover:bg-slate-800/50 transition-colors text-sm cursor-pointer group ${expandedSession === s.id ? 'bg-slate-800/30' : ''}`}
                                        >
                                            <td className="px-4 py-3 relative">
                                                <div className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {expandedSession === s.id ? <ChevronDown className="w-3 h-3 text-brand" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
                                                </div>
                                                <span className="ml-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-brand/10 text-brand border border-brand/20">{s.tool_id}</span>
                                            </td>
                                            <td className="px-4 py-3 text-slate-300 max-w-[200px] truncate">{s.title || 'Untitled'}</td>
                                            <td className="px-4 py-3 text-slate-400 text-xs font-mono">{(s.primary_model || '').slice(0, 20)}</td>
                                            <td className="px-4 py-3 text-slate-300 font-bold">{s.total_turns}</td>
                                            <td className="px-4 py-3 text-purple-400 font-mono text-xs">{((s.total_output_tokens || 0) / 1000).toFixed(0)}K</td>
                                            <td className="px-4 py-3">
                                                <span className={`font-bold ${(s.quality_score || 0) > 100 ? 'text-emerald-400' : (s.quality_score || 0) > 50 ? 'text-brand' : 'text-slate-500'}`}>
                                                    {(s.quality_score || 0).toFixed(0)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-slate-500 text-xs">{s.started_at ? new Date(s.started_at).toLocaleDateString() : '—'}</td>
                                        </tr>
                                        {expandedSession === s.id && (
                                            <tr>
                                                <td colSpan={7} className="p-0 border-b border-brand/10 bg-slate-900/20">
                                                    <SessionDetailsDrawer sessionId={s.id} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Commits */}
            {view === 'commits' && (
                <div className="bg-surface rounded-2xl p-6 border border-slate-800 shadow-lg">
                    <h3 className="text-sm font-bold text-slate-300 mb-4 uppercase tracking-wider">AI Commit Attribution</h3>
                    <div className="space-y-2">
                        {(commits || []).slice(0, 30).map((c: any, i: number) => (
                            <div key={i} className="flex items-center gap-3 p-3 bg-slate-900/50 rounded-xl border border-slate-700/30">
                                <code className="text-[10px] text-slate-500 font-mono w-16">{c.commit_hash?.slice(0, 7)}</code>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs text-slate-300 truncate">{c.commit_message}</p>
                                    <p className="text-[10px] text-slate-500">{c.branch} · {c.commit_date?.slice(0, 10)}</p>
                                </div>
                                <div className="w-24">
                                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                                        <div className="h-full bg-gradient-to-r from-brand to-purple-500 rounded-full" style={{ width: `${c.ai_percentage || 0}%` }} />
                                    </div>
                                    <p className="text-[10px] text-brand text-center mt-0.5 font-bold">{(c.ai_percentage || 0).toFixed(0)}% AI</p>
                                </div>
                                <div className="text-right text-[10px] text-slate-500 w-16">
                                    <span className="text-emerald-400">+{c.lines_added}</span> / <span className="text-rose-400">-{c.lines_deleted}</span>
                                </div>
                            </div>
                        ))}
                        {(!commits || commits.length === 0) && (
                            <p className="text-center text-slate-500 py-8">No commit scores tracked yet.</p>
                        )}
                    </div>
                </div>
            )}

            {/* Topics */}
            {view === 'topics' && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {(topics || []).map((t: any, i: number) => (
                        <div key={i} className="bg-surface rounded-2xl p-5 border border-slate-800 shadow-lg hover:border-purple-500/30 transition-all">
                            <h3 className="text-sm font-bold text-purple-400 mb-2">🏷️ {t.topic}</h3>
                            <div className="flex items-center justify-between text-xs text-slate-400">
                                <span>{t.session_count} sessions</span>
                                <span>Relevance: {(t.avg_relevance || 0).toFixed(1)}</span>
                            </div>
                        </div>
                    ))}
                    {(!topics || topics.length === 0) && (
                        <p className="text-slate-500 col-span-full text-center py-12">No topics classified yet.</p>
                    )}
                </div>
            )}

            {/* IDE Telemetry */}
            {view === 'telemetry' && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Cursor Stats */}
                        <div className="bg-[#050505] rounded-2xl p-6 border border-[#222] shadow-[0_0_20px_rgba(0,243,255,0.05)] relative overflow-hidden group hover:border-[#00f3ff]/40 transition-colors">
                            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#00f3ff] to-transparent opacity-50"></div>
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-8 h-8 rounded bg-[#00f3ff]/10 flex items-center justify-center text-[#00f3ff]">
                                    <Cpu className="w-4 h-4" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white uppercase tracking-widest drop-shadow-[0_0_5px_rgba(0,243,255,0.5)]">Cursor Core</h3>
                                    <p className="text-[10px] text-slate-500 font-mono tracking-widest">DEEP TELEMETRY</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mb-6">
                                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Total Output</p>
                                    <p className="text-2xl font-black text-[#00f3ff] font-mono">{((cursorStats?.overview?.total_output || 0) / 1000).toFixed(1)}K</p>
                                </div>
                                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Total Sessions</p>
                                    <p className="text-2xl font-black text-white font-mono">{cursorStats?.overview?.total_sessions || 0}</p>
                                </div>
                            </div>

                            {cursorStats?.modelBreakdown && cursorStats.modelBreakdown.length > 0 && (
                                <div>
                                    <h4 className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-3 border-b border-slate-800 pb-1">Model Distribution</h4>
                                    <div className="space-y-2">
                                        {cursorStats.modelBreakdown.map((m: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-xs">
                                                <span className="text-slate-300 font-mono truncate max-w-[140px]">{m.model?.replace('claude-', '')}</span>
                                                <div className="flex items-center gap-4">
                                                    <span className="text-[#00f3ff]">{m.sessions} <span className="text-slate-500 text-[10px]">sess</span></span>
                                                    <span className="text-purple-400">{((m.output_tokens || 0) / 1000).toFixed(1)}k <span className="text-slate-500 text-[10px]">tok</span></span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Antigravity Stats */}
                        <div className="bg-[#050505] rounded-2xl p-6 border border-[#222] shadow-[0_0_20px_rgba(57,255,20,0.05)] relative overflow-hidden group hover:border-[#39ff14]/40 transition-colors">
                            <div className="absolute top-0 right-0 w-full h-1 bg-gradient-to-r from-transparent via-[#39ff14] to-transparent opacity-50"></div>
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-8 h-8 rounded bg-[#39ff14]/10 flex items-center justify-center text-[#39ff14]">
                                    <Zap className="w-4 h-4" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-black text-white uppercase tracking-widest drop-shadow-[0_0_5px_rgba(57,255,20,0.5)]">Antigravity Engine</h3>
                                    <p className="text-[10px] text-slate-500 font-mono tracking-widest">AGENT METRICS</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mb-6">
                                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Actions Taken</p>
                                    <p className="text-2xl font-black text-[#39ff14] font-mono">{antigravityStats?.actions_taken || 0}</p>
                                </div>
                                <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Files Created</p>
                                    <p className="text-2xl font-black text-white font-mono">{antigravityStats?.files_created || 0}</p>
                                </div>
                            </div>

                            <div className="p-4 bg-slate-900/30 rounded-xl border border-slate-800 border-dashed text-center">
                                <p className="text-xs text-slate-400 font-mono">Real-time stats from active VS Code instances. Syncs automatically with file system events.</p>
                            </div>
                        </div>
                    </div>

                    {/* Top Heavy Sessions Table (Cursor specific value maximization) */}
                    {cursorStats?.topSessions && cursorStats.topSessions.length > 0 && (
                        <div className="bg-surface rounded-2xl border border-slate-800 shadow-lg p-6">
                            <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-widest flex items-center gap-2">
                                <Activity className="w-4 h-4 font-bold text-[#00f3ff]" /> High-Impact Sessions
                            </h3>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-slate-700 text-[10px] text-slate-400 uppercase tracking-widest">
                                            <th className="pb-3">Session Topic</th>
                                            <th className="pb-3 px-4">Primary Model</th>
                                            <th className="pb-3 px-4">Output Weight</th>
                                            <th className="pb-3 px-4">Files / Lines</th>
                                            <th className="pb-3 pl-4">Agentic Score</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/50">
                                        {cursorStats.topSessions.slice(0, 5).map((s: any) => (
                                            <tr key={s.id} className="text-sm">
                                                <td className="py-3 text-slate-300 max-w-[200px] truncate">{s.title || 'Untitled Activity'}</td>
                                                <td className="py-3 px-4 text-slate-400 font-mono text-xs">{s.primary_model?.replace('claude-', '') || 'Unknown'}</td>
                                                <td className="py-3 px-4 text-[#00f3ff] font-black font-mono">{((s.total_output_tokens || 0) / 1000).toFixed(1)}K</td>
                                                <td className="py-3 px-4 text-slate-400 text-xs">
                                                    Touches {s.files_touched || 0} f / +{s.code_lines_added || 0} l
                                                </td>
                                                <td className="py-3 pl-4">
                                                    <span className="px-2 py-0.5 bg-brand/10 text-brand border border-brand/20 rounded font-black text-[10px]">
                                                        {(s.agentic_score || 0).toFixed(1)}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
