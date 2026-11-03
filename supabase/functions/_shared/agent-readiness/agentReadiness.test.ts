import { describe, expect, it } from 'vitest';
import { RULES, RULE_IDS, SUBSCORE_WEIGHTS } from './rules.ts';
import { isPublicIp, parsePublicUrl, robotsAllows } from './urlGuard.ts';
import { auditHtml } from './siteAudit.ts';
import { buildFixes, buildJsonLd, describeService, scoreAccount, scoreWebsiteOnly, type Snapshot } from './engine.ts';

const GOOD_HTML = `<!doctype html><html><head><title>Acme Plumbing</title>
<meta name="description" content="Licensed plumbers serving Austin, TX with same-day repairs."><meta name="viewport" content="width=device-width">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Plumber","name":"Acme","telephone":"+1 512-555-0100","address":{"@type":"PostalAddress"},"openingHoursSpecification":[{"@type":"OpeningHoursSpecification"}],"areaServed":"Austin","hasOfferCatalog":{"@type":"OfferCatalog"}},{"@type":"FAQPage","mainEntity":[{"@type":"Question"}]}]}</script>
</head><body><a href="tel:+15125550100">Call (512) 555-0100</a><a href="/book">Book online</a></body></html>`;

const HOURS = { mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' }, wed: { open: '08:00', close: '17:00' }, thu: { open: '08:00', close: '17:00' }, fri: { open: '08:00', close: '17:00' } };
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    business: { name: 'Acme', phone: '(512) 555-0100', address: '1 Main St', city: 'Austin', state: 'TX', website: 'https://acme-plumbing.com', country: 'US' },
    hours: HOURS, booking_hours: HOURS, holidays: 2, handles_emergency: 'yes_same_rate', after_hours_mode: 'ai_answer', currency: 'USD', timezone_valid: true,
    services_offered: ['Drain cleaning'], faqs: [{ question: 'Do you work weekends?', answer: 'Yes, by appointment.' }],
    service_areas: ['Austin'],
    price_book: [{ id: 'a1', service_name: 'Drain cleaning', description: null, pricing_model: 'starting_at', price_cents: 14900, price_max_cents: null, unit_label: null }],
    reviews: { connected: false, total: 0, last_90d: 0, due_total: 0, due_replied: 0 },
    booking: { enabled: true, feed_enabled: false, partner_status: 'not_applied' }, phone_ai_configured: true,
    ...over,
  };
}
const audit = (html = GOOD_HTML, ms = 400) => auditHtml(html, 'https://acme.example/', { fetchMs: ms, bytes: html.length });

