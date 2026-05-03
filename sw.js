// OnlyBet Service Worker v1
const CACHE = 'onlybet-v1';
const STATIC = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Deixar APIs sempre ir à rede
  if (e.request.url.includes('/api/')) {
    return e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}', {headers:{'Content-Type':'application/json'}})));
  }
  // HTML — sempre rede, cache como fallback
  if (e.request.mode === 'navigate') {
    return e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
  }
  // Outros — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
