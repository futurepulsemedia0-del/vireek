import { describe, it, expect } from 'vitest';
import {
  buildBusinessForecast,
  quoteTotalDollars,
  type ForecastInput,
  type ForecastJob,
} from './businessForecast';

const NOW = new Date('2026-10-05T10:00:00Z'); // a Monday
const DAY = 86_400_000;
const iso = (offset: number) => new Date(Date.UTC(2026, 9, 5) + offset * DAY + 9 * 3_600_000).toISOString();

function emptyInput(): ForecastInput {
  return {
    jobs: [],
    payments: [],
    memberships: [],
    quotes: [],
    expenses: [],
    technicians: [],
    profitability: [],
    settings: { startingCash: 0, defaultCostRatioPct: 55, quoteWinRatePct: 25, configured: false },
  };
}

/** 2 completed $400 jobs per weekday for 12 weeks + a steady booked pipeline. */
function richInput(): ForecastInput {
  const jobs: ForecastJob[] = [];
  let n = 0;
  for (let off = -84; off < 0; off++) {
    const dow = new Date(Date.UTC(2026, 9, 5) + off * DAY).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let k = 0; k < 2; k++) {
      jobs.push({
        id: `h${n++}`, invoice_amount: 400, invoice_status: 'paid', job_status: 'completed',
        scheduled_datetime: iso(off), created_at: iso(off - 2), completed_at: iso(off),
      });
    }
  }
  for (let off = 0; off < 90; off++) {
    const dow = new Date(Date.UTC(2026, 9, 5) + off * DAY).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (off > 21) continue;
    jobs.push({
      id: `f${n++}`, invoice_amount: 400, invoice_status: 'not_sent', job_status: 'scheduled',
      scheduled_datetime: iso(off), created_at: iso(-3), completed_at: null,
    });
  }
  return {
    ...emptyInput(),
    jobs,
    technicians: [{ id: 't1', max_jobs_per_day: 4 }, { id: 't2', max_jobs_per_day: 4 }],
    profitability: Array.from({ length: 30 }, () => ({ revenue_cents: 40000, total_cost_cents: 22000 })),
    expenses: [{ amount: 3000, frequency: 'monthly', next_due_date: '2026-10-15' }],
    settings: { startingCash: 20000, defaultCostRatioPct: 55, quoteWinRatePct: 25, configured: true },
  };
}

