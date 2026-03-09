// Service Worker — lightweight offline shell, network-first for everything
const CACHE_NAME = 'ai-prod-v3';
const SHELL_URLS = ['/', '/app.js', '/lib/chart.umd.min.js', '/css/style.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept SSE or API calls — let them go straight to network
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: network-first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Offline API cache (5-minute TTL) ─────────────────────────────────────────
const API_CACHE = 'api-cache-v1';
const API_CACHE_URLS = [
  '/api/overview',
  '/api/recommendations',
  '/api/insights/profile',
  '/api/personal-insights',
];
const API_TTL_MS = 5 * 60 * 1000; // 5 minutes

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only cache GET requests to our API
  if (event.request.method !== 'GET') return;
  if (!API_CACHE_URLS.some(p => url.pathname === p)) return;

  event.respondWith(
    caches.open(API_CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) {
        const cachedDate = new Date(cached.headers.get('sw-cached-at') || 0);
        if (Date.now() - cachedDate.getTime() < API_TTL_MS) {
          return cached;
        }
      }
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          // Clone response and add cache timestamp header
          const headers = new Headers(response.headers);
          headers.set('sw-cached-at', new Date().toISOString());
          const cachedResponse = new Response(await response.clone().arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
          cache.put(event.request, cachedResponse);
        }
        return response;
      } catch {
        // Offline — return cached version if available (even if stale)
        return cached || new Response(JSON.stringify({ offline: true, error: 'No network' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    })
  );
});
