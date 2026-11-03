import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Rule { source: string; headers: { key: string; value: string }[] }
const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: Rule[] };
const valueOf = (key: string): string | undefined => config.headers.flatMap((r) => r.headers).find((h) => h.key === key)?.value;

describe('vercel.json security headers', () => {
  it('sends HSTS for at least one year with subdomains', () => {
    const v = valueOf('Strict-Transport-Security') ?? '';
    expect(Number(/max-age=(\d+)/.exec(v)?.[1] ?? 0)).toBeGreaterThanOrEqual(31_536_000);
    expect(v).toContain('includeSubDomains');
  });

  it('sets the baseline hardening headers', () => {
    expect(valueOf('X-Content-Type-Options')).toBe('nosniff');
    expect(valueOf('Referrer-Policy')).toBeTruthy();
    expect(valueOf('Permissions-Policy')).toBeTruthy();
    expect(valueOf('X-Frame-Options')).toBe('DENY');
  });

  it('has a CSP without unsafe-inline/unsafe-eval for scripts and no plugins', () => {
    const csp = config.headers.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy' && h.value.includes('default-src \'self\'; script-src'))?.value ?? '';
    const script = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
  });

  it('serves llms.txt and security.txt as text/plain', () => {
    const rule = config.headers.find((r) => r.source.includes('llms'));
    expect(rule?.headers.find((h) => h.key === 'Content-Type')?.value).toContain('text/plain');
  });
});

describe('security.txt (RFC 9116)', () => {
  const txt = readFileSync('public/.well-known/security.txt', 'utf8');

  it('has Contact, Canonical and Policy', () => {
    expect(txt).toMatch(/^Contact: /m);
    expect(txt).toMatch(/^Canonical: https:\/\/vireek\.com\/\.well-known\/security\.txt$/m);
    expect(txt).toMatch(/^Policy: https:\/\//m);
  });

  it('expires between 30 days and 1 year from now (renew before it lapses)', () => {
    const exp = Date.parse(/^Expires: (.+)$/m.exec(txt)?.[1] ?? '');
    const days = (exp - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(366);
  });
});
