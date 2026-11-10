import { describe, it, expect } from 'vitest';
import { createMockTaxProvider, createPackTaxProvider, createTaxService, requireOkTax, TaxProviderError, type TaxProvider, type TaxQuoteRequest } from './taxProvider';

const noSleep = async () => {};
const DE_CTX: TaxQuoteRequest['context'] = {
  sellerCountry: 'DE', siteCountry: 'DE', supplyDate: '2026-10-20',
  registrations: [{ scheme: 'VAT', number: 'DE123456789', country: 'DE' }],
};
const QC_CTX: TaxQuoteRequest['context'] = {
  sellerCountry: 'CA', sellerSubdivision: 'QC', siteCountry: 'CA', siteSubdivision: 'QC', supplyDate: '2026-10-20',
  registrations: [
    { scheme: 'GST_HST', number: '123456789RT0001', country: 'CA' },
    { scheme: 'QST', number: '1234567890TQ0001', country: 'CA', subdivision: 'QC' },
  ],
};
let n = 0;
const key = () => `doc:${++n}:rev1`;
const req = (o: Partial<TaxQuoteRequest>): TaxQuoteRequest => ({
  idempotencyKey: key(), mode: 'exclusive', currency: 'EUR', lines: [{ id: 'a', amountMinor: 10000 }], context: DE_CTX, ...o,
});

describe('exclusive (net) pricing', () => {
  const svc = createTaxService(createPackTaxProvider(), { sleep: noSleep });
  it('adds VAT on top of net', async () => {
    const r = await svc.quote(req({}));
    expect(r).toMatchObject({ netMinor: 10000, taxMinor: 1900, grossMinor: 11900, mode: 'exclusive', provider: 'regional-packs', inclusiveResidualMinor: 0 });
  });
  it('handles credit notes (negative lines) symmetrically', async () => {
    const r = await svc.quote(req({ lines: [{ id: 'a', amountMinor: -10000 }] }));
    expect(r).toMatchObject({ netMinor: -10000, taxMinor: -1900, grossMinor: -11900 });
  });
  it('zero-rated and exempt lines carry no tax', async () => {
    const r = await svc.quote(req({ lines: [{ id: 'a', amountMinor: 5000, category: 'zero' }, { id: 'b', amountMinor: 5000, category: 'exempt' }, { id: 'c', amountMinor: 1000 }] }));
    expect(r.taxMinor).toBe(190);
    expect(r.lines.map((l) => l.taxMinor)).toEqual([0, 0, 190]);
  });
  it('Quebec: GST + QST are both applied with exact thousandths', async () => {
    const r = await svc.quote(req({ currency: 'CAD', context: QC_CTX, lines: [{ id: 'a', amountMinor: 2000 }] }));
    expect(r.status).toBe('ok');
    expect(r.breakdown.map((b) => [b.code, b.ratePct, b.taxMinor])).toEqual([['GST', 5, 100], ['QST', 9.975, 200]]);
    expect(r.grossMinor).toBe(2300);
  });
});

