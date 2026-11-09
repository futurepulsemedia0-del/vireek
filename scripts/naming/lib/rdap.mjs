// RDAP domain signal via the public IANA RDAP bootstrap.
//
// IMPORTANT: this is a registration SIGNAL, never a statement about whether a domain can be
// bought. Only three outcomes exist (RDAP_STATUS). A missing RDAP record can come from reserved
// names, registry policy, rate limiting or server quirks, so it must be confirmed at a registrar.
//
// All I/O (fetch, clock, sleep, randomness) is injectable so tests never touch the network.

export const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
export const DEFAULT_TLDS = Object.freeze(['com', 'ai', 'io', 'co']);
export const RDAP_STATUS = Object.freeze({
  REGISTERED: 'registered',
  NO_RECORD: 'no RDAP record found (UNVERIFIED, confirm at a registrar)',
  ERROR: 'lookup error',
});

const MAX_BODY_CHARS = 2_000_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** AbortSignal.timeout with a fallback for runtimes (older jsdom, etc.) that lack it. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
  timer.unref?.();
  return controller.signal;
}

/** Bootstrap JSON -> Map(tld -> https base URLs ending with "/"). Non-https services are dropped. */
export function parseBootstrap(json) {
  if (!json || !Array.isArray(json.services)) {
    throw new Error('RDAP bootstrap: missing "services" array');
  }
  const map = new Map();
  for (const entry of json.services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue;
    const bases = [];
    for (const u of entry[1]) {
      try {
        const url = new URL(u);
        if (url.protocol === 'https:') bases.push(url.href.endsWith('/') ? url.href : `${url.href}/`);
      } catch {
        /* ignore malformed service URLs */
      }
    }
    if (!bases.length) continue;
    for (const tld of entry[0]) if (typeof tld === 'string') map.set(tld.toLowerCase(), bases);
  }
  return map;
}

/** Retry-After (seconds or HTTP date) -> milliseconds, capped; null when absent/invalid. */
export function parseRetryAfter(value, nowMs, maxMs) {
  if (value == null || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(maxMs, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(maxMs, Math.max(0, at - nowMs));
}

/** Per-host spacing: each request to a host starts at least minIntervalMs after the previous. */
export function createRateLimiter({ minIntervalMs, now = Date.now, sleep = defaultSleep }) {
  const nextAt = new Map();
  return {
    async wait(host) {
      const t = now();
      const startAt = Math.max(t, nextAt.get(host) ?? 0);
      nextAt.set(host, startAt + minIntervalMs); // reserve synchronously: safe under concurrency
      if (startAt > t) await sleep(startAt - t);
    },
  };
}

export function createRdapClient({
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  random = Math.random,
  timeoutMs = 8000,
  retries = 2,
  minIntervalMs = 1000,
  backoffBaseMs = 500,
  maxBackoffMs = 15_000,
  bootstrapUrl = BOOTSTRAP_URL,
  userAgent = 'vireek-naming-screen/1.0 (dev script; RDAP signal only)',
} = {}) {
  const limiter = createRateLimiter({ minIntervalMs, now, sleep });
  const backoff = (i) =>
    Math.round(Math.min(maxBackoffMs, backoffBaseMs * 2 ** i) * (0.75 + 0.25 * random()));
  let bootstrapPromise = null;

  async function discard(res) {
    try {
      await res.body?.cancel?.();
    } catch {
      /* ignore */
    }
  }

  /** Never throws. Retries network errors, timeouts, 429 and 5xx with backoff. */
  async function request(url, accept) {
    const host = new URL(url).host;
    let attempts = 0;
    let lastError = 'unknown error';
    for (let i = 0; i <= retries; i += 1) {
      attempts += 1;
      await limiter.wait(host);
      let retryDelay = null;
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { accept, 'user-agent': userAgent },
          signal: timeoutSignal(timeoutMs),
          redirect: 'follow',
        });
        if (res.url && !String(res.url).startsWith('https://')) {
          await discard(res);
          return { ok: false, attempts, error: 'insecure redirect target' };
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = `HTTP ${res.status}`;
          retryDelay = parseRetryAfter(res.headers?.get?.('retry-after'), now(), maxBackoffMs);
          await discard(res);
        } else {
          return { ok: true, res, attempts };
        }
      } catch (err) {
        lastError =
          err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? 'timeout'
            : `network error: ${err?.message ?? String(err)}`;
      }
      if (i < retries) await sleep(retryDelay ?? backoff(i));
    }
    return { ok: false, attempts, error: lastError };
  }

  async function readJson(res) {
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) throw new Error('response too large');
    return JSON.parse(text);
  }

  function loadBootstrap() {
    bootstrapPromise ??= (async () => {
      const r = await request(bootstrapUrl, 'application/json');
      if (!r.ok) throw new Error(`bootstrap fetch failed: ${r.error}`);
      if (r.res.status !== 200) {
        await discard(r.res);
        throw new Error(`bootstrap fetch failed: HTTP ${r.res.status}`);
      }
      return parseBootstrap(await readJson(r.res));
    })();
    return bootstrapPromise;
  }

  const fail = (domain, tld, detail, extra = {}) => ({
    domain,
    tld,
    status: RDAP_STATUS.ERROR,
    detail,
    source: null,
    attempts: 0,
    httpStatus: null,
    ...extra,
  });

  async function lookup(label, tld) {
    const domain = `${label}.${tld}`;
    if (!/^[a-z0-9-]{1,63}$/.test(label) || !/^[a-z]{2,24}$/.test(tld)) {
      return fail(domain, tld, 'invalid label or TLD');
    }
    let bootstrap;
    try {
      bootstrap = await loadBootstrap();
    } catch (err) {
      return fail(domain, tld, err.message);
    }
    const base = bootstrap.get(tld)?.[0];
    if (!base) return fail(domain, tld, `no RDAP service for .${tld} in the IANA bootstrap`);

    const url = `${base}domain/${encodeURIComponent(domain)}`;
    const source = new URL(url).host;
    const r = await request(url, 'application/rdap+json, application/json');
    if (!r.ok) return fail(domain, tld, r.error, { source, attempts: r.attempts });

    const httpStatus = r.res.status;
    const done = (status, detail) => ({
      domain,
      tld,
      status,
      detail,
      source,
      attempts: r.attempts,
      httpStatus,
    });
    if (httpStatus === 404) {
      await discard(r.res);
      return done(RDAP_STATUS.NO_RECORD, 'HTTP 404');
    }
    if (httpStatus !== 200) {
      await discard(r.res);
      return done(RDAP_STATUS.ERROR, `HTTP ${httpStatus}`);
    }
    try {
      const body = await readJson(r.res);
      const ldh = typeof body?.ldhName === 'string' ? body.ldhName.toLowerCase() : domain;
      if (body?.objectClassName !== 'domain' || ldh !== domain) {
        return done(RDAP_STATUS.ERROR, 'unexpected RDAP payload');
      }
      return done(RDAP_STATUS.REGISTERED, 'HTTP 200');
    } catch (err) {
      return done(RDAP_STATUS.ERROR, `unreadable response: ${err.message}`);
    }
  }

  return { lookup, loadBootstrap };
}

/** Sequential lookups of one label across TLDs (polite by design). */
export async function lookupDomains(client, label, tlds = DEFAULT_TLDS) {
  const out = [];
  for (const tld of tlds) out.push(await client.lookup(label, tld));
  return out;
}