describe('rules registry', () => {
  it('weights sum to 100 and every rule cites an official https source', () => {
    expect(Object.values(SUBSCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    for (const id of RULE_IDS) expect(RULES[id].source).toMatch(/^https:\/\/(developers\.google\.com|support\.google\.com|web\.dev)\//);
  });
});

describe('urlGuard', () => {
  it('rejects non-public targets and unsafe URL shapes', () => {
    for (const bad of ['http://127.0.0.1', 'https://[::1]/', 'https://user:pw@acme.com', 'https://acme.com:8443', 'file:///etc/passwd', 'ftp://acme.com', 'https://localhost', 'https://printer.local', 'https://10.0.0.5', 'https://2130706433'])
      expect(parsePublicUrl(bad).ok, bad).toBe(false);
    const ok = parsePublicUrl('acme.com/about#x');
    expect(ok.ok && ok.url.href).toBe('https://acme.com/about');
  });
  it('classifies IPs', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:7f00:1', 'garbage'])
      expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
  });
  it('honours robots.txt (specific agent beats *, longest match wins)', () => {
    const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: VireekAgentReadinessBot\nDisallow: /blocked$';
    expect(robotsAllows(txt, 'VireekAgentReadinessBot/1.0', '/private')).toBe(true);
    expect(robotsAllows(txt, 'VireekAgentReadinessBot/1.0', '/blocked')).toBe(false);
    expect(robotsAllows(txt, 'OtherBot', '/private/x')).toBe(false);
    expect(robotsAllows(txt, 'OtherBot', '/private/ok/1')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /', 'AnyBot', '/')).toBe(false);
    expect(robotsAllows('', 'AnyBot', '/')).toBe(true);
  });
});

describe('siteAudit', () => {
  it('detects structured data, tel link, booking link and phones', () => {
    const a = audit();
    expect(a.localBusiness).toMatchObject({ present: true, hasName: true, hasTelephone: true, hasAddress: true, hasHours: true, hasAreaServed: true });
    expect(a.hasService && a.hasFaq && a.hasBookingLink && a.hasViewport && a.hasMetaDescription).toBe(true);
    expect(a.telLinks).toBe(1);
    expect(a.phones).toEqual(['5125550100']);
  });
  it('survives broken JSON-LD and empty HTML', () => {
    const a = audit('<script type="application/ld+json">{oops</script>');
    expect(a.jsonLdInvalid).toBe(1);
    expect(a.localBusiness.present).toBe(false);
    expect(() => audit('')).not.toThrow();
  });
});

describe('scoring', () => {
  it('never turns unmeasured checks into zeros: coverage < 1 and unmeasured subscores are null', () => {
    const r = scoreAccount(snap(), audit());
    expect(r.coverage).toBeLessThan(1);
    expect(r.subscores.find((s) => s.id === 'ai_visibility')?.score).toBeNull();
    expect(r.checks.find((c) => c.ruleId === 'ai_samples')).toMatchObject({ status: 'not_measured', sampled: true });
    expect(r.checks.find((c) => c.ruleId === 'gbp_categories_photos')?.status).toBe('not_measured');
  });
  it('a complete site scores higher than an empty one, and an unaudited site is not scored', () => {
    const good = scoreAccount(snap(), audit());
    const bad = scoreAccount(snap(), audit('<html></html>', 5000));
    const none = scoreAccount(snap(), null);
    expect(good.score!).toBeGreaterThan(bad.score!);
    expect(none.subscores.find((s) => s.id === 'website')?.score).toBeNull();
  });
  it('flags a phone mismatch between profile and site', () => {
    const r = scoreAccount(snap({ business: { ...snap().business, phone: '(512) 555-9999' } }), audit());
    expect(r.checks.find((c) => c.ruleId === 'nap_site_match')?.status).toBe('fail');
  });
  it('accepts AI samples and marks them sampled', () => {
    const r = scoreAccount(snap(), audit(), [{ engine: 'gemini', query: 'plumber austin', mentioned: true }, { engine: 'chatgpt', query: 'plumber austin', mentioned: false }]);
    const c = r.checks.find((x) => x.ruleId === 'ai_samples')!;
    expect(c).toMatchObject({ status: 'partial', sampled: true });
  });
  it('public tool: top fixes are at most 5, sorted by lost points, deterministic', () => {
    const r = scoreWebsiteOnly(audit('<html><head></head></html>', 4000));
    expect(r.topFixes.length).toBeLessThanOrEqual(5);
    const lost = r.topFixes.map((f) => f.lost);
    expect([...lost].sort((a, b) => b - a)).toEqual(lost);
    expect(scoreWebsiteOnly(audit('<html><head></head></html>', 4000))).toEqual(r);
    expect(r.coverage).toBeLessThan(0.3);
  });
});

describe('fix planning', () => {
  it('proposes description diffs only for rows that need them, grounded in the price book', () => {
    const s = snap();
    const fixes = buildFixes(s, scoreAccount(s, audit()).checks);
    const apply = fixes.find((f) => f.key === 'service_descriptions')!;
    expect(apply.kind).toBe('apply');
    expect(apply.diff).toHaveLength(1);
    expect(apply.diff![0].after).toContain('starting at $149');
    const done = snap({ price_book: [{ ...s.price_book[0], description: 'Full drain cleaning for kitchens and bathrooms, including a camera check.' }] });
    expect(buildFixes(done, scoreAccount(done, audit()).checks).find((f) => f.key === 'service_descriptions')).toBeUndefined();
  });
  it('never invents a price: zero-price rows say "contact us"', () => {
    expect(describeService({ ...snap().price_book[0], price_cents: 0 }, '$')).toContain('Contact us');
  });
  it('JSON-LD is valid JSON, escapes "<", and omits what it does not know', () => {
    const s = snap({ business: { ...snap().business, name: 'A</script><b>', address: null } });
    const { json, notes } = buildJsonLd(s);
    expect(json).not.toContain('</script>');
    expect(() => JSON.parse(json)).not.toThrow();
    expect(notes).toContain('address_incomplete');
    expect(JSON.parse(json)['@graph'][0].address).toBeUndefined();
  });
  it('ignores days marked closed and scores after-hours handling', () => {
    const closedWeek = snap({ hours: { mon: { open: '08:00', close: '17:00', closed: true } } });
    expect(scoreAccount(closedWeek, null).checks.find((c) => c.ruleId === 'hours_defined')?.status).toBe('fail');
    expect(scoreAccount(snap({ after_hours_mode: 'voicemail' }), null).checks.find((c) => c.ruleId === 'phone_after_hours')?.status).toBe('fail');
    expect(scoreAccount(snap({ after_hours_mode: null }), null).checks.find((c) => c.ruleId === 'phone_after_hours')?.status).toBe('not_measured');
  });
  it('uses the location currency and flags an assumed one', () => {
    const cad = snap({ currency: 'CAD' });
    expect(buildFixes(cad, scoreAccount(cad, null).checks).find((f) => f.key === 'service_descriptions')?.diff?.[0].after).toContain('CA$149');
    const unknown = snap({ currency: null, business: { ...snap().business, country: null } });
    expect(buildFixes(unknown, scoreAccount(unknown, null).checks).find((f) => f.key === 'service_descriptions')?.notes).toContain('currency_assumed');
  });
  it('flags a hours conflict between booking and business hours', () => {
    const s = snap({ booking_hours: { mon: { open: '09:00', close: '12:00' } } });
    const f = buildFixes(s, scoreAccount(s, audit()).checks).find((x) => x.key === 'hours_review');
    expect(f?.notes).toContain('hours_conflict');
  });
});

// ---------------------------------------------------------------------------------------------
import { fetchPublicPage, type FetchDeps } from './fetchPage.ts';
import { buildFacts, diffScans } from './monitoring.ts';
import { runAccountScan } from './runScan.ts';

const htmlRes = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
function deps(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}): FetchDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: (() => { let t = 0; return () => (t += 100); })(),
    resolve: async (h) => { if (!(h in dns) && !dns['*']) throw new Error('nxdomain'); return dns[h] ?? dns['*']; },
    fetch: async (url) => { calls.push(url); const r = routes[url]; return r ? r() : new Response('', { status: 404 }); },
  };
}
const OK_DNS = { '*': ['93.184.216.34'] };

