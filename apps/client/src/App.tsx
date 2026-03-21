import { useState, useCallback } from 'react';
import CommandCenter from './pages/CommandCenter';
import Performance from './pages/Performance';
import Workspaces from './pages/Workspaces';
import Profile from './pages/Profile';
import { useSSE, triggerRefresh } from './hooks/useApi';

import { Zap, Activity, FolderGit2, UserCog } from 'lucide-react';

type Page = 'command' | 'performance' | 'workspaces' | 'profile';

const NAV_ITEMS: { id: Page; label: string; icon: React.ReactNode }[] = [
    { id: 'command', label: 'Command Center', icon: <Zap className="w-5 h-5" /> },
    { id: 'performance', label: 'Performance', icon: <Activity className="w-5 h-5" /> },
    { id: 'workspaces', label: 'Workspaces', icon: <FolderGit2 className="w-5 h-5" /> },
    { id: 'profile', label: 'Profile', icon: <UserCog className="w-5 h-5" /> },
];

export default function App() {
    const [page, setPage] = useState<Page>('command');
    const [refreshing, setRefreshing] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<number | null>(null);

    const handleSSE = useCallback((_event: string, _data: any) => {
        setLastRefresh(Date.now());
    }, []);
    useSSE(handleSSE);

    const handleRefresh = async () => {
        setRefreshing(true);
        try { await triggerRefresh(); } finally { setRefreshing(false); }
    };

    return (
        <div className="min-h-screen flex bg-background">
            {/* Sidebar */}
            <aside className="w-64 bg-[#050505] border-r border-[#1a1a1a] flex flex-col shrink-0 fixed h-full z-10 glass-panel !rounded-none !border-y-0 !border-l-0">
                <div className="p-6 border-b border-[#1a1a1a]">
                    <h1 className="text-4xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-brand to-neonPink drop-shadow-glow-brand">
                        AAT
                    </h1>
                    <p className="text-[10px] text-neonBlue font-mono mt-1 uppercase tracking-widest neon-text-blue">v5</p>
                </div>
                <nav className="flex-1 p-3 space-y-2 mt-2">
                    {NAV_ITEMS.map(item => (
                        <button
                            key={item.id}
                            onClick={() => setPage(item.id)}
                            className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all duration-300 flex items-center gap-3 group ${page === item.id
                                ? 'bg-brand/10 text-white border border-brand shadow-neon-brand neon-text-brand'
                                : 'text-slate-400 hover:text-white hover:bg-[#111] border border-transparent'
                                }`}
                        >
                            <span className={`text-lg transition-transform ${page === item.id ? 'scale-110' : 'group-hover:scale-110'}`}>{item.icon}</span>
                            <span>{item.label}</span>
                        </button>
                    ))}
                </nav>
                <div className="p-4 border-t border-[#1a1a1a]">
                    <button
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="w-full py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider bg-brand/10 text-brand border border-brand/50 hover:bg-brand/20 hover:shadow-neon-brand hover:border-brand transition-all disabled:opacity-50"
                    >
                        {refreshing ? '⟳ Syncing...' : '↻ Refresh Data'}
                    </button>
                    {lastRefresh && (
                        <p className="text-[10px] text-slate-600 text-center mt-2">
                            Last sync: {new Date(lastRefresh).toLocaleTimeString()}
                        </p>
                    )}
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 ml-64 p-8 overflow-y-auto">
                {page === 'command' && <CommandCenter />}
                {page === 'performance' && <Performance />}
                {page === 'workspaces' && <Workspaces />}
                {page === 'profile' && <Profile />}
            </main>
        </div>
    );
}
