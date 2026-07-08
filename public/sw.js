// Macro Tracker service worker (Tier 2, item 9)
// Shell: stale-while-revalidate · API GETs: network-first (2s) with cache
// fallback · push: fetch pending message from server, show notification.
const VERSION = 'v1';
const SHELL_CACHE = 'shell-' + VERSION;
const API_CACHE = 'api-' + VERSION;
const SHELL = ['/', '/app.js', '/app.css', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL_CACHE && key !== API_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isShell(url) {
  return SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // network-only

  if (isShell(url)) {
    // stale-while-revalidate
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(e.request);
      const refresh = fetch(e.request).then(res => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await refresh) || new Response('offline', { status: 503 });
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // network-first with 2s timeout, fall back to cache, then empty shape
    e.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const res = await Promise.race([
          fetch(e.request),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (_) {
        const cached = await cache.match(e.request);
        return cached || new Response(JSON.stringify({ ok: false, offline: true }), {
          status: 503, headers: { 'content-type': 'application/json' }
        });
      }
    })());
  }
});

// Push: payloads are not encrypted client-side; the server queues the message
// and we fetch it here (session cookie rides along automatically).
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let n = { title: 'Macro Tracker', body: 'You have a reminder.', url: '/' };
    try {
      const res = await fetch('/api/push/pending', { credentials: 'same-origin' });
      const d = await res.json();
      if (d.ok && d.notification) n = d.notification;
    } catch (_) {}
    await self.registration.showNotification(n.title, {
      body: n.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: n.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(url); return; } }
    await self.clients.openWindow(url);
  })());
});