describe('fetchPublicPage', () => {
  it('fetches an allowed page once robots.txt allows it', async () => {
    const d = deps({ 'https://acme.com/robots.txt': () => new Response('User-agent: *\nAllow: /'), 'https://acme.com/': () => htmlRes(GOOD_HTML) }, OK_DNS);
    const r = await fetchPublicPage('acme.com', d);
    expect(r.ok && r.finalUrl).toBe('https://acme.com/');
    expect(r.ok && r.ms).toBeGreaterThan(0);
  });
  it('refuses private resolutions (incl. one bad record among good ones) without ever requesting the site', async () => {
    const d = deps({}, { 'evil.com': ['93.184.216.34', '10.0.0.7'] });
    expect(await fetchPublicPage('https://evil.com', d)).toEqual({ ok: false, code: 'blocked_address' });
    expect(d.calls).toEqual([]);
  });
  it('re-validates every redirect hop (public -> metadata IP is blocked)', async () => {
    const d = deps({ 'https://acme.com/robots.txt': () => new Response(''), 'https://acme.com/': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) }, OK_DNS);
    expect(await fetchPublicPage('https://acme.com', d)).toEqual({ ok: false, code: 'ip_literal' });
    expect(d.calls.some((u) => u.includes('169.254'))).toBe(false);
    const d2 = deps({ 'https://acme.com/robots.txt': () => new Response(''), 'https://acme.com/': () => new Response(null, { status: 301, headers: { location: 'https://internal.acme.com/' } }) }, { 'acme.com': ['93.184.216.34'], 'internal.acme.com': ['192.168.1.5'] });
    expect(await fetchPublicPage('https://acme.com', d2)).toEqual({ ok: false, code: 'blocked_address' });
  });
  it('stops redirect loops', async () => {
    const d = deps({ 'https://acme.com/robots.txt': () => new Response(''), 'https://acme.com/': () => new Response(null, { status: 302, headers: { location: 'https://acme.com/' } }) }, OK_DNS);
    expect(await fetchPublicPage('https://acme.com', d)).toEqual({ ok: false, code: 'redirect' });
  });
  it('honours robots.txt: disallow, and fails closed on a 5xx robots.txt', async () => {
    const blocked = deps({ 'https://acme.com/robots.txt': () => new Response('User-agent: *\nDisallow: /') }, OK_DNS);
    expect(await fetchPublicPage('https://acme.com', blocked)).toEqual({ ok: false, code: 'robots' });
    expect(blocked.calls).toEqual(['https://acme.com/robots.txt']);
    const down = deps({ 'https://acme.com/robots.txt': () => new Response('', { status: 503 }) }, OK_DNS);
    expect(await fetchPublicPage('https://acme.com', down)).toEqual({ ok: false, code: 'robots' });
  });
  it('rejects non-HTML, HTTP errors and caps oversized bodies', async () => {
    const pdf = deps({ 'https://a.com/robots.txt': () => new Response(''), 'https://a.com/': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) }, OK_DNS);
    expect(await fetchPublicPage('https://a.com', pdf)).toEqual({ ok: false, code: 'not_html' });
    const err = deps({ 'https://a.com/robots.txt': () => new Response(''), 'https://a.com/': () => new Response('x', { status: 500 }) }, OK_DNS);
    expect(await fetchPublicPage('https://a.com', err)).toMatchObject({ ok: false, code: 'http_error', status: 500 });
    const big = deps({ 'https://a.com/robots.txt': () => new Response(''), 'https://a.com/': () => htmlRes('x'.repeat(3_000_000)) }, OK_DNS);
    const r = await fetchPublicPage('https://a.com', big);
    expect(r.ok && r.html.length).toBeLessThanOrEqual(1_500_000);
  });
  it('maps DNS failure to blocked_address (no fetch)', async () => {
    const d = deps({}, {});
    expect(await fetchPublicPage('https://nope.example.com', d)).toEqual({ ok: false, code: 'blocked_address' });
  });
});

