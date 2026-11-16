import { describe, expect, it } from 'vitest';
import { computeDrift, summarizeDrift } from './drift';

const it1 = (id: string, price: number, active = true) => ({ external_id: id, service_name: `s${id}`, price_cents: price, active });

describe('computeDrift', () => {
  it('reports no drift for identical sets', () => {
    expect(computeDrift([it1('1', 100), it1('2', 200)], [it1('2', 200), it1('1', 100)]).total).toBe(0);
  });
  it('detects price changes, new remote items and items gone from the provider', () => {
    const r = computeDrift([it1('1', 100), it1('2', 200)], [it1('1', 150), it1('3', 300)]);
    expect(r.price_mismatch).toEqual([{ external_id: '1', vireek_cents: 100, provider_cents: 150 }]);
    expect(r.missing_in_vireek).toEqual(['3']);
    expect(r.missing_in_provider).toEqual(['2']);
    expect(r.total).toBe(3);
  });
  it('ignores inactive remote items that Vireek never had, and already-inactive local items', () => {
    expect(computeDrift([it1('2', 200, false)], [it1('9', 5, false)]).total).toBe(0);
  });
  it('detects an active-flag mismatch', () => {
    expect(computeDrift([it1('1', 100, true)], [it1('1', 100, false)]).active_mismatch).toHaveLength(1);
  });
  it('summarizeDrift caps stored details', () => {
    const many = Array.from({ length: 100 }, (_, i) => it1(String(i), 1));
    expect(summarizeDrift(computeDrift([], many), 25).missing_in_vireek).toHaveLength(25);
  });
});
