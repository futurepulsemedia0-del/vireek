import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  buildLocalBusinessJsonLd,
  buildReadiness,
  serializeJsonLd,
  type FeedPreview,
  type GoogleBookingSettings,
} from './googleBooking';

const settings: GoogleBookingSettings = {
  user_id: 'u', feed_enabled: true, structured_data_enabled: true, partner_status: 'not_applied', horizon_days: 14,
};
const preview = (over: Partial<FeedPreview> = {}): FeedPreview => ({
  preview: true, blocked: null, timezone: 'UTC', capacity_mode: 'business_wide', published_slots: 5,
  next_slots: [], services: ['Drain'], slug: 'acme', ...over,
});

describe('buildReadiness', () => {
  it('passes everything but partner approval when healthy', () => {
    const checks = buildReadiness({ preview: preview(), settings, activeAreaCount: 2 });
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['partner']);
  });

  it('reports the first failing step and defers later ones', () => {
    const checks = buildReadiness({ preview: preview({ blocked: 'timezone_missing', published_slots: 0 }), settings, activeAreaCount: 0 });
    expect(checks[0].ok).toBe(true);
    expect(checks[1].ok).toBe(false);
    expect(checks[1].hint).toMatch(/timezone/i);
    expect(checks[2].ok).toBe(false);
    expect(checks[2].hint).toMatch(/above first/i);
  });

  it('fails closed without a preview', () => {
    const checks = buildReadiness({ preview: null, settings: null, activeAreaCount: 0 });
    expect(checks.every((c) => !c.ok)).toBe(true);
  });
});

describe('buildLocalBusinessJsonLd', () => {
  const data = { name: 'Acme Plumbing', services: ['Drain', 'Drain', ' Heater '], areas: ['North'], hours: { mon: { open: '08:00', close: '17:00' }, xyz: { open: '1', close: '2' } } };

  it('builds a valid LocalBusiness with a ReserveAction', () => {
    const ld = buildLocalBusinessJsonLd(data, 'https://app.vireek.com/book/acme')!;
    expect(ld['@type']).toBe('HomeAndConstructionBusiness');
    expect((ld.potentialAction as { '@type': string })['@type']).toBe('ReserveAction');
    expect((ld.hasOfferCatalog as { itemListElement: unknown[] }).itemListElement).toHaveLength(2); // de-duplicated + trimmed
    expect(ld.openingHoursSpecification).toEqual([{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '08:00', closes: '17:00' }]);
  });

  it('refuses incomplete or non-https input', () => {
    expect(buildLocalBusinessJsonLd({ ...data, name: ' ' }, 'https://x.com/book/a')).toBeNull();
    expect(buildLocalBusinessJsonLd(data, 'http://x.com/book/a')).toBeNull();
  });

  it('cannot break out of the script tag', () => {
    const ld = buildLocalBusinessJsonLd({ ...data, name: '</script><b>' }, 'https://x.com/book/a')!;
    expect(serializeJsonLd(ld)).not.toContain('</script>');
  });
});
