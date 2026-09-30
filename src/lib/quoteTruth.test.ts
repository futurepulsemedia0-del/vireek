import { describe, expect, it } from 'vitest';
import {
  analyzeQuote,
  classifyLine,
  redactCostData,
  type HistoricalQuote,
  type PriceBookEntry,
  type TruthInput,
} from '../../supabase/functions/_shared/quote-truth/engine';

const NOW = '2026-09-30T12:00:00.000Z';

const priceBook: PriceBookEntry[] = [
  {
    service_name: 'AC compressor replacement',
    category: 'HVAC',
    keywords: ['compressor'],
    pricing_model: 'range',
    price_cents: 390_000,
    price_max_cents: 440_000,
    estimated_cost_cents: 240_000,
  },
];

function monthsAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 30 * 86_400_000).toISOString();
}

function history(count: number, accepted: number, subtotalCents: number): HistoricalQuote[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `h${i}`,
    status: i < accepted ? ('accepted' as const) : ('declined' as const),
    created_at: monthsAgo(1 + (i % 12)),
    customer_id: null,
    line_items: [{ description: 'AC compressor replacement', quantity: 1, unit_price_cents: subtotalCents + (i % 3) * 5_000 }],
  }));
}

function baseInput(totalCents: number, overrides: Partial<TruthInput> = {}): TruthInput {
  return {
    now: NOW,
    quote: {
      line_items: [{ description: 'AC compressor replacement', quantity: 1, unit_price_cents: totalCents }],
      tax_percent: 0,
      discount_type: null,
      discount_value: null,
      deposit_percent: 0,
    },
    settings: {
      margin_floor_pct: 20,
      default_cost_ratio_pct: 55,
      regional_price_index: 1,
      max_premium_pct: 12,
      region_label: null,
    },
    context: { technician_level: 'standard', complexity: 'routine', after_hours: false, travel_miles: null },
    priceBook,
    history: history(10, 6, 410_000),
    customer: null,
    equipment: [],
    competitors: [],
    cohort: null,
    ...overrides,
  };
}

describe('classifyLine', () => {
  it('classifies common line items', () => {
    expect(classifyLine('Trip charge')).toBe('travel');
    expect(classifyLine('Permit fee')).toBe('fee');
    expect(classifyLine('Labor - 3 hours')).toBe('labor');
    expect(classifyLine('Capacitor')).toBe('part');
    expect(classifyLine('Install new condenser unit')).toBe('bundle');
  });
});

