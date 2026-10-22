import { describe, it, expect } from 'vitest';
import {
  TYPE_META,
  buildDefaults,
  buildWidgetSnippet,
  formatPercent,
  friendlySaveError,
  getReadinessIssues,
  hasErrors,
  isHttpsUrl,
  normalizeSettings,
  sanitizeOptions,
  settingsEqual,
  starFills,
  summarizeStats,
  validateSettings,
  withOptions,
  type WidgetSettings,
} from './websiteWidgets';

describe('defaults & normalisation', () => {
  it('builds valid defaults for every type', () => {
    for (const t of ['booking', 'quote', 'reviews'] as const) {
      expect(hasErrors(validateSettings(buildDefaults(t)))).toBe(false);
      expect(buildDefaults(t).title).toBe(TYPE_META[t].defaultTitle);
    }
  });
  it('reviews default to inline, others to floating', () => {
    expect(buildDefaults('reviews').display_mode).toBe('inline');
    expect(buildDefaults('booking').display_mode).toBe('floating');
  });
  it('fills gaps and clamps junk from the database', () => {
    const s = normalizeSettings('reviews', { radius: 99, options: { layout: 'weird', max_excerpts: 50, min_rating: 0, platforms: ['nope'] } as never });
    expect(s.radius).toBe(24);
    expect(s.options).toMatchObject({ layout: 'badge', max_excerpts: 5, min_rating: 1, platforms: ['google', 'yelp', 'facebook'] });
  });
  it('null row -> defaults', () => {
    expect(settingsEqual(normalizeSettings('quote', null), buildDefaults('quote'))).toBe(true);
  });
  it('sanitises custom services (trim, dedupe, cap)', () => {
    const o = sanitizeOptions('quote', { services_mode: 'custom', custom_services: [' A ', 'A', '', 5, ...Array.from({ length: 40 }, (_, i) => `S${i}`)] });
    expect((o as { custom_services: string[] }).custom_services).toHaveLength(30);
    expect((o as { custom_services: string[] }).custom_services[0]).toBe('A');
  });
  it('withOptions keeps other options', () => {
    const s = withOptions(buildDefaults('quote') as Extract<WidgetSettings, { widget_type: 'quote' }>, { ask_zip: true });
    expect(s.options.ask_zip).toBe(true);
    expect(s.options.contact_required).toBe('either');
  });
});

describe('validateSettings', () => {
  it('flags bad colour, long copy, empty button on forms', () => {
    const s = { ...buildDefaults('booking'), brand_color: 'red', title: 'x'.repeat(61), button_label: ' ' };
    const e = validateSettings(s);
    expect(e.brand_color).toBeTruthy();
    expect(e.title).toBeTruthy();
    expect(e.button_label).toBeTruthy();
  });
  it('reviews may have an empty link label', () => {
    expect(validateSettings({ ...buildDefaults('reviews'), button_label: '' }).button_label).toBeUndefined();
  });
  it('custom services list must not be empty when selected', () => {
    const s = withOptions(buildDefaults('quote') as Extract<WidgetSettings, { widget_type: 'quote' }>, { services_mode: 'custom' });
    expect(validateSettings(s).custom_services).toBeTruthy();
  });
  it('review CTA must be https', () => {
    const base = buildDefaults('reviews') as Extract<WidgetSettings, { widget_type: 'reviews' }>;
    expect(validateSettings(withOptions(base, { cta_url: 'javascript:alert(1)' })).cta_url).toBeTruthy();
    expect(validateSettings(withOptions(base, { cta_url: 'http://x.com' })).cta_url).toBeTruthy();
    expect(validateSettings(withOptions(base, { cta_url: 'https://g.page/r/abc' })).cta_url).toBeUndefined();
    expect(isHttpsUrl('https://a b.com')).toBe(false);
  });
  it('needs at least one platform and limits domains', () => {
    const base = buildDefaults('reviews') as Extract<WidgetSettings, { widget_type: 'reviews' }>;
    expect(validateSettings(withOptions(base, { platforms: [] })).platforms).toBeTruthy();
    expect(validateSettings({ ...base, allowed_domains: Array.from({ length: 21 }, (_, i) => `a${i}.com`) }).allowed_domains).toBeTruthy();
  });
});

