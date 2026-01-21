/**
 * SBy Service Worker
 *
 * Caching strategy:
 * - /api/*       - Network-first (dynamic JSON data)
 * - /fragments/* - Network-first (dynamic HTML partials, user-specific)
 * - /c/*         - Network-first (page routes, returns app shell)
 * - Static assets - Cache-first with background update
 */

const CACHE_NAME = 'sby-v4';
const STATIC_ASSETS = [
  '/',
  '/css/main.css',
  '/js/sby.js',
  '/lib/htmx.min.js',
  '/lib/htmx-sse.js',
  '/manifest.json'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  // Take control immediately
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname;

  // Network-first for dynamic routes
  if (
    path.startsWith('/api/') ||
    path.startsWith('/fragments/') ||
    path.startsWith('/c/')
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for static assets
  event.respondWith(cacheFirst(event.request));
});

/**
 * Network-first strategy: try network, fall back to cache.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Nothing in cache, return offline error
    return new Response(
      JSON.stringify({ error: 'Offline' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * Cache-first strategy: return cached, update in background.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) {
    // Return cached immediately, but update cache in background
    updateCache(request);
    return cached;
  }

  // Not cached, fetch and cache
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Update cache in background (stale-while-revalidate).
 */
async function updateCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response);
    }
  } catch {
    // Network error, keep using cached version
  }
}
