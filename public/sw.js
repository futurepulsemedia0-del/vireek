// public/sw.js — receives real Web Push events, shows a system notification.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Vireek', body: event.data ? event.data.text() : 'You have a new notification.' };
  }

  const title = data.title || 'Vireek';
  const options = {
    body: data.body || '',
    icon: '/web-app-manifest-192x192.png',
    badge: '/favicon-96x96.png',
    tag: data.tag || 'vireek-notification',
    renotify: true,
    data: { url: data.url || '/dashboard' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});

// ------------------------------------------------------------------
// Offline app shell + background sync (PWA). Lets a technician open the app with no signal.
// ------------------------------------------------------------------
const VK_CACHE = 'vireek-shell-v1';
const VK_SHELL = '/index.html';

self.addEventListener('install', (event) => {
  // Best effort: a failed precache must never block the service worker from installing.
  event.waitUntil(caches.open(VK_CACHE).then((c) => c.add(new Request(VK_SHELL, { cache: 'reload' }))).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('vireek-shell-') && k !== VK_CACHE).map((k) => caches.delete(k)))),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, analytics, fonts: never cached here

  // Page navigations: network first (always fresh when online), cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) {
            const copy = fresh.clone();
            event.waitUntil(caches.open(VK_CACHE).then((c) => c.put(VK_SHELL, copy)));
          }
          return fresh;
        } catch {
          const cached = await caches.match(VK_SHELL);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build assets are immutable: cache first, fill on first use.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(VK_CACHE).then((c) => c.put(req, copy)));
            }
            return res;
          }),
      ),
    );
  }
});

// Background Sync (Chromium): signal is back -> wake any open page so it flushes the outbox.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'vireek-sync') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      list.forEach((client) => client.postMessage({ type: 'vireek-sync' }));
    }),
  );
});