describe('inclusive (gross / shelf) pricing', () => {
  const svc = createTaxService(createPackTaxProvider(), { sleep: noSleep });
  it('backs net and tax out of a VAT-inclusive price and preserves the shelf price', async () => {
    const r = await svc.quote(req({ mode: 'inclusive', lines: [{ id: 'a', amountMinor: 11900 }] }));
    expect(r).toMatchObject({ netMinor: 10000, taxMinor: 1900, grossMinor: 11900, mode: 'inclusive', inclusiveResidualMinor: 0 });
  });
  it('splits a multi-line, mixed-category basket and keeps Σgross exact', async () => {
    const lines = [{ id: 'a', amountMinor: 11900 }, { id: 'b', amountMinor: 5000, category: 'zero' as const }, { id: 'c', amountMinor: 333 }];
    const r = await svc.quote(req({ mode: 'inclusive', lines }));
    expect(r.grossMinor).toBe(17233);
    expect(r.lines.find((l) => l.id === 'b')).toMatchObject({ taxMinor: 0, netMinor: 5000 });
    expect(r.netMinor + r.taxMinor).toBe(r.grossMinor);
  });
  it('works for multi-component Quebec tax (14.975% combined)', async () => {
    const r = await svc.quote(req({ mode: 'inclusive', currency: 'CAD', context: QC_CTX, lines: [{ id: 'a', amountMinor: 11498 }] }));
    expect(r.grossMinor + r.inclusiveResidualMinor).toBe(11498);
    expect(Math.abs(r.inclusiveResidualMinor)).toBeLessThanOrEqual(1);
    expect(r.netMinor).toBe(10000);
  });
  it('credit notes: negative inclusive amounts mirror positive ones', async () => {
    const pos = await svc.quote(req({ mode: 'inclusive', lines: [{ id: 'a', amountMinor: 11900 }] }));
    const neg = await svc.quote(req({ mode: 'inclusive', lines: [{ id: 'a', amountMinor: -11900 }] }));
    expect(neg.netMinor).toBe(-pos.netMinor);
    expect(neg.taxMinor).toBe(-pos.taxMinor);
  });
  it('zero-decimal currency (JPY, 10% flat): ¥1,100 → ¥1,000 + ¥100', async () => {
    const mock = createTaxService(createMockTaxProvider({ ratePct: 10 }), { sleep: noSleep });
    const r = await mock.quote(req({ mode: 'inclusive', currency: 'JPY', lines: [{ id: 'a', amountMinor: 1100 }] }));
    expect(r).toMatchObject({ netMinor: 1000, taxMinor: 100, grossMinor: 1100 });
  });
  it('SWEEP: every shelf price 1..4000 at 19% lands within 1 minor unit, and flags any residual', async () => {
    let exact = 0; let off = 0;
    for (let g = 1; g <= 4000; g++) {
      const r = await svc.quote(req({ mode: 'inclusive', lines: [{ id: 'a', amountMinor: g }] }));
      expect(r.netMinor + r.taxMinor).toBe(r.grossMinor);
      expect(r.grossMinor + r.inclusiveResidualMinor).toBe(g);
      expect(Math.abs(r.inclusiveResidualMinor)).toBeLessThanOrEqual(1);
      if (r.inclusiveResidualMinor === 0) exact += 1;
      else { off += 1; expect(r.warnings.some((w) => w.code === 'INCLUSIVE_RESIDUAL')).toBe(true); }
    }
    // Independent oracle: a shelf price g is exactly reachable iff some net n has n + round(0.19·n) = g.
    const reachable = new Set<number>();
    for (let net = 0; net <= 4000; net++) reachable.add(net + Math.floor((net * 19 + 50) / 100));
    let expectedExact = 0;
    for (let g = 1; g <= 4000; g++) if (reachable.has(g)) expectedExact += 1;
    expect(exact).toBe(expectedExact); // exact precisely when mathematically possible
    expect(exact + off).toBe(4000);
  });
});

