// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_BOX, buildView, type ViewInput } from './core';

const SRC = readFileSync(join(process.cwd(), 'public/embed/badge.v1.js'), 'utf8');
const ORIGIN = 'https://vireek.com';

const baseView: ViewInput = {
  state: 'ok', variant: 'tiny', theme: 'auto', palette: 'blue', locale: 'en', stat: null,
  verifyHref: `${ORIGIN}/verify/acme?t=tok`, rel: ['nofollow'], card: { phone: null, bookingUrl: null }, poweredByHref: null,
};

interface Run { host: HTMLElement | null; script: HTMLScriptElement; fetchMock: ReturnType<typeof vi.fn> }

async function run(attrs: Record<string, string>, respond: () => Promise<unknown>, nav: Record<string, unknown> = {}): Promise<Run> {
  document.body.innerHTML = '<p id="before">x</p>';
  const script = document.createElement('script');
  script.setAttribute('src', `${ORIGIN}/embed/badge.v1.js`);
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(`data-${k}`, v);
  document.body.appendChild(script);
  const fetchMock = vi.fn(respond);
  const fakeDoc = { currentScript: script, createElement: document.createElement.bind(document), querySelector: document.querySelector.bind(document) };
  const fakeNav = { language: 'en-US', ...nav };
  const fakeLoc = { hostname: 'acme.com' };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'window', 'navigator', 'location', 'fetch', 'URLSearchParams', SRC)(fakeDoc, window, fakeNav, fakeLoc, fetchMock, URLSearchParams);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { host: script.nextElementSibling as HTMLElement | null, script, fetchMock };
}
const json = (v: unknown) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(v) });

