import { describe, expect, it } from 'vitest';
import {
  analyzeEnergy,
  categorize,
  cleanPeriods,
  paybackYears,
  projectSavings,
  type EnergyInput,
  type EquipmentInput,
  type UsagePeriod,
} from '../../supabase/functions/_shared/energy-intelligence/engine';
import { parseUsageCsv } from '@/lib/energyCsv';

const CLIMATE_C = [0, 2, 7, 12, 17, 22, 26, 25, 20, 13, 6, 1];
const F = (c: number) => (c * 9) / 5 + 32;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 24 clean monthly periods Jan 2025 - Dec 2026 following a known weather response. */
function synth(opts: {
  fuel: 'electric' | 'gas';
  base: number;
  cdd: number;
  hdd: number;
  spikeIdx?: number;
  spike?: number;
  rateCents?: number;
}): UsagePeriod[] {
  const out: UsagePeriod[] = [];
  for (let i = 0; i < 24; i++) {
    const y = 2025 + Math.floor(i / 12);
    const m = i % 12;
    const f = F(CLIMATE_C[m]);
    const perDay = opts.base + opts.cdd * Math.max(0, f - 65) + opts.hdd * Math.max(0, 65 - f);
    const wobble = 1 + 0.01 * Math.sin(i * 1.7);
    let usage = perDay * DAYS[m] * wobble;
    if (i === opts.spikeIdx) usage *= opts.spike ?? 1;
    const start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);
    out.push({
      id: `${opts.fuel}-${i}`,
      fuel: opts.fuel,
      period_start: start,
      period_end: end,
      usage: Math.round(usage * 10) / 10,
      cost_cents: opts.rateCents ? Math.round(usage * opts.rateCents) : null,
    });
  }
  return out;
}

const eq = (over: Partial<EquipmentInput>): EquipmentInput => ({
  id: 'e1',
  equipment_type: 'Central AC',
  make: 'Carrier',
  model: 'X1',
  install_date: '2008-06-01',
  expected_lifespan_years: 15,
  last_service_date: null,
  service_interval_months: 12,
  ...over,
});

const base = (over: Partial<EnergyInput> = {}): EnergyInput => ({
  now: '2027-01-15T00:00:00Z',
  usage: [],
  property: {
    living_sqft: 2000,
    year_built: 1985,
    monthly_mean_c: CLIMATE_C,
    eia_cents_per_kwh: null,
  },
  equipment: [],
  telemetry_anomalies: [],
  predictions: [],
  weather_events: [],
  measured_kwh_30d: {},
  escalation_pct: 2.5,
  ...over,
});

describe('weather model', () => {
  it('recovers a known base / cooling / heating response', () => {
    const usage = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0.8, rateCents: 15 });
    const r = analyzeEnergy(base({ usage }));
    const m = r.fuels[0].model;
    expect(m.mode).toBe('weather_regression');
    expect(m.r2).toBeGreaterThan(0.95);
    expect(m.base_per_day).toBeGreaterThan(18);
    expect(m.base_per_day).toBeLessThan(22);
    expect(m.cdd_coef).toBeGreaterThan(2.2);
    expect(m.cdd_coef).toBeLessThan(2.8);
    expect(r.confidence).toBe('high');
    expect(r.totals.annual_cost_cents).toBeGreaterThan(0);
  });

  it('falls back to a flat model with no climate data', () => {
    const usage = synth({ fuel: 'electric', base: 25, cdd: 0, hdd: 0, rateCents: 14 });
    const r = analyzeEnergy(
      base({
        usage,
        property: {
          living_sqft: null,
          year_built: null,
          monthly_mean_c: null,
          eia_cents_per_kwh: null,
        },
      }),
    );
    expect(r.fuels[0].model.mode).toBe('flat');
    expect(r.data_quality.warnings.join(' ')).toMatch(/climate/i);
    expect(r.totals.efficiency_score).toBeNull();
  });

  it('never throws and explains itself on empty input', () => {
    const r = analyzeEnergy(base());
    expect(r.fuels).toHaveLength(0);
    expect(r.forecast.scenarios).toHaveLength(0);
    expect(r.data_quality.warnings.join(' ')).toMatch(/No billing history/);
    expect(r.confidence).toBe('low');
  });
});

