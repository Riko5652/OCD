import { useState, useEffect, useCallback } from 'react';
import { X, AlertTriangle, CheckCircle, Info, Zap } from 'lucide-react';

export interface ToastMessage {
    id: string;
    message: string;
    severity: 'info' | 'tip' | 'warning' | 'success' | 'error';
    tool?: string;
    duration?: number;
}

let addToastFn: ((toast: Omit<ToastMessage, 'id'>) => void) | null = null;

export function toast(msg: Omit<ToastMessage, 'id'>) {
    addToastFn?.(msg);
}

const ICONS = {
    info: <Info className="w-4 h-4 text-neonBlue" />,
    tip: <Zap className="w-4 h-4 text-brand" />,
    warning: <AlertTriangle className="w-4 h-4 text-yellow-400" />,
    success: <CheckCircle className="w-4 h-4 text-neonGreen" />,
    error: <AlertTriangle className="w-4 h-4 text-red-400" />,
};

const BORDER_COLORS = {
    info: 'border-neonBlue/40',
    tip: 'border-brand/40',
    warning: 'border-yellow-400/40',
    success: 'border-neonGreen/40',
    error: 'border-red-400/40',
};

export default function ToastContainer() {
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

    const addToast = useCallback((t: Omit<ToastMessage, 'id'>) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setToasts(prev => [...prev.slice(-4), { ...t, id }]);
        setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), t.duration || 5000);
    }, []);

    useEffect(() => { addToastFn = addToast; return () => { addToastFn = null; }; }, [addToast]);

    const dismiss = (id: string) => setToasts(prev => prev.filter(x => x.id !== id));

    if (!toasts.length) return null;

    return (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm">
            {toasts.map(t => (
                <div key={t.id}
                    className={`glass-panel p-4 border ${BORDER_COLORS[t.severity]} animate-[slideIn_0.3s_ease-out] flex items-start gap-3 shadow-lg`}>
                    {ICONS[t.severity]}
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium leading-relaxed">{t.message}</p>
                        {t.tool && <p className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">{t.tool}</p>}
                    </div>
                    <button onClick={() => dismiss(t.id)} className="text-zinc-500 hover:text-white transition-colors">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}
        </div>
    );
}
