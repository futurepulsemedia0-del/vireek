/** Key modes, IP allowlist, sandbox data and deprecation headers (all pure, from the api-v1 contract). */
import { describe, expect, it } from 'vitest';
import edgeFunctionSource from '../../supabase/functions/api-v1/index.ts?raw';
import {
  RESOURCES,
  SANDBOX_RECORD_COUNT,
  checkEdgeFunctionSource,
  clientIp,
  deprecationHeaders,
  ipAllowed,
  isUuid,
  keyModeOfPrefix,
  parseAllowlistInput,
  parseIp,
  parseIpRule,
  sandboxRecords,
  sandboxResponse,
  type ApiResourceName,
} from '../../supabase/functions/api-v1/contract';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('IP parsing and allowlist', () => {
  it('matches exact addresses and CIDR boundaries', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
    expect(ipAllowed('203.0.113.255', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.0', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.0.0.0', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('1.2.3.3', ['9.9.9.9', '1.2.3.0/30'])).toBe(true);
    expect(ipAllowed('1.2.3.4', ['9.9.9.9', '1.2.3.0/30'])).toBe(false);
  });

  it('handles IPv6, compressed forms and IPv4-mapped addresses', () => {
    expect(ipAllowed('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('2001:0db8:0000:0000:0000:0000:0000:0005', ['2001:db8::5'])).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.9', ['203.0.113.9'])).toBe(true);
    expect(ipAllowed('203.0.113.9', ['::ffff:203.0.113.0/120'])).toBe(true);
    expect(ipAllowed('::1', ['127.0.0.1'])).toBe(false);
  });

  it('empty list means any address; a list with an unknown address fails closed', () => {
    expect(ipAllowed('8.8.8.8', [])).toBe(true);
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed(null, ['8.8.8.8'])).toBe(false);
    expect(ipAllowed('not-an-ip', ['8.8.8.8'])).toBe(false);
  });

  it('ignores malformed rules instead of matching them', () => {
    expect(ipAllowed('1.2.3.4', ['garbage', '1.2.3.4/99'])).toBe(false);
  });

  it('rejects malformed addresses and /0 rules', () => {
    for (const bad of [
      '256.1.1.1',
      '1.2.3',
      '01.2.3.4',
      '1.2.3.4.5',
      '2001:::1',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
      '',
      ' ',
    ])
      expect(parseIp(bad)).toBeNull();
    for (const bad of ['0.0.0.0/0', '::/0', '1.2.3.4/33', '1.2.3.4/x', '1.2.3.4/8/8'])
      expect(parseIpRule(bad)).toBeNull();
  });

  it('clientIp trusts only platform headers, never X-Forwarded-For', () => {
    expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.10' }))).toBe('203.0.113.10');
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.9' }))).toBeNull();
    expect(clientIp(headers({ 'cf-connecting-ip': 'junk', 'x-real-ip': '198.51.100.1' }))).toBe(
      '198.51.100.1',
    );
  });

  it('parseAllowlistInput accepts separators, dedupes and explains errors', () => {
    expect(parseAllowlistInput('1.2.3.4, 10.0.0.0/8\n1.2.3.4')).toEqual({
      ok: true,
      list: ['1.2.3.4', '10.0.0.0/8'],
    });
    expect(parseAllowlistInput('')).toEqual({ ok: true, list: [] });
    expect(parseAllowlistInput('1.2.3.4 nope')).toMatchObject({
      ok: false,
      error: expect.stringContaining('"nope"'),
    });
    expect(
      parseAllowlistInput(Array.from({ length: 21 }, (_, i) => `10.0.0.${i + 1}`).join(' ')),
    ).toMatchObject({ ok: false });
  });
});

