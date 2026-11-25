// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DisclosureError, applyCostIndexDisclosure, assertCostIndexPublishable, costCellsHash, validateRawCell } from './disclosure';
import { isRoundedPrice, priceStepCents, roundPriceCents, type PublishedCell, type RawCell } from './schema';

const raw = (o: Partial<RawCell> = {}): RawCell => ({
  trade: 'hvac', region: 'south', job_kind: 'repair', period_key: '2026-Q3',
  n_orgs: 24, n_jobs: 640, org_p25_cents: 31_200, org_p50_cents: 42_800, org_p75_cents: 58_900, max_org_share: 0.12, ...o,
});
const find = (cells: PublishedCell[], region: string, trade = 'hvac', kind = 'repair') =>
  cells.find((c) => c.region === region && c.trade === trade && c.job_kind === kind)!;

describe('price rounding', () => {
  it('uses $10 / $50 / $100 steps by magnitude', () => {
    expect(priceStepCents(99_999)).toBe(1_000);
    expect(priceStepCents(100_000)).toBe(5_000);
    expect(priceStepCents(1_000_000)).toBe(10_000);
    expect(roundPriceCents(42_840)).toBe(43_000);
    expect(roundPriceCents(99_600)).toBe(100_000);
    expect(roundPriceCents(1_234_567)).toBe(1_230_000);
  });
  it('always yields a value that satisfies its own step and never reverses order', () => {
    let prev = 0;
    for (let c = 0; c <= 3_000_000; c += 137) {
      const r = roundPriceCents(c);
      expect(isRoundedPrice(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('suppression rules', () => {
  it('publishes a cell that clears k, dominance and volume, rounding every number', () => {
    const { cells } = applyCostIndexDisclosure([raw()]);
    expect(cells[0]).toMatchObject({ suppressed: false, n_orgs: 25, n_jobs: 640, p25_cents: 31_000, p50_cents: 43_000, p75_cents: 59_000 });
  });
  it('suppresses fewer than 10 organisations and leaks no numbers', () => {
    const { cells, report } = applyCostIndexDisclosure([raw({ n_orgs: 9 })]);
    expect(cells[0]).toMatchObject({ suppressed: true, suppression_reason: 'k_anonymity', n_orgs: null, n_jobs: null, p25_cents: null, p50_cents: null, p75_cents: null });
    expect(report.suppressed.k_anonymity).toBe(1);
    expect(applyCostIndexDisclosure([raw({ n_orgs: 10 })]).cells[0].suppressed).toBe(false);
  });
  it('enforces the dominance cap (0.35): one organisation too large a share', () => {
    expect(applyCostIndexDisclosure([raw({ max_org_share: 0.351 })]).cells[0].suppression_reason).toBe('dominance');
    expect(applyCostIndexDisclosure([raw({ max_org_share: 0.35 })]).cells[0].suppressed).toBe(false);
  });
  it('enforces the minimum job volume (100)', () => {
    expect(applyCostIndexDisclosure([raw({ n_jobs: 99 })]).cells[0].suppression_reason).toBe('low_volume');
    expect(applyCostIndexDisclosure([raw({ n_jobs: 100 })]).cells[0].suppressed).toBe(false);
  });
  it('applies precedence k -> dominance -> volume deterministically', () => {
    expect(applyCostIndexDisclosure([raw({ n_orgs: 3, max_org_share: 0.9, n_jobs: 5 })]).cells[0].suppression_reason).toBe('k_anonymity');
    expect(applyCostIndexDisclosure([raw({ max_org_share: 0.9, n_jobs: 5 })]).cells[0].suppression_reason).toBe('dominance');
  });
  it('suppresses a cell with no price statistics as no_data', () => {
    expect(applyCostIndexDisclosure([raw({ org_p50_cents: null })]).cells[0].suppression_reason).toBe('no_data');
  });
  it('lets a release raise the thresholds but never lower them below the public floors', () => {
    expect(applyCostIndexDisclosure([raw({ n_orgs: 12 })], { kMin: 15 }).cells[0].suppressed).toBe(true);
    expect(applyCostIndexDisclosure([raw({ n_orgs: 6 })], { kMin: 3 }).cells[0].suppressed).toBe(true);
    expect(applyCostIndexDisclosure([raw({ max_org_share: 0.5 })], { dominanceMax: 0.9 }).cells[0].suppressed).toBe(true);
    expect(applyCostIndexDisclosure([raw({ n_jobs: 50 })], { minEvents: 1 }).cells[0].suppressed).toBe(true);
  });
});

describe('complementary suppression (differencing)', () => {
  const regions = ['northeast', 'midwest', 'south', 'west'] as const;
  const world = (over: Record<string, Partial<RawCell>> = {}) => [
    raw({ region: 'all', n_orgs: 80, n_jobs: 2400 }),
    ...regions.map((r) => raw({ region: r, n_orgs: 20, n_jobs: 600, ...over[r] })),
  ];
  it('hides one more regional cell when exactly one region is hidden but the rollup is published', () => {
    const { cells, report } = applyCostIndexDisclosure(world({ west: { n_orgs: 4 } }));
    expect(find(cells, 'west').suppression_reason).toBe('k_anonymity');
    const comp = cells.filter((c) => c.suppression_reason === 'complementary');
    expect(comp).toHaveLength(1);
    expect(report.suppressed.complementary).toBe(1);
    expect(find(cells, 'all').suppressed).toBe(false);
  });
  it('picks the smallest published region (fewest organisations) as the complement', () => {
    const { cells } = applyCostIndexDisclosure(world({ west: { n_orgs: 4 }, midwest: { n_orgs: 11, n_jobs: 300 } }));
    expect(find(cells, 'midwest').suppression_reason).toBe('complementary');
  });
  it('does nothing when none or two-plus regions are hidden', () => {
    expect(applyCostIndexDisclosure(world()).report.suppressed.complementary).toBe(0);
    expect(applyCostIndexDisclosure(world({ west: { n_orgs: 4 }, south: { n_orgs: 3 } })).report.suppressed.complementary).toBe(0);
  });
  it('does not mix different trades or job kinds', () => {
    const rows = [...world({ west: { n_orgs: 4 } }), raw({ trade: 'plumbing', region: 'all' }), raw({ trade: 'plumbing', region: 'west' })];
    const { cells } = applyCostIndexDisclosure(rows);
    expect(find(cells, 'west', 'plumbing').suppressed).toBe(false);
  });
});

describe('allowlist (layer 1)', () => {
  it('rejects unknown fields, missing fields and organisation identifiers', () => {
    expect(() => validateRawCell({ ...raw(), org_id: 'x' })).toThrow(DisclosureError);
    const { n_jobs: _drop, ...rest } = raw();
    expect(() => validateRawCell(rest)).toThrow(DisclosureError);
  });
  it('rejects finer-than-census-region geography and malformed trades', () => {
    expect(() => validateRawCell(raw({ region: '10001' as never }))).toThrow(/coarse region/);
    expect(() => validateRawCell(raw({ region: 'texas' as never }))).toThrow(/coarse region/);
    expect(() => validateRawCell(raw({ trade: 'HVAC; drop' }))).toThrow(/trade/);
    expect(() => validateRawCell(raw({ job_kind: 'maintenance' as never }))).toThrow(/job kind/);
  });
  it('rejects bad numbers and duplicate cells', () => {
    expect(() => validateRawCell(raw({ max_org_share: 1.2 }))).toThrow();
    expect(() => validateRawCell(raw({ org_p50_cents: -1 }))).toThrow();
    expect(() => validateRawCell(raw({ n_orgs: 1.5 }))).toThrow();
    expect(() => applyCostIndexDisclosure([raw(), raw()])).toThrow(/duplicate/);
  });
});

describe('release gate and determinism', () => {
  it('catches tampered finished cells (small cell, exact price, numbers on a suppressed cell)', () => {
    const ok = applyCostIndexDisclosure([raw()]).cells[0];
    expect(() => assertCostIndexPublishable([ok])).not.toThrow();
    expect(() => assertCostIndexPublishable([{ ...ok, n_orgs: 9 }])).toThrow(/below k/);
    expect(() => assertCostIndexPublishable([{ ...ok, n_jobs: 40 }])).toThrow(/minimum volume/);
    expect(() => assertCostIndexPublishable([{ ...ok, p50_cents: 42_837 }])).toThrow(/rounded/);
    expect(() => assertCostIndexPublishable([{ ...ok, p25_cents: 60_000 }])).toThrow(/out of order/);
    expect(() => assertCostIndexPublishable([{ ...ok, suppressed: true, suppression_reason: 'k_anonymity' }])).toThrow(/carries numbers/);
    expect(() => assertCostIndexPublishable([{ ...ok, extra: 1 } as never])).toThrow(/non-allowlisted/);
    expect(() => assertCostIndexPublishable([{ ...ok, region: '94105' as never }])).toThrow(/coarse region/);
  });
  it('is order-independent: shuffled input gives identical cells and hash', async () => {
    const rows = [raw(), raw({ trade: 'plumbing' }), raw({ job_kind: 'install', n_orgs: 4 }), raw({ region: 'west' }), raw({ region: 'all', n_orgs: 60 })];
    const a = applyCostIndexDisclosure(rows);
    const b = applyCostIndexDisclosure([...rows].reverse());
    expect(b.cells).toEqual(a.cells);
    expect(await costCellsHash(a.cells)).toBe(await costCellsHash(b.cells));
    expect(await costCellsHash(a.cells)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('never exposes an exact count or price in any published cell', () => {
    const { cells } = applyCostIndexDisclosure([raw({ n_orgs: 13, n_jobs: 137, org_p50_cents: 43_217 })]);
    expect(cells[0].n_orgs! % 5).toBe(0);
    expect(cells[0].n_jobs! % 10).toBe(0);
    expect(cells[0].p50_cents! % 1_000).toBe(0);
  });
});

import { REVIEW_ITEMS, buildCostIndexDocument, costIndexToCsv, reviewComplete } from './release';

describe('release document, CSV and review gate', () => {
  const { cells, report } = applyCostIndexDisclosure([raw(), raw({ trade: 'plumbing', n_orgs: 3 })]);
  const doc = buildCostIndexDocument({ slug: 'cost-index-2026-q3-r1', title: 'T', releaseSeq: 1, periodKey: '2026-Q3', periodStart: '2026-07-01', periodEnd: '2026-09-30', asOf: '2026-10-05T00:00:00Z', changelog: 'first', cells, report });
  it('freezes thresholds and refuses a document built from unsafe cells', () => {
    expect(doc.thresholds).toEqual({ k_min: 10, dominance_max: 0.35, min_jobs_per_cell: 100, min_jobs_per_org: 3 });
    expect(() => buildCostIndexDocument({ slug: 's', title: 'T', releaseSeq: 1, periodKey: '2026-Q3', periodStart: '', periodEnd: '', asOf: '', changelog: '', report, cells: [{ ...cells[0], n_orgs: 2 }] })).toThrow(/below k/);
  });
  it('exports CSV in whole dollars with suppressed cells empty', () => {
    const csv = costIndexToCsv(doc).split('\n');
    expect(csv[0]).toMatch(/^release,method_version/);
    expect(csv.some((l) => l.includes(',repair,hvac,south,2026-Q3,false,,25,640,310,430,590'))).toBe(true);
    expect(csv.some((l) => l.includes(',repair,plumbing,south,2026-Q3,true,k_anonymity,,,,,'))).toBe(true);
  });
  it('requires every checklist item and two different reviewers', () => {
    const all = Object.fromEntries(REVIEW_ITEMS.map((k) => [k, true]));
    expect(reviewComplete({ items: all, reviewer: 'A', second_reviewer: 'B' }).ok).toBe(true);
    expect(reviewComplete({ items: all, reviewer: 'A', second_reviewer: ' a ' }).missing).toContain('reviewers_must_differ');
    expect(reviewComplete({ items: { ...all, spot_check_recomputed: false }, reviewer: 'A', second_reviewer: 'B' }).missing).toEqual(['spot_check_recomputed']);
    expect(reviewComplete(null).ok).toBe(false);
  });
});