describe('buildBusinessForecast — empty business', () => {
  const f = buildBusinessForecast(emptyInput(), NOW);

  it('never returns NaN and reports low confidence for insufficient history', () => {
    for (const h of [7, 30, 90] as const) {
      for (const v of [f.revenue[h].base, f.grossProfit[h].base, f.cash[h].endingBase, f.capacity[h].utilizationPct]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(f.revenue[h].confidence.level).toBe('low');
      expect(f.revenue[h].confidence.label).toBe('Low confidence — insufficient historical data.');
    }
  });

  it('flags missing technicians on capacity', () => {
    expect(f.capacity[30].status).toBe('no_capacity_data');
    expect(f.capacity[30].confidence.level).toBe('low');
  });
});

describe('buildBusinessForecast — healthy business', () => {
  const f = buildBusinessForecast(richInput(), NOW);

  it('forecasts revenue near the run-rate and grows with horizon', () => {
    // 2 jobs x $400 x 5 days = $4,000 / week
    expect(f.revenue[7].base).toBeGreaterThan(3000);
    expect(f.revenue[7].base).toBeLessThan(4600);
    expect(f.revenue[30].base).toBeGreaterThan(f.revenue[7].base);
    expect(f.revenue[90].base).toBeGreaterThan(f.revenue[30].base);
  });

  it('keeps low <= base <= high everywhere', () => {
    for (const h of [7, 30, 90] as const) {
      expect(f.revenue[h].low).toBeLessThanOrEqual(f.revenue[h].base);
      expect(f.revenue[h].base).toBeLessThanOrEqual(f.revenue[h].high);
      expect(f.grossProfit[h].low).toBeLessThanOrEqual(f.grossProfit[h].base);
      expect(f.grossProfit[h].base).toBeLessThanOrEqual(f.grossProfit[h].high);
      expect(f.cash[h].endingLow).toBeLessThanOrEqual(f.cash[h].endingBase);
      expect(f.cash[h].endingBase).toBeLessThanOrEqual(f.cash[h].endingHigh);
    }
  });

  it('uses the measured margin and reports it as actual', () => {
    expect(f.grossProfit[30].marginSource).toBe('actual');
    expect(f.grossProfit[30].marginPct).toBeCloseTo(45, 0);
  });

  it('gives high confidence for a stable 7-day revenue forecast', () => {
    expect(f.revenue[7].confidence.level).toBe('high');
    expect(f.revenue[7].confidence.headline).toBe('Revenue forecast: High confidence');
  });

  it('is less confident further out', () => {
    expect(f.revenue[90].confidence.score).toBeLessThan(f.revenue[7].confidence.score);
  });

  it('computes capacity from technicians on working weekdays only', () => {
    expect(f.meta.workingDays).toEqual([1, 2, 3, 4, 5]);
    // 8 jobs/day x 5 working days = 40 in the first week
    expect(f.capacity[7].capacityJobs).toBe(40);
    expect(f.capacity[7].status).not.toBe('over');
  });

  it('flags capacity shortfall when demand outgrows technicians', () => {
    const input = richInput();
    input.technicians = [{ id: 't1', max_jobs_per_day: 1 }];
    const g = buildBusinessForecast(input, NOW);
    expect(g.capacity[30].status).toBe('over');
    expect(g.capacity[30].gapJobs).toBeGreaterThan(0);
    expect(g.capacity[30].techniciansNeeded).toBeGreaterThan(0);
  });
});

describe('cash forecast', () => {
  it('flags a critical shortfall when expenses exceed cash', () => {
    const input = richInput();
    input.settings.startingCash = 100;
    input.expenses = [{ amount: 50000, frequency: 'monthly', next_due_date: '2026-10-06' }];
    const f = buildBusinessForecast(input, NOW);
    expect(f.cash[30].risk).toBe('critical');
    expect(f.cash[30].minBalance).toBeLessThan(0);
  });

  it('caps confidence at medium when the opening balance was never set', () => {
    const input = richInput();
    input.settings.configured = false;
    const f = buildBusinessForecast(input, NOW);
    expect(f.cash[7].confidence.level).not.toBe('high');
  });

  it('does not drift monthly expenses past short months', () => {
    const input = emptyInput();
    input.settings.startingCash = 10000;
    input.expenses = [{ amount: 100, frequency: 'monthly', next_due_date: '2026-10-31' }];
    const f = buildBusinessForecast(input, NOW);
    // Oct 31 (day 26), Nov 30 (day 56), Dec 31 (day 87) — all three land inside 90 days
    expect(f.cash[90].outflows).toBeCloseTo(300, 0);
  });

  it('counts a renewing membership on its real renewal date', () => {
    const input = emptyInput();
    input.memberships = [{
      status: 'active', auto_renew: true, current_period_end: '2026-10-10', price_cents: 20000, interval: 'monthly',
    }];
    const f = buildBusinessForecast(input, NOW);
    expect(f.revenue[7].recurring).toBe(200);
    expect(f.revenue[30].recurring).toBe(200); // Nov 10 is day 36, outside 30 days
    expect(f.revenue[90].recurring).toBe(600); // Oct 10, Nov 10, Dec 10
  });
});

describe('quoteTotalDollars', () => {
  it('sums unit_price_cents x quantity and applies tax', () => {
    expect(quoteTotalDollars([{ quantity: 2, unit_price_cents: 10000 }], 10)).toBe(220);
  });
  it('is safe on garbage input', () => {
    expect(quoteTotalDollars(null)).toBe(0);
    expect(quoteTotalDollars([null, 5, {}])).toBe(0);
  });
});
