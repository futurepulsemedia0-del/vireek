import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// Regression guard for Apple Pay / Google Pay: a wrong CSP or Permissions-Policy hides the wallets
// with no visible error, and a malformed directive silently drops the whole directive.

interface HeaderRule { source: string; headers: { key: string; value: string }[] }
const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as { headers: HeaderRule[] };
const pageRule = config.headers.find((r) => r.source.startsWith('/((?!badge)'));

function header(key: string): string {
  const value = pageRule?.headers.find((h) => h.key === key)?.value;
  if (!value) throw new Error(`vercel.json is missing the ${key} header on the app routes`);
  return value;
}

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    map.set(name, values);
  }
  return map;
}

describe('Content-Security-Policy', () => {
  const csp = directives(header('Content-Security-Policy'));

  it('only contains well-formed directive names (a stray ";" would silently drop frame-src)', () => {
    for (const name of csp.keys()) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });

  it('lets Stripe.js load, talk to the Stripe API and render its iframes', () => {
    expect(csp.get('script-src')).toContain('https://js.stripe.com');
    expect(csp.get('connect-src')).toContain('https://api.stripe.com');
    expect(csp.get('frame-src')).toContain('https://js.stripe.com');
    expect(csp.get('frame-src')).toContain('https://hooks.stripe.com');
  });

  it('keeps the existing frame-src entries', () => {
    expect(csp.get('frame-src')).toContain("'self'");
    expect(csp.get('frame-src')).toContain('https://www.youtube-nocookie.com');
  });
});

describe('Permissions-Policy', () => {
  const policy = header('Permissions-Policy');
  const payment = policy.split(',').map((p) => p.trim()).find((p) => p.startsWith('payment='));

  it('delegates the Payment Request API (Google Pay) to Stripe instead of blocking it', () => {
    expect(payment).toBeDefined();
    expect(payment).not.toBe('payment=()');
    expect(payment).toContain('self');
    expect(payment).toContain('https://js.stripe.com');
  });

  it('still blocks features the app does not use', () => {
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('usb=()');
  });
});

describe('Apple Pay domain association file', () => {
  const file = resolve(root, 'public/.well-known/apple-developer-merchantid-domain-association');

  it('is committed under public/.well-known (download it from Stripe → Payment method domains)', () => {
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(100);
  });

  it('is served as plain text and not rewritten to the SPA shell', () => {
    const rule = config.headers.find((r) => r.source === '/.well-known/apple-developer-merchantid-domain-association');
    expect(rule?.headers.find((h) => h.key === 'Content-Type')?.value).toMatch(/^text\/plain/);
  });
});
