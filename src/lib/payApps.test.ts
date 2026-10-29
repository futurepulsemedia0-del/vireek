import { describe, expect, it } from 'vitest';
import {
  allocateByWeight,
  buildDraftLines,
  calculateApplication,
  carryForward,
  friendlyPayAppError,
  nextItemNo,
  parsePercentToBps,
  percentComplete,
  reconcile,
  retainageOf,
  roundDiv,
  thisPeriodFromPercent,
  validateApplication,
  type PayAppLine,
  type SovLine,
} from '@/lib/payApps';

const sov = (id: string, item: string, cents: number, co: string | null = null, sort = 0): SovLine => ({
  id,
  project_id: 'p1',
  item_no: item,
  description: `Item ${item}`,
  scheduled_value_cents: cents,
  change_order_ref: co,
  sort_order: sort,
});

const SOV: SovLine[] = [
  sov('s1', '1', 1_000_000, null, 0), // $10,000.00
  sov('s2', '2', 2_500_050, null, 1), // $25,000.50
  sov('s3', '3', 733_333, null, 2), // $7,333.33
];
const CONTRACT = 1_000_000 + 2_500_050 + 733_333; // 4,233,383

/** Persisted form of a calculated draft (what the DB snapshot holds once issued). */
const asIssued = (lines: PayAppLine[]): PayAppLine[] => lines;

describe('integer helpers', () => {
  it('roundDiv rounds half away from zero', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 2)).toBe(2);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(7, 3)).toBe(2);
    expect(roundDiv(1, 0)).toBe(0);
  });

  it('retainageOf uses basis points (no float drift)', () => {
    expect(retainageOf(10_000, 10)).toBe(1_000);
    expect(retainageOf(1_005, 10)).toBe(101); // 100.5 → 101 (half up)
    expect(retainageOf(999, 7.5)).toBe(75); // 74.925 → 75
    expect(retainageOf(0, 25)).toBe(0);
    expect(retainageOf(123_456_789, 5)).toBe(6_172_839); // 6,172,839.45
  });

  it('parsePercentToBps accepts up to 2 decimals, 0–100', () => {
    expect(parsePercentToBps('45')).toBe(4500);
    expect(parsePercentToBps('45.25%')).toBe(4525);
    expect(parsePercentToBps(' 100 ')).toBe(10_000);
    expect(parsePercentToBps('100.01')).toBeNull();
    expect(parsePercentToBps('45.255')).toBeNull();
    expect(parsePercentToBps('-5')).toBeNull();
    expect(parsePercentToBps('abc')).toBeNull();
    expect(parsePercentToBps('')).toBeNull();
  });

  it('percentComplete guards zero scheduled value', () => {
    expect(percentComplete(500, 0)).toBe(0);
    expect(percentComplete(1, 3)).toBe(33.33);
    expect(percentComplete(2, 3)).toBe(66.67);
  });

  it('thisPeriodFromPercent lands D + E on the rounded percentage', () => {
    // 45% of 2,500,050 = 1,125,022.5 → 1,125,023
    expect(thisPeriodFromPercent(2_500_050, 0, 4500)).toBe(1_125_023);
    expect(thisPeriodFromPercent(2_500_050, 1_000_000, 4500)).toBe(125_023);
    expect(thisPeriodFromPercent(1_000_000, 600_000, 5000)).toBe(-100_000);
  });
});

