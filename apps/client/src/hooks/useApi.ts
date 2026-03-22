import { useState, useEffect, useCallback } from 'react';

const BASE = '';

export function useApi<T>(endpoint: string, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refetch = useCallback(() => {
        setLoading(true);
        fetch(`${BASE}${endpoint}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(d => { setData(d); setError(null); })
            .catch(e => { setError(e.message); setData(null); })
            .finally(() => setLoading(false));
    }, [endpoint, ...deps]);

    useEffect(() => { refetch(); }, [refetch]);

    return { data, loading, error, refetch };
}

export function useSSE(onMessage: (event: string, data: any) => void) {
    useEffect(() => {
        const es = new EventSource('/api/live');
        es.onmessage = e => {
            try { onMessage('message', JSON.parse(e.data)); } catch { onMessage('message', e.data); }
        };
        es.addEventListener('refresh', e => {
            try { onMessage('refresh', JSON.parse((e as MessageEvent).data)); } catch { /* skip */ }
        });
        es.addEventListener('coach', e => {
            try { onMessage('coach', JSON.parse((e as MessageEvent).data)); } catch { /* skip */ }
        });
        return () => es.close();
    }, [onMessage]);
}

export async function triggerRefresh() {
    return fetch('/api/refresh', { method: 'POST' }).then(r => r.json());
}

export async function importSessions(data: any) {
    return fetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    }).then(r => r.json());
}
