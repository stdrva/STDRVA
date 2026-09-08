// Minimal service worker: makes the app installable and gives a graceful
// offline message, WITHOUT caching app pages/data (this is a live business
// tool - stale customer data would be worse than an offline notice). Only the
// static shell assets are cached.
const SHELL = 'bos-shell-v1';
const SHELL_ASSETS = ['/static/css/style.css', '/static/img/logo.png', '/static/img/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/static/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  // Everything else: network only, with a tiny offline fallback for navigations.
  e.respondWith(
    fetch(req).catch(() => {
      if (req.mode === 'navigate') {
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Georgia,serif;background:#1e3d22;color:#e9dfc4;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px"><div><h1 style="font-style:italic">The BOS</h1><p>You are offline. Reconnect to load live business data.</p><p><a href="/dashboard" style="color:#d9a628">Retry</a></p></div>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      return Response.error();
    })
  );
});
