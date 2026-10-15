import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  defaultHours,
  draftFromLocation,
  draftToPayload,
  emptyDraft,
  filterLocations,
  findInvalidHoursDay,
  formatAddress,
  formatHoursSummary,
  friendlyLocationError,
  isOpenNow,
  isValidTimezone,
  normalizeBrands,
  normalizeHours,
  normalizeLocation,
  normalizeLocations,
  normalizeTeamMembers,
  resolveActiveLocationId,
  sortLocations,
  summarizeLocations,
  validateBrand,
  validateDraft,
  type BusinessLocation,
} from './locations';
import { INDUSTRIES } from '@/lib/industries';
import { TRADE_SIGNALS, type ClimateTag } from '@/lib/locationSignals';
import { CITIES, allLocationPaths, buildLocalJsonLd, buildLocalPage, getCityBySlug } from '@/lib/locations';

function loc(over: Partial<BusinessLocation> = {}): BusinessLocation {
  return {
    id: 'l1', brand_id: null, brand_name: null, name: 'Downtown', code: null, status: 'active', is_primary: false,
    phone: null, email: null, address_line1: null, address_line2: null, city: null, state: null, postal_code: null,
    country: 'US', timezone: 'America/Los_Angeles', currency: 'USD', tax_rate_percent: 0, service_radius_miles: null,
    business_hours: defaultHours(), booking_enabled: true, after_hours_mode: 'ai_answer', forwarding_number: null,
    notes: null, member_count: 0, created_at: '', updated_at: '', ...over,
  };
}

describe('hours', () => {
  it('defaults to Mon–Fri 08:00–17:00 with a closed weekend', () => {
    expect(formatHoursSummary(defaultHours())).toBe('Mon–Fri 08:00–17:00 · Sat–Sun closed');
  });

  it('summarises uniform and fully closed weeks', () => {
    const all = normalizeHours({});
    for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] = { closed: false, open: '09:00', close: '18:00' };
    expect(formatHoursSummary(all)).toBe('Every day 09:00–18:00');
    for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] = { closed: true, open: '09:00', close: '18:00' };
    expect(formatHoursSummary(all)).toBe('Closed all week');
  });

  it('normalises garbage input to safe defaults and keeps valid days', () => {
    expect(normalizeHours(null)).toEqual(defaultHours());
    const h = normalizeHours({ mon: { closed: true, open: 'nope', close: '25:99' }, tue: 'x' });
    expect(h.mon).toEqual({ closed: true, open: '08:00', close: '17:00' });
    expect(h.tue).toEqual(defaultHours().tue);
  });

  it('finds the first day whose close is not after open', () => {
    const h = defaultHours();
    expect(findInvalidHoursDay(h)).toBeNull();
    h.wed = { closed: false, open: '17:00', close: '08:00' };
    expect(findInvalidHoursDay(h)).toBe('wed');
    h.wed = { closed: true, open: '17:00', close: '08:00' };
    expect(findInvalidHoursDay(h)).toBeNull();
  });

  it('computes open/closed in the location timezone', () => {
    const h = defaultHours();
    expect(isOpenNow(h, 'America/Los_Angeles', new Date('2026-06-15T19:00:00Z'))).toBe(true); // Mon 12:00 PDT
    expect(isOpenNow(h, 'America/Los_Angeles', new Date('2026-06-16T03:30:00Z'))).toBe(false); // Mon 20:30 PDT
    expect(isOpenNow(h, 'America/Los_Angeles', new Date('2026-06-21T19:00:00Z'))).toBe(false); // Sunday, closed
    expect(isOpenNow(h, 'Not/AZone', new Date())).toBeNull();
  });
});

