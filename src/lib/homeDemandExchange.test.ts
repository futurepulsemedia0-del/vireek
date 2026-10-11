import { describe, expect, it } from 'vitest';
import {
  detectDemand,
  equipmentTrade,
  estimateValueCents,
  haversineKm,
  jobMatchesTrade,
  rankTechnicians,
  recommendRoute,
  scoreDemand,
  summarizeDemand,
  urgencyFromSeverity,
  weatherProfile,
  type DemandSignals,
  type MatchContext,
  type TechnicianSignal,
} from '@/lib/homeDemandExchange';

const NOW = new Date('2027-04-15T12:00:00Z').getTime();
const DAY = 86_400_000;
const isoDaysAgo = (d: number) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
const isoDaysAhead = (d: number) => new Date(NOW + d * DAY).toISOString().slice(0, 10);

const customer = { id: 'c1', name: 'Dana Rivera', phone: '555-0100', email: null, address: '12 Oak St, Austin' };

function signals(over: Partial<DemandSignals> = {}): DemandSignals {
  return {
    now: NOW,
    customers: { c1: customer },
    equipment: [],
    predictions: [],
    weather: [],
    permits: [],
    rebates: [],
    mesh: [],
    properties: [],
    openJobs: [],
    avgTicketCents: null,
    ticketSamples: 0,
    ...over,
  };
}

const furnace = {
  id: 'e1',
  customer_id: 'c1',
  equipment_type: 'Furnace',
  make: 'Carrier',
  model: '59TP6',
  install_date: isoDaysAgo(365 * 17),
  warranty_expires_at: null,
  expected_lifespan_years: 18,
  service_interval_months: 12,
  last_service_date: isoDaysAgo(30),
};

