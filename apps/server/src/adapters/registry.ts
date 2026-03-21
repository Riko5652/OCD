import { IAiAdapter, ToolId } from './types.js';

class AdapterRegistry {
    private adapters = new Map<ToolId, IAiAdapter>();

    register(adapter: IAiAdapter): void {
        if (!adapter.id || !adapter.name || typeof adapter.getSessions !== 'function') {
            throw new Error(`Adapter '${adapter.id || '?'}' missing required field.`);
        }
        this.adapters.set(adapter.id, adapter);
    }

    getAdapters(): IAiAdapter[] {
        return Array.from(this.adapters.values());
    }

    getAdapter(id: ToolId): IAiAdapter | undefined {
        return this.adapters.get(id);
    }
}

export const registry = new AdapterRegistry();
