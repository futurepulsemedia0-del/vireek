import { supabase } from '@/lib/supabase';
import {
  DETECTORS, DETECTOR_WIRED, FORMULA, HIGH_CONFIDENCE, breakdown, buildDigest, computeRealization, splitEstimatedRealized, toCsv, weighted,
  type DetectorId, type Digest, type Evidence, type FixKind, type LeakStatus, type Realization, type ReportLeak,
} from '../../supabase/functions/_shared/revenue-realization/engine';

export { DETECTORS, DETECTOR_WIRED, FORMULA, HIGH_CONFIDENCE, breakdown, buildDigest, computeRealization, splitEstimatedRealized, toCsv, weighted };
export type { DetectorId, Digest, Evidence, FixKind, LeakStatus, Realization, ReportLeak };

export interface LeakRow extends ReportLeak {
  evidence: Evidence[];
  whyKey: string;
  whyParams: Record<string, string | number>;
  fix: FixKind | null;
  lowSample: boolean;
  poolKey: string;
  realizedAmountCents: number | null;
}
export interface ActionRow { id: string; leak_id: string; kind: FixKind; status: 'proposed' | 'approved' | 'executed' | 'undone' | 'rejected' | 'failed'; payload: { draft?: { key: string; params: { name: string } } }; result: Record<string, string | boolean> | null }
export interface SnapshotRow { period_month: string; captured_cents: number; leaked_weighted_cents: number; leaked_full_cents: number; realization_pct: number | null; realization_pct_low: number | null; realization_pct_high: number | null; realized_cents: number; formula_version: string }
export interface RadarData { leaks: LeakRow[]; actions: Record<string, ActionRow>; snapshots: SnapshotRow[]; members: Record<string, string> }

export type Band = 'high' | 'medium' | 'low';
export const confidenceBand = (c: number): Band => (c >= HIGH_CONFIDENCE ? 'high' : c >= 0.4 ? 'medium' : 'low');

/** Route for an evidence record; null when the app has no detail screen for that table. */
export function evidenceHref(e: Evidence): string | null {
  const id = encodeURIComponent(e.id);
  switch (e.table) {
    case 'jobs': return `/dashboard/jobs/${id}`;
    case 'quotes': return `/dashboard/quotes/${id}`;
    case 'calls': return `/dashboard/calls/${id}`;
    case 'invoices': return `/dashboard/invoicing/${id}`;
    case 'payment_requests': return '/dashboard/invoicing';
    case 'warranty_claims': return '/dashboard/warranty-claims';
    case 'recurring_agreements': return '/dashboard/recurring-jobs';
    case 'margin_guardrail_checks': return '/dashboard/margin-guardrails';
    case 'findings_package_items': return '/dashboard/findings';
    case 'revenue_recovery_events': return '/dashboard/recovery';
    default: return null;
  }
}

interface DbLeak {
  id: string; detector: DetectorId; amount_cents: number; confidence: number; status: LeakStatus; owner_member_id: string | null;
  technician_id: string | null; source_label: string | null; customer_name: string | null; occurred_at: string; evidence: Evidence[];
  why_key: string; why_params: Record<string, string | number>; fix_kind: FixKind | null; low_sample: boolean; pool_key: string; realized_amount_cents: number | null;
}

export function mapLeak(r: DbLeak): LeakRow {
  return {
    id: r.id, detector: r.detector, amountCents: Number(r.amount_cents), confidence: Number(r.confidence), status: r.status,
    ownerId: r.owner_member_id, technicianId: r.technician_id, source: r.source_label, occurredAt: r.occurred_at, customerName: r.customer_name,
    evidence: Array.isArray(r.evidence) ? r.evidence : [], whyKey: r.why_key, whyParams: r.why_params ?? {}, fix: r.fix_kind, lowSample: r.low_sample,
    poolKey: r.pool_key, realizedAmountCents: r.realized_amount_cents === null ? null : Number(r.realized_amount_cents),
  };
}

/** Ranked by confidence-weighted dollars, ties by id (stable). */
export const rankLeaks = (xs: LeakRow[]) => [...xs].sort((a, b) => weighted(b) - weighted(a) || a.id.localeCompare(b.id));

const LEAK_COLS = 'id,detector,amount_cents,confidence,status,owner_member_id,technician_id,source_label,customer_name,occurred_at,evidence,why_key,why_params,fix_kind,low_sample,pool_key,realized_amount_cents';

export async function fetchRadar(): Promise<RadarData> {
  // RLS scopes every table to the caller's account. Top 500 by raw amount keeps the payload bounded.
  const [l, a, s, m] = await Promise.all([
    supabase.from('revenue_leaks').select(LEAK_COLS).order('amount_cents', { ascending: false }).limit(500),
    supabase.from('revenue_leak_actions').select('id,leak_id,kind,status,payload,result').in('status', ['proposed', 'approved', 'executed']).limit(500),
    supabase.from('revenue_realization_snapshots').select('period_month,captured_cents,leaked_weighted_cents,leaked_full_cents,realization_pct,realization_pct_low,realization_pct_high,realized_cents,formula_version').order('period_month', { ascending: false }).limit(12),
    supabase.from('team_members').select('id,member_email').limit(200),
  ]);
  for (const r of [l, a, s]) if (r.error) throw new Error(r.error.message);
  const actions: Record<string, ActionRow> = {};
  for (const x of (a.data ?? []) as unknown as ActionRow[]) actions[x.leak_id] = x;
  const members: Record<string, string> = {};
  for (const x of (m.data ?? []) as { id: string; member_email: string | null }[]) if (x.member_email) members[x.id] = x.member_email;
  return { leaks: ((l.data ?? []) as unknown as DbLeak[]).map(mapLeak), actions, snapshots: ((s.data ?? []) as unknown as SnapshotRow[]).map((x) => ({ ...x, captured_cents: Number(x.captured_cents), leaked_weighted_cents: Number(x.leaked_weighted_cents), leaked_full_cents: Number(x.leaked_full_cents), realized_cents: Number(x.realized_cents) })), members };
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let code = 'failed';
    try { code = ((await (error as { context?: Response }).context?.json()) as { error?: string })?.error ?? code; } catch { /* keep default */ }
    throw new Error(code);
  }
  return data as T;
}

export const refreshRadar = () => invoke<{ ok: boolean }>('revenue-realization-run', {});
export type LeakOp = 'propose' | 'approve' | 'reject' | 'execute' | 'undo' | 'feedback' | 'dismiss';
export const leakAction = (op: LeakOp, leakId: string, extra: { verdict?: 'true_positive' | 'false_positive'; reason?: string } = {}) =>
  invoke<{ ok: boolean; data: ActionRow | { ok: true } }>('revenue-realization-action', { op, leakId, ...extra });

/** Headline numbers for the current month (from the stored snapshot) plus the live estimated/realized split. */
export function liveRealization(leaks: LeakRow[], capturedCents: number): Realization {
  return computeRealization(capturedCents, leaks.map((l) => ({ poolKey: l.poolKey, detector: l.detector, amountCents: l.amountCents, confidence: l.confidence, status: l.status })));
}

export function downloadCsv(leaks: ReportLeak[], filename: string): void {
  const url = URL.createObjectURL(new Blob([toCsv(leaks)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
