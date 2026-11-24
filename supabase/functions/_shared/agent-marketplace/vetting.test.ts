// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fieldsExposedBy, projectCustomer, projectJob } from './contract';
import {
  isReportFresh, levenshtein, normalizeManifest, parseDeclaredDomains, reportAllowsApproval, runStaticVetting,
  type ScopeInfo, type VettingInput,
} from './vetting';

const CATALOG: ScopeInfo[] = [
  { slug: 'read:jobs', kind: 'read', risk: 'low' },
  { slug: 'read:job_financials', kind: 'read', risk: 'medium' },
  { slug: 'read:customers', kind: 'read', risk: 'medium' },
  { slug: 'read:customer_contact', kind: 'read', risk: 'high' },
  { slug: 'act:record_insight', kind: 'act', risk: 'low' },
  { slug: 'act:create_task', kind: 'act', risk: 'medium' },
  { slug: 'act:send_sms', kind: 'act', risk: 'high' },
];

const base = (over: Partial<VettingInput> = {}): VettingInput => ({
  agent: { slug: 'acme-hvac', name: 'Acme Furnace Helper', publisherName: 'Acme Ltd', publisherId: 'p1', runtime: 'webhook', endpointUrl: 'https://agents.acme.example/hook' },
  manifest: { scopes: ['read:jobs', 'act:record_insight'], triggers: ['manual'] },
  scopeCatalog: CATALOG,
  peers: { hostMatches: [], firstPartyNames: ['HVAC Diagnostic Agent', 'Plumbing Agent'], otherAgentNames: [] },
  dns: { ok: true, addresses: ['93.184.216.34'] },
  ...over,
});
const find = (r: ReturnType<typeof runStaticVetting>, id: string) => r.checks.find((c) => c.id === id)!;

