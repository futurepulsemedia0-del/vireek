import { describe, expect, it, vi } from 'vitest';

// estimates.ts / galleryApi pull in the Supabase client; the pure rules under test never touch it.
vi.mock('@/lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

import { optionTotals, type EstimateOption } from '@/lib/estimates';
import {
  addOption,
  canManageFindings,
  defaultOptionId,
  nextFreeTier,
  optionTotalCents,
  packageHeadline,
  potentialCents,
  prepareOptionsForSave,
  selectionTotals,
  setRecommended,
  shareState,
  sortFindings,
  validateForSend,
} from '@/lib/findingsPackage';
import {
  isUuid,
  packageStatusFromCounts,
  parseResponseBody,
  type ItemLike,
  type PackageLike,
} from '../../supabase/functions/_shared/findings/engine';

const ITEM_A = '3f2b8a0e-1c4d-4e6f-8a9b-0c1d2e3f4a5b';
const ITEM_B = '4a3c9b1f-2d5e-4f70-9bac-1d2e3f4a5b6c';

function option(id: string, tier: EstimateOption['tier'], cents: number, recommended = false): EstimateOption {
  return {
    id,
    tier,
    name: `${tier} option`,
    summary: '',
    line_items: [{ description: 'Labour', quantity: 1, unit_price_cents: cents }],
    highlights: [],
    warranty_label: null,
    photo_ids: [],
    recommended,
  };
}

function item(over: Partial<ItemLike> & { id: string }): ItemLike {
  return { severity: 'recommended', options: [], recommended_option_id: null, ...over };
}

describe('money parity with tiered estimates', () => {
  it('matches optionTotals() to the cent, including tax rounding', () => {
    const opt = {
      line_items: [
        { description: 'Capacitor', quantity: 3, unit_price_cents: 3333 },
        { description: 'Labour', quantity: 1, unit_price_cents: 12999 },
      ],
    };
    for (const tax of [0, 7.25, 8.875, 20]) {
      expect(optionTotalCents(opt, tax)).toBe(optionTotals(opt, tax).totalCents);
    }
  });

  it('ignores negative and non-numeric values instead of producing NaN', () => {
    const total = optionTotalCents(
      { line_items: [{ description: 'x', quantity: -2, unit_price_cents: 500 }, { description: 'y', quantity: 2, unit_price_cents: Number.NaN }] },
      10,
    );
    expect(total).toBe(0);
  });
});

describe('defaultOptionId', () => {
  it('prefers the recommended option, then the middle one', () => {
    const options = [option('a', 'good', 100), option('b', 'better', 200), option('c', 'best', 300)];
    expect(defaultOptionId({ options, recommended_option_id: 'c' })).toBe('c');
    expect(defaultOptionId({ options, recommended_option_id: null })).toBe('b');
    expect(defaultOptionId({ options: [options[0]], recommended_option_id: null })).toBe('a');
    expect(defaultOptionId({ options: [], recommended_option_id: null })).toBeNull();
  });
});

describe('shareState', () => {
  const now = new Date('2027-03-01T12:00:00Z');
  const base: PackageLike = { status: 'sent', share_enabled: true, share_expires_at: '2027-03-10T00:00:00Z', tax_percent: 0 };

  it('walks every lifecycle state', () => {
    expect(shareState({ ...base, status: 'draft' }, now)).toBe('draft');
    expect(shareState(base, now)).toBe('active');
    expect(shareState({ ...base, share_expires_at: '2027-02-28T00:00:00Z' }, now)).toBe('expired');
    expect(shareState({ ...base, share_enabled: false }, now)).toBe('disabled');
    expect(shareState({ ...base, status: 'approved' }, now)).toBe('answered');
  });

  it('lets an answered package stay viewable after its expiry date', () => {
    expect(shareState({ ...base, status: 'declined', share_expires_at: '2027-01-01T00:00:00Z' }, now)).toBe('answered');
  });
});

describe('sortFindings', () => {
  it('puts urgent first and keeps order stable inside a severity', () => {
    const sorted = sortFindings([
      { id: 1, severity: 'monitor' as const, sort_order: 0 },
      { id: 2, severity: 'recommended' as const, sort_order: 1 },
      { id: 3, severity: 'urgent' as const, sort_order: 2 },
      { id: 4, severity: 'recommended' as const, sort_order: 3 },
    ]);
    expect(sorted.map((s) => s.id)).toEqual([3, 2, 4, 1]);
  });
});

describe('validateForSend', () => {
  it('requires findings, priced options and at least one approvable finding', () => {
    expect(validateForSend([], 0)).toEqual(['Add at least one finding.']);
    expect(validateForSend([item({ id: ITEM_A })], 0).join(' ')).toMatch(/at least one priced option/);
    expect(validateForSend([item({ id: ITEM_A, severity: 'monitor' })], 0).join(' ')).toMatch(/approvable/);
  });

  it('flags zero-dollar and duplicate-tier options', () => {
    const errors = validateForSend(
      [item({ id: ITEM_A, options: [option('a', 'good', 0), option('b', 'good', 500)] })],
      0,
    );
    expect(errors.some((e) => e.includes('totals $0'))).toBe(true);
    expect(errors.some((e) => e.includes('two "good"'))).toBe(true);
  });

  it('passes a valid package, and lets monitor-only findings carry no price', () => {
    const ok = validateForSend(
      [
        item({ id: ITEM_A, options: [option('a', 'good', 15000), option('b', 'better', 32000, true)] }),
        item({ id: ITEM_B, severity: 'monitor' }),
      ],
      8,
    );
    expect(ok).toEqual([]);
  });
});

describe('selectionTotals', () => {
  const items = [
    item({ id: ITEM_A, options: [option('a1', 'good', 10000), option('a2', 'better', 20000)] }),
    item({ id: ITEM_B, options: [option('b1', 'good', 5000)] }),
    item({ id: 'monitor-1', severity: 'monitor' }),
  ];

  it('sums only selected options and applies tax once per option', () => {
    const t = selectionTotals(items, { [ITEM_A]: 'a2', [ITEM_B]: null }, 10);
    expect(t).toEqual({ count: 1, subtotalCents: 20000, taxCents: 2000, totalCents: 22000 });
  });

  it('treats unknown option ids and monitor findings as not selected', () => {
    const t = selectionTotals(items, { [ITEM_A]: 'nope', 'monitor-1': 'x' }, 0);
    expect(t.count).toBe(0);
    expect(t.totalCents).toBe(0);
  });
});

describe('parseResponseBody', () => {
  it('accepts approvals and declines and trims the name', () => {
    const r = parseResponseBody({
      decisions: [{ item_id: ITEM_A, option_id: 'opt-1' }, { item_id: ITEM_B, option_id: null }],
      approver_name: '  Jane Doe  ',
    });
    expect(r).toEqual({
      ok: true,
      decisions: [{ item_id: ITEM_A, option_id: 'opt-1' }, { item_id: ITEM_B, option_id: null }],
      approverName: 'Jane Doe',
    });
  });

  it.each([
    [null],
    [{}],
    [{ decisions: [] }],
    [{ decisions: [{ item_id: 'not-a-uuid', option_id: null }] }],
    [{ decisions: [{ item_id: ITEM_A, option_id: null }, { item_id: ITEM_A, option_id: null }] }],
    [{ decisions: [{ item_id: ITEM_A, option_id: 42 }] }],
    [{ decisions: [{ item_id: ITEM_A, option_id: '' }] }],
  ])('rejects malformed body %#', (body) => {
    expect(parseResponseBody(body).ok).toBe(false);
  });

  it('rejects a non-string approver name', () => {
    expect(parseResponseBody({ decisions: [{ item_id: ITEM_A, option_id: null }], approver_name: 5 })).toEqual({
      ok: false,
      error: 'INVALID_NAME',
    });
  });
});

describe('status + misc', () => {
  it('derives package status from decision counts', () => {
    expect(packageStatusFromCounts(0, 3)).toBe('declined');
    expect(packageStatusFromCounts(3, 0)).toBe('approved');
    expect(packageStatusFromCounts(2, 1)).toBe('partially_approved');
  });

  it('validates uuids', () => {
    expect(isUuid(ITEM_A)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('gates management on owner or job visibility', () => {
    expect(canManageFindings(true, { can_view_all_jobs: false } as never)).toBe(true);
    expect(canManageFindings(false, { can_view_all_jobs: true } as never)).toBe(true);
    expect(canManageFindings(false, { can_view_all_jobs: false } as never)).toBe(false);
  });
});

describe('option ladder helpers', () => {
  it('adds tiers in order, recommends the first, and stops at three', () => {
    let opts: EstimateOption[] = [];
    opts = addOption(opts);
    expect(opts.map((o) => o.tier)).toEqual(['good']);
    expect(opts[0].recommended).toBe(true);
    opts = addOption(addOption(opts));
    expect(opts.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    expect(addOption(opts)).toBe(opts);
    expect(nextFreeTier(opts)).toBeNull();
  });

  it('setRecommended keeps exactly one (or none)', () => {
    const opts = [option('a', 'good', 1, true), option('b', 'better', 2)];
    expect(setRecommended(opts, 'b').map((o) => o.recommended)).toEqual([false, true]);
    expect(setRecommended(opts, null).every((o) => !o.recommended)).toBe(true);
  });

  it('prepareOptionsForSave drops blank options, sorts by tier and reports the recommended id', () => {
    const blank: EstimateOption = { ...option('x', 'best', 0), line_items: [{ description: '  ', quantity: 1, unit_price_cents: 0 }] };
    const { options, recommendedId } = prepareOptionsForSave([option('b', 'better', 200, true), blank, option('a', 'good', 100)]);
    expect(options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(recommendedId).toBe('b');
  });
});

describe('package headline + potential', () => {
  it('sums the default option of every approvable finding', () => {
    const items = [
      { severity: 'urgent' as const, options: [option('a', 'good', 10000), option('b', 'better', 20000, true)], recommended_option_id: 'b' },
      { severity: 'monitor' as const, options: [], recommended_option_id: null },
    ];
    expect(potentialCents(items, 10)).toBe(22000);
  });

  it('describes each status', () => {
    expect(packageHeadline({ status: 'sent', approved_total_cents: 0 }, 22000)).toMatch(/recommended/);
    expect(packageHeadline({ status: 'approved', approved_total_cents: 22000 }, 0)).toMatch(/approved/);
    expect(packageHeadline({ status: 'declined', approved_total_cents: 0 }, 5)).toBe('Declined');
    expect(packageHeadline({ status: 'draft', approved_total_cents: 0 }, 0)).toBe('No prices yet');
  });
});
