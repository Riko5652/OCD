import { useState } from 'react';
import { X, Upload, FileJson, Globe, Loader2 } from 'lucide-react';
import { importSessions } from '../hooks/useApi';
import { toast } from './Toast';

interface Props {
    open: boolean;
    onClose: () => void;
}

const SAMPLE = `{
  "tool": "chatgpt",
  "title": "Debug API auth flow",
  "model": "gpt-4o",
  "turns": [
    { "role": "user", "content": "Why is my JWT token being rejected?" },
    { "role": "assistant", "content": "Check the token expiration..." }
  ]
}`;

export default function ImportModal({ open, onClose }: Props) {
    const [text, setText] = useState('');
    const [loading, setLoading] = useState(false);
    const [tab, setTab] = useState<'paste' | 'bookmarklet'>('paste');

    if (!open) return null;

    const handleImport = async () => {
        if (!text.trim()) return;
        setLoading(true);
        try {
            const data = JSON.parse(text);
            const result = await importSessions(data);
            if (result.ok) {
                toast({ message: `Imported ${result.imported?.length || result.imported || 1} session(s)`, severity: 'success' });
                setText('');
                onClose();
            } else {
                toast({ message: result.error || 'Import failed', severity: 'error' });
            }
        } catch (e: any) {
            toast({ message: `Invalid JSON: ${e.message}`, severity: 'error' });
        } finally {
            setLoading(false);
        }
    };

    const handleFileDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = () => setText(reader.result as string);
            reader.readAsText(file);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative w-full max-w-2xl glass-panel border-neonBlue/30 shadow-neon-blue overflow-hidden"
                onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-[#222]">
                    <h2 className="text-sm font-black text-neonBlue uppercase tracking-widest flex items-center gap-2">
                        <Upload className="w-4 h-4" /> Import Sessions
                    </h2>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-[#222]">
                    <button onClick={() => setTab('paste')}
                        className={`flex-1 px-4 py-3 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors ${tab === 'paste' ? 'text-neonBlue border-b-2 border-neonBlue bg-neonBlue/5' : 'text-zinc-500 hover:text-white'}`}>
                        <FileJson className="w-4 h-4" /> Paste / Upload JSON
                    </button>
                    <button onClick={() => setTab('bookmarklet')}
                        className={`flex-1 px-4 py-3 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors ${tab === 'bookmarklet' ? 'text-neonBlue border-b-2 border-neonBlue bg-neonBlue/5' : 'text-zinc-500 hover:text-white'}`}>
                        <Globe className="w-4 h-4" /> Browser Bookmarklet
                    </button>
                </div>

                {/* Content */}
                <div className="p-6">
                    {tab === 'paste' && (
                        <div className="space-y-4">
                            <div onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}
                                className="border-2 border-dashed border-[#333] hover:border-neonBlue/50 rounded-xl p-4 transition-colors">
                                <textarea
                                    value={text}
                                    onChange={e => setText(e.target.value)}
                                    placeholder="Paste JSON here or drag & drop a .json file..."
                                    className="w-full h-48 bg-transparent text-sm text-zinc-300 font-mono placeholder:text-zinc-600 resize-none outline-none"
                                />
                            </div>
                            <details className="text-xs text-zinc-500">
                                <summary className="cursor-pointer hover:text-zinc-300 font-bold uppercase tracking-widest">Example format</summary>
                                <pre className="mt-2 p-3 bg-[#050505] rounded-lg border border-[#222] text-zinc-400 overflow-x-auto">{SAMPLE}</pre>
                            </details>
                            <button onClick={handleImport} disabled={loading || !text.trim()}
                                className="w-full py-3 rounded-xl text-sm font-black uppercase tracking-widest bg-neonBlue/10 text-neonBlue border border-neonBlue/50 hover:bg-neonBlue/20 hover:shadow-neon-blue transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                                {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing...</> : <><Upload className="w-4 h-4" /> Import Sessions</>}
                            </button>
                        </div>
                    )}

                    {tab === 'bookmarklet' && (
                        <div className="space-y-4 text-sm text-zinc-300">
                            <p>Capture conversations from ChatGPT, Claude.ai, or Google Gemini with one click.</p>
                            <div className="p-4 bg-[#050505] rounded-xl border border-[#222] text-center">
                                <p className="text-xs text-zinc-500 mb-3 uppercase tracking-widest font-bold">Drag this to your bookmarks bar:</p>
                                <a href={`javascript:void(fetch('/api/bookmarklet').then(r=>r.text()))`}
                                    className="inline-block px-6 py-3 bg-brand/20 text-brand border border-brand/50 rounded-xl font-black text-sm uppercase tracking-widest hover:shadow-neon-brand transition-all">
                                    Capture AI Session
                                </a>
                            </div>
                            <p className="text-xs text-zinc-500">
                                Or visit <a href="/api/bookmarklet" target="_blank" className="text-neonBlue hover:underline">/api/bookmarklet</a> for detailed setup instructions.
                            </p>
                            <div className="text-xs text-zinc-500">
                                <p className="font-bold uppercase tracking-widest mb-1">Supported platforms:</p>
                                <ul className="list-disc list-inside space-y-1">
                                    <li>ChatGPT (chat.openai.com / chatgpt.com)</li>
                                    <li>Claude.ai</li>
                                    <li>Google Gemini</li>
                                </ul>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