describe('runStaticVetting', () => {
  it('passes a minimal low-risk agent', () => {
    const r = runStaticVetting(base());
    expect(r.verdict).toBe('pass');
    expect(r.riskTier).toBe('low');
    expect(r.outboundDomains).toEqual(['agents.acme.example']);
    expect(r.summary.fail).toBe(0);
  });

  it('is deterministic and returns every check id exactly once', () => {
    const a = runStaticVetting(base());
    const b = runStaticVetting(base());
    expect(a).toEqual(b);
    const ids = a.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(14);
  });

  it('fails on a malformed manifest and unknown scopes', () => {
    expect(find(runStaticVetting(base({ manifest: 'nope' })), 'manifest.shape').status).toBe('fail');
    expect(find(runStaticVetting(base({ manifest: { scopes: [], triggers: ['manual'] } })), 'manifest.shape').status).toBe('fail');
    expect(find(runStaticVetting(base({ manifest: { scopes: ['read:jobs'], triggers: ['bogus'] } })), 'manifest.shape').status).toBe('fail');
    const r = runStaticVetting(base({ manifest: { scopes: ['read:jobs', 'root:everything'], triggers: ['manual'] } }));
    expect(find(r, 'scopes.known').status).toBe('fail');
    expect(r.riskTier).toBe('high');
    expect(r.verdict).toBe('fail');
  });

  it('flags high-risk scopes and PII exposure', () => {
    const r = runStaticVetting(base({ manifest: { scopes: ['read:jobs', 'read:customers', 'read:customer_contact', 'act:send_sms'], triggers: ['manual'] } }));
    expect(r.riskTier).toBe('high');
    expect(find(r, 'scopes.risk').status).toBe('warn');
    expect(find(r, 'data.exposure').status).toBe('warn');
    expect(r.dataExposure.classification).toBe('contact_pii');
    expect(r.dataExposure.customerFields).toContain('phone');
    expect(find(r, 'data.messaging').status).toBe('warn');
    expect(r.verdict).toBe('warn');
  });

  it('requires a processor declaration when contact data is requested', () => {
    const scopes = ['read:jobs', 'read:customers', 'read:customer_contact', 'act:send_sms'];
    const none = runStaticVetting(base({ manifest: { scopes, triggers: ['manual'] } }));
    expect(find(none, 'outbound.declared').status).toBe('warn');
    const empty = runStaticVetting(base({ manifest: { scopes, triggers: ['manual'], outbound_domains: [] } }));
    expect(find(empty, 'outbound.declared').status).toBe('pass');
    const some = runStaticVetting(base({ manifest: { scopes, triggers: ['manual'], outbound_domains: ['api.twilio.example'] } }));
    expect(some.outboundDomains).toEqual(['agents.acme.example', 'api.twilio.example']);
  });

  it('detects dead or over-broad scope combinations', () => {
    const sms = runStaticVetting(base({ manifest: { scopes: ['read:jobs', 'act:send_sms'], triggers: ['manual'] } }));
    expect(find(sms, 'scopes.coherence').status).toBe('warn');
    const contactOnly = runStaticVetting(base({ manifest: { scopes: ['read:jobs', 'read:customers', 'read:customer_contact'], triggers: ['manual'] } }));
    expect(find(contactOnly, 'scopes.coherence').evidence?.join(' ')).toContain('no messaging purpose');
  });

  it('rejects unsafe endpoints', () => {
    const bad = ['http://acme.example/h', 'https://localhost/h', 'https://10.0.0.1/h', 'https://acme.example:8443/h', 'https://user:pw@acme.example/h', 'https://[::1]/h', 'https://intranet'];
    for (const endpointUrl of bad) {
      const r = runStaticVetting(base({ agent: { ...base().agent, endpointUrl } }));
      expect(find(r, 'outbound.endpoint').status).toBe('fail');
      expect(r.verdict).toBe('fail');
    }
    const missing = runStaticVetting(base({ agent: { ...base().agent, endpointUrl: null } }));
    expect(find(missing, 'outbound.endpoint').status).toBe('fail');
  });

  it('checks DNS answers', () => {
    expect(find(runStaticVetting(base({ dns: { ok: true, addresses: ['10.1.2.3'] } })), 'outbound.dns').status).toBe('fail');
    expect(find(runStaticVetting(base({ dns: { ok: true, addresses: ['93.184.216.34', '::1'] } })), 'outbound.dns').status).toBe('fail');
    expect(find(runStaticVetting(base({ dns: { ok: true, addresses: [] } })), 'outbound.dns').status).toBe('fail');
    expect(find(runStaticVetting(base({ dns: { ok: false, error: 'NXDOMAIN' } })), 'outbound.dns').status).toBe('fail');
    const skipped = runStaticVetting({ ...base(), dns: undefined });
    expect(find(skipped, 'outbound.dns').status).toBe('warn');
    expect(skipped.verdict).toBe('warn');
  });

  it('warns on punycode hosts and hosts shared with other publishers', () => {
    const idn = runStaticVetting(base({ agent: { ...base().agent, endpointUrl: 'https://xn--acme-9ua.example/h' } }));
    expect(find(idn, 'outbound.host').status).toBe('warn');
    const shared = runStaticVetting(base({ peers: { ...base().peers, hostMatches: ['other-agent'] } }));
    expect(find(shared, 'outbound.host').evidence?.join(' ')).toContain('other-agent');
  });

  it('flags first-party impersonation and look-alike names', () => {
    const imp = runStaticVetting(base({ agent: { ...base().agent, publisherName: 'Vireek Official' } }));
    expect(find(imp, 'identity.publisher').status).toBe('fail');
    const imp2 = runStaticVetting(base({ agent: { ...base().agent, name: 'V.i.r.e.e.k Support' } }));
    expect(find(imp2, 'identity.publisher').status).toBe('fail');
    const fp = runStaticVetting(base({ agent: { ...base().agent, publisherId: null, publisherName: 'Vireek', runtime: 'builtin', endpointUrl: null } }));
    expect(find(fp, 'identity.publisher').status).toBe('pass');
    const twin = runStaticVetting(base({ agent: { ...base().agent, name: 'HVAC Diagnostic Agent' } }));
    expect(find(twin, 'identity.lookalike').status).toBe('warn');
    const near = runStaticVetting(base({ agent: { ...base().agent, name: 'HVAC Diagnostic Agnt' } }));
    expect(find(near, 'identity.lookalike').status).toBe('warn');
    expect(find(runStaticVetting(base()), 'identity.lookalike').status).toBe('pass');
  });

  it('rejects system_prompt on webhook agents and warns on high limits', () => {
    const p = runStaticVetting(base({ manifest: { scopes: ['read:jobs'], triggers: ['manual'], system_prompt: 'x' } }));
    expect(find(p, 'manifest.prompt').status).toBe('fail');
    const l = runStaticVetting(base({ manifest: { scopes: ['read:jobs'], triggers: ['manual'], limits: { timeout_ms: 15000, max_actions: 9 } } }));
    expect(find(l, 'manifest.limits').status).toBe('warn');
    const out = runStaticVetting(base({ manifest: { scopes: ['read:jobs'], triggers: ['manual'], limits: { timeout_ms: 99999 } } }));
    expect(find(out, 'manifest.shape').status).toBe('fail');
  });

  it('does not mutate its input', () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    runStaticVetting(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('parseDeclaredDomains', () => {
  it('accepts clean hostnames and dedupes', () => {
    expect(parseDeclaredDomains(['A.example.com', 'a.example.com ', 'b.example.com']).domains).toEqual(['a.example.com', 'b.example.com']);
    expect(parseDeclaredDomains(undefined)).toEqual({ domains: [], errors: [] });
  });
  it('rejects URLs, paths, IPs, internal names and oversize lists', () => {
    for (const bad of ['https://a.example.com', 'a.example.com/x', '10.0.0.1', 'localhost', 'a.local', '', 'exa mple.com']) {
      expect(parseDeclaredDomains([bad]).errors).toHaveLength(1);
    }
    expect(parseDeclaredDomains('x').errors).toHaveLength(1);
    expect(parseDeclaredDomains(Array.from({ length: 11 }, (_, i) => `d${i}.example.com`)).errors).toHaveLength(1);
  });
});

describe('fieldsExposedBy agrees with projectJob / projectCustomer', () => {
  const ALL = CATALOG.map((s) => s.slug);
  const probe = (granted: string[]) => {
    const f = fieldsExposedBy(ALL);
    const jobRow: Record<string, unknown> = {};
    for (const k of f.jobs) jobRow[k] = 1;
    const custRow: Record<string, unknown> = {};
    for (const k of f.customers) custRow[k] = 1;
    return { job: Object.keys(projectJob(jobRow, granted)).sort(), cust: Object.keys(projectCustomer(custRow, granted)).sort(), f: fieldsExposedBy(granted) };
  };
  const combos = [[], ['read:jobs'], ['read:jobs', 'read:job_financials'], ['read:customers'], ['read:jobs', 'read:customers', 'read:customer_contact'], ['read:customer_contact'], ALL];
  for (const granted of combos) {
    it(`matches for [${granted.join(',')}]`, () => {
      const p = probe(granted);
      expect(p.f.jobs.slice().sort()).toEqual(p.job);
      expect(p.f.customers.slice().sort()).toEqual(p.cust);
    });
  }
});

describe('helpers', () => {
  it('normalizeManifest tolerates garbage', () => {
    expect(normalizeManifest(null).errors.length).toBeGreaterThan(0);
    expect(normalizeManifest({ scopes: ['read:jobs', 'read:jobs'], triggers: ['manual'] }).scopes).toEqual(['read:jobs']);
  });
  it('levenshtein', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
  it('report gate and freshness', () => {
    expect(reportAllowsApproval({ verdict: 'fail' })).toBe(false);
    expect(reportAllowsApproval({ verdict: 'warn' })).toBe(true);
    const now = new Date('2029-03-20T00:00:00Z');
    expect(isReportFresh('2029-03-10T00:00:00Z', now)).toBe(true);
    expect(isReportFresh('2029-02-01T00:00:00Z', now)).toBe(false);
    expect(isReportFresh('2029-03-21T00:00:00Z', now)).toBe(false);
    expect(isReportFresh('garbage', now)).toBe(false);
  });
});
