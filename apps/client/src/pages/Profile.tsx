import { useApi } from '../hooks/useApi';
import { Target, Flame, Brain, Plug, Trophy, Calendar } from 'lucide-react';



function heatmapColor(sessions: number): string {
    if (sessions === 0) return 'bg-slate-800/50';
    if (sessions <= 2) return 'bg-brand/20';
    if (sessions <= 5) return 'bg-brand/40';
    if (sessions <= 10) return 'bg-brand/60';
    return 'bg-brand';
}

export default function Profile() {
    const { data } = useApi<any>('/api/personal-insights');

    if (!data) return <div className="flex items-center justify-center h-64 text-slate-500">Loading profile...</div>;

    const levelProgress = data.xp ? ((data.xp % 100) / 100) * 100 : 0;

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-extrabold text-white tracking-tight">Profile</h2>
                <p className="text-sm text-slate-400 mt-1">Your AI coding journey — gamification &amp; achievements</p>
            </div>

            {/* Hero Card */}
            <div className="glass-panel border-brand/30 shadow-neon-brand p-8 bg-gradient-to-br from-[#111] to-[#000]">
                <div className="flex items-start gap-8">
                    {/* Avatar & Level */}
                    <div className="text-center group">
                        <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-brand to-neonPink flex items-center justify-center text-5xl font-black text-white shadow-neon-brand transition-transform group-hover:scale-105 border-2 border-white/20">
                            {data.level || 1}
                        </div>
                        <p className="text-sm font-black text-brand uppercase tracking-widest mt-3 neon-text-brand">{data.rank || 'Novice'}</p>
                        <p className="text-[10px] text-zinc-400 uppercase tracking-widest">Level {data.level}</p>
                    </div>

                    {/* XP & Stats */}
                    <div className="flex-1 space-y-6">
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-black text-neonBlue uppercase tracking-widest drop-shadow-glow-blue">Experience Points</span>
                                <span className="text-sm text-brand font-mono font-black neon-text-brand">{data.xp?.toLocaleString()} XP</span>
                            </div>
                            <div className="h-4 bg-[#111] rounded-full overflow-hidden border border-white/10 shadow-inner">
                                <div className="h-full bg-gradient-to-r from-brand to-neonPink rounded-full transition-all duration-1000 ease-out relative shadow-neon-brand"
                                    style={{ width: `${levelProgress}%` }}>
                                    <div className="absolute top-0 right-0 bottom-0 w-4 bg-white/30 skew-x-12 blur-sm animate-pulse" />
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-4 gap-4">
                            <StatBox label="Sessions" value={data.totalSessions} icon={<Target className="w-6 h-6 text-neonBlue" />} />
                            <StatBox label="Streak" value={`${data.streak}d`} icon={<Flame className="w-6 h-6 text-brand" />} />
                            <StatBox label="Flow/Zen" value={data.flowCount} icon={<Brain className="w-6 h-6 text-neonPink" />} />
                            <StatBox label="Adapters" value={data.toolsUsed} icon={<Plug className="w-6 h-6 text-neonGreen" />} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-4">
                <div className="glass-panel p-6 text-center border-neonBlue/30 hover:shadow-neon-blue transition-all">
                    <p className="text-4xl font-black text-neonBlue drop-shadow-glow-blue">{((data.totalOutputTokens || 0) / 1_000_000).toFixed(1)}M</p>
                    <p className="text-xs text-zinc-400 mt-2 font-bold uppercase tracking-widest">Output Tokens</p>
                </div>
                <div className="glass-panel p-6 text-center border-neonGreen/30 hover:shadow-neon-green transition-all">
                    <p className="text-4xl font-black text-neonGreen drop-shadow-glow-green">{((data.totalLinesAdded || 0) / 1000).toFixed(1)}K</p>
                    <p className="text-xs text-zinc-400 mt-2 font-bold uppercase tracking-widest">Lines Written</p>
                </div>
                <div className="glass-panel p-6 text-center border-neonPink/30 hover:border-brand/30 hover:shadow-neon-brand transition-all">
                    <p className="text-4xl font-black text-white drop-shadow-glow-brand">{data.achievements?.unlocked?.length || 0} <span className="text-xl text-zinc-500">/ {data.achievements?.total || 0}</span></p>
                    <p className="text-xs text-zinc-400 mt-2 font-bold uppercase tracking-widest">Achievements</p>
                </div>
            </div>

            {/* Achievements */}
            <div className="glass-panel p-6">
                <h3 className="text-sm font-black text-neonBlue mb-6 uppercase tracking-widest drop-shadow-glow-blue flex items-center gap-2">
                    <Trophy className="w-4 h-4" /> Achievement Badges
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    {(data.achievements?.unlocked || []).map((a: any) => (
                        <div key={a.id} className="glass-panel p-5 text-center hover:-translate-y-1 hover:shadow-neon-brand hover:border-brand/50 transition-all group cursor-default">
                            <span className="text-4xl filter drop-shadow-md group-hover:scale-110 transition-transform inline-block">{a.icon}</span>
                            <p className="text-sm font-black text-white mt-3 leading-tight">{a.title}</p>
                            <p className="text-[10px] text-brand font-bold mt-1 uppercase tracking-wider">{a.desc}</p>
                        </div>
                    ))}
                    {(!data.achievements?.unlocked || data.achievements.unlocked.length === 0) && (
                        <p className="text-zinc-600 col-span-full text-center py-8 font-mono text-sm uppercase tracking-widest">Keep coding to unlock achievements!</p>
                    )}
                </div>
            </div>

            {/* Activity Heatmap */}
            <div className="glass-panel p-6">
                <h3 className="text-sm font-black text-brand mb-6 uppercase tracking-widest drop-shadow-glow-brand flex items-center gap-2">
                    <Calendar className="w-4 h-4" /> Activity Heatmap
                </h3>
                <div className="flex gap-[3px] flex-wrap justify-center">
                    {buildHeatmapData(data.heatmap || []).map((d, i) => (
                        <div key={i} className={`w-3.5 h-3.5 rounded-[2px] ${heatmapColor(d.sessions)} transition-colors hover:scale-125 cursor-crosshair`}
                            title={`${d.date}: ${d.sessions} sessions`} />
                    ))}
                </div>
                <div className="flex items-center justify-end gap-2 mt-4 text-[10px] text-zinc-500 font-bold uppercase tracking-widest">
                    <span>Less</span>
                    <div className="w-3.5 h-3.5 rounded-[2px] bg-[#111]" />
                    <div className="w-3.5 h-3.5 rounded-[2px] bg-brand/20" />
                    <div className="w-3.5 h-3.5 rounded-[2px] bg-brand/40" />
                    <div className="w-3.5 h-3.5 rounded-[2px] bg-brand/70" />
                    <div className="w-3.5 h-3.5 rounded-[2px] bg-brand shadow-neon-brand" />
                    <span>More</span>
                </div>
            </div>
        </div>
    );
}

function StatBox({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
    return (
        <div className="glass-panel p-3 text-center bg-[#050505] flex flex-col items-center">
            <span className="drop-shadow-md mb-2">{icon}</span>
            <p className="text-2xl font-black text-white">{value}</p>
            <p className="text-[9px] font-black text-brand uppercase tracking-widest mt-1 neon-text-brand">{label}</p>
        </div>
    );
}

function buildHeatmapData(heatmap: any[]): { date: string; sessions: number }[] {
    const map = new Map<string, number>();
    for (const h of heatmap) map.set(h.date, h.sessions);

    const days: { date: string; sessions: number }[] = [];
    const now = new Date();
    for (let i = 364; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        days.push({ date: ds, sessions: map.get(ds) || 0 });
    }
    return days;
}