describe('readiness', () => {
  const ctx = { bookingEnabled: true, bookingSlug: 'acme', serviceCount: 3, reviewCount: 10 };
  it('booking needs online booking enabled', () => {
    expect(getReadinessIssues(buildDefaults('booking'), ctx)).toEqual([]);
    expect(getReadinessIssues(buildDefaults('booking'), { ...ctx, bookingEnabled: false })).toHaveLength(1);
    expect(getReadinessIssues(buildDefaults('booking'), { ...ctx, bookingSlug: null })).toHaveLength(1);
  });
  it('reviews need synced reviews', () => {
    expect(getReadinessIssues(buildDefaults('reviews'), { ...ctx, reviewCount: 0 })).toHaveLength(1);
    expect(getReadinessIssues(withOptions(buildDefaults('reviews') as Extract<WidgetSettings, { widget_type: 'reviews' }>, { min_reviews: 20 }), ctx)[0]).toMatch(/10 reviews/);
    expect(getReadinessIssues(buildDefaults('reviews'), ctx)).toEqual([]);
  });
  it('quote warns when no services exist', () => {
    expect(getReadinessIssues(buildDefaults('quote'), { ...ctx, serviceCount: 0 })).toHaveLength(1);
  });
});

describe('buildWidgetSnippet', () => {
  const base = { origin: 'https://app.vireek.com/', publicKey: 'ww_abc', supabaseUrl: 'https://x.supabase.co/', supabaseAnonKey: 'anon"<' };
  it('floating = script only, escaped', () => {
    const out = buildWidgetSnippet({ ...base, type: 'booking', mode: 'floating' });
    expect(out).toContain('src="https://app.vireek.com/website-widgets.js"');
    expect(out).toContain('data-api="https://x.supabase.co"');
    expect(out).toContain('data-anon="anon&quot;&lt;"');
    expect(out).not.toContain('data-vireek-widget');
  });
  it('inline adds the mount div', () => {
    const out = buildWidgetSnippet({ ...base, type: 'reviews', mode: 'inline' });
    expect(out).toContain('<div data-vireek-widget="ww_abc"></div>');
    expect(out.indexOf('<div')).toBeLessThan(out.indexOf('<script'));
  });
});

describe('summarizeStats', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const rows = [
    { widget_id: 'w', day: '2026-10-20', views: 10, opens: 4, conversions: 2 },
    { widget_id: 'w', day: '2026-10-19', views: 5, opens: 1, conversions: 0 },
    { widget_id: 'w', day: '2026-08-01', views: 999, opens: 999, conversions: 999 },
  ];
  it('sums only the window and zero-fills the series', () => {
    const s = summarizeStats(rows, 7, now);
    expect(s).toMatchObject({ views: 15, opens: 5, conversions: 2 });
    expect(s.series).toHaveLength(7);
    expect(s.series[6]).toEqual({ day: '2026-10-20', views: 10, conversions: 2 });
    expect(s.series[0].views).toBe(0);
  });
  it('rates are null without views and never exceed 100%', () => {
    expect(summarizeStats([], 7, now).openRate).toBeNull();
    expect(summarizeStats([{ widget_id: 'w', day: '2026-10-20', views: 1, opens: 5, conversions: 9 }], 7, now).conversionRate).toBe(1);
  });
  it('formats percentages', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.034)).toBe('3.4%');
    expect(formatPercent(0.4)).toBe('40%');
  });
});

describe('misc', () => {
  it('starFills', () => {
    expect(starFills(4.3)).toEqual([1, 1, 1, 1, 0.3]);
    expect(starFills(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFills(9)).toEqual([1, 1, 1, 1, 1]);
    expect(starFills(NaN)).toEqual([0, 0, 0, 0, 0]);
  });
  it('friendlySaveError', () => {
    expect(friendlySaveError(new Error('WIDGET_FORBIDDEN'))).toMatch(/permission/);
    expect(friendlySaveError({ message: 'new row violates row-level security policy' })).toMatch(/permission/);
    expect(friendlySaveError(new Error('boom'))).toBe('Could not save. Please try again.');
  });
});