describe('helpers', () => {
  it('maps equipment types to trades', () => {
    expect(equipmentTrade('Tankless water heater').trade).toBe('plumbing');
    expect(equipmentTrade('Heat pump').skill).toBe('heat_pump');
    expect(equipmentTrade('Breaker panel').trade).toBe('electrical');
    expect(equipmentTrade('Mystery box').trade).toBe('general');
  });

  it('maps weather alerts to trades', () => {
    expect(weatherProfile('Excessive Heat Warning')?.trade).toBe('hvac');
    expect(weatherProfile('Hard Freeze Watch')?.trade).toBe('plumbing');
    expect(weatherProfile('Earthquake')).toBeNull();
  });

  it('grades urgency from severity', () => {
    expect(urgencyFromSeverity(0.9)).toBe('critical');
    expect(urgencyFromSeverity(0.7)).toBe('high');
    expect(urgencyFromSeverity(0.45)).toBe('medium');
    expect(urgencyFromSeverity(0.1)).toBe('low');
  });

  it('scores monotonically and stays within 0..100', () => {
    const low = scoreDemand({ severity: 0.2, confidence: 0.5, estValueCents: 10_000, daysToWindowStart: 60 });
    const high = scoreDemand({ severity: 0.9, confidence: 0.9, estValueCents: 900_000, daysToWindowStart: 0 });
    expect(high).toBeGreaterThan(low);
    expect(scoreDemand({ severity: 5, confidence: 5, estValueCents: 1e12, daysToWindowStart: -10 })).toBeLessThanOrEqual(100);
    expect(scoreDemand({ severity: -1, confidence: -1, estValueCents: 0, daysToWindowStart: 999 })).toBeGreaterThanOrEqual(0);
  });

  it('uses account ticket data only with enough samples', () => {
    expect(estimateValueCents('hvac', 'repair', 80_000, 2)).toBe(42_000);
    expect(estimateValueCents('hvac', 'repair', 80_000, 12)).toBe(80_000);
    expect(estimateValueCents('hvac', 'replacement', 80_000, 12)).toBe(950_000);
  });

  it('matches open jobs to trades', () => {
    expect(jobMatchesTrade('AC repair', 'hvac')).toBe(true);
    expect(jobMatchesTrade('Drain cleaning', 'hvac')).toBe(false);
    expect(jobMatchesTrade(null, 'hvac')).toBe(true);
  });

  it('computes distance', () => {
    const d = haversineKm({ lat: 30.2672, lng: -97.7431 }, { lat: 29.4241, lng: -98.4936 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(120);
  });
});

describe('detectDemand', () => {
  it('flags an aging furnace as a qualified replacement opportunity', () => {
    const [c] = detectDemand(signals({ equipment: [furnace] }));
    expect(c.source_kind).toBe('equipment_health');
    expect(c.dedupe_key).toBe('eq:e1:replace');
    expect(c.trade_category).toBe('hvac');
    expect(c.est_value_cents).toBe(950_000);
    expect(c.qualified).toBe(true);
    expect(c.scope).toBe('property');
  });

  it('flags overdue service with a stable key that changes once serviced', () => {
    const e = { ...furnace, install_date: isoDaysAgo(365 * 3), last_service_date: isoDaysAgo(500) };
    const first = detectDemand(signals({ equipment: [e] }));
    expect(first[0].service_label).toMatch(/maintenance/);
    const serviced = detectDemand(signals({ equipment: [{ ...e, last_service_date: isoDaysAgo(10) }] }));
    expect(serviced).toHaveLength(0);
  });

  it('merges a prediction and equipment health on the same asset into one opportunity', () => {
    const out = detectDemand(
      signals({
        equipment: [furnace],
        predictions: [
          { id: 'p1', equipment_id: 'e1', failure_label: 'Heat exchanger crack', probability: 0.8, confidence: 0.7, horizon_days: 20, recommended_action: 'Inspect' },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].source_kind).toBe('predicted_failure');
    expect(out[0].evidence.some((ev) => ev.label.startsWith('Also flagged'))).toBe(true);
  });

  it('ignores weak predictions', () => {
    const out = detectDemand(
      signals({
        equipment: [{ ...furnace, install_date: isoDaysAgo(365) }],
        predictions: [{ id: 'p1', equipment_id: 'e1', failure_label: 'x', probability: 0.2, confidence: 0.9, horizon_days: 10, recommended_action: null }],
      }),
    );
    expect(out).toHaveLength(0);
  });

  it('blocks qualification when the customer is unreachable or already has an open job', () => {
    const noContact = detectDemand(signals({ customers: { c1: { ...customer, phone: null, email: null } }, equipment: [furnace] }));
    expect(noContact[0].qualified).toBe(false);
    expect(noContact[0].qualification.find((g) => g.key === 'contactable')?.passed).toBe(false);

    const conflict = detectDemand(
      signals({
        equipment: [furnace],
        openJobs: [{ customer_id: 'c1', service_type: 'Furnace tune-up', scheduled_datetime: isoDaysAhead(3), job_status: 'scheduled' }],
      }),
    );
    expect(conflict[0].qualified).toBe(false);
    expect(conflict[0].qualification.find((g) => g.key === 'no_conflict')?.passed).toBe(false);
  });

  it('detects warranty expiry, failed permits and rebates', () => {
    const out = detectDemand(
      signals({
        equipment: [{ ...furnace, id: 'e2', install_date: isoDaysAgo(365), warranty_expires_at: isoDaysAhead(20) }],
        permits: [{ id: 'pm1', customer_id: 'c1', site_id: null, permit_type: 'electrical', status: 'failed', expires_on: null, final_inspection_on: null, description: 'Panel swap' }],
        rebates: [{ id: 'r1', customer_id: 'c1', equipment_id: null, total_expected_cents: 150_000, install_target_date: isoDaysAhead(40), created_at: new Date(NOW - DAY).toISOString() }],
      }),
    );
    const kinds = out.map((c) => c.source_kind).sort();
    expect(kinds).toEqual(['permit', 'rebate', 'warranty']);
  });

  it('turns an active heat alert into a market-scope opportunity that is never a lead', () => {
    const out = detectDemand(
      signals({
        equipment: [{ ...furnace, equipment_type: 'Central AC', install_date: isoDaysAgo(365) }],
        weather: [{ id: 'w1', event_type: 'Excessive Heat Warning', severity: 'Severe', headline: 'Heat', area_desc: 'Travis', effective_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 2 * DAY).toISOString() }],
      }),
    );
    const wx = out.find((c) => c.source_kind === 'weather');
    expect(wx?.scope).toBe('market');
    expect(wx?.qualified).toBe(false);
    expect(wx?.customer_id).toBeNull();
  });

  it('drops expired weather and low-level mesh events, keeps elevated ones', () => {
    const out = detectDemand(
      signals({
        weather: [{ id: 'w1', event_type: 'Heat Advisory', severity: 'Minor', headline: null, area_desc: null, effective_at: null, expires_at: new Date(NOW - DAY).toISOString() }],
        mesh: [
          { id: 'm1', event_kind: 'demand_spike', level: 'low', probability: 0.1, window_start: new Date(NOW).toISOString(), window_end: new Date(NOW + DAY).toISOString() },
          { id: 'm2', event_kind: 'demand_spike', level: 'high', probability: 0.7, window_start: new Date(NOW).toISOString(), window_end: new Date(NOW + DAY).toISOString() },
        ],
      }),
    );
    expect(out.map((c) => c.dedupe_key)).toEqual(['mesh:m2']);
  });

  it('flags old homes with no recent service', () => {
    const out = detectDemand(signals({ properties: [{ customer_id: 'c1', site_id: null, year_built: 1962, heating_fuel: 'gas' }] }));
    expect(out[0].source_kind).toBe('property_condition');
  });

  it('is deterministic and sorted best-first', () => {
    const s = signals({ equipment: [furnace, { ...furnace, id: 'e3', install_date: isoDaysAgo(365 * 3), last_service_date: isoDaysAgo(900) }] });
    const a = detectDemand(s);
    expect(detectDemand(s)).toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].demand_score).toBeGreaterThanOrEqual(a[i].demand_score);
  });
});

describe('rankTechnicians', () => {
  const tech = (id: string, over: Partial<TechnicianSignal> = {}): TechnicianSignal => ({
    id,
    name: id,
    role: 'technician',
    skills: ['hvac'],
    service_area: 'Austin',
    max_jobs_per_day: 4,
    dispatch_enabled: true,
    hourly_cost_rate_cents: 4_000,
    home_latitude: null,
    home_longitude: null,
    current_latitude: null,
    current_longitude: null,
    location_updated_at: null,
    ...over,
  });
  const ctx: MatchContext = {
    now: NOW,
    targetMs: NOW + DAY,
    trade: 'hvac',
    skill: null,
    serviceLabel: 'Furnace replacement',
    address: '12 Oak St, Austin',
    customerId: 'c1',
    site: { lat: 30.2672, lng: -97.7431 },
    estValueCents: 950_000,
    estMarginPct: 34,
    durationMinutes: 240,
  };

  it('weights add up to 100 and scores stay in range', () => {
    const [m] = rankTechnicians(ctx, [tech('a')], {});
    expect(m.factors.reduce((s, f) => s + f.weight, 0)).toBe(100);
    expect(m.score).toBeGreaterThanOrEqual(0);
    expect(m.score).toBeLessThanOrEqual(100);
  });

  it('prefers the skilled, nearby, available technician', () => {
    const near = tech('near', { home_latitude: 30.27, home_longitude: -97.74 });
    const far = tech('far', { skills: ['roofing'], home_latitude: 32.78, home_longitude: -96.8 });
    const ranked = rankTechnicians(ctx, [far, near], {});
    expect(ranked[0].technician_id).toBe('near');
  });

  it('blocks technicians at capacity or with dispatch disabled and sorts them last', () => {
    const day = new Date(NOW + DAY).toISOString();
    const full = Array.from({ length: 4 }, () => ({ scheduled_datetime: day, job_status: 'scheduled', customer_id: null }));
    const ranked = rankTechnicians(ctx, [tech('full'), tech('off', { dispatch_enabled: false }), tech('free')], { full });
    expect(ranked[0].technician_id).toBe('free');
    expect(ranked.find((m) => m.technician_id === 'full')?.eligible).toBe(false);
    expect(ranked.find((m) => m.technician_id === 'off')?.blockers[0]).toMatch(/disabled/);
  });

  it('rewards history with the customer and ignores non-technicians', () => {
    const history = [{ scheduled_datetime: new Date(NOW - 20 * DAY).toISOString(), job_status: 'completed', customer_id: 'c1' }];
    const ranked = rankTechnicians(ctx, [tech('known'), tech('stranger'), tech('boss', { role: 'admin' })], { known: history });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].technician_id).toBe('known');
  });

  it('routes by fit and value', () => {
    const good = rankTechnicians(ctx, [tech('a', { home_latitude: 30.27, home_longitude: -97.74 })], {});
    expect(recommendRoute(good, 950_000).route).toBe('dispatch');
    expect(recommendRoute([], 950_000).route).toBe('capacity_exchange');
    expect(recommendRoute([], 12_000).route).toBe('marketplace');
  });
});

describe('summarizeDemand', () => {
  it('counts open pipeline, expected margin and monthly conversions', () => {
    const s = summarizeDemand(
      [
        { status: 'qualified', scope: 'property', est_value_cents: 100_000, est_margin_pct: 50, source_kind: 'rebate', converted_at: null },
        { status: 'detected', scope: 'market', est_value_cents: 900_000, est_margin_pct: null, source_kind: 'weather', converted_at: null },
        { status: 'converted', scope: 'property', est_value_cents: 1, est_margin_pct: 1, source_kind: 'permit', converted_at: new Date(NOW).toISOString() },
        { status: 'dismissed', scope: 'property', est_value_cents: 500_000, est_margin_pct: 50, source_kind: 'permit', converted_at: null },
      ],
      NOW,
    );
    expect(s.open).toBe(2);
    expect(s.qualified).toBe(1);
    expect(s.pipelineCents).toBe(100_000);
    expect(s.expectedMarginCents).toBe(50_000);
    expect(s.convertedThisMonth).toBe(1);
    expect(s.bySource.weather).toBe(1);
  });
});
