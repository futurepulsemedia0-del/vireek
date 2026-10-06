import { supabase } from '@/lib/supabase';

export type ReceivablesConfidence = 'low' | 'medium' | 'high';

export interface ReceivablesSummary {
  billed_cents: number;
  collected_cents: number;
  open_cents: number;
  overdue_cents: number;
  disputed_open_cents: number;
  expected_collectable_cents: number;
  at_risk_cents: number;
  median_days_to_cash: number | null;
  p90_days_to_cash: number | null;
  dso_days: number | null;
}

export interface AgingBucket {
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  count: number;
  cents: number;
}

export type GraphNodeKey = 'job' | 'quote' | 'approval' | 'contract' | 'invoice' | 'payment' | 'dispute' | 'collection';

export interface GraphNode {
  key: GraphNodeKey;
  count: number;
}

export interface GraphTransitions {
  quote_to_approval_days: number | null;
  approval_to_invoice_days: number | null;
  job_to_invoice_days: number | null;
  invoice_to_payment_days: number | null;
}

export interface ReceivablesSegment {
  service_type: string;
  approval_gated: boolean;
  has_contract: boolean;
  invoices: number;
  paid: number;
  billed_cents: number;
  open_cents: number;
  avg_ticket_cents: number;
  median_days_to_cash: number | null;
  median_approval_days: number | null;
  median_approval_to_invoice_days: number | null;
  median_job_to_invoice_days: number | null;
  dispute_rate: number;
  overdue_rate: number;
}

export interface AtRiskInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string;
  service_type: string;
  total_cents: number;
  days_past_due: number;
  collect_prob: number;
  disputed: boolean;
  reminders: number;
  approval_gated: boolean;
  has_contract: boolean;
  at_risk_cents: number;
}

export interface ReceivablesWeek {
  week_start: string;
  billed_cents: number;
  collected_cents: number;
}

export interface ReceivablesResult {
  window_days: number;
  invoices_analyzed: number;
  paid_invoices: number;
  confidence: ReceivablesConfidence;
  method: 'aging_prior_adjusted';
  summary: ReceivablesSummary;
  aging: AgingBucket[];
  graph: { nodes: GraphNode[]; transitions: GraphTransitions };
  segments: ReceivablesSegment[];
  at_risk_invoices: AtRiskInvoice[];
  weekly: ReceivablesWeek[];
}

export interface ReceivablesAnalysisRow {
  result: ReceivablesResult | null;
  computed_at: string | null;
}

export async function fetchReceivablesAnalysis(): Promise<ReceivablesAnalysisRow | null> {
  const { data, error } = await supabase
    .from('receivables_intelligence_analyses')
    .select('result, computed_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { result: (data.result as ReceivablesResult | null) ?? null, computed_at: (data.computed_at as string | null) ?? null };
}

export async function computeReceivablesAnalysis(days = 365): Promise<ReceivablesResult> {
  const { data, error } = await supabase.rpc('compute_receivables_intelligence', { p_days: days });
  if (error) throw error;
  return data as ReceivablesResult;
}

// ---------------------------------------------------------------
// Pure derivations (no network) — kept here so they are unit-testable.
// ---------------------------------------------------------------

export type DelayStage = 'approval' | 'handoff' | 'invoicing' | 'collection';

export const DELAY_STAGE_LABELS: Record<DelayStage, string> = {
  approval: 'quote approval',
  handoff: 'approval-to-invoice handoff',
  invoicing: 'job-to-invoice lag',
  collection: 'customer payment',
};

export interface CashDragInsight {
  service_type: string;
  approval_gated: boolean;
  has_contract: boolean;
  days_to_cash: number;
  baseline_days: number;
  delay_days: number;
  multiple: number;
  bottleneck: DelayStage;
  bottleneck_days: number;
  trapped_cents: number;
  dispute_rate: number;
  avg_ticket_cents: number;
}

/** Which stage of this segment's chain consumes the most time. */
export function dominantDelayStage(s: ReceivablesSegment): { stage: DelayStage; days: number } {
  const candidates: Array<{ stage: DelayStage; days: number }> = [
    { stage: 'approval', days: s.median_approval_days ?? 0 },
    { stage: 'handoff', days: s.median_approval_to_invoice_days ?? 0 },
    { stage: 'invoicing', days: s.median_job_to_invoice_days ?? 0 },
    { stage: 'collection', days: s.median_days_to_cash ?? 0 },
  ];
  return candidates.reduce((best, c) => (c.days > best.days ? c : best), candidates[0]);
}

/**
 * Segments whose cash realization is materially slower than the account's own
 * median. Needs enough settled invoices per segment to avoid noise.
 */
export function buildCashDragInsights(result: ReceivablesResult, limit = 4): CashDragInsight[] {
  const baseline = result.summary.median_days_to_cash;
  if (baseline === null || baseline <= 0) return [];
  const out: CashDragInsight[] = [];
  for (const s of result.segments) {
    if (s.paid < 3 || s.median_days_to_cash === null) continue;
    const delay = s.median_days_to_cash - baseline;
    const multiple = s.median_days_to_cash / baseline;
    if (multiple < 1.25 || delay < 5) continue;
    const { stage, days } = dominantDelayStage(s);
    out.push({
      service_type: s.service_type,
      approval_gated: s.approval_gated,
      has_contract: s.has_contract,
      days_to_cash: s.median_days_to_cash,
      baseline_days: baseline,
      delay_days: delay,
      multiple,
      bottleneck: stage,
      bottleneck_days: days,
      trapped_cents: s.open_cents,
      dispute_rate: s.dispute_rate,
      avg_ticket_cents: s.avg_ticket_cents,
    });
  }
  return out.sort((a, b) => b.trapped_cents - a.trapped_cents).slice(0, limit);
}

export interface WorkflowComparison {
  gated_days: number;
  direct_days: number;
  gated_paid: number;
  direct_paid: number;
}

/** Paid-invoice-weighted average of segment medians: approval-gated vs direct billing. */
export function compareWorkflows(segments: ReceivablesSegment[]): WorkflowComparison | null {
  const acc = { gated: { w: 0, d: 0 }, direct: { w: 0, d: 0 } };
  for (const s of segments) {
    if (s.median_days_to_cash === null || s.paid <= 0) continue;
    const bucket = s.approval_gated ? acc.gated : acc.direct;
    bucket.w += s.paid;
    bucket.d += s.paid * s.median_days_to_cash;
  }
  if (acc.gated.w === 0 || acc.direct.w === 0) return null;
  return {
    gated_days: acc.gated.d / acc.gated.w,
    direct_days: acc.direct.d / acc.direct.w,
    gated_paid: acc.gated.w,
    direct_paid: acc.direct.w,
  };
}

export function collectabilityPct(result: ReceivablesResult): number | null {
  const open = result.summary.open_cents;
  if (open <= 0) return null;
  return (result.summary.expected_collectable_cents / open) * 100;
}
