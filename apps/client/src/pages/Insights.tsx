import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from 'recharts';
import { Brain, TrendingUp, Sparkles, Lightbulb, Target, BarChart2, Loader2, RefreshCw, Zap, AlertTriangle, FlaskConical, ShieldAlert, BookOpen, Database, Search } from 'lucide-react';

function MarkdownBlock({ text }: { text: string }) {
    const lines = text.split('\n');
    return (
        <div className="space-y-1">
            {lines.map((line, i) => {
                if (line.startsWith('## ')) return <h3 key={i} className="text-xs font-bold uppercase tracking-widest text-neonBlue mt-4 mb-2 first:mt-0">{line.slice(3)}</h3>;
                if (line.match(/^[-*] /)) return <li key={i} className="text-sm text-zinc-300 leading-relaxed ml-4 list-disc">{renderInline(line.slice(2))}</li>;
                if (line.trim() === '') return <br key={i} />;
                return <p key={i} className="text-sm text-zinc-300 leading-relaxed">{renderInline(line)}</p>;
            })}
        </div>
    );
}

function renderInline(s: string) {
    return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-white font-bold">{p.slice(2, -2)}</strong>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="px-1 py-0.5 bg-slate-800 text-neonBlue rounded text-[11px] font-mono">{p.slice(1, -1)}</code>;
        return p;
    });
}

