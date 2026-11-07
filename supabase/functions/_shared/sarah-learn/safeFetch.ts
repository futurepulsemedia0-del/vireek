// supabase/functions/_shared/sarah-learn/safeFetch.ts
//
// SSRF-safe, robots.txt-respecting fetcher for "Sarah Learns Your Business".
// Pure TypeScript (no Deno globals) so it is unit-testable under Vitest; the
// edge function injects `resolveDns` (Deno.resolveDns) at runtime.
//
// Rules enforced here:
//   * http/https only, default ports only, no embedded credentials
//   * hostname must not be localhost / internal / a private, loopback,
//     link-local, CGNAT, multicast or cloud-metadata address (checked on the
//     literal AND on every DNS answer)
//   * redirects are followed manually (max 3) and every hop is re-validated;
//     a redirect may only stay on the same host (or its www / apex twin)
//   * robots.txt is honoured; our UA token is "VireekSarahBot"
//   * response size and time are capped; only text-like content types

export const BOT_UA_TOKEN = 'VireekSarahBot';
export const BOT_USER_AGENT = `${BOT_UA_TOKEN}/1.0 (+https://vireek.com/bot; owner-requested)`;

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_HOST'
  | 'BLOCKED_ROBOTS'
  | 'BAD_REDIRECT'
  | 'TOO_LARGE'
  | 'BAD_CONTENT_TYPE'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK';

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

export function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

export function isPrivateIpv6(raw: string): boolean {
  const h = raw.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
  if (h === '::' || h === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) return true; // hex-form mapped: refuse
  const first = h.split(':')[0];
  if (first === '') return false;
  const n = parseInt(first, 16);
  if (Number.isNaN(n)) return true;
  return (
    (n & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (n & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (n & 0xff00) === 0xff00 // multicast
  );
}

export function isPrivateAddress(addr: string): boolean {
  const v4 = parseIpv4(addr);
  if (v4) return isPrivateIpv4(v4);
  if (addr.includes(':')) return isPrivateIpv6(addr);
  return true; // unknown format -> refuse
}

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.private'];

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'metadata' || h === 'metadata.google.internal') return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h.startsWith('[') || h.includes(':')) return isPrivateIpv6(h);
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4);
  if (/^[0-9.x]+$/i.test(h)) return true; // odd numeric forms
  return !h.includes('.'); // single-label hosts are internal
}

/** Validates a user-supplied URL. Returns a normalised URL (no fragment). */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError('INVALID_URL', 'That does not look like a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SafeFetchError('INVALID_URL', 'Only http and https addresses are supported.');
  }
  if (url.username || url.password) {
    throw new SafeFetchError('INVALID_URL', 'Addresses with embedded credentials are not allowed.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new SafeFetchError('BLOCKED_HOST', 'Only standard web ports are allowed.');
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SafeFetchError('BLOCKED_HOST', 'That address is not a public website.');
  }
  url.hash = '';
  return url;
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

export function sameSite(a: URL, b: URL): boolean {
  return bareHost(a.hostname) === bareHost(b.hostname);
}

// ---------------------------------------------------------------------
// robots.txt (RFC 9309 subset: groups, allow/disallow, * and $, longest match)
// ---------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsRules {
  rules: RobotsRule[];
}

export function parseRobots(text: string, uaToken: string = BOT_UA_TOKEN): RobotsRules {
  const token = uaToken.toLowerCase();
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (current) current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '' || !r.allow) };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (anchored ? '$' : ''));
}

export function robotsAllows(robots: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of robots.rules) {
    if (rule.pattern === '') continue; // "Disallow:" (empty) allows everything
    if (!patternToRegex(rule.pattern).test(pathAndQuery)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to IP strings (Deno.resolveDns A + AAAA). Omit only in tests. */
  resolveDns?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 8000;

async function assertResolvesPublic(url: URL, opts: SafeFetchOptions): Promise<void> {
  if (!opts.resolveDns) return;
  if (parseIpv4(url.hostname) || url.hostname.includes(':')) return; // literal already validated
  let addrs: string[];
  try {
    addrs = await opts.resolveDns(url.hostname);
  } catch {
    throw new SafeFetchError('NETWORK', 'We could not look up that website.');
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    throw new SafeFetchError('BLOCKED_HOST', 'That address is not a public website.');
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchError('TOO_LARGE', 'That page is too large to read.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/** Fetch one public page (no robots check — see fetchWithRobots). */
export async function fetchPublicPage(rawUrl: string, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const origin = assertPublicHttpUrl(rawUrl);
  let current = origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertResolvesPublic(current, opts);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': opts.userAgent ?? BOT_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') throw new SafeFetchError('TIMEOUT', 'The website took too long to respond.');
      throw new SafeFetchError('NETWORK', 'We could not reach that website.');
    }

    try {
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new SafeFetchError('BAD_REDIRECT', 'The website redirected without a destination.');
        const next = assertPublicHttpUrl(new URL(loc, current).toString());
        if (!sameSite(origin, next)) {
          throw new SafeFetchError('BAD_REDIRECT', 'The website redirects to a different site, which we do not follow.');
        }
        await res.body?.cancel().catch(() => undefined);
        current = next;
        continue;
      }
      if (!res.ok) throw new SafeFetchError('HTTP_ERROR', `The website answered with status ${res.status}.`);
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!/^(text\/(html|plain)|application\/(xhtml\+xml|xml|json|ld\+json))/.test(contentType) && contentType !== '') {
        throw new SafeFetchError('BAD_CONTENT_TYPE', 'That address is not a readable web page.');
      }
      const text = await readCapped(res, maxBytes);
      return { finalUrl: current.toString(), status: res.status, contentType, text };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFetchError('BAD_REDIRECT', 'The website redirected too many times.');
}

/**
 * Fetch robots.txt once per origin. A missing robots.txt (404/410) means
 * "allowed"; a server error or unreachable robots.txt means "do not crawl"
 * (RFC 9309 §2.3.1.4) — we fail closed.
 */
export async function loadRobots(origin: URL, opts: SafeFetchOptions = {}): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    await assertResolvesPublic(origin, opts);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await doFetch(robotsUrl, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': opts.userAgent ?? BOT_USER_AGENT },
      });
      if (res.status === 404 || res.status === 410) return { rules: [] };
      if (!res.ok) return { rules: [{ allow: false, pattern: '/' }] };
      const text = await readCapped(res, 200_000);
      return parseRobots(text);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === 'BLOCKED_HOST') throw err;
    return { rules: [{ allow: false, pattern: '/' }] };
  }
}

export async function fetchWithRobots(rawUrl: string, robots: RobotsRules, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  const url = assertPublicHttpUrl(rawUrl);
  if (!robotsAllows(robots, url.pathname + url.search)) {
    throw new SafeFetchError('BLOCKED_ROBOTS', 'This website asks automated tools not to read that page.');
  }
  return fetchPublicPage(url.toString(), opts);
}
