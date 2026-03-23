import { useState, useCallback, useEffect } from 'react';
import CommandCenter from './pages/CommandCenter';
import Performance from './pages/Performance';
import Workspaces from './pages/Workspaces';
import Profile from './pages/Profile';
import Insights from './pages/Insights';
import Onboarding from './components/Onboarding';
import CommandPalette from './components/CommandPalette';
import ImportModal from './components/ImportModal';
import ToastContainer, { toast } from './components/Toast';
import { useSSE, triggerRefresh } from './hooks/useApi';

import { Zap, Activity, FolderGit2, UserCog, Brain, Upload, Menu, X, WifiOff, Download, Sun, Moon, Crosshair, HelpCircle } from 'lucide-react';
import { createContext } from 'react';

export const FocusModeContext = createContext(false);
import { useTheme } from './hooks/useTheme';

type Page = 'command' | 'performance' | 'workspaces' | 'profile' | 'insights';

const NAV_ITEMS: { id: Page; label: string; shortLabel: string; icon: React.ReactNode }[] = [
    { id: 'command', label: 'Command Center', shortLabel: 'Command', icon: <Zap className="w-5 h-5" /> },
    { id: 'insights', label: 'Insights', shortLabel: 'Insights', icon: <Brain className="w-5 h-5" /> },
    { id: 'performance', label: 'Performance', shortLabel: 'Perf', icon: <Activity className="w-5 h-5" /> },
    { id: 'workspaces', label: 'Workspaces', shortLabel: 'Work', icon: <FolderGit2 className="w-5 h-5" /> },
    { id: 'profile', label: 'Profile', shortLabel: 'Profile', icon: <UserCog className="w-5 h-5" /> },
];