describe('allocateByWeight', () => {
  it('always sums to the exact total', () => {
    for (const total of [0, 1, 99, 100, 1_000_001, 4_233_383]) {
      const parts = allocateByWeight(total, [1, 1, 3, 1]);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });
  it('gives remainder cents to the largest fractions, ties by order', () => {
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeight(10, [3, 3, 4])).toEqual([3, 3, 4]);
  });
  it('handles empty / zero weights', () => {
    expect(allocateByWeight(100, [])).toEqual([]);
    expect(allocateByWeight(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('Application #1 — first billing with stored materials', () => {
  const lines = buildDraftLines(SOV, null, {
    s1: { thisPeriodCents: thisPeriodFromPercent(1_000_000, 0, 5000), storedCents: 0 }, // 50% → 500,000
    s2: { thisPeriodCents: 200_000, storedCents: 300_000 },
    s3: { thisPeriodCents: 0, storedCents: 100_000 },
  });
  const r = calculateApplication({ lines, retainagePercent: 10, retainageReleaseCents: 0, previousCertificatesCents: 0 });
  const t = r.totals;

  it('reconciles to the cent', () => expect(reconcile(r)).toEqual([]));

  it('G703 columns', () => {
    expect(t.scheduledCents).toBe(CONTRACT);
    expect(t.previousCents).toBe(0);
    expect(t.thisPeriodCents).toBe(700_000);
    expect(t.storedCents).toBe(400_000);
    expect(t.totalCents).toBe(1_100_000);
    expect(t.balanceCents).toBe(CONTRACT - 1_100_000);
  });

  it('G702 lines 1–9', () => {
    expect(t.originalContractCents).toBe(CONTRACT); // 1
    expect(t.changeOrdersCents).toBe(0); // 2
    expect(t.contractToDateCents).toBe(CONTRACT); // 3
    expect(t.completedStoredCents).toBe(1_100_000); // 4
    expect(t.retainageWorkCents).toBe(70_000); // 5a  10% of 700,000
    expect(t.retainageStoredCents).toBe(40_000); // 5b  10% of 400,000
    expect(t.totalRetainageCents).toBe(110_000); // 5
    expect(t.earnedLessRetainageCents).toBe(990_000); // 6
    expect(t.previousCertificatesCents).toBe(0); // 7
    expect(t.currentPaymentDueCents).toBe(990_000); // 8
    expect(t.balanceToFinishCents).toBe(CONTRACT - 990_000); // 9
  });
});

describe('Application #2 — previous-billed carry-forward', () => {
  const app1 = asIssued(
    buildDraftLines(SOV, null, {
      s1: { thisPeriodCents: 500_000, storedCents: 0 },
      s2: { thisPeriodCents: 200_000, storedCents: 300_000 },
      s3: { thisPeriodCents: 0, storedCents: 100_000 },
    }, 'a1'),
  );
  const calc1 = calculateApplication({ lines: app1, retainagePercent: 10, retainageReleaseCents: 0, previousCertificatesCents: 0 });

  it('carries D + E forward and drops stored (F) — stored must be re-billed as installed work', () => {
    const cf = carryForward(app1);
    expect(cf.get('s1')).toBe(500_000);
    expect(cf.get('s2')).toBe(200_000);
    expect(cf.get('s3')).toBe(0);
  });

  it('stored material that is installed moves from F to E without double-billing', () => {
    // s2: the 300,000 stored last month is now installed (+150,000 more work); nothing stored.
    // s3: 100,000 stored last month installed this month.
    const lines = buildDraftLines(SOV, app1, {
      s1: { thisPeriodCents: 250_000, storedCents: 0 },
      s2: { thisPeriodCents: 450_000, storedCents: 0 },
      s3: { thisPeriodCents: 100_000, storedCents: 0 },
    }, 'a2');
    const r = calculateApplication({
      lines,
      retainagePercent: 10,
      retainageReleaseCents: 0,
      previousCertificatesCents: calc1.totals.earnedLessRetainageCents,
    });
    const t = r.totals;
    expect(reconcile(r)).toEqual([]);
    expect(t.previousCents).toBe(700_000); // 500,000 + 200,000 + 0
    expect(t.thisPeriodCents).toBe(800_000);
    expect(t.totalCents).toBe(1_500_000); // 1.1M last time + 800,000 − 400,000 stored now installed
    expect(t.totalRetainageCents).toBe(150_000);
    expect(t.earnedLessRetainageCents).toBe(1_350_000);
    expect(t.previousCertificatesCents).toBe(990_000);
    expect(t.currentPaymentDueCents).toBe(360_000); // 1,350,000 − 990,000
  });

  it('payments across applications add back up to total earned less retainage', () => {
    const l2 = buildDraftLines(SOV, app1, { s1: { thisPeriodCents: 250_000, storedCents: 0 } }, 'a2');
    const r2 = calculateApplication({ lines: l2, retainagePercent: 10, retainageReleaseCents: 0, previousCertificatesCents: calc1.totals.earnedLessRetainageCents });
    expect(calc1.totals.currentPaymentDueCents + r2.totals.currentPaymentDueCents).toBe(r2.totals.earnedLessRetainageCents);
  });

  it('a line added later (change order) starts at D = 0', () => {
    const withCo = [...SOV, sov('s4', '4', 120_000, 'CO-1', 3)];
    const lines = buildDraftLines(withCo, app1, { s4: { thisPeriodCents: 60_000, storedCents: 0 } }, 'a2');
    const co = lines.find((l) => l.sov_line_id === 's4')!;
    expect(co.previous_cents).toBe(0);
    const r = calculateApplication({ lines, retainagePercent: 10, retainageReleaseCents: 0, previousCertificatesCents: calc1.totals.earnedLessRetainageCents });
    expect(reconcile(r)).toEqual([]);
    expect(r.totals.originalContractCents).toBe(CONTRACT);
    expect(r.totals.changeOrdersCents).toBe(120_000);
    expect(r.totals.contractToDateCents).toBe(CONTRACT + 120_000);
  });
});

describe('final application with retainage release', () => {
  it('releasing all retainage pays the contract in full, to the cent', () => {
    const lines = buildDraftLines(SOV, null, {
      s1: { thisPeriodCents: 1_000_000, storedCents: 0 },
      s2: { thisPeriodCents: 2_500_050, storedCents: 0 },
      s3: { thisPeriodCents: 733_333, storedCents: 0 },
    });
    const held = retainageOf(CONTRACT, 10);
    const r = calculateApplication({ lines, retainagePercent: 10, retainageReleaseCents: held, previousCertificatesCents: 0 });
    expect(reconcile(r)).toEqual([]);
    expect(r.totals.totalRetainageCents).toBe(0);
    expect(r.totals.earnedLessRetainageCents).toBe(CONTRACT);
    expect(r.totals.currentPaymentDueCents).toBe(CONTRACT);
    expect(r.totals.balanceToFinishCents).toBe(0);
  });
});

describe('0% retainage project', () => {
  it('pays exactly the work completed', () => {
    const lines = buildDraftLines(SOV, null, { s1: { thisPeriodCents: 123_457, storedCents: 0 } });
    const r = calculateApplication({ lines, retainagePercent: 0, retainageReleaseCents: 0, previousCertificatesCents: 0 });
    expect(r.totals.totalRetainageCents).toBe(0);
    expect(r.totals.currentPaymentDueCents).toBe(123_457);
    expect(reconcile(r)).toEqual([]);
  });
});

describe('validation', () => {
  const base = (over: Partial<PayAppLine> = {}): PayAppLine[] => [
    { ...buildDraftLines([sov('s1', '1', 100_000)], null, {})[0], ...over },
  ];
  const run = (lines: PayAppLine[], extra: Partial<Parameters<typeof validateApplication>[0]> = {}) =>
    validateApplication({ lines, retainagePercent: 10, retainageReleaseCents: 0, contractValueCents: 100_000, periodTo: '2027-03-31', previousPeriodTo: null, ...extra });

  it('accepts a clean application', () => expect(run(base({ this_period_cents: 50_000 }))).toEqual([]));
  it('blocks completed + stored over the scheduled value', () => {
    expect(run(base({ this_period_cents: 90_000, stored_cents: 10_001 })).map((i) => i.code)).toEqual(['line_over']);
  });
  it('allows exactly 100%', () => expect(run(base({ this_period_cents: 90_000, stored_cents: 10_000 }))).toEqual([]));
  it('blocks negative cumulative work', () => {
    expect(run(base({ previous_cents: 0, this_period_cents: -1 })).map((i) => i.code)).toContain('line_negative');
  });
  it('allows a credit that stays above zero', () => {
    expect(run(base({ previous_cents: 50_000, this_period_cents: -20_000 }))).toEqual([]);
  });
  it('blocks a release above the retainage held', () => {
    const lines = base({ this_period_cents: 50_000 }); // held 5,000
    expect(run(lines, { retainageReleaseCents: 5_001 }).map((i) => i.code)).toEqual(['release_exceeds']);
    expect(run(lines, { retainageReleaseCents: 5_000 })).toEqual([]);
  });
  it('requires the original SOV to equal the contract value', () => {
    expect(run(base({ this_period_cents: 1 }), { contractValueCents: 100_001 }).map((i) => i.code)).toEqual(['sov_mismatch']);
  });
  it('change-order lines do not count toward the contract match', () => {
    const lines = [...base(), { ...buildDraftLines([sov('s9', '9', 5_000, 'CO-1')], null, {})[0] }];
    expect(run(lines)).toEqual([]);
  });
  it('rejects a period before the previous application', () => {
    expect(run(base(), { previousPeriodTo: '2027-04-30' }).map((i) => i.code)).toEqual(['period_before_previous']);
  });
  it('requires at least one line', () => expect(run([]).map((i) => i.code)).toContain('no_lines'));
});

describe('property: every random application reconciles to the cent', () => {
  // Deterministic LCG so a failure is reproducible.
  let seed = 20_280_115;
  const rnd = (n: number) => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed % n;
  };

  it('holds over 2,000 randomized multi-application chains', () => {
    for (let run = 0; run < 2_000; run++) {
      const count = 1 + rnd(8);
      const master: SovLine[] = Array.from({ length: count }, (_, i) =>
        sov(`l${i}`, String(i + 1), rnd(50_000_000) + 1, rnd(4) === 0 ? `CO-${i}` : null, i),
      );
      const pct = [0, 5, 7.5, 10, 12.25, 25][rnd(6)];
      let prev: PayAppLine[] | null = null;
      let prevCert = 0;
      let totalPaid = 0;
      for (let app = 1; app <= 1 + rnd(5); app++) {
        const entries: Record<string, { thisPeriodCents: number; storedCents: number }> = {};
        const carried = carryForward(prev);
        for (const s of master) {
          const d = carried.get(s.id) ?? 0;
          const room = s.scheduled_value_cents - d;
          const e = room > 0 ? rnd(Math.floor(room / 3) + 1) : 0;
          const f = rnd(Math.floor((room - e) / 3) + 1);
          entries[s.id] = { thisPeriodCents: e, storedCents: Math.max(0, f) };
        }
        const lines = buildDraftLines(master, prev, entries, `a${app}`);
        expect(validateApplication({ lines, retainagePercent: pct, retainageReleaseCents: 0, contractValueCents: 0, periodTo: '2027-01-01', previousPeriodTo: null })).toEqual([]);
        const r = calculateApplication({ lines, retainagePercent: pct, retainageReleaseCents: 0, previousCertificatesCents: prevCert });
        expect(reconcile(r)).toEqual([]);
        totalPaid += r.totals.currentPaymentDueCents;
        expect(totalPaid).toBe(r.totals.earnedLessRetainageCents);
        prev = lines;
        prevCert = r.totals.earnedLessRetainageCents;
      }
    }
  });
});

describe('misc', () => {
  it('nextItemNo continues numeric item numbers', () => {
    expect(nextItemNo([])).toBe('1');
    expect(nextItemNo([{ item_no: '1' }, { item_no: '7' }, { item_no: 'A' }])).toBe('8');
  });
  it('buildDraftLines orders by sort_order then item number', () => {
    const lines = buildDraftLines([sov('b', '10', 1, null, 1), sov('a', '2', 1, null, 1), sov('c', '1', 1, null, 0)], null, {});
    expect(lines.map((l) => l.item_no)).toEqual(['1', '2', '10']);
  });
  it('friendlyPayAppError maps server codes and keeps the item number', () => {
    expect(friendlyPayAppError(new Error('pay_app_line_over: 3'), 'x')).toBe('Item 3: A line’s completed + stored amount exceeds its scheduled value.');
    expect(friendlyPayAppError({ message: 'sov_locked' }, 'x')).toContain('change-order');
    expect(friendlyPayAppError({ message: 'duplicate key value violates unique constraint "idx_install_sov_item_no"' }, 'x')).toContain('item number');
    expect(friendlyPayAppError(new Error('boom'), 'fallback')).toBe('fallback');
    expect(friendlyPayAppError(new Error('not_authorized'), 'fallback')).toContain('permission');
  });
});
