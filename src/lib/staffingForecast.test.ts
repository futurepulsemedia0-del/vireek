import { describe, expect, it } from 'vitest';
import {
  addDays,
  analyzeStaffing,
  diffDays,
  localDate,
  type DailyCallRow,
  type HourlyCallRow,
  type JobDayRow,
  type StaffingInput,
  type StaffingSettings,
  type WeatherDay,
} from '../../supabase/functions/_shared/staffing-forecast/engine';

const NOW = '2026-10-20T15:00:00Z'; // Tuesday
const TZ = 'America/New_York';
const TODAY = '2026-10-20';

const SETTINGS: StaffingSettings = {
  calls_per_csr_hour: 5,
  csr_target_occupancy_pct: 75,
  avg_job_minutes_override: 90,
  tech_hourly_cost_cents: 3000,
  csr_hourly_cost_cents: 2000,
  overtime_multiplier: 1.5,
  tech_paid_hours_per_day: 8,
  sustained_weeks_to_hire: 3,
  csr_concurrent_override: null,
};
const HOURS = {
  mon: { open: '08:00', close: '17:00' }, tue: { open: '08:00', close: '17:00' }, wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' }, fri: { open: '08:00', close: '17:00' },
};
// Mon..Sun relative weekday weights (closed weekend).
const JOB_BASE = [1.2, 1.1, 1.0, 1.0, 0.9, 0, 0];
const dow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0

/** Deterministic pseudo-noise in [-1, 1] so tests never flake. */
const noise = (i: number) => Math.sin(i * 12.9898) * 0.5 + Math.cos(i * 78.233) * 0.5;

function makeInput(over: Partial<StaffingInput> & { days?: number; jobsPerDay?: number; callsPerDay?: number; humanShare?: number } = {}): StaffingInput {
  const days = over.days ?? 120;
  const jobsPerDay = over.jobsPerDay ?? 8;
  const callsPerDay = over.callsPerDay ?? 20;
  const humanShare = over.humanShare ?? 0.1;
  const jobs: JobDayRow[] = [];
  const callsDaily: DailyCallRow[] = [];
  const callsHourly: HourlyCallRow[] = [];
  for (let i = days; i >= 1; i--) {
    const d = addDays(TODAY, -i);
    const w = dow(d);
    const j = Math.max(0, Math.round(jobsPerDay * JOB_BASE[w] + noise(i) * 0.8));
    jobs.push({ d, jobs: j, minutes: j * 90 });
    const c = w >= 5 ? Math.round(callsPerDay * 0.3) : Math.round(callsPerDay * JOB_BASE[w] + noise(i + 7));
    callsDaily.push({ d, calls: c, human: Math.round(c * humanShare), emergency: 0 });
    if (i <= 84) {
      for (let h = 8; h < 17; h++) {
        const share = Math.floor(c / 9) + (h - 8 < c % 9 ? 1 : 0);
        callsHourly.push({ d, h, calls: share, human: Math.round(share * humanShare), emergency: 0 });
      }
    }
  }
  return {
    now: NOW, timezone: TZ, calls_daily: callsDaily, calls_hourly: callsHourly, jobs_daily: jobs, booked_ahead: [],
    tech: { headcount: 2, capacity_jobs_per_day: 12 }, csr: { headcount: 1 }, hours: HOURS,
    policy: { low_threshold_pct: 50, full_threshold_pct: 90, emergency_reserve_slots: 1 },
    settings: SETTINGS, weather: null, regional: null, include_costs: true, ...over,
  };
}

describe('date helpers', () => {
  it('computes the local business date, not the UTC date', () => {
    expect(localDate('2026-10-21T02:30:00Z', 'America/New_York')).toBe('2026-10-20');
    expect(localDate('2026-10-21T02:30:00Z', 'Asia/Baku')).toBe('2026-10-21');
  });
  it('falls back safely on a bad timezone', () => {
    expect(localDate('2026-10-20T10:00:00Z', 'Not/AZone')).toBe('2026-10-20');
  });
  it('adds and diffs days across month boundaries', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(diffDays('2026-10-20', '2026-11-03')).toBe(14);
  });
});

