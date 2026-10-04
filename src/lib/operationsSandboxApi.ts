/**
 * Operations Sandbox — data layer.
 *
 * Calibrates the digital twin from the account's real records and stores
 * saved scenario runs. Every read is "soft": a missing table or column
 * never breaks the page, the affected input simply falls back to a default
 * and is flagged as assumed.
 * Server counterpart: supabase/migrations/20270210000000_operations_sandbox.sql
 */

import { supabase } from '@/lib/supabase';
import {
  calibrateBaseline,
  clamp,
  defaultBaseline,
  SIM,
  type Assumptions,
  type Baseline,
  type BaselineKey,
  type LeverInstance,
  type MetricKey,
  type Provenance,
  type SimulationResult,
  type VerdictKey,
} from '@/lib/operationsSandbox';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;

/** A missing table / column must never break the page: return an empty list. */
async function soft<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await p;
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

interface JobRow {
  id: string;
  customer_name: string | null;
  scheduled_datetime: string | null;
  arrived_at?: string | null;
  completed_at?: string | null;
  assigned_technician_id: string | null;
  job_status: string | null;
  invoice_amount: number | string | null;
  created_at: string;
}

interface CallRow {
  status: string | null;
  call_datetime: string;
}

interface TeamRow {
  id: string;
  role: string | null;
  dispatch_enabled?: boolean | null;
  max_jobs_per_day?: number | null;
}

