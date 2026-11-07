import { describe, it, expect } from 'vitest';
import { SafeFetchError, assertPublicHttpUrl, fetchPublicPage, fetchWithRobots, isBlockedHostname, isPrivateAddress, loadRobots, parseRobots, robotsAllows } from './safeFetch';

const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('SSRF protection', () => {
  const blocked = [
    'http://localhost/', 'http://127.0.0.1/', 'http://0.0.0.0/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/', 'http://2130706433/', 'http://0x7f000001/',
    'http://100.64.0.1/', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://example.com:8443/',
  ];
  for (const u of blocked) {
    it(`blocks ${u}`, () => {
      expect(() => assertPublicHttpUrl(u)).toThrow();
    });
  }
  it('allows a normal public site and strips the fragment', () => {
    expect(assertPublicHttpUrl('https://www.example.com/about#team').toString()).toBe('https://www.example.com/about');
  });
  it('classifies addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
  });
  it('blocks a hostname whose DNS answer is private (rebinding)', async () => {
    const fetchImpl = (() => Promise.resolve(html('hi'))) as typeof fetch;
    await expect(fetchPublicPage('https://evil.example.com/', { fetchImpl, resolveDns: async () => ['10.0.0.5'] })).rejects.toThrow(SafeFetchError);
  });
  it('refuses redirects to a different site and to private hosts', async () => {
    const redirect = (loc: string) => (() => Promise.resolve(new Response(null, { status: 302, headers: { location: loc } }))) as typeof fetch;
    await expect(fetchPublicPage('https://example.com/', { fetchImpl: redirect('https://other.com/') })).rejects.toThrow(/different site/);
    await expect(fetchPublicPage('https://example.com/', { fetchImpl: redirect('http://169.254.169.254/') })).rejects.toThrow();
  });
  it('follows a same-site www redirect', async () => {
    let n = 0;
    const fetchImpl = (() => (n++ === 0 ? Promise.resolve(new Response(null, { status: 301, headers: { location: 'https://www.example.com/' } })) : Promise.resolve(html('<p>ok</p>')))) as typeof fetch;
    const page = await fetchPublicPage('https://example.com/', { fetchImpl });
    expect(page.finalUrl).toBe('https://www.example.com/');
  });
  it('caps response size and rejects non-text content', async () => {
    await expect(fetchPublicPage('https://example.com/', { fetchImpl: (() => Promise.resolve(html('x'.repeat(5000)))) as typeof fetch, maxBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(fetchPublicPage('https://example.com/', { fetchImpl: (() => Promise.resolve(new Response('x', { headers: { 'content-type': 'application/pdf' } }))) as typeof fetch })).rejects.toThrow(/readable/);
  });
});

describe('robots.txt', () => {
  it('honours specific-agent groups, longest match and Allow overrides', () => {
    const r = parseRobots(['User-agent: *', 'Disallow: /private', 'Allow: /private/public', '', 'User-agent: VireekSarahBot', 'Disallow: /services/secret$'].join('\n'));
    expect(robotsAllows(r, '/services/secret')).toBe(false);
    expect(robotsAllows(r, '/services/secret/x')).toBe(true);
    expect(robotsAllows(r, '/private')).toBe(true); // specific group replaces "*"
    const star = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public');
    expect(robotsAllows(star, '/private/x')).toBe(false);
    expect(robotsAllows(star, '/private/public/x')).toBe(true);
    expect(robotsAllows(star, '/about')).toBe(true);
  });
  it('supports wildcards and empty Disallow', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow:');
    expect(robotsAllows(r, '/a/b.pdf')).toBe(false);
    expect(robotsAllows(r, '/a/b.html')).toBe(true);
  });
  it('fetchWithRobots refuses disallowed pages without requesting them', async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(html('x'));
    }) as typeof fetch;
    const robots = parseRobots('User-agent: *\nDisallow: /');
    await expect(fetchWithRobots('https://example.com/services', robots, { fetchImpl })).rejects.toThrow(/automated tools/);
    expect(called).toBe(false);
  });
  it('loadRobots: 404 = allowed, 500 = fail closed', async () => {
    const mk = (status: number) => (() => Promise.resolve(new Response('', { status }))) as typeof fetch;
    expect(robotsAllows(await loadRobots(new URL('https://example.com/'), { fetchImpl: mk(404) }), '/x')).toBe(true);
    expect(robotsAllows(await loadRobots(new URL('https://example.com/'), { fetchImpl: mk(500) }), '/x')).toBe(false);
  });
});