describe('anomalies', () => {
  it('flags an injected spike without letting it hide in the fit', () => {
    const usage = synth({
      fuel: 'electric',
      base: 20,
      cdd: 2.5,
      hdd: 0.8,
      spikeIdx: 18,
      spike: 1.9,
      rateCents: 15,
    });
    const r = analyzeEnergy(base({ usage }));
    const spike = r.anomalies.find((a) => a.kind === 'usage_spike');
    expect(spike).toBeDefined();
    expect(spike!.period_start).toBe('2026-07-01');
    expect(['medium', 'high']).toContain(spike!.severity);
    expect(spike!.est_excess_cost_cents).toBeGreaterThan(0);
    expect(r.fuels[0].model.excluded_outliers).toBeGreaterThanOrEqual(1);
  });

  it('stays quiet on clean data', () => {
    const usage = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0.8, rateCents: 15 });
    expect(
      analyzeEnergy(base({ usage })).anomalies.filter((a) => a.fuel === 'electric'),
    ).toHaveLength(0);
  });

  it('surfaces energy-relevant telemetry signals only for known equipment', () => {
    const usage = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0.8, rateCents: 15 });
    const r = analyzeEnergy(
      base({
        usage,
        equipment: [eq({})],
        telemetry_anomalies: [
          {
            id: 't1',
            equipment_id: 'e1',
            metric: 'filter_dp',
            kind: 'drift',
            severity: 'high',
            direction: 'high',
            explanation: 'Filter drop rising.',
            detected_at: '2027-01-10T00:00:00Z',
          },
          {
            id: 't2',
            equipment_id: 'e1',
            metric: 'humidity',
            kind: 'spike',
            severity: 'low',
            direction: 'high',
            explanation: 'x',
            detected_at: '2027-01-10T00:00:00Z',
          },
          {
            id: 't3',
            equipment_id: 'ghost',
            metric: 'power_kw',
            kind: 'spike',
            severity: 'low',
            direction: 'high',
            explanation: 'x',
            detected_at: '2027-01-10T00:00:00Z',
          },
        ],
      }),
    );
    const sig = r.anomalies.filter((a) => a.kind === 'equipment_signal');
    expect(sig).toHaveLength(1);
    expect(sig[0].explanation).toMatch(/airflow/i);
  });
});

describe('equipment, opportunities, portfolio', () => {
  const usage = [
    ...synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0, rateCents: 15 }),
    ...synth({ fuel: 'gas', base: 0.4, cdd: 0, hdd: 0.45, rateCents: 130 }),
  ];
  const equipment = [
    eq({ id: 'ac', equipment_type: 'Central AC', install_date: '2004-05-01' }),
    eq({
      id: 'fur',
      equipment_type: 'Gas Furnace',
      install_date: '2001-10-01',
      make: 'Lennox',
      model: 'G',
    }),
  ];

  it('attributes weather-driven load and finds old-unit savings', () => {
    const r = analyzeEnergy(base({ usage, equipment }));
    const ac = r.equipment.find((e) => e.id === 'ac')!;
    const fur = r.equipment.find((e) => e.id === 'fur')!;
    expect(ac.basis).toBe('weather_model');
    expect(ac.attributed_kwh).toBeGreaterThan(0);
    expect(ac.efficiency!.effective).toBeLessThan(ac.efficiency!.nominal);
    expect(fur.attributed_therms).toBeGreaterThan(0);
    const ids = r.opportunities.map((o) => o.id);
    expect(ids).toContain('cooling-ac');
    expect(ids).toContain('furnace-fur');
    expect(ids).toContain('smart-thermostat');
  });

  it('never double counts overlapping measures', () => {
    const r = analyzeEnergy(base({ usage, equipment }));
    const sum = r.opportunities.reduce((s, o) => s + (o.savings_cents?.expected ?? 0), 0);
    expect(r.portfolio.savings_cents!.expected).toBeLessThanOrEqual(sum);
    expect(r.portfolio.overlap_discount_pct).toBeGreaterThan(0);
    expect(r.portfolio.savings_cents!.low).toBeLessThanOrEqual(r.portfolio.savings_cents!.expected);
    expect(r.portfolio.savings_cents!.high).toBeGreaterThanOrEqual(
      r.portfolio.savings_cents!.expected,
    );
  });

  it('does not offer a fuel switch that would cost more', () => {
    const cheapGas = [
      ...synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0, rateCents: 30 }),
      ...synth({ fuel: 'gas', base: 0.4, cdd: 0, hdd: 0.45, rateCents: 40 }),
    ];
    const r = analyzeEnergy(base({ usage: cheapGas, equipment }));
    expect(r.opportunities.some((o) => o.id.startsWith('hp-switch'))).toBe(false);
  });

  it('skips efficiency maths when the install date is unknown', () => {
    const r = analyzeEnergy(base({ usage, equipment: [eq({ id: 'ac', install_date: null })] }));
    expect(r.equipment[0].efficiency).toBeNull();
    expect(r.opportunities.some((o) => o.id === 'cooling-ac')).toBe(false);
  });

  it('has no dollar savings when no rate is known', () => {
    const noCost = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0 });
    const r = analyzeEnergy(base({ usage: noCost, equipment }));
    expect(r.totals.annual_cost_cents).toBeNull();
    expect(r.opportunities.every((o) => o.savings_cents === null)).toBe(true);
  });

  it('uses the EIA rate only as a labelled fallback', () => {
    const noCost = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0 });
    const r = analyzeEnergy(
      base({
        usage: noCost,
        equipment,
        property: {
          living_sqft: 2000,
          year_built: 1985,
          monthly_mean_c: CLIMATE_C,
          eia_cents_per_kwh: 16,
        },
      }),
    );
    expect(r.fuels[0].rate_source).toBe('eia');
    expect(r.totals.annual_cost_cents).toBeGreaterThan(0);
  });
});

