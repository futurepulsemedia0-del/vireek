// public/sw.js — Web Push, versioned offline app shell, background sync.
//
// __BUILD_ID__ is replaced at build time by scripts/stamp-sw.mjs (it stays literal in dev, which is harmless).
// There is deliberately NO skipWaiting() on install: the page shows "A new version is available" and asks
// for activation with { type: 'SKIP_WAITING' } (see src/lib/pwa/swUpdate.ts), so nobody loses work mid-session.

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ------------------------------------------------------------------
// Web Push
// ------------------------------------------------------------------
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
    badge: '/icons/monochrome-96.png',
    tag: data.tag || 'vireek-notification',
    renotify: true,
    data: { url: data.url || '/dashboard' },
  };

  event.waitUntil(
    (async () => {
      // Chat: do not buzz when the person is already looking at that conversation.
      if (data.chatChannelId) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const watching = wins.some((c) => c.visibilityState === 'visible' && c.url.includes('c=' + data.chatChannelId));
        if (watching) return;
      }
      await self.registration.showNotification(title, options);
    })(),
  );
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
// Offline app shell + versioned caches (PWA). Lets a technician open the app with no signal.
// ------------------------------------------------------------------
const VK_BUILD = '__BUILD_ID__';
const VK_SHELL_CACHE = 'vireek-shell-' + VK_BUILD; // one per deploy; older ones are pruned on activate
const VK_ASSET_CACHE = 'vireek-assets-v1'; // immutable hashed files, capped (old tabs may still need old hashes)
const VK_SHELL_URL = '/_spa.html'; // pristine SPA shell, never a prerendered marketing page
const VK_ASSET_LIMIT = 200;
const VK_NAV_TIMEOUT_MS = 4000; // slower than this and a cached shell is served instead

async function vkTrim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

self.addEventListener('install', (event) => {
  // Best effort: a failed precache must never block the service worker from installing.
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch(VK_SHELL_URL, { cache: 'reload' });
        if (res.ok) await (await caches.open(VK_SHELL_CACHE)).put(VK_SHELL_URL, res);
      } catch (_) {
        // offline fallback is best-effort
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('vireek-shell-') && n !== VK_SHELL_CACHE).map((n) => caches.delete(n)),
      );
    })(),
  );
});

// Network first; cached shell when offline OR when the network is slower than VK_NAV_TIMEOUT_MS.
async function vkNavigate(req) {
  const network = fetch(req);
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), VK_NAV_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, slow]);
    if (first) return first;
  } catch (_) {
    // offline: fall through to the cached shell
  }
  const cached = await caches.match(VK_SHELL_URL);
  return cached || network;
}

// Hashed build assets are immutable: cache first, fill on first use, keep the newest VK_ASSET_LIMIT.
async function vkAsset(req) {
  const cache = await caches.open(VK_ASSET_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).then(() => vkTrim(cache, VK_ASSET_LIMIT)).catch(() => undefined);
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, analytics, fonts: never cached here

  if (req.mode === 'navigate') event.respondWith(vkNavigate(req));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(vkAsset(req));
});

// ------------------------------------------------------------------
// Background Sync (Chromium): signal is back -> wake any open page so it flushes the outbox.
// ------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag !== 'vireek-sync') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      list.forEach((client) => client.postMessage({ type: 'vireek-sync' }));
    }),
  );
});