describe('idempotency', () => {
  it('the same key + payload hits the provider once', async () => {
    const mock = createMockTaxProvider();
    const svc = createTaxService(mock, { sleep: noSleep });
    const r = req({});
    const [a, b] = await Promise.all([svc.quote(r), svc.quote({ ...r })]);
    await svc.quote(r);
    expect(a).toEqual(b);
    expect(mock.calls).toHaveLength(1);
  });
  it('the same key with a different payload is rejected', async () => {
    const svc = createTaxService(createMockTaxProvider(), { sleep: noSleep });
    const r = req({});
    await svc.quote(r);
    await expect(svc.quote({ ...r, lines: [{ id: 'a', amountMinor: 1 }] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('failures are not cached, so a retry with the same key can succeed', async () => {
    const mock = createMockTaxProvider({ failFirst: 1 });
    const svc = createTaxService(mock, { maxAttempts: 1, sleep: noSleep });
    const r = req({});
    await expect(svc.quote(r)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(svc.quote(r)).resolves.toMatchObject({ taxMinor: 1000 });
  });
});

describe('reliability', () => {
  it('retries retryable outages with backoff and then succeeds', async () => {
    const waits: number[] = [];
    const mock = createMockTaxProvider({ failFirst: 2 });
    const svc = createTaxService(mock, { sleep: async (ms) => { waits.push(ms); } });
    await expect(svc.quote(req({}))).resolves.toMatchObject({ taxMinor: 1000 });
    expect(mock.calls).toHaveLength(3);
    expect(waits).toEqual([200, 400]);
  });
  it('gives up after maxAttempts', async () => {
    const mock = createMockTaxProvider({ failFirst: 9 });
    const svc = createTaxService(mock, { maxAttempts: 3, sleep: noSleep });
    await expect(svc.quote(req({}))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(mock.calls).toHaveLength(3);
  });
  it('never retries a rejection', async () => {
    const mock = createMockTaxProvider({ rejectWith: 'bad address' });
    const svc = createTaxService(mock, { sleep: noSleep });
    await expect(svc.quote(req({}))).rejects.toMatchObject({ code: 'PROVIDER_REJECTED', message: 'bad address' });
    expect(mock.calls).toHaveLength(1);
  });
  it('honours cancellation', async () => {
    const svc = createTaxService(createMockTaxProvider(), { sleep: noSleep });
    const ac = new AbortController(); ac.abort();
    await expect(svc.quote(req({}), { signal: ac.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('rejects a provider that returns inconsistent money', async () => {
    const liar: TaxProvider = {
      id: 'liar',
      async calculate(r) {
        return { status: 'ok', currency: r.currency, netMinor: 100, taxMinor: 10, grossMinor: 999, lines: [], breakdown: [], reverseCharge: false, placeOfSupply: { country: 'DE', subdivision: null }, notes: [], warnings: [] };
      },
    };
    await expect(createTaxService(liar, { sleep: noSleep }).quote(req({}))).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
  });
  it('rejects a provider that silently switches currency', async () => {
    const sneaky: TaxProvider = { id: 's', async calculate(r) { return { status: 'ok', currency: 'USD', netMinor: 0, taxMinor: 0, grossMinor: 0, lines: [], breakdown: [], reverseCharge: false, placeOfSupply: { country: r.context.siteCountry, subdivision: null }, notes: [], warnings: [] }; } };
    await expect(createTaxService(sneaky, { sleep: noSleep }).quote(req({}))).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
  });
});

describe('input validation (malicious / malformed)', () => {
  const svc = createTaxService(createMockTaxProvider(), { sleep: noSleep });
  const bad = (o: Partial<TaxQuoteRequest>) => expect(svc.quote(req(o))).rejects.toBeInstanceOf(TaxProviderError);
  it('rejects floats, NaN, huge amounts, empty/duplicate lines, bad keys and currencies', async () => {
    await bad({ lines: [{ id: 'a', amountMinor: 10.5 }] });
    await bad({ lines: [{ id: 'a', amountMinor: NaN }] });
    await bad({ lines: [{ id: 'a', amountMinor: 1e13 }] });
    await bad({ lines: [] });
    await bad({ lines: [{ id: 'a', amountMinor: 1 }, { id: 'a', amountMinor: 2 }] });
    await bad({ lines: [{ id: '', amountMinor: 1 }] });
    await bad({ idempotencyKey: 'short' });
    await bad({ idempotencyKey: 'has spaces and ; injection--' });
    await bad({ currency: 'EURO' });
    await bad({ mode: 'weird' as never });
    await bad({ lines: Array.from({ length: 501 }, (_, i) => ({ id: `l${i}`, amountMinor: 1 })) });
  });
  it('unknown jurisdictions are NOT silently taxed at 0: status is out_of_scope and requireOkTax refuses it', async () => {
    const real = createTaxService(createPackTaxProvider(), { sleep: noSleep });
    const r = await real.quote(req({ context: { ...DE_CTX, siteCountry: 'ZZ' } }));
    expect(r.status).toBe('out_of_scope');
    expect(r.warnings.map((w) => w.code)).toContain('NO_PACK');
    expect(() => requireOkTax(r)).toThrow(/not final/);
  });
  it('unregistered sellers are flagged, not silently zero-taxed', async () => {
    const real = createTaxService(createPackTaxProvider(), { sleep: noSleep });
    const r = await real.quote(req({ context: { ...DE_CTX, registrations: [] } }));
    expect(r.status).toBe('no_registration');
    expect(() => requireOkTax(r)).toThrow();
  });
  it('requireOkTax passes a complete calculation through', async () => {
    const real = createTaxService(createPackTaxProvider(), { sleep: noSleep });
    expect(requireOkTax(await real.quote(req({}))).taxMinor).toBe(1900);
  });
});
