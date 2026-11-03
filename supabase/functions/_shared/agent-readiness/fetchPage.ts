// Agent Readiness — guarded single-page fetch. No Deno globals: DNS + fetch are injected so every
// safety decision is unit-testable. Used by the public tool, the owner scan and the weekly cron.
//
// Guarantees: http/https on 80/443 only; no credentials; every hop (and robots.txt) is re-validated;
// ALL resolved addresses must be public; redirects are followed manually (max 3); robots.txt is honoured
// for our user-agent; response must be HTML; body is capped; one GET per hop; nothing is stored here.
//
// KNOWN LIMIT: fetch() resolves DNS again when it connects, so a hostile DNS server could answer
// differently between our check and the connection (rebinding). Running the function in a network
// without access to private ranges (Supabase edge default) is the second line of defence.
import { isPublicIp, parsePublicUrl, robotsAllows, type UrlRejection } from './urlGuard.ts';

export const BOT_TOKEN = 'VireekAgentReadinessBot';
export const USER_AGENT = `${BOT_TOKEN}/1.0 (+https://vireek.com/agent-readiness)`;
export const MAX_BYTES = 1_500_000;

export interface FetchDeps {
  resolve: (host: string) => Promise<string[]>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}
export type FetchFailure = UrlRejection | 'blocked_address' | 'dns' | 'robots' | 'timeout' | 'network' | 'http_error' | 'redirect' | 'not_html';
export type FetchResult =
  | { ok: true; finalUrl: string; html: string; ms: number; bytes: number }
  | { ok: false; code: FetchFailure; status?: number };

const TIMEOUT_MS = 8000;
const MAX_HOPS = 3;

async function assertPublicHost(host: string, deps: FetchDeps): Promise<boolean> {
  let addrs: string[];
  try { addrs = await deps.resolve(host); } catch { return false; }
  return addrs.length > 0 && addrs.every(isPublicIp);
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: '', bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) { const take = Math.min(c.byteLength, merged.byteLength - off); merged.set(c.subarray(0, take), off); off += take; if (off >= merged.byteLength) break; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), bytes: total };
}

async function robotsOk(origin: string, path: string, deps: FetchDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(`${origin}/robots.txt`, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 500) { await res.body?.cancel().catch(() => undefined); return false; }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => undefined); return true; }
    if (res.status >= 400) { await res.body?.cancel().catch(() => undefined); return true; }
    const { text } = await readCapped(res, 200_000);
    return robotsAllows(text, BOT_TOKEN, path);
  } catch { return false; }
}

export async function fetchPublicPage(input: string, deps: FetchDeps): Promise<FetchResult> {
  let parsed = parsePublicUrl(input);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  let current = parsed.url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const host = current.hostname.toLowerCase();
    if (!(await assertPublicHost(host, deps))) return { ok: false, code: 'blocked_address' };
    if (!(await robotsOk(current.origin, current.pathname + current.search, deps))) return { ok: false, code: 'robots' };
    const started = deps.now();
    let res: Response;
    try {
      res = await deps.fetch(current.href, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, code: e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc || hop === MAX_HOPS) return { ok: false, code: 'redirect' };
      let next: URL;
      try { next = new URL(loc, current); } catch { return { ok: false, code: 'redirect' }; }
      parsed = parsePublicUrl(next.href);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      current = parsed.url;
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { ok: false, code: 'http_error', status: res.status }; }
    if (!/(text\/html|application\/xhtml\+xml)/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel().catch(() => undefined); return { ok: false, code: 'not_html' }; }
    try {
      const { text, bytes } = await readCapped(res, MAX_BYTES);
      return { ok: true, finalUrl: current.href, html: text, ms: deps.now() - started, bytes };
    } catch (e) {
      return { ok: false, code: e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }
  return { ok: false, code: 'redirect' };
}
