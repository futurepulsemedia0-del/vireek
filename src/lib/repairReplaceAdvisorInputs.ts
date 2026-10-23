import type { PassportEvent } from '@/lib/equipmentPassport';
import type { MeasureType, OptionResult, RebateReport } from '@/lib/rebateIntelligence';
import { isRepairVisit, type ForecastSignal, type RebateSummary, type RepairEvent } from '@/lib/repairReplaceAdvisor';

/**
 * Pure adapters between Vireek's stored data (jobs, passport events, predictive-failure forecasts,
 * rebate reports) and the advisor engine. No I/O here, so every mapping is unit tested.
 * The I/O lives in repairReplaceAdvisorApi.ts.
 */

const DAY_MS = 86_400_000;
/** A passport event within this window of a job is the same visit seen twice. */
const SAME_VISIT_MS = 1.5 * DAY_MS;
/** A failure mode below this probability is not worth calling out as a safety risk. */
export const SAFETY_MODE_MIN_PROBABILITY = 0.15;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// ----------------------------------------------------------------------- repair history

export interface JobEquipmentRow {
  service_type: string | null;
  jobs: {
    service_type: string | null;
    scheduled_datetime: string | null;
    job_status: string;
    invoice_amount: number | null;
  } | null;
}

/**
 * Completed repair visits on this machine from our own jobs (with what the customer paid), merged with
 * repair events other contractors recorded on its passport (cost unknown). A passport event that matches
 * one of our jobs is the same visit and is dropped, so nothing is counted twice.
 * Maintenance, inspection and install visits never count as repairs.
 */
export function buildRepairHistory(jobRows: JobEquipmentRow[], passportEvents: PassportEvent[]): RepairEvent[] {
  const fromJobs: RepairEvent[] = [];
  for (const row of jobRows) {
    const job = row.jobs;
    if (!job || job.job_status !== 'completed' || !job.scheduled_datetime) continue;
    if (!isRepairVisit(row.service_type, job.service_type)) continue;
    const amount = num(job.invoice_amount);
    fromJobs.push({ date: job.scheduled_datetime, costCents: amount !== null && amount > 0 ? Math.round(amount * 100) : null, source: 'job' });
  }
  const jobTimes = fromJobs.map((j) => Date.parse(j.date as string));

  const fromPassport: RepairEvent[] = [];
  for (const e of passportEvents) {
    const isRepair = e.event_type === 'repair' || e.event_type === 'part_replaced' || (e.event_type === 'service_visit' && isRepairVisit(e.summary?.service_type, e.title));
    if (!isRepair) continue;
    const t = Date.parse(e.occurred_at);
    if (!Number.isFinite(t)) continue;
    if (jobTimes.some((jt) => Math.abs(jt - t) <= SAME_VISIT_MS)) continue;
    // A repair and the part replaced during it are one event.
    if (fromPassport.some((p) => Math.abs(Date.parse(p.date as string) - t) <= SAME_VISIT_MS)) continue;
    fromPassport.push({ date: e.occurred_at, costCents: null, source: 'passport' });
  }
  return [...fromJobs, ...fromPassport].sort((a, b) => Date.parse(b.date as string) - Date.parse(a.date as string));
}

// ----------------------------------------------------------------------- predictive failure

export interface ForecastRow {
  probability: number | string;
  horizon_days: number;
  band: ForecastSignal['band'];
  confidence: ForecastSignal['confidence'];
  calibrated: boolean;
  top_mode_label: string | null;
  modes: { label?: string; probability?: number; safetyCritical?: boolean }[] | null;
  issued_at: string | null;
}

export function toForecastSignal(row: ForecastRow | null | undefined): ForecastSignal | null {
  if (!row) return null;
  const probability = num(row.probability);
  if (probability === null || probability < 0 || probability > 1 || !(row.horizon_days > 0)) return null;
  const safety = (Array.isArray(row.modes) ? row.modes : [])
    .filter((m) => m?.safetyCritical && (num(m.probability) ?? 0) >= SAFETY_MODE_MIN_PROBABILITY && m.label)
    .map((m) => String(m.label));
  return {
    probability,
    horizonDays: row.horizon_days,
    confidence: row.confidence,
    calibrated: !!row.calibrated,
    band: row.band,
    topModeLabel: row.top_mode_label ?? null,
    safetyCriticalModes: [...new Set(safety)],
    issuedAt: row.issued_at ?? null,
  };
}

// ----------------------------------------------------------------------- rebates

/** Reduces one Rebate Intelligence option (and its report) to the figures the advisor needs. */
export function toRebateSummary(option: OptionResult, report: Pick<RebateReport, 'deadline_alerts' | 'actions' | 'data_quality'>, manufacturerRebateCents = 0): RebateSummary {
  const mfr = Math.max(0, Math.round(manufacturerRebateCents));
  const programs: RebateSummary['programs'] = option.incentives.map((ev) => ({
    name: ev.name,
    amountCents: ev.amount_cents,
    expectedCents: ev.status === 'needs_info' ? 0 : ev.expected_cents,
    status: ev.status === 'eligible' || ev.status === 'likely' ? ev.status : 'needs_info',
    timing: ev.payout_timing,
    endDate: ev.end_date,
    requiresPreApproval: ev.requires_pre_approval,
  }));
  if (mfr > 0) {
    programs.push({ name: 'Manufacturer rebate', amountCents: mfr, expectedCents: mfr, status: 'eligible', timing: 'post_install', endDate: null, requiresPreApproval: false });
  }
  return {
    atInstallCents: option.point_of_sale_cents,
    afterInstallCents: option.post_install_cents,
    taxFilingCents: option.tax_filing_cents,
    expectedCents: option.total_expected_cents,
    conservativeCents: Math.max(0, option.gross_cost_cents - option.net_cost_conservative_cents),
    bestCaseCents: option.total_potential_cents,
    programs,
    deadlines: report.deadline_alerts.map((d) => ({ program: d.program, daysLeft: d.days_left, endDate: d.end_date })),
    warnings: report.data_quality.warnings,
    actions: report.actions,
  };
}

// ----------------------------------------------------------------------- form helpers

/** Best guess at the rebate measure for a piece of equipment. The user can always change it. */
export function suggestMeasure(equipmentType: string, make?: string | null, model?: string | null): MeasureType {
  const t = `${equipmentType} ${make ?? ''} ${model ?? ''}`.toLowerCase();
  if (/water\s*heater|hot\s*water|tankless/.test(t)) return /heat\s*pump|hybrid/.test(t) ? 'heat_pump_water_heater' : 'water_heater';
  if (/heat\s*pump|mini.?split|ductless/.test(t)) return 'heat_pump_hvac';
  if (/furnace/.test(t)) return 'furnace';
  if (/boiler/.test(t)) return 'boiler';
  if (/air\s*condition|\bac\b|a\/c|condens|cooling/.test(t)) return 'central_ac';
  return 'heat_pump_hvac';
}

/** Pulls "TX" and "78701" out of a US-style address string. Returns empty strings when it cannot. */
export function parseUsAddress(address: string | null | undefined): { state: string; zip: string } {
  const a = (address ?? '').trim();
  const withZip = a.match(/\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  if (withZip) return { state: withZip[1].toUpperCase(), zip: withZip[2] };
  const stateOnly = a.match(/,\s*([A-Za-z]{2})\s*$/);
  return { state: stateOnly ? stateOnly[1].toUpperCase() : '', zip: '' };
}