describe('monitoring diff', () => {
  const base: { score: number; facts: Record<string, string | number | boolean>; site: { ok: boolean; local_business?: boolean } } = { score: 70, facts: { hours: 'H', booking_hours: 'B', holidays: 1, feed_enabled: true, feed_ready: true }, site: { ok: true, local_business: true } };
  it('is quiet when nothing changed and has no baseline alerts on the first scan', () => {
    expect(diffScans(base, base)).toEqual([]);
    expect(diffScans(null, base)).toEqual([]);
  });
  it('raises each regression kind', () => {
    const kinds = (n: typeof base) => diffScans(base, n).map((a) => a.kind);
    expect(kinds({ ...base, score: 55 })).toContain('score_drop');
    expect(kinds({ ...base, score: 61 })).not.toContain('score_drop');
    expect(kinds({ ...base, facts: { ...base.facts, hours: 'H2' } })).toContain('hours_changed');
    expect(kinds({ ...base, facts: { ...base.facts, feed_ready: false } })).toContain('feed_stale');
    expect(kinds({ ...base, site: { ok: true, local_business: false } })).toContain('site_regression');
    expect(kinds({ ...base, site: { ok: false } })).toContain('site_unreachable');
  });
  it('feed_stale is raised even on the first scan; facts are order-independent', () => {
    expect(diffScans(null, { ...base, facts: { ...base.facts, feed_ready: false } }).map((a) => a.kind)).toEqual(['feed_stale']);
    const a = buildFacts(snap({ hours: { mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' } } }));
    const b = buildFacts(snap({ hours: { tue: { open: '08:00', close: '17:00' }, mon: { open: '08:00', close: '17:00' } } }));
    expect(a.hours).toBe(b.hours);
  });
});

describe('runAccountScan', () => {
  it('scores, stores through the service RPC and returns the payload', async () => {
    const stored: unknown[] = [];
    const admin = { rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'agent_readiness_snapshot_internal') return { data: snap(), error: null };
      stored.push(args); return { data: 'scan-1', error: null };
    } };
    const d = deps({ 'https://acme-plumbing.com/robots.txt': () => new Response(''), 'https://acme-plumbing.com/': () => htmlRes(GOOD_HTML) }, OK_DNS);
    const r = await runAccountScan(admin, 'owner-1', 'manual', d);
    expect(r.ok && r.scanId).toBe('scan-1');
    expect(stored).toHaveLength(1);
    expect(r.ok && r.payload.site.ok).toBe(true);
    expect(r.ok && r.payload.fixes.some((f) => f.key === 'service_descriptions')).toBe(true);
  });
  it('records a failed site fetch instead of failing the scan', async () => {
    const admin = { rpc: async (fn: string) => (fn === 'agent_readiness_snapshot_internal' ? { data: snap(), error: null } : { data: 'scan-2', error: null }) };
    const r = await runAccountScan(admin, 'owner-1', 'weekly', deps({}, {}));
    expect(r.ok && r.payload.site).toMatchObject({ ok: false, code: 'blocked_address' });
    expect(r.ok && r.payload.subscores.find((s) => s.id === 'website')?.score).toBeNull();
  });
  it('reports a missing profile and a failed store', async () => {
    expect(await runAccountScan({ rpc: async () => ({ data: null, error: null }) }, 'o', 'manual', deps({}, {}))).toEqual({ ok: false, code: 'no_business_profile' });
    const bad = { rpc: async (fn: string) => (fn === 'agent_readiness_snapshot_internal' ? { data: snap({ business: { ...snap().business, website: null } }), error: null } : { data: null, error: { message: 'x' } }) };
    expect(await runAccountScan(bad, 'o', 'manual', deps({}, {}))).toEqual({ ok: false, code: 'store_failed' });
  });
});
