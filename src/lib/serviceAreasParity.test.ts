import { describe, it, expect, vi } from 'vitest';

// Keeps the client library and the Deno edge port honest: same inputs, same answers.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import * as client from './serviceAreas';
import * as edge from '../../supabase/functions/_shared/service-areas/resolve';

const SQUARE: [number, number][] = [
  [30, -98],
  [30, -97],
  [31, -97],
  [31, -98],
];

const base = {
  user_id: 'o',
  color: '#3b82f6',
  notes: null,
  updated_at: '2027-01-01T00:00:00.000Z',
  created_at: '2027-01-01T00:00:00.000Z',
  is_active: true,
  priority: 0,
  travel_fee_cents: 2500,
  surge_enabled: true,
  surge_multiplier: 1.5,
  surge_ends_at: null,
};

const areas = [
  {
    ...base,
    id: 'z',
    name: 'Zip',
    zone_type: 'zip' as const,
    zip_codes: ['78701', 'K1A'],
    polygon: null,
  },
  {
    ...base,
    id: 'p',
    name: 'Poly',
    zone_type: 'polygon' as const,
    zip_codes: [],
    polygon: SQUARE,
    priority: 3,
  },
];

describe('client ↔ edge parity', () => {
  it.each(['78701', '78701-9999', 'k1a 0b1', '99999', 'abc', ' 1234 '])(
    'normalizePostalCode(%j)',
    (v) => {
      expect(edge.normalizePostalCode(v)).toBe(client.normalizePostalCode(v));
    },
  );

  it.each([
    '1 Main St, Austin TX 78701',
    'Ottawa ON K1N 8S7',
    'no code here',
    '12345 Oak Ave 90210-1234',
  ])('extractPostalCode(%j)', (v) => {
    expect(edge.extractPostalCode(v)).toBe(client.extractPostalCode(v));
  });

  it.each([
    [{ postalCode: '78701' }],
    [{ postalCode: '78701', latitude: 30.5, longitude: -97.5 }],
    [{ latitude: 30.5, longitude: -97.5 }],
    [{ latitude: 45, longitude: -97.5 }],
    [{ postalCode: '99999', latitude: 45, longitude: 10 }],
    [{}],
  ])('resolveServiceArea(%j)', (q) => {
    const a = client.resolveServiceArea(areas as never, q);
    const b = edge.resolveServiceArea(areas as never, q);
    expect(b.status).toBe(a.status);
    if (a.status === 'in_area' && b.status === 'in_area') expect(b.area.id).toBe(a.area.id);
  });

  it('computeAreaQuote matches', () => {
    const now = new Date('2027-03-01T00:00:00.000Z');
    expect(edge.computeAreaQuote(areas[0] as never, 12345, now)).toEqual(
      client.computeAreaQuote(areas[0] as never, 12345, now),
    );
  });

  it('out-of-area replies match', () => {
    for (const mode of ['decline', 'waitlist', 'transfer'] as const) {
      expect(edge.outOfAreaReply({ out_of_area_mode: mode, out_of_area_message: null })).toBe(
        client.outOfAreaReply({ out_of_area_mode: mode, out_of_area_message: null }),
      );
    }
    expect(edge.outOfAreaReply(null)).toBe(client.outOfAreaReply(null));
  });
});