describe('test-mode sandbox data', () => {
  const names = RESOURCES.map((r) => r.name as ApiResourceName);

  it('is deterministic and has valid, unique ids', () => {
    for (const name of names) {
      const recs = sandboxRecords(name);
      expect(recs).toHaveLength(SANDBOX_RECORD_COUNT);
      expect(new Set(recs.map((r) => r.id)).size).toBe(SANDBOX_RECORD_COUNT);
      for (const r of recs) expect(isUuid(r.id as string)).toBe(true);
      expect(sandboxRecords(name)).toEqual(recs);
    }
  });

  it('matches the documented field list: required fields present with the right types, and livemode:false', () => {
    for (const def of RESOURCES) {
      for (const rec of sandboxRecords(def.name)) {
        expect(rec.livemode).toBe(false);
        for (const f of def.fields) {
          const v = rec[f.name];
          if (v === null || v === undefined) {
            expect(f.nullable, `${def.name}.${f.name} must not be null`).toBe(true);
            continue;
          }
          if (f.type === 'array') expect(Array.isArray(v)).toBe(true);
          else if (f.type === 'integer') expect(Number.isInteger(v)).toBe(true);
          else expect(typeof v).toBe(f.type);
        }
      }
    }
  });

  it('never contains real-looking account data', () => {
    for (const name of names)
      expect(JSON.stringify(sandboxRecords(name))).not.toMatch(/Jordan Lee|742 Evergreen/);
  });

  it('paginates newest-first with before/next_before until every record is seen exactly once', () => {
    for (const name of names) {
      const seen: string[] = [];
      let before: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const page = sandboxResponse(name, null, 7, before) as {
          data: { id: string; created_at: string }[];
          has_more: boolean;
          next_before: string | null;
        };
        seen.push(...page.data.map((r) => r.id));
        if (page.data.length < 7) break;
        before = page.next_before;
      }
      expect(seen).toHaveLength(SANDBOX_RECORD_COUNT);
      expect(new Set(seen).size).toBe(SANDBOX_RECORD_COUNT);
    }
  });

  it('gets by id (case-insensitive) and returns null for unknown ids', () => {
    const id = sandboxRecords('leads')[3].id as string;
    expect(sandboxResponse('leads', id.toUpperCase(), 25, null)).toEqual({
      data: sandboxRecords('leads')[3],
    });
    expect(sandboxResponse('leads', '3f2b8c1e-7a4d-4e0b-9c5a-1d2e3f4a5b6c', 25, null)).toBeNull();
  });
});

describe('deprecation headers and key mode', () => {
  it('sends nothing when nothing is deprecated (today)', () => {
    expect(deprecationHeaders('calls')).toEqual({});
    expect(deprecationHeaders(null)).toEqual({});
  });

  it('emits Deprecation (RFC 9745), Sunset (RFC 8594) and a deprecation Link', () => {
    const list = [
      {
        resource: 'jobs' as const,
        deprecatedAt: '2027-01-01T00:00:00Z',
        sunsetAt: '2027-04-01T00:00:00Z',
        link: 'https://vireek.com/migrate',
      },
    ];
    expect(deprecationHeaders('jobs', list)).toEqual({
      Deprecation: '@1798761600',
      Sunset: 'Thu, 01 Apr 2027 00:00:00 GMT',
      Link: '<https://vireek.com/migrate>; rel="deprecation"',
    });
    expect(deprecationHeaders('calls', list)).toEqual({});
  });

  it('reads the mode from the key prefix', () => {
    expect(keyModeOfPrefix('vrk_test_abc')).toBe('test');
    expect(keyModeOfPrefix('vrk_live_abc')).toBe('live');
  });
});

describe('index.ts security guards', () => {
  it('passes for the real function and fails if X-Forwarded-For is trusted or sandbox/allowlist are removed', () => {
    expect(checkEdgeFunctionSource(edgeFunctionSource)).toEqual([]);
    expect(
      checkEdgeFunctionSource(`${edgeFunctionSource}\nreq.headers.get("X-Forwarded-For");`).join(
        ' ',
      ),
    ).toMatch(/Forwarded/);
    expect(
      checkEdgeFunctionSource(edgeFunctionSource.replaceAll('ipAllowed(', 'x(')).join(' '),
    ).toMatch(/allowlist/);
    expect(
      checkEdgeFunctionSource(edgeFunctionSource.replaceAll('sandboxResponse(', 'x(')).join(' '),
    ).toMatch(/sandbox/);
  });

  it('checks the allowlist before any data access and serves test keys before the real query', () => {
    const iAllow = edgeFunctionSource.indexOf('ipAllowed(');
    const iRate = edgeFunctionSource.indexOf('api_v1_rate_limit_ok');
    const iSandbox = edgeFunctionSource.indexOf('sandboxResponse(');
    const iQuery = edgeFunctionSource.indexOf('admin.from(route.table)');
    expect(iAllow).toBeGreaterThan(0);
    expect(iAllow).toBeLessThan(iRate);
    expect(iSandbox).toBeLessThan(iQuery);
  });
});
