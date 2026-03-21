import { useState, useEffect, useContext } from 'react';
import { useApi } from '../hooks/useApi';
import { FocusModeContext } from '../App';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from 'recharts';
import { Target, FileText, Zap, Trophy, Coins, TrendingUp, BarChart2, Sparkles, Loader2, ChevronDown, ChevronRight } from 'lucide-react';

function KpiCard({ label, value, sub, color = 'brand', icon }: { label: string; value: string | number; sub?: string; color?: string; icon?: React.ReactNode }) {
    const borderColor = color === 'brand' ? 'hover:border-brand/50 hover:shadow-neon-brand' : color === 'purple' ? 'hover:border-neonPink/50 hover:shadow-neon-pink' : color === 'emerald' ? 'hover:border-neonGreen/50 hover:shadow-neon-green' : 'hover:border-neonPink/50 hover:shadow-neon-pink';
    const textColor = color === 'brand' ? 'group-hover:text-brand neon-text-brand' : color === 'purple' ? 'group-hover:text-neonPink neon-text-pink' : color === 'emerald' ? 'group-hover:text-neonGreen neon-text-green' : 'group-hover:text-neonPink neon-text-pink';
    return (
        <div className={`glass-panel p-6 border-[#222] ${borderColor} transition-all duration-300 group hover:-translate-y-1`}>
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-zinc-500 text-[10px] font-black uppercase tracking-widest">{label}</h3>
                {icon && <span className="text-2xl filter drop-shadow opacity-70 group-hover:opacity-100 group-hover:scale-110 transition-all">{icon}</span>}
            </div>
            <p className={`text-4xl font-black text-white ${textColor} transition-colors`}>{value}</p>
            {sub && <p className="mt-3 text-[10px] text-zinc-500 font-bold uppercase tracking-wider">{sub}</p>}
        </div>
    );
}

function SavingsWidget({ data }: { data: any }) {
    if (!data) return null;
    return (
        <div>
            <div className="grid grid-cols-3 gap-6">
                <div className="bg-[#050505] p-4 rounded-xl border border-[#222]">
                    <p className="text-3xl font-black text-neonGreen drop-shadow-glow-green">${data.dollars?.total_estimated_cost || 0}</p>
                    <p className="text-[10px] text-zinc-500 mt-2 font-bold uppercase tracking-widest">Total Cost</p>
                </div>
                <div className="bg-[#050505] p-4 rounded-xl border border-brand/30">
                    <p className="text-3xl font-black text-brand drop-shadow-glow-brand">${data.dollars?.cache_savings_dollars || 0}</p>
                    <p className="text-[10px] text-zinc-500 mt-2 font-bold uppercase tracking-widest">Cache Savings</p>
                </div>
                <div className="bg-[#050505] p-4 rounded-xl border border-neonPink/30">
                    <p className="text-3xl font-black text-neonPink drop-shadow-glow-pink">{data.time?.estimated_hours_saved || 0}h</p>
                    <p className="text-[10px] text-zinc-500 mt-2 font-bold uppercase tracking-widest">Hours Saved</p>
                </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
                <span className="px-3 py-1.5 rounded bg-neonGreen/10 text-neonGreen border border-neonGreen/30 text-[10px] font-black uppercase tracking-widest shadow-neon-green">
                    {data.relative?.cache_savings_pct || 0}% cache hit savings
                </span>
                <span className="px-3 py-1.5 rounded bg-brand/10 text-brand border border-brand/30 text-[10px] font-black uppercase tracking-widest shadow-neon-brand">
                    {data.relative?.error_recovery_rate || 0}% error recovery
                </span>
            </div>
        </div>
    );
}