describe('insufficient data', () => {
  it('refuses to forecast from a handful of days and says why', () => {
    const r = analyzeStaffing(makeInput({ days: 8 }));
    expect(r.status).toBe('insufficient_data');
    expect(r.daily).toHaveLength(0);
    expect(r.recommendations[0].kind).toBe('improve_data');
  });
});

describe('weekday seasonality and capacity', () => {
  const r = analyzeStaffing(makeInput());
  it('produces 14 days, 168 hourly rows and 8 weeks', () => {
    expect(r.status).toBe('ok');
    expect(r.daily).toHaveLength(14);
    expect(r.hourly).toHaveLength(7 * 24);
    expect(r.weekly).toHaveLength(8);
    expect(r.daily[0].date).toBe(TODAY);
  });
  it('keeps closed weekend days at zero capacity and ~zero jobs', () => {
    const weekend = r.daily.filter((d) => d.weekday === 'sat' || d.weekday === 'sun');
    expect(weekend.length).toBeGreaterThan(0);
    for (const d of weekend) {
      expect(d.tech_capacity_jobs).toBe(0);
      expect(d.status).toBe('closed');
      expect(d.jobs.p50).toBeLessThan(0.5);
    }
  });
  it('forecasts weekdays close to the true level with ordered bands', () => {
    const mon = r.daily.find((d) => d.weekday === 'mon')!;
    expect(mon.jobs.p50).toBeGreaterThan(8.2);
    expect(mon.jobs.p50).toBeLessThan(11);
    for (const d of r.daily) {
      expect(d.jobs.p10).toBeLessThanOrEqual(d.jobs.p50);
      expect(d.jobs.p50).toBeLessThanOrEqual(d.jobs.p90);
    }
  });
  it('reports a backtest accuracy figure', () => {
    expect(r.accuracy.jobs_wape).not.toBeNull();
    expect(r.accuracy.jobs_wape!).toBeLessThan(0.5);
  });
  it('is balanced for a comfortably staffed business', () => {
    expect(r.recommendations.some((x) => x.kind === 'hire_technician')).toBe(false);
    expect(r.recommendations[0].kind === 'balanced' || r.recommendations[0].severity === 'info').toBe(true);
  });
});

describe('booked work is a floor', () => {
  it('never forecasts below what is already booked', () => {
    const booked = [{ d: addDays(TODAY, 2), jobs: 30 }];
    const r = analyzeStaffing(makeInput({ booked_ahead: booked }));
    const day = r.daily[2];
    expect(day.jobs.p10).toBeGreaterThanOrEqual(30);
    expect(day.deficit_jobs).toBeGreaterThan(0);
  });
});

describe('overload -> rebalance / overtime / hire', () => {
  it('recommends rebalancing and overtime for a short spike', () => {
    const booked = [{ d: addDays(TODAY, 1), jobs: 20 }];
    const r = analyzeStaffing(makeInput({ booked_ahead: booked }));
    const kinds = r.recommendations.map((x) => x.kind);
    expect(kinds).toContain('rebalance_schedule');
    expect(r.headline.next14_deficit_jobs).toBeGreaterThan(0);
  });
  it('recommends hiring when demand stays above the full threshold for weeks', () => {
    const r = analyzeStaffing(makeInput({ jobsPerDay: 11, tech: { headcount: 2, capacity_jobs_per_day: 12 } }));
    const hire = r.recommendations.find((x) => x.kind === 'hire_technician');
    expect(hire).toBeDefined();
    expect(hire!.quantity).toBeGreaterThanOrEqual(1);
    expect(hire!.est_cost_cents).not.toBeNull();
  });
  it('hides money figures when include_costs is false', () => {
    const r = analyzeStaffing(makeInput({ jobsPerDay: 11, include_costs: false }));
    for (const rec of r.recommendations) expect(rec.est_cost_cents).toBeNull();
  });
  it('recommends demand generation, not hiring, when capacity is idle', () => {
    const r = analyzeStaffing(makeInput({ jobsPerDay: 2 }));
    expect(r.recommendations.some((x) => x.kind === 'generate_demand')).toBe(true);
    expect(r.recommendations.some((x) => x.kind === 'hire_technician')).toBe(false);
  });
  it('flags missing technicians instead of dividing by zero', () => {
    const r = analyzeStaffing(makeInput({ tech: { headcount: 0, capacity_jobs_per_day: 0 } }));
    expect(r.recommendations.some((x) => x.kind === 'configure_technicians')).toBe(true);
    for (const d of r.daily) expect(d.utilization_pct).toBeNull();
  });
});