describe('loader budget', () => {
  it('is under 3 KB raw (and far smaller gzipped)', () => {
    expect(Buffer.byteLength(SRC)).toBeLessThan(3072);
    expect(gzipSync(SRC).length).toBeLessThan(2000);
  });
  it('never touches cookies, storage or script injection', () => {
    expect(SRC).not.toMatch(/cookie|localStorage|sessionStorage|indexedDB|innerHTML|insertAdjacentHTML|eval\(|ld\+json|document\.write/);
  });
});

describe('size table', () => {
  it('matches BADGE_BOX (the dashboard preview uses it)', () => {
    const m = /Z=\{(.*?)\}\[V\]/.exec(SRC)!;
    const parsed = Function(`return ({${m[1]}})`)() as typeof BADGE_BOX;
    expect(parsed).toEqual(BADGE_BOX);
  });
});

describe('loader behaviour', () => {
  // Force the <style> fallback by default so CSS can be asserted; the dedicated test below covers the constructable-stylesheet path.
  beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('CSSStyleSheet', undefined); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reserves the final size synchronously (no layout shift) and renders inside a Shadow DOM', async () => {
    let sizeAtRequest = { w: '', h: '' };
    const r = await run({ slug: 'acme', variant: 'tiny', size: 'md' }, () => {
      const h = document.querySelector('script')!.nextElementSibling as HTMLElement;
      sizeAtRequest = { w: h.style.width, h: h.style.height };
      return json(buildView(baseView))();
    });
    expect(sizeAtRequest).toEqual({ w: '240px', h: '34px' });
    expect(r.host!.shadowRoot).not.toBeNull();
    const a = r.host!.shadowRoot!.querySelector('a.m')!;
    expect(a.getAttribute('aria-label')).toContain('Verify this badge');
    expect(a.getAttribute('rel')).toBe('noopener nofollow');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('href')).toBe(`${ORIGIN}/verify/acme?t=tok`);
    expect(r.host!.shadowRoot!.textContent).toContain('Calls answered 24/7 by Vireek');
    expect(r.host!.style.display).not.toBe('none');
  });

  it('sends only what is needed: slug, variant, host, DNT; no credentials', async () => {
    const r = await run({ slug: 'acme', variant: 'stat', theme: 'dark', lang: 'fa' }, json(buildView({ ...baseView, variant: 'stat' })), { doNotTrack: '1' });
    const url = new URL(r.fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/badge-api/render`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ k: 'acme', v: 'stat', t: 'dark', l: 'fa', h: 'acme.com', dnt: '1' });
    expect(JSON.stringify(r.fetchMock.mock.calls[0][1])).not.toMatch(/include|cookie/i);
    expect(document.cookie).toBe('');
  });

  it('honours Global Privacy Control as Do Not Track', async () => {
    const r = await run({ slug: 'acme' }, json(buildView(baseView)), { globalPrivacyControl: true });
    expect(new URL(r.fetchMock.mock.calls[0][0] as string).searchParams.get('dnt')).toBe('1');
  });

  it.each([
    ['hidden state', { s: 'hidden' }],
    ['garbage', 'nope'],
    ['missing palette', { s: 'ok', h: 'https://x', x: 'a' }],
    ['null', null],
  ])('collapses silently on %s', async (_n, payload) => {
    const r = await run({ slug: 'acme' }, json(payload));
    expect(r.host!.style.display).toBe('none');
  });

  it('collapses (no throw, no error UI) when offline or the API errors', async () => {
    const off = await run({ slug: 'acme' }, () => Promise.reject(new TypeError('Failed to fetch')));
    expect(off.host!.style.display).toBe('none');
    const err = await run({ slug: 'acme' }, () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    expect(err.host!.style.display).toBe('none');
  });

  it('does nothing without a slug, with an unknown variant, or when not served over https', async () => {
    expect((await run({}, json(buildView(baseView)))).fetchMock).not.toHaveBeenCalled();
    expect((await run({ slug: 'a', variant: 'evil' }, json(buildView(baseView)))).fetchMock).not.toHaveBeenCalled();
    document.body.innerHTML = '';
    const s = document.createElement('script'); s.setAttribute('src', 'http://vireek.com/embed/badge.v1.js'); s.setAttribute('data-slug', 'a'); document.body.appendChild(s);
    const f = vi.fn();
    new Function('document', 'window', 'navigator', 'location', 'fetch', 'URLSearchParams', SRC)({ currentScript: s, createElement: document.createElement.bind(document) }, window, {}, { hostname: 'a.com' }, f, URLSearchParams);
    expect(f).not.toHaveBeenCalled();
  });

  it('neutralises hostile values from a tampered response (javascript: URLs, CSS injection)', async () => {
    const view = { ...buildView({ ...baseView, variant: 'card', card: { phone: '+15125550123', bookingUrl: 'https://vireek.com/book/a' } }) };
    view.h = 'javascript:alert(1)';
    view.c = [{ x: 'Go', h: 'javascript:alert(2)' }, { x: 'Call', h: 'tel:+15125550123' }];
    view.p = { l: ['red;}body{display:none', '#111111', '#111111', '#111111'], d: ['#000000', '#ffffff', '#ffffff', '#ffffff'] };
    const r = await run({ slug: 'acme', variant: 'card' }, json(view));
    const root = r.host!.shadowRoot!;
    const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('#');
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false);
    expect(root.querySelector('style')!.textContent).not.toContain('display:none');
    expect(root.querySelector('script')).toBeNull();
    expect(document.querySelectorAll('script[type="application/ld+json"]').length).toBe(0);
  });

  it('card renders both actions and powered-by; RTL sets dir', async () => {
    const view = buildView({ ...baseView, variant: 'card', locale: 'ar', card: { phone: '+15125550123', bookingUrl: 'https://vireek.com/book/a' }, poweredByHref: 'https://vireek.com/?utm_source=trust_badge' });
    const r = await run({ slug: 'acme', variant: 'card', lang: 'ar' }, json(view));
    const root = r.host!.shadowRoot!;
    expect(root.querySelectorAll('.c a').length).toBe(2);
    expect(root.querySelector('a.p')!.getAttribute('rel')).toBe('noopener nofollow');
    expect(root.querySelector('.w')!.getAttribute('dir')).toBe('rtl');
    expect(root.querySelector('.w')!.getAttribute('lang')).toBe('ar');
  });

  it('styles are applied without an inline <style> when constructable stylesheets exist (strict style-src CSP)', async () => {
    const sheets: string[] = [];
    class FakeSheet { replaceSync(c: string) { sheets.push(c); } }
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const r = await run({ slug: 'acme' }, json(buildView(baseView)));
    expect(sheets.length).toBe(1);
    expect(sheets[0]).toContain('a:focus-visible');
    expect(r.host!.shadowRoot!.querySelector('style')).toBeNull();
  });

  it('no animation at all (reduced-motion safe) and a visible focus style', async () => {
    const r = await run({ slug: 'acme' }, json(buildView(baseView)));
    const css = r.host!.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).not.toMatch(/animation|@keyframes|transition/);
    expect(css).toContain('a:focus-visible');
  });

  it('dark/auto themes add the dark palette (auto via prefers-color-scheme)', async () => {
    const auto = await run({ slug: 'acme', theme: 'auto' }, json(buildView({ ...baseView, theme: 'auto' })));
    expect(auto.host!.shadowRoot!.querySelector('style')!.textContent).toContain('prefers-color-scheme:dark');
    const light = await run({ slug: 'acme', theme: 'light' }, json(buildView({ ...baseView, theme: 'light' })));
    expect(light.host!.shadowRoot!.querySelector('style')!.textContent).not.toContain('prefers-color-scheme');
  });

  it('consent="wait" makes no request until consent is granted', async () => {
    const r = await run({ slug: 'acme', consent: 'wait' }, json(buildView(baseView)));
    expect(r.fetchMock).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('vireek-badge-consent'));
    await new Promise((x) => setTimeout(x, 0));
    expect(r.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second execution for the same tag does nothing', async () => {
    const r = await run({ slug: 'acme' }, json(buildView(baseView)));
    const fakeDoc = { currentScript: r.script, createElement: document.createElement.bind(document) };
    const f2 = vi.fn();
    new Function('document', 'window', 'navigator', 'location', 'fetch', 'URLSearchParams', SRC)(fakeDoc, window, {}, { hostname: 'a' }, f2, URLSearchParams);
    expect(f2).not.toHaveBeenCalled();
  });
});
