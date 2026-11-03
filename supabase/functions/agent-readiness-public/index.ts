// agent-readiness-public — free, no-login website check for the public /agent-readiness page.
//   POST { url }   ->  { ok, score, coverage, subscores, checks, topFixes, host }
//
// Deploy: supabase functions deploy agent-readiness-public --no-verify-jwt
// Secrets: AGENT_READINESS_HASH_SALT (required — the function refuses to run without it)
//
// Privacy: the URL, host and IP are NEVER stored or logged. The limiter keeps only salted SHA-256 hashes
// (IP: 10 scans/hour; host: 3 scans/hour so this can't be used to hammer someone else's site) and
// the page HTML is analysed in memory and discarded. Fails CLOSED if the limiter is unavailable.
// Fetching: robots.txt honoured, identified user-agent, one page, SSRF-guarded (see fetchPage.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { scoreWebsiteOnly } from '../_shared/agent-readiness/engine.ts';
import { fetchPublicPage } from '../_shared/agent-readiness/fetchPage.ts';
import { auditHtml } from '../_shared/agent-readiness/siteAudit.ts';
import { clientIp, corsHeaders, hashKey, json, productionDeps } from '../_shared/agent-readiness/edge.ts';
import { parsePublicUrl } from '../_shared/agent-readiness/urlGuard.ts';

const IP_MAX = 10;
const HOST_MAX = 3;
const WINDOW_SECONDS = 3600;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);

  const salt = Deno.env.get('AGENT_READINESS_HASH_SALT') ?? '';
  if (salt.length < 16) return json({ ok: false, code: 'not_configured' }, 503);

  const body = (await req.json().catch(() => null)) as { url?: unknown; website_confirm?: unknown } | null;
  if (!body || typeof body.url !== 'string') return json({ ok: false, code: 'bad_request' }, 400);
  if (typeof body.website_confirm === 'string' && body.website_confirm.trim() !== '') return json({ ok: false, code: 'bad_request' }, 400); // honeypot

  const parsed = parsePublicUrl(body.url);
  if (!parsed.ok) return json({ ok: false, code: parsed.code }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const limit = async (key: string, max: number): Promise<boolean | null> => {
    const { data, error } = await admin.rpc('consume_agent_readiness_limit', { p_key_hash: await hashKey(salt, key), p_max: max, p_window_seconds: WINDOW_SECONDS });
    return error ? null : data === true;
  };
  const ipOk = await limit(`ip:${clientIp(req)}`, IP_MAX);
  const hostOk = ipOk ? await limit(`host:${parsed.url.hostname.toLowerCase()}`, HOST_MAX) : ipOk;
  if (ipOk === null || hostOk === null) return json({ ok: false, code: 'unavailable' }, 503);
  if (!ipOk || !hostOk) return json({ ok: false, code: 'rate_limited' }, 429, { 'Retry-After': String(WINDOW_SECONDS) });

  const started = Date.now();
  const page = await fetchPublicPage(parsed.url.href, productionDeps());
  console.log(JSON.stringify({ event: 'agent_readiness_public', ok: page.ok, code: page.ok ? null : page.code, ms: Date.now() - started }));
  if (!page.ok) return json({ ok: false, code: page.code });

  const audit = auditHtml(page.html, page.finalUrl, { fetchMs: page.ms, bytes: page.bytes });
  const result = scoreWebsiteOnly(audit);
  return json({
    ok: true,
    host: new URL(page.finalUrl).hostname,
    score: result.score, coverage: result.coverage, subscores: result.subscores,
    checks: result.checks, topFixes: result.topFixes,
  });
});