export default function CommandCenter() {
    const { data: overview } = useApi<any>('/api/overview');
    const { data: savings } = useApi<any>('/api/savings-report');
    const { data: health } = useApi<any>('/api/health');
    const { data: tokenBudget } = useApi<any>('/api/token-budget');

    const [insights, setInsights] = useState<string>('');
    const [loadingInsights, setLoadingInsights] = useState(false);
    const [showInsights, setShowInsights] = useState(false);
    const [showSavings, setShowSavings] = useState(false);
    const focusMode = useContext(FocusModeContext);

    useEffect(() => {
        setLoadingInsights(true);
        let text = '';
        const es = new EventSource('/api/insights/deep');

        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.token) {
                    text += data.token;
                    setInsights(text);
                }
                if (data.done || data.cached) {
                    if (data.cached) setInsights(data.token);
                    es.close();
                    setLoadingInsights(false);
                }
                if (data.error) {
                    es.close();
                    setLoadingInsights(false);
                    if (!text) setInsights('Failed to load CI/CD insights: ' + data.error);
                }
            } catch { }
        };
        es.onerror = () => {
            es.close();
            setLoadingInsights(false);
            if (!text) setInsights('Failed to connect to insights stream.');
        };
        return () => es.close();
    }, []);

    const g = overview?.global || {};
    const daily = overview?.daily || [];

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-extrabold text-white tracking-tight">Command Center</h2>
                    <p className="text-sm text-slate-400 mt-1">Cross-tool AI productivity overview</p>
                </div>
                <div className="flex items-center gap-2 bg-surface px-4 py-2 rounded-full border border-slate-700/50">
                    <div className={`w-2 h-2 rounded-full ${health?.status === 'ok' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
                    <span className="text-[10px] font-semibold text-slate-300 uppercase tracking-widest">
                        {health?.status === 'ok' ? 'Live' : 'Offline'} · v{health?.version || '?'}
                    </span>
                </div>
            </div>

            {/* KPI Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard label="Total Sessions" value={fmt(g.total_sessions)} icon={<Target className="text-brand w-6 h-6" />} color="brand" sub={`${overview?.tools?.length || 0} tools active`} />
                <KpiCard label="Output Tokens" value={fmtTokens(g.total_output)} icon={<FileText className="text-neonPink w-6 h-6" />} color="purple" sub={`${fmtTokens(g.total_input)} input`} />
                <KpiCard label="Cache Hit Rate" value={`${(g.avg_cache_hit || 0).toFixed(1)}%`} icon={<Zap className="text-neonGreen w-6 h-6" />} color="emerald" sub={`${fmtTokens(g.total_cache)} cached tokens`} />
                <KpiCard label="Avg Quality" value={(g.avg_quality || 0).toFixed(0)} icon={<Trophy className="text-neonPink w-6 h-6" />} color="pink" sub={`${fmtTokens(g.total_lines_added)} lines generated`} />
            </div>

            {/* Token Budget & Quick Wins — always visible (universal value) */}
            {tokenBudget && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Token Burn Rate */}
                    <div className="glass-panel p-6 border-neonPink/20">
                        <h3 className="text-xs font-black text-neonPink mb-4 uppercase tracking-widest">Token Burn Rate</h3>
                        <div className="grid grid-cols-3 gap-4 mb-4">
                            <div className="bg-[#050505] p-3 rounded-xl border border-[#222] text-center">
                                <p className="text-2xl font-black text-white">{fmtTokens(tokenBudget.today.input_tokens + tokenBudget.today.output_tokens)}</p>
                                <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Today</p>
                            </div>
                            <div className="bg-[#050505] p-3 rounded-xl border border-[#222] text-center">
                                <p className="text-2xl font-black text-zinc-300">{fmtTokens(tokenBudget.daily_avg.input_tokens + tokenBudget.daily_avg.output_tokens)}</p>
                                <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Daily Avg</p>
                            </div>
                            <div className="bg-[#050505] p-3 rounded-xl border border-neonPink/20 text-center">
                                <p className="text-2xl font-black text-neonPink">${tokenBudget.weekly_forecast.cost}</p>
                                <p className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Week Forecast</p>
                            </div>
                        </div>
                        {tokenBudget.efficiency_by_tool?.length > 0 && (
                            <div className="space-y-2">
                                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Tokens per Quality Point (lower = more efficient)</p>
                                {tokenBudget.efficiency_by_tool.map((t: any) => (
                                    <div key={t.tool} className="flex items-center gap-2 text-xs">
                                        <span className="text-zinc-400 w-24 truncate font-bold">{t.tool}</span>
                                        <div className="flex-1 h-4 bg-[#111] rounded overflow-hidden border border-[#222]">
                                            <div className="h-full bg-gradient-to-r from-neonGreen/40 to-neonGreen rounded transition-all"
                                                style={{ width: `${Math.min(100, Math.max(5, 100 - (t.tokens_per_quality_point / 200)))}%` }}>
                                            </div>
                                        </div>
                                        <span className="text-zinc-500 w-14 text-right font-mono text-[10px]">{t.tokens_per_quality_point}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Quick Wins */}
                    <div className="glass-panel p-6 border-neonGreen/20">
                        <h3 className="text-xs font-black text-neonGreen mb-4 uppercase tracking-widest">Quick Wins — Save Tokens Now</h3>
                        {tokenBudget.quick_wins?.length > 0 ? (
                            <div className="space-y-4">
                                {tokenBudget.quick_wins.map((w: any, i: number) => (
                                    <div key={i} className="p-4 bg-[#050505] rounded-xl border border-[#222]">
                                        <p className="text-sm font-bold text-white">{w.tip}</p>
                                        <p className="text-[10px] text-neonGreen mt-2">{w.impact}</p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-6">
                                <p className="text-sm text-zinc-500">No quick wins detected — your token usage looks efficient!</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {focusMode && (
                <div className="glass-panel p-4 border-brand/20 bg-brand/5 text-center">
                    <p className="text-[10px] text-brand font-black uppercase tracking-widest">Focus Mode — showing key metrics only</p>
                </div>
            )}

            {!focusMode && <>
            {/* CI/CD Optimization Insights — Collapsible */}
            <div className="glass-panel border-neonBlue/30 bg-gradient-to-r from-[#050505] to-[#0a0a0a]">
                <button onClick={() => setShowInsights(!showInsights)} className="w-full p-6 flex items-center justify-between group">
                    <h3 className="text-xs font-black text-neonBlue uppercase tracking-widest flex items-center gap-2 drop-shadow-glow-blue">
                        <Sparkles className="w-4 h-4" /> CI/CD Workflow Optimization
                        {loadingInsights && <Loader2 className="w-3 h-3 animate-spin ml-2 text-neonBlue/70" />}
                    </h3>
                    {showInsights ? <ChevronDown className="w-4 h-4 text-zinc-500 group-hover:text-white transition-colors" /> : <ChevronRight className="w-4 h-4 text-zinc-500 group-hover:text-white transition-colors" />}
                </button>
                {showInsights && (
                    <div className="px-6 pb-6">
                        <div className="bg-[#111] p-5 rounded-lg border border-neonBlue/20">
                            <pre className="text-sm text-zinc-300 font-sans leading-relaxed whitespace-pre-wrap break-words">
                                {insights || 'Analyzing your recent sessions to generate personalized workflow improvements...'}
                            </pre>
                        </div>
                    </div>
                )}
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Daily Activity */}
                <div className="glass-panel p-6">
                    <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><TrendingUp className="w-4 h-4 text-brand" /> Daily Activity (30d)</h3>
                    <ResponsiveContainer width="100%" height={220}>
                        <AreaChart data={daily}>
                            <defs>
                                <linearGradient id="gradSessions" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#ff5500" stopOpacity={0.6} />
                                    <stop offset="100%" stopColor="#ff5500" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#666', fontWeight: 700 }} tickFormatter={d => d?.slice(5)} />
                            <YAxis tick={{ fontSize: 10, fill: '#666', fontWeight: 700 }} />
                            <Tooltip contentStyle={{ background: '#0a0a0a', border: '1px solid #ff5500', borderRadius: 8, fontSize: 12, boxShadow: '0 0 10px rgba(255,85,0,0.5)' }} itemStyle={{ color: '#fff', fontWeight: 700 }} />
                            <Area type="monotone" dataKey="sessions" stroke="#ff5500" fill="url(#gradSessions)" strokeWidth={3} style={{ filter: 'drop-shadow(0 0 4px #ff5500)' }} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>

                {/* Tool Breakdown */}
                <div className="glass-panel p-6">
                    <h3 className="text-xs font-black text-zinc-400 mb-6 uppercase tracking-widest flex items-center gap-2"><BarChart2 className="w-4 h-4 text-neonBlue" /> Sessions by Tool</h3>
                    <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={overview?.tools || []} layout="vertical">
                            <CartesianGrid strokeDasharray="3 3" stroke="#222" horizontal={false} />
                            <XAxis type="number" tick={{ fontSize: 10, fill: '#666', fontWeight: 700 }} />
                            <YAxis dataKey="tool_id" type="category" tick={{ fontSize: 10, fill: '#aaa', fontWeight: 700 }} width={90} />
                            <Tooltip contentStyle={{ background: '#0a0a0a', border: '1px solid #00f3ff', borderRadius: 8, fontSize: 12, boxShadow: '0 0 10px rgba(0,243,255,0.5)' }} itemStyle={{ color: '#fff', fontWeight: 700 }} />
                            <Bar dataKey="sessions" fill="#00f3ff" radius={[0, 4, 4, 0]} style={{ filter: 'drop-shadow(0 0 5px #00f3ff)' }} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* Savings — Collapsible */}
            <div className="glass-panel border-brand/30">
                <button onClick={() => setShowSavings(!showSavings)} className="w-full p-6 flex items-center justify-between group">
                    <h3 className="text-xs font-black text-brand uppercase tracking-widest flex items-center gap-2 drop-shadow-glow-brand">
                        <Coins className="w-4 h-4" /> Savings Report
                    </h3>
                    {showSavings ? <ChevronDown className="w-4 h-4 text-zinc-500 group-hover:text-white transition-colors" /> : <ChevronRight className="w-4 h-4 text-zinc-500 group-hover:text-white transition-colors" />}
                </button>
                {showSavings && (
                    <div className="px-6 pb-6">
                        <SavingsWidget data={savings} />
                    </div>
                )}
            </div>
            </>}
        </div>
    );
}

function fmt(n: number | undefined): string {
    if (n == null) return '0';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function fmtTokens(n: number | undefined): string {
    if (n == null) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1000).toFixed(0)}K`;
    return String(n);
}