export default function Insights() {
    const { data: profile } = useApi<any>('/api/insights/profile');
    const { data: trends } = useApi<any>('/api/insights/trends');
    const { data: promptMetrics } = useApi<any>('/api/insights/prompt-metrics');
    const { data: recommendations } = useApi<any[]>('/api/recommendations');
    const { data: dailyPick } = useApi<any>('/api/insights/daily-pick');
    const { data: ollamaStatus } = useApi<any>('/api/ollama/status');
    const { data: embeddingStatus } = useApi<any>('/api/embedding/status');
    const { data: effectSizes } = useApi<any>('/api/prompt-coach/effects');
    const { data: p2pStatus } = useApi<any>('/api/p2p/peers');
    const { data: templates } = useApi<any>('/api/prompt-coach/templates');
    const { data: improvements } = useApi<any>('/api/prompt-coach/improve');

    const [view, setView] = useState<'profile' | 'trends' | 'prompts' | 'daily' | 'deep' | 'recommendations' | 'memory'>('profile');
    const [promptScienceTab, setPromptScienceTab] = useState<'evidence' | 'templates' | 'antipatterns'>('evidence');
    const [deepText, setDeepText] = useState('');
    const [deepLoading, setDeepLoading] = useState(false);
    const [refreshingPick, setRefreshingPick] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<any[] | null>(null);
    const [searching, setSearching] = useState(false);

    const tabs = [
        { id: 'profile' as const, label: 'How You Work', icon: <Target className="w-4 h-4" /> },
        { id: 'trends' as const, label: 'Trends', icon: <TrendingUp className="w-4 h-4" /> },
        { id: 'prompts' as const, label: 'Prompt Science', icon: <FlaskConical className="w-4 h-4" /> },
        { id: 'daily' as const, label: 'Daily Pick', icon: <Sparkles className="w-4 h-4" /> },
        { id: 'deep' as const, label: 'Deep Analyze', icon: <Brain className="w-4 h-4" /> },
        { id: 'recommendations' as const, label: 'Optimize', icon: <Lightbulb className="w-4 h-4" /> },
        { id: 'memory' as const, label: 'Memory', icon: <Database className="w-4 h-4" /> },
    ];

    const runDeepAnalyze = () => {
        if (deepLoading) return;
        setDeepLoading(true);
        setDeepText('');
        let full = '';
        const es = new EventSource('/api/insights/deep-analyze');
        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.token) { full += data.token; setDeepText(full); }
                if (data.done || data.cached) { if (data.cached) setDeepText(data.token); es.close(); setDeepLoading(false); }
                if (data.error) { setDeepText(prev => prev || 'Error: ' + data.error); es.close(); setDeepLoading(false); }
            } catch { /* skip */ }
        };
        es.onerror = () => { es.close(); setDeepLoading(false); if (!full) setDeepText('Failed to connect.'); };
    };

    const refreshDailyPick = async () => {
        setRefreshingPick(true);
        try { await fetch('/api/insights/daily-pick/refresh', { method: 'POST' }); } finally { setRefreshingPick(false); }
    };

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-extrabold text-white tracking-tight">Insights</h2>
                    <p className="text-sm text-slate-400 mt-1">AI-powered analysis of your coding patterns</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <div className={`w-2 h-2 rounded-full ${ollamaStatus?.available ? 'bg-neonGreen animate-pulse' : 'bg-zinc-600'}`} />
                    <span>{ollamaStatus?.available ? `LLM: ${ollamaStatus.provider}/${ollamaStatus.model}` : 'No LLM configured'}</span>
                </div>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-2 glass-panel p-2 w-fit">
                {tabs.map(t => (
                    <button key={t.id} onClick={() => setView(t.id)}
                        className={`px-4 py-2 flex items-center gap-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${view === t.id ? 'bg-brand/20 text-brand border border-brand/50 shadow-neon-brand' : 'text-zinc-500 hover:text-white border border-transparent hover:bg-[#111]'}`}>
                        {t.icon} <span>{t.label}</span>
                    </button>
                ))}
            </div>

            {/* Profile — How You Work */}
            {view === 'profile' && profile && (
                <div className="space-y-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <StatCard label="Median Turns" value={profile.medianTurns} />
                        <StatCard label="Median Duration" value={`${profile.medianDurationMin}m`} />
                        <StatCard label="Primary Tool" value={profile.primaryTool} color="brand" />
                        <StatCard label="Peak Hour" value={`${profile.peakHour}:00`} color="neonBlue" />
                    </div>

                    {/* Tool Call Breakdown */}
                    {profile.toolBreakdown?.length > 0 && (
                        <div className="glass-panel p-6">
                            <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">Claude Code Tool Usage</h3>
                            <div className="space-y-3">
                                {profile.toolBreakdown.map((t: any) => (
                                    <div key={t.name} className="flex items-center gap-3">
                                        <span className="text-xs font-mono text-zinc-400 w-20 truncate">{t.name}</span>
                                        <div className="flex-1 h-6 bg-[#111] rounded overflow-hidden border border-[#222]">
                                            <div className="h-full bg-gradient-to-r from-brand/60 to-brand rounded transition-all" style={{ width: `${t.pct}%` }}>
                                                <span className="text-[10px] font-black text-white px-2 leading-6">{t.count}</span>
                                            </div>
                                        </div>
                                        <span className="text-[10px] font-black text-zinc-500 w-10 text-right">{t.pct}%</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Prompt Quality Indicators */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="glass-panel p-6 border-neonGreen/20">
                            <h3 className="text-xs font-black text-neonGreen mb-2 uppercase tracking-widest">File Context Rate</h3>
                            <p className="text-4xl font-black text-white">{profile.fileContextRate}%</p>
                            <p className="text-[10px] text-zinc-500 mt-1">of sessions include file paths in first turn</p>
                            {profile.avgQWithFile && <p className="text-xs text-zinc-400 mt-2">With file: <span className="text-neonGreen font-bold">Q {profile.avgQWithFile}</span> · Without: <span className="text-zinc-500">Q {profile.avgQWithoutFile}</span></p>}
                        </div>
                        <div className="glass-panel p-6 border-brand/20">
                            <h3 className="text-xs font-black text-brand mb-2 uppercase tracking-widest">Constrained Prompts</h3>
                            <p className="text-4xl font-black text-white">{profile.constrainedRate}%</p>
                            <p className="text-[10px] text-zinc-500 mt-1">of sessions use constraints (only, must, avoid...)</p>
                        </div>
                    </div>

                    {/* First Turn Bucket Histogram */}
                    {profile.firstTurnBuckets && (
                        <div className="glass-panel p-6">
                            <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">First Turn Prompt Length Distribution</h3>
                            <ResponsiveContainer width="100%" height={180}>
                                <BarChart data={Object.entries(profile.firstTurnBuckets).map(([k, v]) => ({ range: k, count: v }))}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                    <XAxis dataKey="range" tick={{ fontSize: 10, fill: '#888', fontWeight: 700 }} />
                                    <YAxis tick={{ fontSize: 10, fill: '#666' }} />
                                    <Tooltip contentStyle={{ background: '#0a0a0a', border: '1px solid #ff5500', borderRadius: 8, fontSize: 12 }} />
                                    <Bar dataKey="count" fill="#ff5500" radius={[4, 4, 0, 0]} name="Sessions" />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                </div>
            )}

            {/* Trends */}
            {view === 'trends' && trends && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <TrendChart title="Cache Hit Rate (7d rolling)" data={trends.cacheHit} color="#39ff14" baseline={trends.cacheBaseline} />
                        <TrendChart title="Quality Score (7d rolling)" data={trends.quality} color="#00f3ff" />
                        {trends.reaskRate && <TrendChart title="Re-ask Rate (7d rolling)" data={trends.reaskRate} color="#ff00ff" />}
                        {trends.errorRate && <TrendChart title="Error Rate (7d rolling)" data={trends.errorRate} color="#ff4444" />}
                    </div>
                </div>
            )}

            {/* Prompt Science */}
            {view === 'prompts' && (
                <div className="space-y-6">
                    <p className="text-xs text-zinc-500">Based on {promptMetrics?.totalSessions || 0} analyzed sessions — evidence-based prompt engineering from your history</p>

                    {/* Sub-tabs for Prompt Science */}
                    <div className="flex gap-2">
                        {([
                            { id: 'evidence' as const, label: 'Evidence', icon: <FlaskConical className="w-3 h-3" /> },
                            { id: 'templates' as const, label: 'Templates', icon: <BookOpen className="w-3 h-3" /> },
                            { id: 'antipatterns' as const, label: 'Anti-Patterns', icon: <ShieldAlert className="w-3 h-3" /> },
                        ]).map(t => (
                            <button key={t.id} onClick={() => setPromptScienceTab(t.id)}
                                className={`px-3 py-1.5 flex items-center gap-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${promptScienceTab === t.id ? 'bg-neonPink/20 text-neonPink border border-neonPink/50' : 'text-zinc-500 hover:text-white border border-transparent hover:bg-[#111]'}`}>
                                {t.icon} {t.label}
                            </button>
                        ))}
                    </div>

                    {/* Evidence tab — effect sizes + correlations */}
                    {promptScienceTab === 'evidence' && (
                        <div className="space-y-6">
                            {promptMetrics?.avgTurnsToFirstEdit != null && (
                                <div className="glass-panel p-6 border-brand/20">
                                    <h3 className="text-xs font-black text-brand mb-2 uppercase tracking-widest">Avg Turns to First Edit</h3>
                                    <p className="text-5xl font-black text-white">{promptMetrics.avgTurnsToFirstEdit}</p>
                                    <p className="text-[10px] text-zinc-500 mt-1">turns before first Write/Edit/Bash call</p>
                                </div>
                            )}

                            {/* Effect Sizes */}
                            {effectSizes?.effects?.length > 0 && (
                                <div className="glass-panel p-6 border-neonPink/20">
                                    <h3 className="text-xs font-black text-neonPink mb-4 uppercase tracking-widest flex items-center gap-2">
                                        <FlaskConical className="w-4 h-4" /> Evidence-Based Effect Sizes
                                    </h3>
                                    <div className="space-y-3">
                                        {effectSizes.effects.map((e: any, i: number) => (
                                            <div key={i} className="flex items-center gap-4 p-4 bg-[#050505] rounded-xl border border-[#222]">
                                                <div className="flex-1">
                                                    <p className="text-sm font-bold text-white">{e.signal}</p>
                                                    <p className="text-[10px] text-zinc-500 mt-1">
                                                        n={e.sample_with}{e.sample_without > 0 ? `/${e.sample_without}` : ''}
                                                    </p>
                                                </div>
                                                <div className="text-center px-4">
                                                    <p className="text-lg font-black text-neonGreen">{e.with_avg ?? '—'}</p>
                                                    <p className="text-[9px] text-zinc-500">Avg Quality</p>
                                                </div>
                                                {e.without_avg != null && (
                                                    <div className="text-center px-4">
                                                        <p className="text-lg font-black text-zinc-500">{e.without_avg}</p>
                                                        <p className="text-[9px] text-zinc-500">Without</p>
                                                    </div>
                                                )}
                                                {e.delta != null && (
                                                    <div className={`text-xs font-black px-2 py-1 rounded ${e.delta > 0 ? 'text-neonGreen bg-neonGreen/10' : 'text-red-400 bg-red-400/10'}`}>
                                                        {e.delta > 0 ? '+' : ''}{e.delta} pts ({e.delta_pct > 0 ? '+' : ''}{e.delta_pct}%)
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Original correlations */}
                            {promptMetrics?.correlations?.length > 0 && (
                                <div className="glass-panel p-6">
                                    <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">Quality Correlations</h3>
                                    <div className="space-y-4">
                                        {(promptMetrics.correlations || []).map((c: any, i: number) => (
                                            <div key={i} className="flex items-center gap-4 p-4 bg-[#050505] rounded-xl border border-[#222]">
                                                <div className="flex-1">
                                                    <p className="text-sm font-bold text-white">{c.signal}</p>
                                                    <p className="text-[10px] text-zinc-500 mt-1">{c.rate}% of sessions</p>
                                                </div>
                                                <div className="text-center px-4">
                                                    <p className="text-lg font-black text-neonGreen">{c.with ?? '—'}</p>
                                                    <p className="text-[9px] text-zinc-500">{c.withLabel || 'With'}</p>
                                                </div>
                                                <div className="text-center px-4">
                                                    <p className="text-lg font-black text-zinc-500">{c.without ?? '—'}</p>
                                                    <p className="text-[9px] text-zinc-500">{c.withoutLabel || 'Without'}</p>
                                                </div>
                                                {c.with != null && c.without != null && (
                                                    <div className={`text-xs font-black px-2 py-1 rounded ${c.with > c.without ? 'text-neonGreen bg-neonGreen/10' : 'text-red-400 bg-red-400/10'}`}>
                                                        {c.with > c.without ? '+' : ''}{((c.with - c.without) / (c.without || 1) * 100).toFixed(0)}%
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Templates tab — best prompts by task type */}
                    {promptScienceTab === 'templates' && (
                        <div className="space-y-6">
                            {templates?.templates && Object.keys(templates.templates).length > 0 ? (
                                Object.entries(templates.templates).map(([taskType, sessions]: [string, any]) => (
                                    <div key={taskType} className="glass-panel p-6 border-[#222]">
                                        <h3 className="text-xs font-black text-brand mb-4 uppercase tracking-widest">{taskType}</h3>
                                        <div className="space-y-3">
                                            {sessions.slice(0, 3).map((s: any, i: number) => (
                                                <div key={i} className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-brand/10 text-brand border border-brand/30">{s.tool}</span>
                                                            <span className="text-[10px] font-mono text-zinc-500">{s.model}</span>
                                                        </div>
                                                        <div className="flex items-center gap-3 text-[10px]">
                                                            <span className="text-neonGreen font-bold">Q: {s.quality}</span>
                                                            <span className="text-zinc-500">{s.turns} turns</span>
                                                            <span className="text-zinc-500">{s.cache_hit}% cache</span>
                                                        </div>
                                                    </div>
                                                    {s.first_prompt && (
                                                        <p className="text-xs text-zinc-400 leading-relaxed mt-2 bg-[#111] p-3 rounded border border-[#1a1a1a] font-mono">
                                                            {s.first_prompt}
                                                        </p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <p className="text-zinc-600 text-sm py-8 text-center">No high-quality prompt templates extracted yet. Requires sessions with quality &gt; 70.</p>
                            )}
                        </div>
                    )}

                    {/* Anti-patterns tab */}
                    {promptScienceTab === 'antipatterns' && (
                        <div className="space-y-6">
                            {improvements?.low_quality_patterns?.length > 0 ? (
                                <>
                                    <div className="glass-panel p-6 border-red-400/20">
                                        <h3 className="text-xs font-black text-red-400 mb-4 uppercase tracking-widest flex items-center gap-2">
                                            <ShieldAlert className="w-4 h-4" /> Low-Quality Session Patterns
                                        </h3>
                                        <div className="space-y-3">
                                            {improvements.low_quality_patterns.map((p: any, i: number) => (
                                                <div key={i} className="p-4 bg-[#050505] rounded-xl border border-red-400/10">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{p.tool} · Q: {p.quality}</span>
                                                        <span className="text-[10px] font-mono text-zinc-600">{p.session_id?.slice(0, 12)}</span>
                                                    </div>
                                                    {p.gaps.length > 0 && (
                                                        <ul className="space-y-1">
                                                            {p.gaps.map((g: string, j: number) => (
                                                                <li key={j} className="text-xs text-red-300 flex items-center gap-2">
                                                                    <span className="w-1 h-1 rounded-full bg-red-400" /> {g}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    {improvements.optimal?.tips?.length > 0 && (
                                        <div className="glass-panel p-6 border-neonGreen/20">
                                            <h3 className="text-xs font-black text-neonGreen mb-4 uppercase tracking-widest">What Works Instead</h3>
                                            <ul className="space-y-2">
                                                {improvements.optimal.tips.map((tip: string, i: number) => (
                                                    <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                                                        <span className="text-neonGreen mt-0.5">+</span> {tip}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <p className="text-zinc-600 text-sm py-8 text-center">No anti-patterns detected yet. Requires sessions with quality &lt; 50.</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Daily Pick */}
            {view === 'daily' && (
                <div className="glass-panel p-6 border-neonPink/20 bg-gradient-to-br from-[#0a0a0a] to-[#050505]">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xs font-black text-neonPink uppercase tracking-widest flex items-center gap-2">
                            <Sparkles className="w-4 h-4" /> Today's Automation Pick
                        </h3>
                        <button onClick={refreshDailyPick} disabled={refreshingPick}
                            className="text-xs text-zinc-500 hover:text-white flex items-center gap-1 transition-colors disabled:opacity-40">
                            <RefreshCw className={`w-3 h-3 ${refreshingPick ? 'animate-spin' : ''}`} /> Regenerate
                        </button>
                    </div>
                    {dailyPick?.text ? (
                        <div className="bg-[#111] p-5 rounded-xl border border-neonPink/10">
                            <MarkdownBlock text={dailyPick.text} />
                            {dailyPick.provider && (
                                <p className="text-[10px] text-zinc-600 mt-4 uppercase tracking-widest">Generated by {dailyPick.provider}</p>
                            )}
                        </div>
                    ) : (
                        <p className="text-zinc-600 text-sm py-8 text-center">No daily pick generated yet. Configure an LLM provider or click Regenerate.</p>
                    )}
                </div>
            )}

            {/* Deep Analyze */}
            {view === 'deep' && (
                <div className="glass-panel p-6 border-neonBlue/20">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xs font-black text-neonBlue uppercase tracking-widest flex items-center gap-2">
                            <Brain className="w-4 h-4" /> Deep Session Analysis
                        </h3>
                        <button onClick={runDeepAnalyze} disabled={deepLoading}
                            className="px-4 py-2 text-xs font-black uppercase tracking-widest bg-neonBlue/10 text-neonBlue border border-neonBlue/50 rounded-lg hover:bg-neonBlue/20 hover:shadow-neon-blue transition-all disabled:opacity-40 flex items-center gap-2">
                            {deepLoading ? <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</> : <><Zap className="w-3 h-3" /> Run Analysis</>}
                        </button>
                    </div>
                    {deepText ? (
                        <div className="bg-[#050505] p-5 rounded-xl border border-neonBlue/10 relative">
                            {deepLoading && <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-neonBlue to-transparent animate-pulse" />}
                            <MarkdownBlock text={deepText} />
                        </div>
                    ) : (
                        <p className="text-zinc-600 text-sm py-8 text-center">Click "Run Analysis" to generate an AI-powered performance review of your recent sessions.</p>
                    )}
                </div>
            )}

            {/* Recommendations */}
            {view === 'recommendations' && (
                <div className="space-y-4">
                    {(recommendations || []).length === 0 && (
                        <p className="text-zinc-600 text-sm py-8 text-center">No active recommendations. Your workflow looks optimal!</p>
                    )}
                    {(recommendations || []).map((r: any) => (
                        <div key={r.id} className="glass-panel p-5 border-[#222] hover:border-brand/30 transition-colors">
                            <div className="flex items-start gap-3">
                                <div className={`mt-0.5 ${r.severity === 'warning' ? 'text-yellow-400' : r.severity === 'tip' ? 'text-brand' : 'text-neonBlue'}`}>
                                    {r.severity === 'warning' ? <AlertTriangle className="w-5 h-5" /> : r.severity === 'tip' ? <Lightbulb className="w-5 h-5" /> : <BarChart2 className="w-5 h-5" />}
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest ${r.severity === 'warning' ? 'bg-yellow-400/10 text-yellow-400' : r.severity === 'tip' ? 'bg-brand/10 text-brand' : 'bg-neonBlue/10 text-neonBlue'}`}>{r.severity}</span>
                                        <span className="text-[10px] text-zinc-500 uppercase tracking-widest">{r.category}</span>
                                        {r.tool_id && <span className="text-[10px] text-zinc-600 uppercase tracking-widest">· {r.tool_id}</span>}
                                    </div>
                                    <h4 className="text-sm font-bold text-white">{r.title}</h4>
                                    <p className="text-sm text-zinc-400 mt-1 leading-relaxed">{r.description}</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Memory — Embedding Status */}
            {view === 'memory' && (
                <div className="space-y-6">
                    {/* Provider Status */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="glass-panel p-5 text-center">
                            <div className={`w-3 h-3 rounded-full mx-auto mb-2 ${embeddingStatus?.isSemantic ? 'bg-neonGreen animate-pulse' : 'bg-yellow-400'}`} />
                            <p className="text-lg font-black text-white capitalize">{embeddingStatus?.provider || '...'}</p>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Provider</p>
                        </div>
                        <StatCard label="Embedded" value={embeddingStatus?.embeddedSessions ?? '...'} />
                        <StatCard label="Coverage" value={embeddingStatus?.coveragePct != null ? `${embeddingStatus.coveragePct}%` : '...'} color={embeddingStatus?.coveragePct > 80 ? 'brand' : undefined} />
                        <StatCard label="Dimensions" value={embeddingStatus?.dimensions ?? '...'} color="neonBlue" />
                    </div>

                    {/* Semantic vs keyword warning */}
                    {embeddingStatus && !embeddingStatus.isSemantic && (
                        <div className="glass-panel p-5 border-yellow-400/30 bg-yellow-400/5">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" />
                                <div>
                                    <h4 className="text-sm font-bold text-yellow-400">Hash fallback active — keyword matching only</h4>
                                    <p className="text-xs text-zinc-400 mt-1">
                                        Similarity search uses keyword hashing, not real semantic understanding.
                                        Install the ONNX model by restarting the server (auto-downloads ~30MB on first run),
                                        or configure Ollama/OpenAI for higher-quality embeddings.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Provider breakdown */}
                    {embeddingStatus?.providerBreakdown?.length > 0 && (
                        <div className="glass-panel p-6">
                            <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">Embeddings by Provider</h3>
                            <div className="space-y-3">
                                {embeddingStatus.providerBreakdown.map((p: any) => (
                                    <div key={p.provider} className="flex items-center gap-3">
                                        <span className="text-xs font-mono text-zinc-400 w-16">{p.provider}</span>
                                        <div className="flex-1 h-6 bg-[#111] rounded overflow-hidden border border-[#222]">
                                            <div className="h-full bg-gradient-to-r from-brand/60 to-brand rounded transition-all"
                                                style={{ width: `${Math.min(100, (p.cnt / (embeddingStatus.embeddedSessions || 1)) * 100)}%` }}>
                                                <span className="text-[10px] font-black text-white px-2 leading-6">{p.cnt}</span>
                                            </div>
                                        </div>
                                        <span className={`text-[10px] font-black px-2 py-0.5 rounded ${p.provider === 'hash' ? 'text-yellow-400 bg-yellow-400/10' : 'text-neonGreen bg-neonGreen/10'}`}>
                                            {p.provider === 'hash' ? 'keyword' : 'semantic'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* P2P Security Warning */}
                    {p2pStatus?.security?.enabled && p2pStatus.security.warnings?.length > 0 && (
                        <div className="glass-panel p-5 border-red-400/30 bg-red-400/5">
                            <div className="flex items-start gap-3">
                                <ShieldAlert className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
                                <div>
                                    <h4 className="text-sm font-bold text-red-400">P2P Security Notice</h4>
                                    {p2pStatus.security.warnings.map((w: string, i: number) => (
                                        <p key={i} className="text-xs text-zinc-400 mt-1">{w}</p>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Live search */}
                    <div className="glass-panel p-6 border-neonBlue/20">
                        <h3 className="text-xs font-black text-neonBlue mb-4 uppercase tracking-widest flex items-center gap-2">
                            <Search className="w-4 h-4" /> Try Similarity Search
                        </h3>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && searchQuery.trim()) {
                                        setSearching(true);
                                        fetch(`/api/embedding/search?q=${encodeURIComponent(searchQuery)}&limit=5`)
                                            .then(r => r.json())
                                            .then(d => { setSearchResults(d.results || []); setSearching(false); })
                                            .catch(() => setSearching(false));
                                    }
                                }}
                                placeholder="Search your session memory..."
                                className="flex-1 bg-[#111] border border-[#222] rounded-lg px-4 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-neonBlue/50"
                            />
                            <button
                                onClick={() => {
                                    if (!searchQuery.trim()) return;
                                    setSearching(true);
                                    fetch(`/api/embedding/search?q=${encodeURIComponent(searchQuery)}&limit=5`)
                                        .then(r => r.json())
                                        .then(d => { setSearchResults(d.results || []); setSearching(false); })
                                        .catch(() => setSearching(false));
                                }}
                                disabled={searching || !searchQuery.trim()}
                                className="px-4 py-2 text-xs font-black uppercase tracking-widest bg-neonBlue/10 text-neonBlue border border-neonBlue/50 rounded-lg hover:bg-neonBlue/20 transition-all disabled:opacity-40 flex items-center gap-2"
                            >
                                {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                                Search
                            </button>
                        </div>
                        {searchResults && (
                            <div className="mt-4 space-y-2">
                                {searchResults.length === 0 && (
                                    <p className="text-zinc-600 text-sm text-center py-4">No matches found.</p>
                                )}
                                {searchResults.map((r: any, i: number) => (
                                    <div key={i} className="p-3 bg-[#050505] rounded-xl border border-[#222] flex items-center gap-3">
                                        <div className="text-center w-16 shrink-0">
                                            <p className="text-lg font-black text-white">{(r.similarity * 100).toFixed(0)}%</p>
                                            <p className={`text-[9px] font-black uppercase ${r.matchType === 'semantic' ? 'text-neonGreen' : 'text-yellow-400'}`}>{r.matchType}</p>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-white truncate">{r.title}</p>
                                            <p className="text-xs text-zinc-500 truncate">{r.tldr || 'No summary'}</p>
                                        </div>
                                        {r.quality && (
                                            <span className="text-[10px] font-black text-neonGreen bg-neonGreen/10 px-2 py-0.5 rounded shrink-0">Q: {r.quality}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
    const textClass = color === 'brand' ? 'text-brand' : color === 'neonBlue' ? 'text-neonBlue' : 'text-white';
    return (
        <div className="glass-panel p-5 text-center">
            <p className={`text-3xl font-black ${textClass}`}>{value}</p>
            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-2">{label}</p>
        </div>
    );
}

function TrendChart({ title, data, color, baseline }: { title: string; data: any[]; color: string; baseline?: number | null }) {
    return (
        <div className="glass-panel p-6">
            <h3 className="text-xs font-black text-zinc-400 mb-4 uppercase tracking-widest">{title}</h3>
            <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={data || []}>
                    <defs>
                        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#666' }} tickFormatter={d => d?.slice(5)} />
                    <YAxis tick={{ fontSize: 9, fill: '#666' }} />
                    <Tooltip contentStyle={{ background: '#0a0a0a', border: `1px solid ${color}`, borderRadius: 8, fontSize: 11 }} />
                    <Area type="monotone" dataKey="value" stroke={color} fill={`url(#grad-${color.replace('#', '')})`} strokeWidth={2} />
                    {baseline != null && (
                        <Area type="monotone" dataKey={() => baseline} stroke="#666" strokeDasharray="4 4" fill="none" strokeWidth={1} />
                    )}
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
