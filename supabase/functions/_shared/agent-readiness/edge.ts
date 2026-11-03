// Agent Readiness — small helpers shared by the three edge functions. No Deno globals (fetch / crypto.subtle only).
import { BOT_TOKEN, type FetchDeps } from './fetchPage.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret',
};
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

export async function hashKey(salt: string, value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${value}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('cf-connecting-ip') || 'unknown';
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** DNS-over-HTTPS A + AAAA lookup (same approach as landing-domain-verify). Throws when nothing resolves. */
export async function dohResolve(host: string, doFetch: typeof fetch = fetch): Promise<string[]> {
  const ask = async (type: 'A' | 'AAAA', code: number): Promise<string[]> => {
    const res = await doFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`doh_${res.status}`);
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? []).filter((a) => a.type === code).map((a) => a.data);
  };
  const [a, aaaa] = await Promise.all([ask('A', 1), ask('AAAA', 28).catch(() => [] as string[])]);
  const all = [...a, ...aaaa];
  if (all.length === 0) throw new Error('nxdomain');
  return all;
}

export function productionDeps(): FetchDeps {
  return { resolve: (h) => dohResolve(h), fetch: (url, init) => fetch(url, init), now: () => performance.now() };
}
export { BOT_TOKEN };