describe('timezone', () => {
  it('validates IANA names', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('normalisation', () => {
  it('rejects rows without id/name and fills every default', () => {
    expect(normalizeLocation(null)).toBeNull();
    expect(normalizeLocation({ id: 'x' })).toBeNull();
    const l = normalizeLocation({ id: 'x', name: 'HQ', status: 'weird', tax_rate_percent: '8.25', business_hours: 5 });
    expect(l?.status).toBe('active');
    expect(l?.tax_rate_percent).toBe(8.25);
    expect(l?.country).toBe('US');
    expect(l?.business_hours).toEqual(defaultHours());
    expect(l?.member_count).toBe(0);
  });

  it('reads the embedded brand name and member count', () => {
    const l = normalizeLocation({ id: 'x', name: 'HQ', brand: { name: 'Acme HVAC' }, members: [{ count: 4 }] });
    expect(l?.brand_name).toBe('Acme HVAC');
    expect(l?.member_count).toBe(4);
  });

  it('drops invalid rows from lists and counts only non-archived locations per brand', () => {
    const list = normalizeLocations([{ id: 'a', name: 'A', brand_id: 'b1' }, { id: 'b', name: 'B', brand_id: 'b1', status: 'archived' }, { nope: 1 }]);
    expect(list).toHaveLength(2);
    const brands = normalizeBrands([{ id: 'b1', name: 'Acme', primary_color: 'red' }, { id: 5 }], list);
    expect(brands).toHaveLength(1);
    expect(brands[0].location_count).toBe(1);
    expect(brands[0].primary_color).toBeNull();
  });

  it('builds a readable team member label', () => {
    const m = normalizeTeamMembers([{ id: 't1', member_email: 'a@b.co' }, { id: 't2', member_name: 'Sam', role: 'technician' }, {}]);
    expect(m.map((x) => x.name)).toEqual(['a@b.co', 'Sam']);
    expect(m[1].role).toBe('technician');
  });
});

describe('validateDraft', () => {
  const ok = () => emptyDraft({ name: 'Downtown', timezone: 'America/Chicago' });

  it('accepts a minimal valid draft', () => {
    expect(validateDraft(ok())).toEqual({});
  });

  it('requires a name and caps its length', () => {
    expect(validateDraft({ ...ok(), name: '  ' }).name).toBeTruthy();
    expect(validateDraft({ ...ok(), name: 'x'.repeat(81) }).name).toBeTruthy();
  });

  it('checks code format and uniqueness (ignoring the location being edited)', () => {
    expect(validateDraft({ ...ok(), code: 'bad code!' }).code).toBeTruthy();
    const others = [{ id: 'l2', code: 'DT-1' }];
    expect(validateDraft({ ...ok(), code: 'dt-1' }, others, null).code).toBeTruthy();
    expect(validateDraft({ ...ok(), code: 'dt-1' }, others, 'l2').code).toBeUndefined();
  });

  it('validates phone, email, tax, radius and timezone', () => {
    const e = validateDraft({ ...ok(), phone: 'abc', email: 'nope', tax_rate_percent: '45', service_radius_miles: '1.5', timezone: 'x/y' });
    expect(Object.keys(e).sort()).toEqual(['email', 'phone', 'service_radius_miles', 'tax_rate_percent', 'timezone']);
  });

  it('flags invalid hours and requires a number when forwarding after hours', () => {
    const d = ok();
    d.business_hours.mon = { closed: false, open: '18:00', close: '09:00' };
    d.after_hours_mode = 'forward';
    const e = validateDraft(d);
    expect(e.business_hours).toContain('Monday');
    expect(e.forwarding_number).toBeTruthy();
  });
});

describe('draft ⇄ payload', () => {
  it('converts blanks to null, uppercases codes and rounds tax', () => {
    const p = draftToPayload({ ...emptyDraft({ name: '  HQ ', timezone: 'UTC' }), country: 'us', currency: 'usd', tax_rate_percent: '8.12345', brand_id: '' });
    expect(p.name).toBe('HQ');
    expect(p.country).toBe('US');
    expect(p.currency).toBe('USD');
    expect(p.tax_rate_percent).toBe(8.123);
    expect(p.brand_id).toBeNull();
    expect(p.phone).toBeNull();
    expect(p.service_radius_miles).toBeNull();
  });

  it('round-trips an existing location through the form', () => {
    const l = loc({ code: 'DT', brand_id: 'b1', phone: '+1 555 010 2000', tax_rate_percent: 7.5, service_radius_miles: 25, status: 'paused' });
    const p = draftToPayload(draftFromLocation(l));
    expect(p.code).toBe('DT');
    expect(p.brand_id).toBe('b1');
    expect(p.tax_rate_percent).toBe(7.5);
    expect(p.service_radius_miles).toBe(25);
    expect(p.status).toBe('paused');
  });
});

describe('validateBrand', () => {
  const existing = [{ id: 'b1', name: 'Acme' }];
  it('validates name, duplicates, website and color', () => {
    expect(validateBrand('', '', '', existing)).toBeTruthy();
    expect(validateBrand('acme', '', '', existing)).toBeTruthy();
    expect(validateBrand('acme', '', '', existing, 'b1')).toBeNull();
    expect(validateBrand('New', 'ftp://x', '', existing)).toBeTruthy();
    expect(validateBrand('New', 'https://x.co', 'blue', existing)).toBeTruthy();
    expect(validateBrand('New', 'https://x.co', '#12AB9f', existing)).toBeNull();
  });
});

describe('list helpers', () => {
  const list = [
    loc({ id: 'a', name: 'Zeta', status: 'active' }),
    loc({ id: 'b', name: 'Alpha', status: 'archived' }),
    loc({ id: 'c', name: 'Mid', status: 'paused', city: 'Austin', brand_name: 'Acme' }),
    loc({ id: 'd', name: 'Prime', status: 'active', is_primary: true }),
  ];

  it('sorts primary first, archived last, then by name', () => {
    expect(sortLocations(list).map((l) => l.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('filters by status and free text; "all" hides archived', () => {
    expect(filterLocations(list, 'all', '').map((l) => l.id)).toEqual(['a', 'c', 'd']);
    expect(filterLocations(list, 'archived', '').map((l) => l.id)).toEqual(['b']);
    expect(filterLocations(list, 'all', 'austin').map((l) => l.id)).toEqual(['c']);
    expect(filterLocations(list, 'all', 'ACME').map((l) => l.id)).toEqual(['c']);
  });

  it('summarises counts', () => {
    expect(summarizeLocations(list, [{ id: 'b1', name: 'Acme', website_url: null, primary_color: null, location_count: 1 }])).toEqual({
      total: 3, active: 2, paused: 1, archived: 1, brands: 1,
    });
  });

  it('formats addresses and skips empty parts', () => {
    expect(formatAddress({ address_line1: '1 Main St', address_line2: null, city: 'Austin', state: 'TX', postal_code: '78701' })).toBe('1 Main St · Austin, TX 78701');
    expect(formatAddress({ address_line1: null, address_line2: null, city: null, state: null, postal_code: null })).toBe('');
  });

  it('resolves the active location with sensible fallbacks', () => {
    expect(resolveActiveLocationId(list, 'c')).toBe('c');
    expect(resolveActiveLocationId(list, 'b')).toBe('d'); // archived → primary
    expect(resolveActiveLocationId(list, 'missing')).toBe('d');
    expect(resolveActiveLocationId([], null)).toBeNull();
    expect(resolveActiveLocationId([loc({ id: 'z', status: 'archived' })], 'z')).toBeNull();
  });
});

describe('friendlyLocationError', () => {
  it('maps duplicates and permission errors, hides internals', () => {
    expect(friendlyLocationError({ code: '23505', message: 'duplicate key value violates unique constraint "idx_business_locations_code_unique"' }, 'x')).toContain('code');
    expect(friendlyLocationError({ code: '42501', message: 'new row violates row-level security policy' }, 'x')).toContain('permission');
    expect(friendlyLocationError({ message: 'relation "business_locations" does not exist' }, 'Fallback')).toBe('Fallback');
    expect(friendlyLocationError({ message: 'Make another location primary before archiving this one.' }, 'x')).toContain('primary');
  });
});

// ───────────────────────── Programmatic SEO location pages ─────────────────────────

const TAGS: ClimateTag[] = ['extreme-heat', 'humid-heat', 'hurricane', 'severe-storm', 'hard-freeze', 'monsoon', 'wet-mild'];
const pages = INDUSTRIES.flatMap((i) => CITIES.map((c) => ({ i, c, p: buildLocalPage(i, c) })));
const words = (p: ReturnType<typeof buildLocalPage>, c: (typeof CITIES)[number]) =>
  [p.intro, c.seasonNote, c.housingNote, ...p.drivers.map((d) => d.text), ...p.faq.flatMap((f) => [f.q, f.a])].join(' ').split(/\s+/).length;

describe('locations data', () => {
  it('has unique city slugs with valid tags and suburbs', () => {
    expect(new Set(CITIES.map((c) => c.slug)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(c.tags.length).toBeGreaterThan(0);
      expect(c.suburbs.length).toBeGreaterThanOrEqual(5);
      expect(getCityBySlug(c.slug)).toBe(c);
    }
  });
  it('defines every climate signal for every trade', () => {
    for (const i of INDUSTRIES) for (const t of TAGS) expect(TRADE_SIGNALS[i.slug]?.[t], `${i.slug}/${t}`).toBeTruthy();
  });
});

describe('programmatic pages', () => {
  it('generates one page per city x trade with unique SEO fields and content', () => {
    expect(pages).toHaveLength(CITIES.length * INDUSTRIES.length);
    for (const key of ['title', 'description', 'canonical', 'intro'] as const) {
      expect(new Set(pages.map((x) => x.p[key])).size, key).toBe(pages.length);
    }
  });
  it('keeps meta lengths sane and content substantial', () => {
    for (const { p, c } of pages) {
      expect(p.description.length, p.path).toBeLessThanOrEqual(165);
      expect(p.title.length, p.path).toBeLessThanOrEqual(75);
      expect(words(p, c), p.path).toBeGreaterThanOrEqual(220);
    }
  });
  it('emits valid schema.org markup', () => {
    const { i, c, p } = pages[0];
    const ld = buildLocalJsonLd(i, c, p);
    expect(ld.map((x) => x['@type'])).toEqual(['BreadcrumbList', 'Service', 'FAQPage']);
    expect(ld.every((x) => x['@context'] === 'https://schema.org')).toBe(true);
    expect((ld[1].areaServed as { name: string }).name).toBe(c.name);
    expect(JSON.parse(JSON.stringify(ld))).toEqual(ld);
  });
});

describe('sitemap registration', () => {
  it('lists every /locations URL (run `npm run sitemap:locations` if this fails)', () => {
    const xml = readFileSync(join(process.cwd(), 'public/sitemap.xml'), 'utf8');
    const missing = allLocationPaths().filter((p) => !xml.includes(`<loc>https://vireek.com${p}</loc>`));
    expect(missing).toEqual([]);
  });
});