describe('CSR and AI coverage', () => {
  it('flags a CSR gap when human-requested calls outgrow coverage', () => {
    const r = analyzeStaffing(makeInput({ callsPerDay: 90, humanShare: 0.5, csr: { headcount: 1 } }));
    expect(r.headline.next7_csr_gap_hours).toBeGreaterThan(0);
    expect(r.recommendations.some((x) => x.kind === 'add_csr_coverage')).toBe(true);
  });
  it('has no gap when AI resolves nearly everything', () => {
    const r = analyzeStaffing(makeInput({ callsPerDay: 20, humanShare: 0.02 }));
    expect(r.headline.next7_csr_gap_hours).toBe(0);
    expect(r.recommendations.some((x) => x.kind === 'add_csr_coverage')).toBe(false);
  });
  it('asks to configure CSRs when people want a human and nobody is set up', () => {
    const r = analyzeStaffing(makeInput({ callsPerDay: 60, humanShare: 0.4, csr: { headcount: 0 } }));
    expect(r.recommendations.some((x) => x.kind === 'configure_csr')).toBe(true);
  });
});

describe('weather and regional signals', () => {
  /** 400 days of weather; jobs jump on hot days (anomaly > 0). */
  function weatherInput() {
    const weather: WeatherDay[] = [];
    const jobs: JobDayRow[] = [];
    const days = 400;
    for (let i = days; i >= -20; i--) {
      const d = addDays(TODAY, -i);
      const month = Number(d.slice(5, 7));
      const base = 55 + 25 * Math.sin(((month - 4) / 12) * 2 * Math.PI);
      const swing = noise(i * 3) * 14;
      weather.push({ d, mean_f: base + swing, precip_in: 0 });
      if (i >= 1) {
        const w = dow(d);
        const hot = Math.max(0, swing);
        const n = Math.max(0, JOB_BASE[w] * (6 + hot * 0.35) + noise(i) * 0.3);
        jobs.push({ d, jobs: Math.round(n), minutes: Math.round(n) * 90 });
      }
    }
    return { weather, jobs };
  }
  it('learns that hot spells drive demand and exposes the driver', () => {
    const { weather, jobs } = weatherInput();
    const r = analyzeStaffing(makeInput({ weather, jobs_daily: jobs }));
    expect(r.data_quality.weather).toBe('used');
    expect(r.drivers.weather).not.toBeNull();
    expect(r.drivers.weather!.hot_per_f_pct).toBeGreaterThan(1);
  });
  it('reports weather as unavailable (never fakes it) when none is supplied', () => {
    const r = analyzeStaffing(makeInput({ weather: null }));
    expect(r.data_quality.weather).toBe('unavailable');
    expect(r.drivers.weather).toBeNull();
  });
  it('nudges calls toward a surging region, bounded', () => {
    const base = analyzeStaffing(makeInput());
    const up = analyzeStaffing(makeInput({
      regional: { region_label: 'Austin', sample_size: 12, call_volume_change_pct: 80, emergency_rate_pct: 10 },
    }));
    expect(up.data_quality.regional).toBe('used');
    expect(up.drivers.regional!.applied_pct).toBeLessThanOrEqual(15);
    expect(up.daily[0].calls.p50).toBeGreaterThanOrEqual(base.daily[0].calls.p50);
  });
});