interface MembershipRow {
  started_at: string | null;
  cancelled_at: string | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

async function fetchJobs(sinceIso: string): Promise<JobRow[]> {
  const full = 'id, customer_name, scheduled_datetime, arrived_at, completed_at, assigned_technician_id, job_status, invoice_amount, created_at';
  const basic = 'id, customer_name, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, created_at';
  try {
    const r = await supabase.from('jobs').select(full).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(8000);
    if (!r.error) return (r.data ?? []) as JobRow[];
  } catch {
    /* timing columns not migrated yet: fall back to the basic columns */
  }
  return soft<JobRow>(supabase.from('jobs').select(basic).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(8000));
}

async function fetchTeam(): Promise<TeamRow[]> {
  try {
    const r = await supabase.from('team_members').select('id, role, dispatch_enabled, max_jobs_per_day');
    if (!r.error) return (r.data ?? []) as TeamRow[];
  } catch {
    /* dispatch columns not migrated yet */
  }
  return soft<TeamRow>(supabase.from('team_members').select('id, role'));
}

/** Builds the digital twin from real data. Always resolves; never throws. */
export async function gatherBaseline(now: number = Date.now()): Promise<Baseline> {
  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
  const since180 = new Date(now - 2 * WINDOW_DAYS * DAY_MS).toISOString();

  const [jobs, calls, team, outcomes, paid, memberships] = await Promise.all([
    fetchJobs(since180),
    soft<CallRow>(supabase.from('calls').select('status, call_datetime').gte('call_datetime', since).limit(10000)),
    fetchTeam(),
    soft<{ is_rework: boolean | null }>(supabase.from('job_outcomes').select('is_rework').gte('recorded_at', since).limit(5000)),
    soft<{ sent_at: string | null; paid_at: string | null }>(
      supabase.from('invoices').select('sent_at, paid_at').eq('status', 'paid').gte('paid_at', since180).limit(3000),
    ),
    soft<MembershipRow>(supabase.from('memberships').select('started_at, cancelled_at').limit(5000)),
  ]);

  const base = defaultBaseline();
  const prov: Record<BaselineKey, Provenance> = { ...base.provenance };
  const out: Baseline = { ...base, provenance: prov };

  // ---- jobs, ticket size, volume ----
  const sinceMs = now - WINDOW_DAYS * DAY_MS;
  const completed = jobs.filter((j) => {
    if (j.job_status !== 'completed') return false;
    const at = ms(j.completed_at) ?? ms(j.scheduled_datetime) ?? ms(j.created_at);
    return at !== null && at >= sinceMs && at <= now;
  });
  const earliest = jobs.reduce<number | null>((min, j) => {
    const t = ms(j.created_at);
    return t !== null && (min === null || t < min) ? t : min;
  }, null);
  const windowMonths = earliest === null ? 0 : clamp((now - earliest) / (30 * DAY_MS), 1, WINDOW_DAYS / 30);

  if (completed.length >= 10 && windowMonths > 0) {
    out.jobsPerMonth = completed.length / windowMonths;
    prov.jobsPerMonth = 'measured';
  }
  const tickets = completed.map((j) => num(j.invoice_amount)).filter((v): v is number => v !== null && v > 0);
  if (tickets.length >= 5) {
    out.avgTicket = tickets.reduce((s, v) => s + v, 0) / tickets.length;
    prov.avgTicket = 'measured';
  }

  // ---- technicians and capacity ----
  const techs = team.filter((m) => m.role === 'technician' && m.dispatch_enabled !== false);
  if (techs.length > 0) {
    out.technicians = techs.length;
    prov.technicians = 'measured';
  } else {
    const assigned = new Set(completed.map((j) => j.assigned_technician_id).filter((id): id is string => !!id));
    if (assigned.size > 0) {
      out.technicians = assigned.size;
      prov.technicians = 'measured';
    } else {
      out.technicians = Math.max(1, Math.ceil(out.jobsPerMonth / (SIM.defaultJobsPerDay * SIM.practicalUtilization * SIM.workdays * 0.7)));
    }
  }
  const caps = techs.map((m) => num(m.max_jobs_per_day)).filter((v): v is number => v !== null && v > 0);
  if (caps.length > 0) {
    out.jobsPerTechMonth = (caps.reduce((s, v) => s + v, 0) / caps.length) * SIM.practicalUtilization * SIM.workdays;
    prov.capacity = 'measured';
  }

  // ---- on-time rate ----
  let judged = 0;
  let onTime = 0;
  for (const j of completed) {
    const arrived = ms(j.arrived_at);
    const scheduled = ms(j.scheduled_datetime);
    if (arrived === null || scheduled === null) continue;
    judged++;
    if (arrived <= scheduled + SIM.slaGraceMinutes * 60_000) onTime++;
  }
  if (judged >= 10) {
    out.slaOnTimePct = (onTime / judged) * 100;
    prov.sla = 'measured';
  }

  // ---- calls ----
  const real = calls.filter((c) => c.status !== 'spam');
  if (real.length >= 20 && windowMonths > 0) {
    const missed = real.filter((c) => c.status === 'missed').length;
    const answered = real.length - missed;
    const booked = real.filter((c) => c.status === 'booked').length;
    out.callsPerMonth = real.length / windowMonths;
    out.missedCallRate = missed / real.length;
    if (answered >= 10) out.bookRate = booked / answered;
    prov.calls = 'measured';
    if (answered >= 10) prov.bookRate = 'measured';
  }

  // ---- rework ----
  if (outcomes.length >= 10) {
    out.reworkRate = outcomes.filter((o) => o.is_rework).length / outcomes.length;
    prov.rework = 'measured';
  }

  // ---- days to pay ----
  const gaps = paid
    .map((i) => {
      const s = ms(i.sent_at);
      const p = ms(i.paid_at);
      return s !== null && p !== null && p >= s ? (p - s) / DAY_MS : null;
    })
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (gaps.length >= 5) {
    out.daysToPay = gaps[Math.floor(gaps.length / 2)];
    prov.daysToPay = 'measured';
  }

  // ---- churn: membership cancellations over active members at window start ----
  const activeAtStart = memberships.filter((m) => {
    const st = ms(m.started_at);
    const ca = ms(m.cancelled_at);
    return st !== null && st <= sinceMs && (ca === null || ca > sinceMs);
  }).length;
  if (activeAtStart >= 20 && windowMonths > 0) {
    const cancelled = memberships.filter((m) => {
      const st = ms(m.started_at);
      const ca = ms(m.cancelled_at);
      return st !== null && st <= sinceMs && ca !== null && ca > sinceMs && ca <= now;
    }).length;
    out.churnMonthlyPct = (cancelled / activeAtStart / windowMonths) * 100;
    prov.churn = 'measured';
  }

  out.sample = {
    jobs: completed.length,
    calls: real.length,
    customers: new Set(completed.map((j) => (j.customer_name ?? '').trim().toLowerCase()).filter(Boolean)).size,
    windowMonths: Math.round(windowMonths * 10) / 10,
  };
  return calibrateBaseline(out);
}

// ============================================================
// SAVED RUNS
// ============================================================

export interface SavedRun {
  id: string;
  name: string;
  levers: LeverInstance[];
  assumptions: Assumptions;
  verdict: VerdictKey;
  summary: SavedSummary;
  created_at: string;
}

export interface SavedSummary {
  confidence: number;
  runRateUplift: number;
  paybackMonth: number | null;
  cashTrough: number;
  deltas: Partial<Record<MetricKey, number>>;
  projected: Partial<Record<MetricKey, number>>;
}

export function summarize(r: SimulationResult): SavedSummary {
  return {
    confidence: r.confidence.score,
    runRateUplift: r.probability.runRateUplift,
    paybackMonth: r.cash.paybackMonth,
    cashTrough: r.cash.trough,
    deltas: { revenue: r.deltas.revenue, grossProfit: r.deltas.grossProfit, marginPct: r.deltas.marginPct, slaPct: r.deltas.slaPct, churnPct: r.deltas.churnPct, cashFlow: r.deltas.cashFlow },
    projected: { revenue: r.projected.revenue, marginPct: r.projected.marginPct, utilizationPct: r.projected.utilizationPct, slaPct: r.projected.slaPct },
  };
}

export async function fetchSavedRuns(): Promise<SavedRun[]> {
  const rows = await soft<Record<string, unknown>>(
    supabase
      .from('operations_sandbox_runs')
      .select('id, name, levers, assumptions, verdict, summary, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
  );
  return rows as unknown as SavedRun[];
}

export async function saveRun(name: string, levers: LeverInstance[], assumptions: Assumptions, result: SimulationResult): Promise<void> {
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new Error('Give the scenario a name.');
  const { error } = await supabase.from('operations_sandbox_runs').insert({
    name: clean,
    levers,
    assumptions,
    verdict: result.verdict.key,
    summary: summarize(result),
  });
  if (error) throw error;
}

export async function deleteRun(id: string): Promise<void> {
  const { error } = await supabase.from('operations_sandbox_runs').delete().eq('id', id);
  if (error) throw error;
}