describe('forecast', () => {
  const usage = synth({ fuel: 'electric', base: 20, cdd: 2.5, hdd: 0.8, rateCents: 15 });
  it('orders scenarios sensibly', () => {
    const r = analyzeEnergy(base({ usage, equipment: [eq({ install_date: '2004-05-01' })] }));
    const by = Object.fromEntries(r.forecast.scenarios.map((s) => [s.key, s]));
    expect(by.baseline.months).toHaveLength(12);
    expect(by.baseline.months[0].month).toBe('2027-01');
    expect(by.upgraded.total_kwh).toBeLessThan(by.baseline.total_kwh);
    expect(Math.max(by.hot_summer.total_kwh, by.cold_winter.total_kwh)).toBeGreaterThan(
      by.baseline.total_kwh * 0.999,
    );
    const m = by.baseline.months[6];
    expect(m.kwh_low).toBeLessThan(m.kwh);
    expect(m.kwh_high).toBeGreaterThan(m.kwh);
  });
});

describe('helpers', () => {
  it('drops overlapping and invalid periods', () => {
    const ps: UsagePeriod[] = [
      {
        id: 'a',
        fuel: 'electric',
        period_start: '2026-01-01',
        period_end: '2026-02-01',
        usage: 500,
        cost_cents: null,
      },
      {
        id: 'b',
        fuel: 'electric',
        period_start: '2026-01-10',
        period_end: '2026-02-10',
        usage: 500,
        cost_cents: null,
      },
      {
        id: 'c',
        fuel: 'electric',
        period_start: '2026-02-01',
        period_end: '2026-01-01',
        usage: 500,
        cost_cents: null,
      },
      {
        id: 'd',
        fuel: 'electric',
        period_start: '2026-02-01',
        period_end: '2026-03-01',
        usage: -4,
        cost_cents: null,
      },
      {
        id: 'e',
        fuel: 'electric',
        period_start: '2026-02-01',
        period_end: '2026-03-01',
        usage: 480,
        cost_cents: null,
      },
    ];
    const { rows, warnings } = cleanPeriods(ps, 'electric', null);
    expect(rows.map((r) => r.id)).toEqual(['a', 'e']);
    expect(warnings.join(' ')).toMatch(/overlapping/);
  });

  it('categorizes equipment', () => {
    expect(categorize('Heat Pump')).toBe('heat_pump');
    expect(categorize('Gas Furnace')).toBe('heating');
    expect(categorize('Central AC')).toBe('cooling');
    expect(categorize('Tankless Water Heater')).toBe('water_heating');
    expect(categorize('Smart Thermostat')).toBe('controls');
    expect(categorize('Dehumidifier')).toBe('other');
  });

  it('projects and pays back with escalation', () => {
    const p = projectSavings(100_000, 10, 3);
    expect(p).toHaveLength(10);
    expect(p[9].cumulative_cents).toBeGreaterThan(1_000_000);
    expect(paybackYears(0, 100, 3)).toBe(0);
    expect(paybackYears(500_000, 100_000, 0)).toBe(5);
    expect(paybackYears(500_000, 0, 0)).toBeNull();
    expect(paybackYears(1_000_000_000, 100_000, 0)).toBeNull();
    expect(paybackYears(500_000, 100_000, 5)!).toBeLessThan(5);
  });
});

describe('usage CSV import', () => {
  it('parses dollars and kWh, rejects bad rows with line numbers', () => {
    const csv =
      'period_start,period_end,usage,cost\n2026-01-01,2026-02-01,812,$121.80\n2026-02-01,2026-03-01,not-a-number,90\n2026-03-01,2026-02-01,500,60\n';
    const { rows, errors } = parseUsageCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      period_start: '2026-01-01',
      period_end: '2026-02-01',
      usage: 812,
      cost_cents: 12180,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Line 3/);
  });

  it('accepts semicolons, tabs and US dates', () => {
    const { rows, errors } = parseUsageCsv('01/01/2026;02/01/2026;700;\n');
    expect(errors).toHaveLength(0);
    expect(rows[0].period_start).toBe('2026-01-01');
    expect(rows[0].cost_cents).toBeNull();
  });
});
