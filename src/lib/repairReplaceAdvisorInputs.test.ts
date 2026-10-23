import { describe, it, expect } from 'vitest';
import type { PassportEvent } from '@/lib/equipmentPassport';
import type { OptionResult } from '@/lib/rebateIntelligence';
import { buildRepairHistory, parseUsAddress, suggestMeasure, toForecastSignal, toRebateSummary, type ForecastRow, type JobEquipmentRow } from './repairReplaceAdvisorInputs';

const job = (date: string, status: string, st: string | null, amount: number | null, jst: string | null = null): JobEquipmentRow => ({
  service_type: st,
  jobs: { service_type: jst, scheduled_datetime: date, job_status: status, invoice_amount: amount },
});
const ev = (type: PassportEvent['event_type'], at: string, title = 'x', service_type?: string): PassportEvent =>
  ({ id: at + type, seq: 1, event_type: type, title, detail: null, occurred_at: at, recorded_at: at, contributor_name: null, is_mine: false, visibility: 'network', summary: service_type ? { service_type } : {}, entry_hash: 'h' }) as PassportEvent;

describe('buildRepairHistory', () => {
  it('keeps completed repair jobs with their cost and drops everything else', () => {
    const h = buildRepairHistory(
      [job('2026-01-10T10:00:00Z', 'completed', 'repair', 640.5), job('2026-02-01T10:00:00Z', 'completed', 'maintenance', 150), job('2026-03-01T10:00:00Z', 'scheduled', 'repair', 400), job('2026-04-01T10:00:00Z', 'completed', 'repair', 0)],
      [],
    );
    expect(h).toHaveLength(2);
    expect(h[1]).toEqual({ date: '2026-01-10T10:00:00Z', costCents: 64050, source: 'job' });
    expect(h[0].costCents).toBeNull();
  });
  it('adds other contractors\u2019 passport repairs with unknown cost', () => {
    const h = buildRepairHistory([], [ev('repair', '2025-06-01T00:00:00Z'), ev('note', '2025-07-01T00:00:00Z'), ev('inspection', '2025-08-01T00:00:00Z')]);
    expect(h).toEqual([{ date: '2025-06-01T00:00:00Z', costCents: null, source: 'passport' }]);
  });
  it('does not count the same visit twice (job + its passport event, repair + part replaced)', () => {
    const h = buildRepairHistory(
      [job('2026-01-10T10:00:00Z', 'completed', 'repair', 500)],
      [ev('service_visit', '2026-01-10T12:00:00Z', 'Repair visit', 'repair'), ev('repair', '2025-05-01T09:00:00Z'), ev('part_replaced', '2025-05-01T11:00:00Z')],
    );
    expect(h.map((x) => x.source)).toEqual(['job', 'passport']);
  });
  it('ignores events with invalid dates and sorts newest first', () => {
    const h = buildRepairHistory([job('2024-01-01T00:00:00Z', 'completed', 'repair', 100), job('2026-01-01T00:00:00Z', 'completed', 'repair', 100)], [ev('repair', 'garbage')]);
    expect(h.map((x) => x.date)).toEqual(['2026-01-01T00:00:00Z', '2024-01-01T00:00:00Z']);
  });
});

describe('toForecastSignal', () => {
  const row: ForecastRow = { probability: '0.4200', horizon_days: 90, band: 'high', confidence: 'moderate', calibrated: true, top_mode_label: 'Compressor', modes: [{ label: 'Cracked heat exchanger', probability: 0.2, safetyCritical: true }, { label: 'Minor gas leak', probability: 0.05, safetyCritical: true }, { label: 'Capacitor', probability: 0.6, safetyCritical: false }], issued_at: '2026-10-01T00:00:00Z' };
  it('converts numeric strings and keeps only material safety modes', () => {
    const f = toForecastSignal(row);
    expect(f?.probability).toBe(0.42);
    expect(f?.safetyCriticalModes).toEqual(['Cracked heat exchanger']);
    expect(f?.calibrated).toBe(true);
  });
  it('rejects unusable rows', () => {
    expect(toForecastSignal(null)).toBeNull();
    expect(toForecastSignal({ ...row, probability: 1.5 })).toBeNull();
    expect(toForecastSignal({ ...row, probability: 'x' })).toBeNull();
    expect(toForecastSignal({ ...row, horizon_days: 0 })).toBeNull();
    expect(toForecastSignal({ ...row, modes: null })?.safetyCriticalModes).toEqual([]);
  });
});

describe('toRebateSummary', () => {
  const option = {
    gross_cost_cents: 800000, point_of_sale_cents: 50000, post_install_cents: 100000, tax_filing_cents: 60000, total_expected_cents: 210000, total_potential_cents: 300000, net_cost_conservative_cents: 700000,
    incentives: [
      { name: 'Utility rebate', amount_cents: 100000, expected_cents: 90000, status: 'eligible', payout_timing: 'post_install', end_date: '2026-12-31', requires_pre_approval: true },
      { name: 'Income tier', amount_cents: 80000, expected_cents: 0, status: 'needs_info', payout_timing: 'point_of_sale', end_date: null, requires_pre_approval: false },
    ],
  } as unknown as OptionResult;
  const report = { deadline_alerts: [{ program: 'Utility rebate', end_date: '2026-12-31', days_left: 69 }], actions: ['Get pre-approval'], data_quality: { warnings: ['w'] } } as never;
  it('maps timing, confidence-weighted totals and the conservative figure', () => {
    const s = toRebateSummary(option, report, 20000);
    expect([s.atInstallCents, s.afterInstallCents, s.taxFilingCents, s.expectedCents]).toEqual([50000, 100000, 60000, 210000]);
    expect(s.conservativeCents).toBe(100000);
    expect(s.bestCaseCents).toBe(300000);
    expect(s.deadlines).toEqual([{ program: 'Utility rebate', daysLeft: 69, endDate: '2026-12-31' }]);
    expect(s.programs.find((p) => p.name === 'Manufacturer rebate')?.amountCents).toBe(20000);
    expect(s.programs.find((p) => p.name === 'Income tier')?.expectedCents).toBe(0);
  });
});

describe('form helpers', () => {
  it('suggests a rebate measure from the equipment description', () => {
    expect(suggestMeasure('Central air conditioner')).toBe('central_ac');
    expect(suggestMeasure('Heat pump')).toBe('heat_pump_hvac');
    expect(suggestMeasure('Gas furnace')).toBe('furnace');
    expect(suggestMeasure('Water heater', 'Rheem', 'Hybrid')).toBe('heat_pump_water_heater');
    expect(suggestMeasure('Tankless water heater')).toBe('water_heater');
    expect(suggestMeasure('Boiler')).toBe('boiler');
  });
  it('parses state and ZIP from an address', () => {
    expect(parseUsAddress('12 Main St, Austin, TX 78701')).toEqual({ state: 'TX', zip: '78701' });
    expect(parseUsAddress('12 Main St, Austin, tx 78701-1234')).toEqual({ state: 'TX', zip: '78701' });
    expect(parseUsAddress('Austin, TX')).toEqual({ state: 'TX', zip: '' });
    expect(parseUsAddress(null)).toEqual({ state: '', zip: '' });
  });
});
