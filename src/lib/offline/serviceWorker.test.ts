// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import swSource from '../../../public/sw.js?raw';
import offlineHtml from '../../../public/offline.html?raw';

/**
 * Runs the REAL public/sw.js in a sandbox with an in-memory Cache API, so the
 * offline-fallback behaviour is tested against the shipped file, not a copy.
 */

const ORIGIN = 'https://app.test';
const SHELL_HTML =
  '<html><head><script type="module" src="/assets/index-abc.js"></script>' +
  '<link rel="modulepreload" href="/assets/vendor-def.js"><link rel="stylesheet" href="/assets/index-123.css"></head></html>';

type Handler = (event: Record<string, unknown>) => void;

// Service workers resolve relative URLs against their own origin; Node's Request does not.
class SwRequest extends Request {
  constructor(input: string | Request, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
  }
}

let fetchImpl: (r: { url: string; mode?: string }) => Promise<Response> = async () => {
  throw new TypeError('offline');
};
let online: Record<string, () => Response> = {};

function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: string | { url: string }) =>
    new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (r: string | { url: string }, res: Response) => void store.set(key(r), res),
      add: async (r: string | { url: string }) => {
        const res = await fetchImpl(typeof r === 'string' ? { url: new URL(r, ORIGIN).href } : r);
        if (!res.ok) throw new Error(`add failed: ${res.status}`);
        store.set(key(r), res);
      },
    };
  };
  return {
    stores,
    open: async (name: string) => cacheFor(name),
    match: async (r: string | { url: string }) => {
      for (const store of stores.values()) {
        const hit = store.get(key(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

function boot() {
  const handlers: Record<string, Handler> = {};
  const caches = makeCaches();
  const self = {
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: async () => [], openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
    addEventListener: (type: string, fn: Handler) => {
      const prev = handlers[type];
      handlers[type] = prev ? (e) => (prev(e), fn(e)) : fn;
    },
  };
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', swSource)(
    self,
    caches,
    (r: { url: string; mode?: string }) => fetchImpl(r),
    SwRequest,
    Response,
    URL,
  );

  const waits: Promise<unknown>[] = [];
  const lifecycle = async (type: 'install' | 'activate') => {
    handlers[type]({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits.splice(0));
  };
  const navigate = async (path: string) => {
    let responded: Promise<Response> | undefined;
    handlers.fetch({
      // Node's Request refuses mode "navigate", so a request-shaped object stands in.
      request: { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' },
      respondWith: (p: Promise<Response>) => (responded = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const res = responded ? await responded : undefined;
    await Promise.all(waits.splice(0));
    return res;
  };
  const rawFetch = (req: { url: string; method: string; mode?: string }) => {
    let responded = false;
    handlers.fetch({
      request: req,
      respondWith: () => (responded = true),
      waitUntil: () => undefined,
    });
    return responded;
  };
  return { caches, lifecycle, navigate, rawFetch };
}

function installOnlineNetwork() {
  online = {
    '/index.html': () => new Response(SHELL_HTML, { status: 200 }),
    '/offline.html': () => new Response(offlineHtml, { status: 200 }),
    '/offline.js': () => new Response('// js', { status: 200 }),
    '/assets/index-abc.js': () => new Response('a', { status: 200 }),
    '/assets/vendor-def.js': () => new Response('b', { status: 200 }),
    '/assets/index-123.css': () => new Response('c', { status: 200 }),
  };
  fetchImpl = async (r) => {
    const path = new URL(r.url).pathname;
    const make = online[path] ?? (r.mode === 'navigate' ? online['/index.html'] : undefined);
    return make ? make() : new Response('nf', { status: 404 });
  };
}

function goOffline() {
  fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
}

describe('offline.html (shipped file)', () => {
  it('has no inline script (site CSP) and loads only /offline.js', () => {
    const scripts = [...offlineHtml.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('src="/offline.js"');
  });
  it('makes no external network references', () => {
    expect(offlineHtml).not.toMatch(/https?:\/\//);
  });
});

describe('service worker offline fallback', () => {
  beforeEach(() => installOnlineNetwork());
  afterEach(() => vi.useRealTimers());

  it('install precaches the offline page, its script, the shell and the shell’s bundles', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    const cache = sw.caches.stores.get('vireek-shell-v2')!;
    expect([...cache.keys()].sort()).toEqual(
      [
        '/assets/index-123.css',
        '/assets/index-abc.js',
        '/assets/vendor-def.js',
        '/index.html',
        '/offline.html',
        '/offline.js',
      ].sort(),
    );
  });

  it('install still succeeds when offline', async () => {
    goOffline();
    const sw = boot();
    await expect(sw.lifecycle('install')).resolves.toBeUndefined();
  });

  it('serves the network response when online and refreshes the cached shell', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    online['/index.html'] = () => new Response(SHELL_HTML + '<!-- v2 -->', { status: 200 });
    const res = await sw.navigate('/dashboard');
    expect(await res!.text()).toContain('v2');
    const cached = await sw.caches.match('/index.html');
    expect(await cached!.text()).toContain('v2');
  });

  it('offline with a complete cached shell → serves the app shell', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    goOffline();
    const res = await sw.navigate('/dashboard/documents');
    expect(await res!.text()).toBe(SHELL_HTML);
  });

  it('offline with a shell whose bundles are NOT cached → serves /offline.html, never a blank shell', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    sw.caches.stores.get('vireek-shell-v2')!.delete('/assets/vendor-def.js');
    goOffline();
    const res = await sw.navigate('/dashboard');
    expect(await res!.text()).toBe(offlineHtml);
  });

  it('offline with no shell at all → serves /offline.html', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    sw.caches.stores.get('vireek-shell-v2')!.delete('/index.html');
    goOffline();
    const res = await sw.navigate('/anything');
    expect(await res!.text()).toBe(offlineHtml);
  });

  it('nothing cached at all → network error (browser default), not a crash', async () => {
    goOffline();
    const sw = boot();
    const res = await sw.navigate('/');
    expect(res!.type).toBe('error');
  });

  it('falls back after the lie-fi timeout instead of hanging', async () => {
    const sw = boot();
    await sw.lifecycle('install');
    vi.useFakeTimers();
    fetchImpl = () => new Promise<Response>(() => undefined);
    const pending = sw.navigate('/dashboard');
    await vi.advanceTimersByTimeAsync(8000);
    const res = await pending;
    expect(await res!.text()).toBe(SHELL_HTML);
  });

  it('keeps waiting for a slow network when there is nothing to fall back to', async () => {
    const sw = boot();
    vi.useFakeTimers();
    fetchImpl = () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response('late page')), 12000),
      );
    const pending = sw.navigate('/');
    await vi.advanceTimersByTimeAsync(12000);
    expect(await (await pending)!.text()).toBe('late page');
  });

  it('activate deletes caches from older versions only', async () => {
    const sw = boot();
    await sw.caches.open('vireek-shell-v1');
    await sw.caches.open('vireek-shell-v2');
    await sw.caches.open('unrelated-cache');
    await sw.lifecycle('activate');
    expect(await sw.caches.keys()).toEqual(['vireek-shell-v2', 'unrelated-cache']);
  });

  it('ignores non-GET and cross-origin requests', () => {
    const sw = boot();
    expect(sw.rawFetch({ url: `${ORIGIN}/api`, method: 'POST' })).toBe(false);
    expect(sw.rawFetch({ url: 'https://project.supabase.co/rest/v1/jobs', method: 'GET' })).toBe(
      false,
    );
  });
});
