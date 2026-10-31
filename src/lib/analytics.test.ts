import { beforeEach, describe, expect, it, vi } from 'vitest';

const GA = 'G-TEST123456';
const gaScripts = () =>
  Array.from(document.querySelectorAll('script')).filter((s) => /googletagmanager\.com/.test(s.src));

async function fresh() {
  vi.resetModules();
  vi.stubEnv('VITE_GA4_MEASUREMENT_ID', GA);
  const engine = await import('@/lib/consent/engine');
  engine.__resetConsentForTests();
  const analytics = await import('@/lib/analytics');
  return { engine, analytics };
}

beforeEach(() => {
  localStorage.clear();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  Reflect.deleteProperty(window, 'dataLayer');
  Reflect.deleteProperty(window, 'gtag');
  Reflect.deleteProperty(window, `ga-disable-${GA}`);
});

describe('analytics gating', () => {
  it('injects no Google script and sends nothing before consent', async () => {
    const { analytics } = await fresh();
    analytics.trackPageview('/');
    analytics.trackEvent('x');
    expect(gaScripts()).toHaveLength(0);
    expect(window.dataLayer ?? []).toHaveLength(0);
    expect(analytics.hasAnalyticsConsent()).toBe(false);
  });

  it('stays silent after Reject non-essential', async () => {
    const { engine, analytics } = await fresh();
    engine.rejectNonEssential();
    analytics.trackEvent('x');
    expect(gaScripts()).toHaveLength(0);
  });

  it('loads GA once on accept, with Consent Mode v2 defaults denied before config', async () => {
    const { engine, analytics } = await fresh();
    engine.acceptAll();
    expect(gaScripts()).toHaveLength(1);
    const calls = (window.dataLayer as ArrayLike<unknown>[]).map((a) => Array.from(a));
    const idxDefault = calls.findIndex((c) => c[0] === 'consent' && c[1] === 'default');
    const idxConfig = calls.findIndex((c) => c[0] === 'config');
    expect(idxDefault).toBeGreaterThanOrEqual(0);
    expect(idxDefault).toBeLessThan(idxConfig);
    expect(calls[idxDefault][2]).toMatchObject({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    analytics.trackEvent('hello');
    expect(calls.length).toBeLessThan((window.dataLayer as unknown[]).length);
  });

  it('pushes real Arguments objects (gtag.js ignores plain arrays)', async () => {
    const { engine } = await fresh();
    engine.acceptAll();
    const first = (window.dataLayer as unknown[])[0];
    expect(Object.prototype.toString.call(first)).toBe('[object Arguments]');
  });

  it('withdrawal disables hits, denies storage and deletes _ga cookies at once', async () => {
    const { engine, analytics } = await fresh();
    engine.acceptAll();
    document.cookie = '_ga=GA1.1.1; path=/';
    document.cookie = `_ga_TEST123456=GS1; path=/`;
    const before = (window.dataLayer as unknown[]).length;
    engine.rejectNonEssential();
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA}`]).toBe(true);
    expect(document.cookie).not.toMatch(/_ga/);
    const afterWithdraw = (window.dataLayer as unknown[]).length;
    analytics.trackEvent('after-withdrawal');
    analytics.trackPageview('/x');
    expect((window.dataLayer as unknown[]).length).toBe(afterWithdraw);
    expect(afterWithdraw).toBeGreaterThan(before); // the consent "denied" update itself
    expect(gaScripts()).toHaveLength(1); // not re-injected
  });

  it('re-granting after withdrawal re-enables hits without a second script', async () => {
    const { engine, analytics } = await fresh();
    engine.acceptAll();
    engine.rejectNonEssential();
    engine.acceptAll();
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA}`]).toBe(false);
    expect(gaScripts()).toHaveLength(1);
    const n = (window.dataLayer as unknown[]).length;
    analytics.trackEvent('again');
    expect((window.dataLayer as unknown[]).length).toBe(n + 1);
  });

  it('never reports wallboard token paths', async () => {
    const { engine, analytics } = await fresh();
    engine.acceptAll();
    const n = (window.dataLayer as unknown[]).length;
    analytics.trackPageview('/wallboard/secret-token');
    expect((window.dataLayer as unknown[]).length).toBe(n);
  });
});
