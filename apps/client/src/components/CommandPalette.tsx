import { useState, useEffect, useRef } from 'react';
import { Search, Zap, Activity, FolderGit2, UserCog, RefreshCw, Upload, Brain, BarChart2, Settings } from 'lucide-react';

interface CommandItem {
    id: string;
    label: string;
    icon: React.ReactNode;
    action: () => void;
    keywords?: string;
}

interface Props {
    onNavigate: (page: string) => void;
    onRefresh: () => void;
    onOpenImport: () => void;
}

export default function CommandPalette({ onNavigate, onRefresh, onOpenImport }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const commands: CommandItem[] = [
        { id: 'nav-command', label: 'Go to Command Center', icon: <Zap className="w-4 h-4 text-brand" />, action: () => onNavigate('command'), keywords: 'dashboard home kpi' },
        { id: 'nav-perf', label: 'Go to Performance', icon: <Activity className="w-4 h-4 text-neonBlue" />, action: () => onNavigate('performance'), keywords: 'tools models costs' },
        { id: 'nav-work', label: 'Go to Workspaces', icon: <FolderGit2 className="w-4 h-4 text-neonGreen" />, action: () => onNavigate('workspaces'), keywords: 'projects sessions' },
        { id: 'nav-profile', label: 'Go to Profile', icon: <UserCog className="w-4 h-4 text-neonPink" />, action: () => onNavigate('profile'), keywords: 'xp level achievements' },
        { id: 'nav-insights', label: 'Go to Insights', icon: <Brain className="w-4 h-4 text-purple-400" />, action: () => onNavigate('insights'), keywords: 'trends daily pick analyze' },
        { id: 'refresh', label: 'Refresh Data', icon: <RefreshCw className="w-4 h-4 text-brand" />, action: onRefresh, keywords: 'sync reload ingest' },
        { id: 'import', label: 'Import Sessions', icon: <Upload className="w-4 h-4 text-neonBlue" />, action: onOpenImport, keywords: 'upload paste bookmarklet' },
        { id: 'nav-routing', label: 'View Routing Recommendations', icon: <BarChart2 className="w-4 h-4 text-brand" />, action: () => onNavigate('performance'), keywords: 'win rate best tool model' },
        { id: 'health', label: 'Run Health Check', icon: <Settings className="w-4 h-4 text-zinc-400" />, action: () => window.open('/api/health', '_blank'), keywords: 'doctor status version' },
    ];

    const filtered = query
        ? commands.filter(c => `${c.label} ${c.keywords || ''}`.toLowerCase().includes(query.toLowerCase()))
        : commands;

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setOpen(prev => !prev);
                setQuery('');
                setSelected(0);
            }
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    useEffect(() => { setSelected(0); }, [query]);

    const execute = (cmd: CommandItem) => {
        cmd.action();
        setOpen(false);
        setQuery('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
        if (e.key === 'Enter' && filtered[selected]) { execute(filtered[selected]); }
    };

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={() => setOpen(false)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative w-full max-w-lg glass-panel border-brand/30 shadow-neon-brand overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[#222]">
                    <Search className="w-5 h-5 text-brand" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a command..."
                        className="flex-1 bg-transparent text-white text-sm font-medium placeholder:text-zinc-500 outline-none"
                    />
                    <kbd className="px-2 py-0.5 bg-[#111] border border-[#333] rounded text-[10px] text-zinc-500 font-mono">ESC</kbd>
                </div>
                <div className="max-h-72 overflow-y-auto py-2">
                    {filtered.map((cmd, i) => (
                        <button key={cmd.id}
                            onClick={() => execute(cmd)}
                            onMouseEnter={() => setSelected(i)}
                            className={`w-full flex items-center gap-3 px-5 py-3 text-left text-sm transition-colors ${i === selected ? 'bg-brand/10 text-white' : 'text-zinc-400 hover:text-white'}`}>
                            {cmd.icon}
                            <span className="font-medium">{cmd.label}</span>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <p className="text-center text-zinc-600 py-8 text-sm">No matching commands</p>
                    )}
                </div>
            </div>
        </div>
    );
}
