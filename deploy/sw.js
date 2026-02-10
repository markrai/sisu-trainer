// Service Worker for VO2 Max Coach PWA
// Cache name is derived from version.js (single source of truth)

const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/dist/main.js',
  '/dist/workoutData.js',
  '/dist/workoutLogic.js',
  '/dist/workoutStorage.js',
  '/dist/workoutSummary.js',
  '/dist/zoneCalculator.js',
  '/dist/profile.js',
  '/dist/voice.js',
  '/dist/uiControls.js',
  '/dist/sisuSync.js',
  '/dist/pwaInstall.js',
  '/dist/wakeLock.js',
  '/dist/version.js',
  '/data.json',
  '/manifest.json',
  '/heart.png',
  '/bike.png',
  '/elliptical.png',
  '/dumbbell.png',
  '/favicon.ico'
];

// Resolve cache name by fetching version.js and parsing APP_VERSION (single source of truth)
let _cacheNamePromise = null;
function getCacheName() {
  if (_cacheNamePromise) return _cacheNamePromise;
  _cacheNamePromise = self.fetch('/dist/version.js')
    .then((r) => r.text())
    .then((text) => {
      const m = text.match(/APP_VERSION\\s*=\\s*['\"]([^'\"]+)['\"]/);
      const version = (m && m[1]) ? m[1] : '0';
      return 'vo2-coach-' + version;
    })
    .catch(() => 'vo2-coach-unknown');
  return _cacheNamePromise;
}

// Install event - cache resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    getCacheName()
      .then((cacheName) => {
        console.log('Opened cache', cacheName);
        return caches.open(cacheName).then((cache) => {
          return Promise.allSettled(
            urlsToCache.map((url) => cache.add(url).catch((err) => console.warn('Cache miss:', url, err)))
          );
        });
      })
      .catch((error) => {
        console.error('Cache failed:', error);
      })
  );
  self.skipWaiting(); // Activate immediately
});

// Activate event - clean up old caches, then claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    getCacheName()
      .then((currentName) => {
        return caches.keys().then((cacheNames) => {
          return Promise.all(
            cacheNames.map((cacheName) => {
              if (cacheName !== currentName) {
                console.log('Deleting old cache:', cacheName);
                return caches.delete(cacheName);
              }
            })
          );
        });
      })
      .then(() => self.clients.claim())
  );
});

// Listen for skip waiting message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch event - network-first for HTML, cache-first for assets
self.addEventListener('fetch', (event) => {
  // IMPORTANT: do not interfere with cross-origin requests (e.g., SISU sync).
  // If we handle them here and the network request fails (TLS/mixed-content/etc),
  // our fallback Response(503) masks the real browser error and makes debugging impossible.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return; // Let the browser handle it normally.
  }

  // Network-first strategy for HTML documents to get updates immediately
  if (event.request.destination === 'document' || 
      event.request.url.endsWith('.html') ||
      event.request.url.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          getCacheName().then((cacheName) => {
            caches.open(cacheName).then((cache) => cache.put(event.request, responseClone));
          });
          return response;
        })
        .catch(() => {
          return getCacheName().then((cacheName) => {
            return caches.match(event.request).then((cachedResponse) => {
              if (!cachedResponse && event.request.destination === 'document') {
                return caches.match('/index.html');
              }
              return cachedResponse;
            });
          });
        })
    );
  } else {
    // Cache-first strategy for assets (CSS, JS, images, etc.)
    event.respondWith(
      getCacheName().then((cacheName) => {
        return caches.match(event.request)
          .then((response) => {
            if (response) return response;
            return fetch(event.request)
              .then((networkResponse) => {
                const responseClone = networkResponse.clone();
                caches.open(cacheName).then((cache) => cache.put(event.request, responseClone));
                return networkResponse;
              })
              .catch(() => new Response('Offline', { status: 503 }));
          });
      })
    );
  }
});
