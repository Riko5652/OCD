/** Central adapter registry. Each adapter file calls register() on load. */
const _adapters = new Map();

export function register(adapter) {
  if (!adapter.id || !adapter.name || typeof adapter.getSessions !== 'function') {
    throw new Error(`Adapter '${adapter.id || '?'}' missing required fields: id, name, getSessions`);
  }
  _adapters.set(adapter.id, adapter);
}

export function getAdapters() {
  return [..._adapters.values()];
}

export function getAdapter(id) {
  return _adapters.get(id);
}
