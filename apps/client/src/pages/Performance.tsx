import { useState, useContext } from 'react';
import { useApi } from '../hooks/useApi';
import { FocusModeContext } from '../App';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Legend } from 'recharts';
import { ArrowRightLeft, BrainCircuit, DollarSign, Bot, BarChart2, Target, Terminal, Wallet, GitCommit, FileCode, Users, Trophy, Navigation } from 'lucide-react';

const TOOL_COLORS: Record<string, string> = {
    'claude-code': '#ff5500', 'cursor': '#00f3ff', 'antigravity': '#39ff14',
    'aider': '#ff00ff', 'windsurf': '#f0f', 'copilot': '#0ff', 'continue': '#ff0',
};

export default function Performance() {
    const { data: compare } = useApi<any[]>('/api/compare');
    const { data: models } = useApi<any[]>('/api/models');
    const { data: costs } = useApi<any>('/api/costs');
    const { data: codeGen } = useApi<any>('/api/code-generation');
    const { data: agentic } = useApi<any>('/api/agentic/scores');
    const { data: commits } = useApi<any[]>('/api/commits');
    const { data: modelPerf } = useApi<any[]>('/api/models/performance');
    const { data: winRates } = useApi<any[]>('/api/models/win-rates');
    const { data: routing } = useApi<any>('/api/models/routing');
    const focusMode = useContext(FocusModeContext);
    const [view, setView] = useState<'tools' | 'models' | 'costs' | 'agentic' | 'authorship' | 'codegen' | 'modelperf' | 'winrates' | 'routing'>('tools');

    const tabs = [
        { id: 'tools' as const, label: 'Tool Comparison', icon: <ArrowRightLeft className="w-4 h-4" /> },
        { id: 'models' as const, label: 'Model Usage', icon: <BrainCircuit className="w-4 h-4" /> },
        { id: 'modelperf' as const, label: 'Model Performance', icon: <BarChart2 className="w-4 h-4" /> },
        { id: 'winrates' as const, label: 'Win Rates', icon: <Trophy className="w-4 h-4" /> },
        { id: 'routing' as const, label: 'Routing', icon: <Navigation className="w-4 h-4" /> },
        { id: 'costs' as const, label: 'Cost Tracking', icon: <DollarSign className="w-4 h-4" /> },
        { id: 'codegen' as const, label: 'Code Generation', icon: <FileCode className="w-4 h-4" /> },
        { id: 'authorship' as const, label: 'Code Authorship', icon: <GitCommit className="w-4 h-4" /> },
        { id: 'agentic' as const, label: 'Agentic Scores', icon: <Bot className="w-4 h-4" /> },
    ];

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-extrabold text-white tracking-tight">Performance</h2>
                <p className="text-sm text-slate-400 mt-1">Token usage, model benchmarks, and cost analysis</p>
            </div>

            {/* Sub-tabs */}
            {!focusMode && (
                <div className="flex gap-2 glass-panel p-2 w-fit overflow-x-auto max-w-full">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setView(t.id)}
                            className={`px-4 py-2 flex items-center gap-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${view === t.id ? 'bg-brand/20 text-brand border border-brand/50 shadow-neon-brand' : 'text-zinc-500 hover:text-white border border-transparent hover:bg-[#111]'}`}>
                            {t.icon} <span>{t.label}</span>
                        </button>
                    ))}
                </div>
            )}
            {focusMode && (
                <div className="glass-panel p-4 border-brand/20 bg-brand/5 text-center">
                    <p className="text-[10px] text-brand font-black uppercase tracking-widest">Focus Mode — showing Tool Comparison only</p>
                </div>
            )}

            {/* Tool Comparison */}
            {view === 'tools' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="glass-panel p-6 border-brand/20">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><BarChart2 className="w-4 h-4 text-brand" /> Sessions & Turns</h3>
                        <ResponsiveContainer width="100%" height={280}>
                            <BarChart data={compare || []}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                <XAxis dataKey="tool_id" tick={{ fontSize: 10, fill: '#aaa', fontWeight: 700 }} />
                                <YAxis tick={{ fontSize: 10, fill: '#666', fontWeight: 700 }} />
                                <Tooltip contentStyle={{ background: '#0a0a0a', border: '1px solid #ff5500', borderRadius: 8, fontSize: 12, boxShadow: '0 0 10px rgba(255,85,0,0.5)' }} itemStyle={{ color: '#fff', fontWeight: 700 }} />
                                <Bar dataKey="sessions" fill="#ff5500" radius={[4, 4, 0, 0]} name="Sessions" style={{ filter: 'drop-shadow(0 0 5px #ff5500)' }} />
                                <Bar dataKey="total_turns" fill="#00f3ff" radius={[4, 4, 0, 0]} name="Turns" style={{ filter: 'drop-shadow(0 0 5px #00f3ff)' }} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                    <div className="glass-panel p-6 border-neonPink/20">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><Target className="w-4 h-4 text-neonPink" /> Quality Radar</h3>
                        <ResponsiveContainer width="100%" height={280}>
                            <RadarChart data={(compare || []).map((t: any) => ({
                                tool: t.tool_id,
                                quality: t.avg_quality || 0,
                                cacheHit: t.avg_cache_hit || 0,
                                agentic: t.avg_agentic || 0,
                                firstAttempt: t.avg_first_attempt || 0,
                            }))}>
                                <PolarGrid stroke="#333" />
                                <PolarAngleAxis dataKey="tool" tick={{ fontSize: 10, fill: '#aaa', fontWeight: 700 }} />
                                <PolarRadiusAxis tick={{ fontSize: 9, fill: '#555' }} />
                                <Radar name="Quality" dataKey="quality" stroke="#39ff14" fill="#39ff14" fillOpacity={0.2} style={{ filter: 'drop-shadow(0 0 5px #39ff14)' }} />
                                <Radar name="Cache" dataKey="cacheHit" stroke="#ff00ff" fill="#ff00ff" fillOpacity={0.2} style={{ filter: 'drop-shadow(0 0 5px #ff00ff)' }} />
                                <Legend wrapperStyle={{ fontSize: 11, fontWeight: 700, color: '#fff' }} />
                            </RadarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Code Generation */}
            {view === 'codegen' && !focusMode && (
                <div className="space-y-6">
                    {/* Code Generation Stats */}
                    <div className="glass-panel p-6 border-neonGreen/20">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><Terminal className="w-4 h-4 text-neonGreen" /> Lines Generated by Tool</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            {(codeGen?.byTool || []).map((t: any) => (
                                <div key={t.tool_id} className="bg-[#050505] rounded-xl p-5 border border-[#222] hover:border-[#444] transition-colors group">
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-2.5 h-2.5 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: TOOL_COLORS[t.tool_id] || '#666', color: TOOL_COLORS[t.tool_id] || '#666' }} />
                                        <span className="text-[10px] font-black text-white uppercase tracking-widest">{t.tool_id}</span>
                                    </div>
                                    <p className="text-3xl font-black text-white group-hover:scale-105 origin-left transition-transform" style={{ textShadow: `0 0 10px ${TOOL_COLORS[t.tool_id] || '#fff'}40` }}>{((t.lines_added || 0) / 1000).toFixed(1)}K</p>
                                    <p className="text-[10px] uppercase font-bold tracking-widest text-zinc-500 mt-1">lines generated</p>
                                </div>
                            ))}
                        </div>
                    </div>
                    {/* Branch Code Gen Stats */}
                    <div className="glass-panel p-6 border-[#222]">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><ArrowRightLeft className="w-4 h-4 text-brand" /> Top Branches</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {(codeGen?.commits || []).slice(0, 6).map((b: any, i: number) => (
                                <div key={i} className="p-4 bg-[#111] border border-[#222] rounded-lg">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-black text-white uppercase tracking-widest truncate">{b.branch}</span>
                                        <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">{b.commits} commits</span>
                                    </div>
                                    <div className="flex items-end justify-between">
                                        <div>
                                            <p className="text-xl font-black text-brand neon-text-brand">{((b.ai_lines_added || 0) / 1000).toFixed(1)}K</p>
                                            <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">AI lines</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-black text-white">{Math.round(b.avg_ai_pct || 0)}%</p>
                                            <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Avg AI</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Code Authorship */}
            {view === 'authorship' && !focusMode && (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="glass-panel p-6 border-neonPink/20 hover:border-neonPink/50 transition-colors">
                            <h3 className="text-xs font-black text-zinc-400 mb-3 uppercase tracking-widest flex items-center gap-2"><GitCommit className="w-4 h-4 text-neonPink" /> Scanned Commits</h3>
                            <p className="text-5xl font-black text-white drop-shadow-md">{commits?.length || 0}</p>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-2">Correlated with AI sessions</p>
                        </div>
                        <div className="glass-panel p-6 border-brand/20 hover:border-brand/50 transition-colors">
                            <h3 className="text-xs font-black text-zinc-400 mb-3 uppercase tracking-widest flex items-center gap-2"><Bot className="w-4 h-4 text-brand" /> Avg AI Attribution</h3>
                            <p className="text-5xl font-black text-white drop-shadow-md">
                                {commits?.length ? Math.round(commits.reduce((a: number, c: any) => a + (c.ai_percentage || 0), 0) / commits.length) : 0}%
                            </p>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-2">Across all commits</p>
                        </div>
                        <div className="glass-panel p-6 border-neonBlue/20 hover:border-neonBlue/50 transition-colors">
                            <h3 className="text-xs font-black text-zinc-400 mb-3 uppercase tracking-widest flex items-center gap-2"><Users className="w-4 h-4 text-neonBlue" /> Top Tool</h3>
                            {(() => {
                                if (!commits?.length) return <p className="text-2xl font-black text-zinc-600 mt-2">N/A</p>;
                                const counts: Record<string, number> = {};
                                commits.forEach((c: any) => { counts[c.tool_id] = (counts[c.tool_id] || 0) + 1; });
                                const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
                                return (
                                    <>
                                        <p className="text-3xl font-black text-white mt-1 uppercase tracking-widest truncate" style={{ textShadow: `0 0 10px ${TOOL_COLORS[top[0]] || '#0ff'}50` }}>{top[0]}</p>
                                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-2">{top[1]} commits attributed</p>
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                    
                    {/* Commits Table */}
                    <div className="glass-panel p-6 border-[#222]">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><GitCommit className="w-4 h-4 text-brand" /> Recent Commits</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-[#333]">
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Hash</th>
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Message</th>
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Branch</th>
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Tool</th>
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">AI %</th>
                                        <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Lines (+/-)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(commits || []).slice(0, 15).map((c: any, i: number) => (
                                        <tr key={i} className="border-b border-[#222] hover:bg-[#111] transition-colors group">
                                            <td className="py-3 px-4 text-xs font-mono text-zinc-400 group-hover:text-white transition-colors">{c.commit_hash.slice(0, 7)}</td>
                                            <td className="py-3 px-4 text-sm font-bold text-white max-w-[300px] truncate" title={c.message}>{c.message}</td>
                                            <td className="py-3 px-4 text-xs font-black uppercase tracking-widest text-brand">{c.branch}</td>
                                            <td className="py-3 px-4">
                                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-[#333]" style={{ color: TOOL_COLORS[c.tool_id] || '#fff', borderColor: `${TOOL_COLORS[c.tool_id] || '#fff'}40` }}>
                                                    {c.tool_id}
                                                </span>
                                            </td>
                                            <td className="py-3 px-4">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-black text-white w-8">{Math.round(c.ai_percentage)}%</span>
                                                    <div className="w-16 h-1.5 bg-[#111] rounded-full overflow-hidden">
                                                        <div className="h-full bg-brand" style={{ width: `${c.ai_percentage}%` }} />
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-3 px-4 text-right">
                                                <span className="text-xs font-black text-neonGreen">+{c.lines_added}</span>
                                                <span className="text-xs font-black text-neonPink ml-2">-{c.lines_deleted}</span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {(!commits || commits.length === 0) && (
                                <p className="text-center text-zinc-600 font-mono text-sm uppercase tracking-widest py-10">No commit scores available. Run Git Scanner first.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Model Usage */}
            {view === 'models' && !focusMode && (
                <div className="glass-panel p-6 border-neonBlue/20">
                    <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><BrainCircuit className="w-4 h-4 text-neonBlue" /> Model Breakdown</h3>
                    <div className="space-y-4">
                        {(models || []).map((m: any, i: number) => {
                            const maxSessions = Math.max(...(models || []).map((x: any) => x.sessions || 1));
                            const pct = ((m.sessions || 0) / maxSessions) * 100;
                            return (
                                <div key={i} className="flex items-center gap-4">
                                    <span className="text-[10px] font-black uppercase tracking-wider text-white w-48 truncate">{m.model}</span>
                                    <div className="flex-1 h-8 bg-[#111] rounded-sm overflow-hidden border border-[#222]">
                                        <div className="h-full bg-gradient-to-r from-neonBlue/50 to-neonBlue rounded-r-sm transition-all duration-1000 flex items-center pl-3 shadow-[0_0_10px_#00f3ff]"
                                            style={{ width: `${pct}%` }}>
                                            <span className="text-[10px] font-black text-white drop-shadow-md uppercase tracking-wider">{m.sessions} sessions</span>
                                        </div>
                                    </div>
                                    <span className="text-[10px] text-brand font-black uppercase tracking-widest w-20 text-right neon-text-brand">Q: {(m.avg_quality || 0).toFixed(0)}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Costs */}
            {view === 'costs' && !focusMode && (
                <div className="space-y-6">
                    <div className="grid grid-cols-3 gap-6">
                        <div className="glass-panel p-6 border-[#222]">
                            <h3 className="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-2">Total Estimated</h3>
                            <p className="text-4xl font-black text-white drop-shadow-md">${costs?.totalCost?.toFixed(2) || '0.00'}</p>
                        </div>
                        <div className="glass-panel p-6 border-neonGreen/30 bg-gradient-to-br from-[#050505] to-[#111]">
                            <h3 className="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-2">Cache Savings</h3>
                            <p className="text-4xl font-black text-neonGreen drop-shadow-glow-green">${costs?.totalSavings?.toFixed(2) || '0.00'}</p>
                        </div>
                        <div className="glass-panel p-6 border-neonPink/30">
                            <h3 className="text-[10px] text-zinc-500 font-black uppercase tracking-widest mb-2">Models Tracked</h3>
                            <p className="text-4xl font-black text-neonPink drop-shadow-glow-pink">{costs?.costs?.length || 0}</p>
                        </div>
                    </div>
                    <div className="glass-panel p-6 border-[#222]">
                        <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><Wallet className="w-4 h-4 text-brand" /> Cost by Model</h3>
                        <ResponsiveContainer width="100%" height={250}>
                            <BarChart data={(costs?.costs || []).slice(0, 10)}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                                <XAxis dataKey="model" tick={{ fontSize: 9, fill: '#aaa', fontWeight: 700 }} angle={-30} textAnchor="end" height={60} />
                                <YAxis tick={{ fontSize: 10, fill: '#666', fontWeight: 700 }} />
                                <Tooltip contentStyle={{ background: '#0a0a0a', border: '1px solid #39ff14', borderRadius: 8, fontSize: 12, boxShadow: '0 0 10px rgba(57,255,20,0.5)' }} itemStyle={{ color: '#fff', fontWeight: 700 }} cursor={{ fill: '#111' }} />
                                <Bar dataKey="totalCost" fill="#39ff14" radius={[4, 4, 0, 0]} name="Cost ($)" style={{ filter: 'drop-shadow(0 0 5px #39ff14)' }} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Agentic Scores */}
            {view === 'agentic' && !focusMode && (
                <div className="glass-panel p-6 border-brand/30 shadow-neon-brand">
                    <h3 className="text-xs font-black text-brand mb-6 uppercase tracking-widest flex items-center gap-2 drop-shadow-glow-brand"><Bot className="w-4 h-4" /> Agentic Leaderboard</h3>
                    <div className="space-y-3">
                        {(agentic?.leaderboard || []).map((r: any, i: number) => (
                            <div key={i} className="flex items-center gap-4 p-4 bg-[#050505] border border-[#222] hover:border-brand/40 transition-colors group">
                                <span className="text-2xl w-8 text-center filter drop-shadow">
                                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span className="text-sm font-black text-zinc-600">#{i + 1}</span>}
                                </span>
                                <div className="flex-1">
                                    <p className="text-[10px] font-black text-white uppercase tracking-widest">{r.tool_id} <span className="text-zinc-600">/</span> {r.primary_model}</p>
                                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mt-1">{r.sessions} sessions · avg {(r.avg_turns || 0).toFixed(0)} turns</p>
                                </div>
                                <div className="text-right px-4 border-r border-[#222]">
                                    <p className="text-2xl font-black text-brand neon-text-brand group-hover:scale-110 transition-transform">{(r.avg_agentic || 0).toFixed(0)}</p>
                                    <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">avg score</p>
                                </div>
                                <div className="text-right pr-2">
                                    <p className="text-2xl font-black text-neonPink neon-text-pink group-hover:scale-110 transition-transform delay-75">{(r.peak_agentic || 0).toFixed(0)}</p>
                                    <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest">peak</p>
                                </div>
                            </div>
                        ))}
                        {(!agentic?.leaderboard || agentic.leaderboard.length === 0) && (
                            <p className="text-center text-zinc-600 font-mono text-sm uppercase tracking-widest py-10">No agentic scores computed yet. Run a data refresh first.</p>
                        )}
                    </div>
                </div>
            )}

            {/* Model Performance Table */}
            {view === 'modelperf' && !focusMode && (
                <div className="glass-panel p-6 border-[#222]">
                    <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2">
                        <BarChart2 className="w-4 h-4 text-neonBlue" /> Model Performance Benchmark
                    </h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-[#333]">
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Model</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Tools</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Sessions</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Avg Turns</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Cache Hit</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Latency</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Error Rate</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(modelPerf || []).map((m: any, i: number) => (
                                    <tr key={i} className="border-b border-[#222] hover:bg-[#111] transition-colors group">
                                        <td className="py-3 px-4 text-sm font-bold text-white max-w-[200px] truncate">{m.model}</td>
                                        <td className="py-3 px-4">
                                            <div className="flex flex-wrap gap-1">
                                                {(m.tools || []).map((t: string) => (
                                                    <span key={t} className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border border-[#333]"
                                                        style={{ color: TOOL_COLORS[t] || '#aaa', borderColor: `${TOOL_COLORS[t] || '#aaa'}30` }}>{t}</span>
                                                ))}
                                            </div>
                                        </td>
                                        <td className="py-3 px-4 text-right text-sm font-black text-white">{m.sessions}</td>
                                        <td className="py-3 px-4 text-right text-sm text-zinc-300">{(m.avg_turns || 0).toFixed(1)}</td>
                                        <td className="py-3 px-4 text-right">
                                            <span className={`text-sm font-bold ${(m.cache_hit || 0) > 60 ? 'text-neonGreen' : (m.cache_hit || 0) > 30 ? 'text-brand' : 'text-zinc-500'}`}>
                                                {(m.cache_hit || 0).toFixed(1)}%
                                            </span>
                                        </td>
                                        <td className="py-3 px-4 text-right text-sm text-zinc-400">{(m.avg_latency || 0).toFixed(1)}s</td>
                                        <td className="py-3 px-4 text-right">
                                            <span className={`text-sm font-bold ${(m.error_rate || 0) < 5 ? 'text-neonGreen' : (m.error_rate || 0) < 15 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                {(m.error_rate || 0).toFixed(1)}%
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {(!modelPerf || modelPerf.length === 0) && (
                            <p className="text-center text-zinc-600 font-mono text-sm uppercase tracking-widest py-10">No model performance data available yet.</p>
                        )}
                    </div>
                </div>
            )}

            {/* Model Win Rates */}
            {view === 'winrates' && !focusMode && (
                <div className="glass-panel p-6 border-neonPink/20">
                    <h3 className="text-xs font-black text-neonPink mb-6 uppercase tracking-widest flex items-center gap-2">
                        <Trophy className="w-4 h-4" /> Model Win Rates by Task
                    </h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-[#333]">
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Tool</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Model</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500">Task Type</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Win Rate</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Avg Turns</th>
                                    <th className="py-3 px-4 text-[10px] font-black uppercase tracking-widest text-zinc-500 text-right">Sessions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(winRates || []).map((w: any, i: number) => (
                                    <tr key={i} className="border-b border-[#222] hover:bg-[#111] transition-colors">
                                        <td className="py-3 px-4">
                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border border-[#333]"
                                                style={{ color: TOOL_COLORS[w.tool_id] || '#aaa' }}>{w.tool_id}</span>
                                        </td>
                                        <td className="py-3 px-4 text-sm font-mono text-white truncate max-w-[160px]">{w.model}</td>
                                        <td className="py-3 px-4 text-sm text-zinc-400">{w.task_type || 'general'}</td>
                                        <td className="py-3 px-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <div className="w-20 h-2 bg-[#111] rounded-full overflow-hidden">
                                                    <div className="h-full rounded-full transition-all"
                                                        style={{ width: `${w.win_rate || 0}%`, background: (w.win_rate || 0) > 70 ? '#39ff14' : (w.win_rate || 0) > 40 ? '#ff5500' : '#ff0055' }} />
                                                </div>
                                                <span className="text-sm font-black text-white w-10">{(w.win_rate || 0).toFixed(0)}%</span>
                                            </div>
                                        </td>
                                        <td className="py-3 px-4 text-right text-sm text-zinc-400">{(w.avg_turns || 0).toFixed(1)}</td>
                                        <td className="py-3 px-4 text-right text-sm font-bold text-zinc-300">{w.sessions || 0}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {(!winRates || winRates.length === 0) && (
                            <p className="text-center text-zinc-600 font-mono text-sm uppercase tracking-widest py-10">No win rate data available. Requires multiple models in use.</p>
                        )}
                    </div>
                </div>
            )}

            {/* Routing Recommendation */}
            {view === 'routing' && !focusMode && (
                <div className="space-y-6">
                    <div className="glass-panel p-6 border-brand/20 bg-gradient-to-br from-[#0a0a0a] to-[#050505]">
                        <h3 className="text-xs font-black text-brand mb-4 uppercase tracking-widest flex items-center gap-2">
                            <Navigation className="w-4 h-4" /> Intelligent Model Routing
                        </h3>
                        <p className="text-sm text-zinc-400 mb-6">Based on your historical data, these are the best model choices per task type and tool.</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {(routing?.recommendations || []).map((r: any, i: number) => (
                                <div key={i} className="bg-[#050505] rounded-xl p-5 border border-[#222] hover:border-brand/40 transition-colors group">
                                    <div className="flex items-center justify-between mb-3">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">{r.task_type || 'General'}</span>
                                        <span className="px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest border border-[#333]"
                                            style={{ color: TOOL_COLORS[r.tool_id] || '#aaa' }}>{r.tool_id}</span>
                                    </div>
                                    <p className="text-lg font-black text-white mb-2 group-hover:text-brand transition-colors truncate">{r.recommended_model}</p>
                                    <div className="flex items-center justify-between text-[10px] text-zinc-500">
                                        <span>Win rate: <span className="text-neonGreen font-bold">{(r.win_rate || 0).toFixed(0)}%</span></span>
                                        <span>Quality: <span className="text-neonBlue font-bold">{(r.avg_quality || 0).toFixed(0)}</span></span>
                                    </div>
                                    {r.reason && <p className="text-[10px] text-zinc-600 mt-2 leading-relaxed">{r.reason}</p>}
                                </div>
                            ))}
                        </div>
                        {(!routing?.recommendations || routing.recommendations.length === 0) && (
                            <div className="text-center py-10">
                                <p className="text-zinc-600 font-mono text-sm uppercase tracking-widest">Not enough data for routing recommendations.</p>
                                <p className="text-zinc-700 text-xs mt-2">Use multiple tools and models to enable intelligent routing.</p>
                            </div>
                        )}
                    </div>

                    {/* Quick routing summary */}
                    {routing?.summary && (
                        <div className="grid grid-cols-3 gap-4">
                            <div className="glass-panel p-5 text-center border-neonGreen/20">
                                <p className="text-3xl font-black text-neonGreen">{routing.summary.models_tracked}</p>
                                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Models Tracked</p>
                            </div>
                            <div className="glass-panel p-5 text-center border-brand/20">
                                <p className="text-3xl font-black text-brand">{routing.summary.tools_tracked}</p>
                                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Tools Tracked</p>
                            </div>
                            <div className="glass-panel p-5 text-center border-neonBlue/20">
                                <p className="text-3xl font-black text-neonBlue">{routing.summary.total_sessions}</p>
                                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Sessions Analyzed</p>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