export default function App() {
    const [page, setPage] = useState<Page>('command');
    const [refreshing, setRefreshing] = useState(false);
    const [lastRefresh, setLastRefresh] = useState<number | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
    const [offline, setOffline] = useState(!navigator.onLine);
    const [installPrompt, setInstallPrompt] = useState<any>(null);
    const [focusMode, setFocusMode] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('ocd-onboarded'));
    const { theme, toggle: toggleTheme } = useTheme();

    // Online/offline detection
    useEffect(() => {
        const on = () => setOffline(false);
        const off = () => { setOffline(true); toast({ message: 'You are offline — showing cached data', severity: 'warning' }); };
        window.addEventListener('online', on);
        window.addEventListener('offline', off);
        return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
    }, []);

    // PWA install prompt
    useEffect(() => {
        const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e); };
        window.addEventListener('beforeinstallprompt', handler);
        return () => window.removeEventListener('beforeinstallprompt', handler);
    }, []);

    const handleInstall = async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice;
        setInstallPrompt(null);
    };

    // SSE for live updates + coach nudges
    const handleSSE = useCallback((event: string, data: any) => {
        setLastRefresh(Date.now());
        if (event === 'coach' && data?.nudges) {
            for (const nudge of data.nudges) {
                toast({ message: nudge.message, severity: nudge.severity || 'tip', tool: nudge.tool });
            }
        }
    }, []);
    useSSE(handleSSE);

    // Version check on mount
    useEffect(() => {
        fetch('/api/version-check').then(r => r.json()).then(d => {
            if (d.updateAvailable && d.latest) setUpdateAvailable(d.latest);
        }).catch(() => {});
    }, []);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await triggerRefresh();
            toast({ message: 'Data refreshed successfully', severity: 'success' });
        } catch {
            toast({ message: 'Refresh failed', severity: 'error' });
        } finally {
            setRefreshing(false);
        }
    };

    const navigate = (p: string) => { setPage(p as Page); setMobileNavOpen(false); };

    return (
        <FocusModeContext.Provider value={focusMode}>
        <div className="min-h-screen flex bg-background">
            {/* Command Palette (Cmd+K) */}
            <CommandPalette onNavigate={navigate} onRefresh={handleRefresh} onOpenImport={() => setImportOpen(true)} />

            {/* Import Modal */}
            <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />

            {/* Toast Notifications */}
            <ToastContainer />

            {/* Offline Banner */}
            {offline && (
                <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-500/90 text-black text-center py-2 text-xs font-bold flex items-center justify-center gap-2">
                    <WifiOff className="w-3.5 h-3.5" /> Offline — showing cached data
                </div>
            )}

            {/* Version Update Banner */}
            {updateAvailable && !offline && (
                <div className="fixed top-0 left-0 right-0 z-40 bg-brand/90 text-white text-center py-2 text-xs font-bold">
                    Update available: v{updateAvailable} — <code className="bg-black/20 px-2 py-0.5 rounded">npm install -g ocd</code>
                    <button onClick={() => setUpdateAvailable(null)} className="ml-4 text-white/70 hover:text-white">dismiss</button>
                </div>
            )}

            {/* Mobile menu toggle */}
            <button onClick={() => setMobileNavOpen(!mobileNavOpen)}
                className="md:hidden fixed top-4 left-4 z-30 p-2 bg-surface border border-[#222] rounded-lg">
                {mobileNavOpen ? <X className="w-5 h-5 text-white" /> : <Menu className="w-5 h-5 text-white" />}
            </button>

            {/* Sidebar */}
            <aside className={`w-64 bg-[#050505] border-r border-[#1a1a1a] flex flex-col shrink-0 fixed h-full z-20 glass-panel !rounded-none !border-y-0 !border-l-0 transition-transform duration-300 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
                <div className="p-6 border-b border-[#1a1a1a] flex items-start justify-between">
                    <div>
                        <h1 className="text-4xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-brand to-neonPink drop-shadow-glow-brand">
                            OCD
                        </h1>
                        <p className="text-[10px] text-neonBlue font-mono mt-1 uppercase tracking-widest neon-text-blue">v5.4.0</p>
                    </div>
                    <div className="flex gap-1.5">
                        <button onClick={() => setFocusMode(!focusMode)} className={`p-2 rounded-lg border transition-colors ${focusMode ? 'bg-brand/20 border-brand/50 shadow-neon-brand' : 'bg-[#111] border-[#222] hover:border-brand/50'}`} title={focusMode ? 'Exit Focus Mode' : 'Enter Focus Mode — show only key metrics'}>
                            <Crosshair className={`w-4 h-4 ${focusMode ? 'text-brand' : 'text-zinc-500'}`} />
                        </button>
                        <button onClick={toggleTheme} className="p-2 rounded-lg bg-[#111] border border-[#222] hover:border-brand/50 transition-colors" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
                            {theme === 'dark' ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4 text-neonBlue" />}
                        </button>
                    </div>
                </div>
                <nav className="flex-1 p-3 space-y-2 mt-2 overflow-y-auto">
                    {NAV_ITEMS.map(item => (
                        <button
                            key={item.id}
                            onClick={() => navigate(item.id)}
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
                <div className="p-4 border-t border-[#1a1a1a] space-y-2">
                    <div className="flex gap-2">
                        <button
                            onClick={() => setImportOpen(true)}
                            className="flex-1 py-2 px-4 rounded-xl text-xs font-bold uppercase tracking-wider bg-neonBlue/10 text-neonBlue border border-neonBlue/30 hover:bg-neonBlue/20 hover:shadow-neon-blue transition-all flex items-center justify-center gap-2"
                        >
                            <Upload className="w-3.5 h-3.5" /> Import
                        </button>
                        <button
                            onClick={() => { localStorage.removeItem('ocd-onboarded'); setShowOnboarding(true); }}
                            className="py-2 px-3 rounded-xl text-xs font-bold bg-[#111] text-zinc-500 border border-[#222] hover:border-brand/50 hover:text-brand transition-all"
                            title="Show setup guide"
                        >
                            <HelpCircle className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <button
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="w-full py-2.5 px-4 rounded-xl text-xs font-black uppercase tracking-wider bg-brand/10 text-brand border border-brand/50 hover:bg-brand/20 hover:shadow-neon-brand hover:border-brand transition-all disabled:opacity-50"
                    >
                        {refreshing ? '⟳ Syncing...' : '↻ Refresh Data'}
                    </button>
                    {lastRefresh && (
                        <p className="text-[10px] text-slate-600 text-center">
                            Last sync: {new Date(lastRefresh).toLocaleTimeString()}
                        </p>
                    )}
                    {installPrompt && (
                        <button onClick={handleInstall}
                            className="w-full py-2 px-4 rounded-xl text-xs font-bold uppercase tracking-wider bg-neonGreen/10 text-neonGreen border border-neonGreen/30 hover:bg-neonGreen/20 hover:shadow-neon-green transition-all flex items-center justify-center gap-2">
                            <Download className="w-3.5 h-3.5" /> Install App
                        </button>
                    )}
                    <p className="text-[9px] text-zinc-700 text-center mt-1">
                        <kbd className="px-1.5 py-0.5 bg-[#111] border border-[#333] rounded text-[9px] font-mono">⌘K</kbd> command palette
                    </p>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 md:ml-64 p-4 md:p-8 overflow-y-auto min-h-screen">
                {showOnboarding ? (
                    <Onboarding onDismiss={() => { localStorage.setItem('ocd-onboarded', '1'); setShowOnboarding(false); }} />
                ) : (
                    <>
                        {page === 'command' && <CommandCenter />}
                        {page === 'insights' && <Insights />}
                        {page === 'performance' && <Performance />}
                        {page === 'workspaces' && <Workspaces />}
                        {page === 'profile' && <Profile />}
                    </>
                )}
            </main>

            {/* Mobile bottom nav */}
            <nav className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-[#050505] border-t border-[#1a1a1a] flex">
                {NAV_ITEMS.map(item => (
                    <button key={item.id} onClick={() => navigate(item.id)}
                        className={`flex-1 py-3 flex flex-col items-center gap-1 text-[9px] font-bold uppercase tracking-widest transition-colors ${page === item.id ? 'text-brand' : 'text-zinc-600'}`}>
                        {item.icon}
                        <span>{item.shortLabel}</span>
                    </button>
                ))}
            </nav>
        </div>
        </FocusModeContext.Provider>
    );
}