describe('analyzeQuote', () => {
  it('is deterministic for identical input', () => {
    const a = analyzeQuote(baseInput(485_000));
    const b = analyzeQuote(baseInput(485_000));
    expect(a).toEqual(b);
  });

  it('flags a quote well above the expected range as high risk', () => {
    const r = analyzeQuote(baseInput(560_000));
    expect(['high', 'overpriced']).toContain(r.verdict);
    expect(r.expected.position).not.toBe('within_range');
    expect(r.findings.some((f) => f.code === 'above_expected_range')).toBe(true);
    expect(r.risk.overcharge_score).toBeGreaterThan(20);
  });

  it('treats a quote inside the expected range as well priced', () => {
    const r = analyzeQuote(baseInput(410_000));
    expect(r.verdict).toBe('well_priced');
    expect(r.expected.position).toBe('within_range');
    expect(r.risk.overcharge_level).toBe('low');
  });

  it('raises rejection probability monotonically as price rises', () => {
    const cheap = analyzeQuote(baseInput(380_000));
    const mid = analyzeQuote(baseInput(450_000));
    const dear = analyzeQuote(baseInput(560_000));
    expect(cheap.risk.rejection_probability).toBeLessThan(mid.risk.rejection_probability);
    expect(mid.risk.rejection_probability).toBeLessThan(dear.risk.rejection_probability);
    expect(dear.risk.rejection_probability).toBeLessThanOrEqual(0.97);
  });

  it('detects underpriced quotes', () => {
    const r = analyzeQuote(baseInput(300_000));
    expect(r.verdict).toBe('underpriced');
    expect(r.findings.some((f) => f.code === 'below_expected_range')).toBe(true);
  });

  it('flags charging for parts on warrantied equipment as critical', () => {
    const r = analyzeQuote(
      baseInput(430_000, {
        equipment: [
          {
            equipment_type: 'AC compressor',
            make: null,
            install_date: '2024-01-01',
            expected_lifespan_years: 15,
            warranty_expires_at: '2028-01-01',
            status: 'active',
          },
        ],
      }),
    );
    const f = r.findings.find((x) => x.code === 'warranty_conflict');
    expect(f?.severity).toBe('critical');
    expect(r.risk.overcharge_drivers.some((d) => d.label.includes('warrantied'))).toBe(true);
    expect(r.verdict).not.toBe('well_priced');
  });

  it('flags replacement on young equipment and supports replacement on old equipment', () => {
    const young = analyzeQuote(
      baseInput(410_000, {
        equipment: [{ equipment_type: 'AC compressor', make: null, install_date: '2023-01-01', expected_lifespan_years: 15, warranty_expires_at: null, status: 'active' }],
      }),
    );
    const old = analyzeQuote(
      baseInput(410_000, {
        equipment: [{ equipment_type: 'AC compressor', make: null, install_date: '2010-01-01', expected_lifespan_years: 15, warranty_expires_at: null, status: 'active' }],
      }),
    );
    expect(young.findings.some((f) => f.code === 'premature_replacement')).toBe(true);
    expect(old.findings.some((f) => f.code === 'end_of_life_supports_replacement')).toBe(true);
    expect(old.risk.acceptance_probability).toBeGreaterThan(young.risk.acceptance_probability);
  });

  it('flags excessive parts markup when real costs are known', () => {
    const r = analyzeQuote(
      baseInput(50_000, {
        priceBook: [
          { service_name: 'Capacitor', category: null, keywords: [], pricing_model: 'flat', price_cents: 5_000, price_max_cents: null, estimated_cost_cents: 1_000 },
        ],
        quote: {
          line_items: [{ description: 'Capacitor', quantity: 1, unit_price_cents: 30_000 }],
          tax_percent: 0,
          discount_type: null,
          discount_value: null,
          deposit_percent: 0,
        },
        history: [],
      }),
    );
    expect(r.findings.some((f) => f.code === 'parts_markup_high')).toBe(true);
  });

  it('uses competitor benchmarks that match the job and ignores stale or non-matching ones', () => {
    const r = analyzeQuote(
      baseInput(410_000, {
        competitors: [
          { service_keyword: 'compressor replacement', region_label: null, low_cents: 350_000, high_cents: 380_000, source_label: 'Local shop', observed_at: monthsAgo(2) },
          { service_keyword: 'furnace tune-up', region_label: null, low_cents: 10_000, high_cents: 15_000, source_label: 'Other', observed_at: monthsAgo(2) },
          { service_keyword: 'compressor replacement', region_label: null, low_cents: 100_000, high_cents: 120_000, source_label: 'Ancient', observed_at: monthsAgo(60) },
        ],
      }),
    );
    expect(r.data_quality.competitor_benchmarks_used).toBe(1);
    expect(r.expected.anchors.some((a) => a.key === 'competitor')).toBe(true);
  });

  it('falls back to a low-evidence verdict when only cost-plus is available', () => {
    const r = analyzeQuote(baseInput(410_000, { priceBook: [], history: [] }));
    expect(r.verdict).toBe('low_evidence');
    expect(r.expected.confidence_label).toBe('low');
    expect(r.expected.anchors).toHaveLength(1);
    expect(r.findings.some((f) => f.code === 'thin_evidence')).toBe(true);
  });

  it('never recommends a price below the margin floor when a feasible price exists', () => {
    const r = analyzeQuote(baseInput(560_000));
    expect(r.optimization.recommended.feasible).toBe(true);
    const m = r.optimization.recommended.margin_pct;
    expect(m).not.toBeNull();
    expect(m as number).toBeGreaterThanOrEqual(20);
  });

  it('recommends lowering an overpriced quote and raising an underpriced one', () => {
    const over = analyzeQuote(baseInput(650_000));
    const under = analyzeQuote(baseInput(300_000));
    expect(over.optimization.action).toBe('lower');
    expect(over.optimization.recommended.price_cents).toBeLessThan(650_000);
    expect(under.optimization.action).toBe('raise');
    expect(under.optimization.recommended.price_cents).toBeGreaterThan(300_000);
  });

  it('never recommends raising a quote that is already above the expected range, even when margin is huge', () => {
    const r = analyzeQuote(baseInput(485_000));
    expect(r.expected.position).not.toBe('within_range');
    expect(r.optimization.action).toBe('lower');
    expect(r.optimization.recommended.price_cents).toBeLessThan(485_000);
    expect(r.optimization.recommended.price_cents).toBeLessThanOrEqual(Math.round(r.expected.high_cents * 1.06));
    expect(r.optimization.safe_max_cents).toBeLessThanOrEqual(Math.round(r.expected.high_cents * 1.06));
  });

  it('keeps the recommended price inside the fair-price ceiling for any input price', () => {
    for (const total of [200_000, 300_000, 410_000, 485_000, 650_000, 900_000]) {
      const r = analyzeQuote(baseInput(total));
      expect(r.optimization.recommended.price_cents).toBeLessThanOrEqual(Math.max(total, Math.round(r.expected.high_cents * 1.06)));
    }
  });

  it('applies technician, complexity and travel factors to the expected range', () => {
    const plain = analyzeQuote(baseInput(410_000));
    const loaded = analyzeQuote(
      baseInput(410_000, {
        context: { technician_level: 'master', complexity: 'complex', after_hours: true, travel_miles: 60 },
      }),
    );
    expect(loaded.expected.mid_cents).toBeGreaterThan(plain.expected.mid_cents);
    expect(loaded.expected.factors.find((f) => f.key === 'travel')?.applied).toBe(true);
  });

  it('applies percent and flat discounts before judging the price', () => {
    const pct = analyzeQuote(baseInput(500_000, { quote: { ...baseInput(500_000).quote, discount_type: 'percent', discount_value: 10 } }));
    const flat = analyzeQuote(baseInput(500_000, { quote: { ...baseInput(500_000).quote, discount_type: 'flat', discount_value: 500 } }));
    expect(pct.quote.subtotal_cents).toBe(450_000);
    expect(flat.quote.subtotal_cents).toBe(450_000);
  });

  it('calibrates price sensitivity from enough decided history', () => {
    const decided: HistoricalQuote[] = [];
    for (let i = 0; i < 16; i++) {
      const expensive = i % 2 === 0;
      decided.push({
        id: `d${i}`,
        status: expensive ? (i % 8 === 0 ? 'accepted' : 'declined') : 'accepted',
        created_at: monthsAgo(1 + (i % 10)),
        customer_id: null,
        line_items: [{ description: 'AC compressor replacement', quantity: 1, unit_price_cents: expensive ? 520_000 : 380_000 }],
      });
    }
    const r = analyzeQuote(baseInput(450_000, { history: decided }));
    expect(r.risk.sensitivity_source).toBe('calibrated');
    expect(r.risk.sensitivity).toBeGreaterThanOrEqual(1.5);
    expect(r.risk.sensitivity).toBeLessThanOrEqual(8);
  });

  it('keeps probabilities and scores within valid bounds', () => {
    for (const total of [1_000, 50_000, 410_000, 900_000, 5_000_000]) {
      const r = analyzeQuote(baseInput(total));
      expect(r.risk.acceptance_probability).toBeGreaterThanOrEqual(0.03);
      expect(r.risk.acceptance_probability).toBeLessThanOrEqual(0.97);
      expect(r.risk.rejection_band[0]).toBeLessThanOrEqual(r.risk.rejection_probability);
      expect(r.risk.rejection_band[1]).toBeGreaterThanOrEqual(r.risk.rejection_probability);
      expect(r.risk.overcharge_score).toBeGreaterThanOrEqual(0);
      expect(r.risk.overcharge_score).toBeLessThanOrEqual(100);
    }
  });

  it('throws on empty or zero-value quotes', () => {
    expect(() => analyzeQuote(baseInput(0))).toThrow();
    expect(() => analyzeQuote({ ...baseInput(100), quote: { ...baseInput(100).quote, line_items: [] } })).toThrow();
  });

  it('redacts all cost and margin data for viewers without billing access', () => {
    const full = analyzeQuote(baseInput(410_000));
    const red = redactCostData(full);
    expect(red.redacted).toBe(true);
    expect(red.margin).toBeNull();
    expect(red.expected.anchors.some((a) => a.key === 'cost_plus')).toBe(false);
    expect(red.optimization.curve.every((c) => c.expected_profit_cents === null)).toBe(true);
    expect(red.optimization.current.margin_pct).toBeNull();
    expect(JSON.stringify(red)).not.toContain('estimated_cost_cents');
  });
});
