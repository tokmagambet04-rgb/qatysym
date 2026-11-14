// Қатысым — service worker. Файлдар өзгерсе, нұсқаны арттыру керек.
const CACHE = 'qatysym-v7';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Алдымен кэштен береді (интернетсіз жұмыс), артынан желіден жаңартып қояды.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req)
      .then((res) => {
        if (res.ok && !res.redirected) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      e.waitUntil(fresh);
      return cached;
    }
    return (await fresh) || new Response('Интернет жоқ', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
