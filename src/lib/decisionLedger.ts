/**
 * Decision Ledger — client library.
 *
 * Full audit trail of a decision's life cycle: Recommendation + Evidence
 * -> Approval -> Action -> real measured Outcome. Every stage transition
 * is appended to an immutable `timeline` server-side (see the SECURITY
 * DEFINER functions below) so the history can never be edited, only
 * extended.
 *
 * Server counterpart: supabase/migrations/20261206000000_decision_ledger.sql
 */

import { supabase } from '@/lib/supabase';
import { formatDollars } from '@/lib/decisionDebt';

export type LedgerCategory = 'pricing' | 'dispatch' | 'staffing' | 'marketing' | 'collections' | 'retention' | 'operations' | 'custom';
export type LedgerSource = 'ai_recommendation' | 'agent' | 'manual';
export type LedgerStatus = 'recommended' | 'approved' | 'rejected' | 'action_taken' | 'outcome_recorded' | 'expired';

export interface LedgerEvidenceItem {
  label: string;
  value: string;
  source?: string;
}

export interface LedgerTimelineEvent {
  at: string;
  stage: LedgerStatus;
  note: string | null;
}

export interface DecisionLedgerEntry {
  id: string;
  linked_decision_id: string | null;
  title: string;
  category: LedgerCategory;
  source: LedgerSource;
  recommendation: string;
  evidence: LedgerEvidenceItem[];
  confidence_score: number | null;
  expected_impact: number | null;
  status: LedgerStatus;
  approved_by: string | null;
  approved_at: string | null;
  approval_notes: string | null;
  action_taken: string | null;
  action_taken_at: string | null;
  action_taken_by: string | null;
  actual_outcome_value: number | null;
  outcome_recorded_at: string | null;
  outcome_notes: string | null;
  timeline: LedgerTimelineEvent[];
  created_at: string;
  updated_at: string;
}

// ============================================================
// LABELS
// ============================================================

export const CATEGORY_LABELS: Record<LedgerCategory, string> = {
  pricing: 'Pricing',
  dispatch: 'Dispatch',
  staffing: 'Staffing',
  marketing: 'Marketing',
  collections: 'Collections',
  retention: 'Retention',
  operations: 'Operations',
  custom: 'Other',
};

export const SOURCE_LABELS: Record<LedgerSource, string> = {
  ai_recommendation: 'AI Decision Engine',
  agent: 'Autonomous Agent',
  manual: 'Manual Entry',
};

export const STATUS_LABELS: Record<LedgerStatus, string> = {
  recommended: 'Awaiting Approval',
  approved: 'Approved — Awaiting Action',
  rejected: 'Rejected',
  action_taken: 'Action Taken — Awaiting Outcome',
  outcome_recorded: 'Outcome Recorded',
  expired: 'Expired',
};

export const STATUS_COLORS: Record<LedgerStatus, string> = {
  recommended: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-accent/10 text-accent',
  rejected: 'bg-danger/10 text-danger',
  action_taken: 'bg-accent/10 text-accent',
  outcome_recorded: 'bg-success-500/10 text-success-500',
  expired: 'bg-bg-tertiary text-text-secondary',
};

// ============================================================
// OUTCOME MATH
// ============================================================

export interface OutcomeAccuracy {
  hasOutcome: boolean;
  variance: number | null;
  variancePct: number | null;
  wasAccurate: boolean | null;
}

/** How far the real measured outcome landed from what was expected at recommendation time. */
export function computeOutcomeAccuracy(entry: DecisionLedgerEntry): OutcomeAccuracy {
  if (entry.actual_outcome_value === null || entry.expected_impact === null) {
    return { hasOutcome: entry.actual_outcome_value !== null, variance: null, variancePct: null, wasAccurate: null };
  }
  const variance = entry.actual_outcome_value - entry.expected_impact;
  const variancePct = entry.expected_impact !== 0 ? (variance / Math.abs(entry.expected_impact)) * 100 : null;
  return { hasOutcome: true, variance, variancePct, wasAccurate: Math.abs(variancePct ?? 0) <= 20 };
}

export interface LedgerSummary {
  total: number;
  awaitingApproval: number;
  awaitingAction: number;
  awaitingOutcome: number;
  outcomeRecorded: number;
  totalExpectedImpact: number;
  totalActualOutcome: number;
  avgAccuracyPct: number | null;
}

export function summarizeLedger(entries: DecisionLedgerEntry[]): LedgerSummary {
  let totalExpectedImpact = 0;
  let totalActualOutcome = 0;
  const accuracies: number[] = [];

  for (const e of entries) {
    if (e.expected_impact !== null) totalExpectedImpact += e.expected_impact;
    if (e.actual_outcome_value !== null) totalActualOutcome += e.actual_outcome_value;
    const acc = computeOutcomeAccuracy(e);
    if (acc.variancePct !== null) accuracies.push(100 - Math.min(100, Math.abs(acc.variancePct)));
  }

  return {
    total: entries.length,
    awaitingApproval: entries.filter((e) => e.status === 'recommended').length,
    awaitingAction: entries.filter((e) => e.status === 'approved').length,
    awaitingOutcome: entries.filter((e) => e.status === 'action_taken').length,
    outcomeRecorded: entries.filter((e) => e.status === 'outcome_recorded').length,
    totalExpectedImpact,
    totalActualOutcome,
    avgAccuracyPct: accuracies.length ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null,
  };
}

export { formatDollars };

// ============================================================
// CRUD + STAGE TRANSITIONS
// ============================================================

export async function fetchLedgerEntries(filters?: { status?: LedgerStatus; category?: LedgerCategory }): Promise<DecisionLedgerEntry[]> {
  let query = supabase.from('decision_ledger_entries').select('*').order('created_at', { ascending: false }).limit(300);
  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.category) query = query.eq('category', filters.category);
  const { data, error } = await query;
  if (error) throw error;
  return (data as DecisionLedgerEntry[]) ?? [];
}

export async function fetchLedgerEntry(id: string): Promise<DecisionLedgerEntry | null> {
  const { data, error } = await supabase.from('decision_ledger_entries').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as DecisionLedgerEntry) ?? null;
}

export interface CreateLedgerEntryInput {
  title: string;
  category: LedgerCategory;
  source: LedgerSource;
  recommendation: string;
  evidence: LedgerEvidenceItem[];
  confidence_score: number | null;
  expected_impact: number | null;
  linked_decision_id: string | null;
}

export async function createLedgerEntry(input: CreateLedgerEntryInput, userId: string): Promise<DecisionLedgerEntry> {
  const { data, error } = await supabase
    .from('decision_ledger_entries')
    .insert({
      user_id: userId,
      linked_decision_id: input.linked_decision_id,
      title: input.title.trim(),
      category: input.category,
      source: input.source,
      recommendation: input.recommendation.trim(),
      evidence: input.evidence,
      confidence_score: input.confidence_score,
      expected_impact: input.expected_impact,
      timeline: [{ at: new Date().toISOString(), stage: 'recommended', note: null }],
    })
    .select()
    .single();
  if (error) throw error;
  return data as DecisionLedgerEntry;
}

export async function approveLedgerEntry(id: string, approvedBy: string | null, notes: string): Promise<DecisionLedgerEntry> {
  const { data, error } = await supabase.rpc('approve_decision_ledger_entry', { p_id: id, p_approved_by: approvedBy, p_notes: notes });
  if (error) throw error;
  return data as DecisionLedgerEntry;
}

export async function rejectLedgerEntry(id: string, notes: string): Promise<DecisionLedgerEntry> {
  const { data, error } = await supabase.rpc('reject_decision_ledger_entry', { p_id: id, p_notes: notes });
  if (error) throw error;
  return data as DecisionLedgerEntry;
}

export async function recordLedgerAction(id: string, actionTaken: string, actionTakenBy: string | null): Promise<DecisionLedgerEntry> {
  const { data, error } = await supabase.rpc('record_decision_ledger_action', { p_id: id, p_action_taken: actionTaken, p_action_taken_by: actionTakenBy });
  if (error) throw error;
  return data as DecisionLedgerEntry;
}

export async function recordLedgerOutcome(id: string, actualOutcomeValue: number, notes: string): Promise<DecisionLedgerEntry> {
  const { data, error } = await supabase.rpc('record_decision_ledger_outcome', { p_id: id, p_actual_outcome_value: actualOutcomeValue, p_notes: notes });
  if (error) throw error;
  return data as DecisionLedgerEntry;
}

export async function deleteLedgerEntry(id: string): Promise<void> {
  const { error } = await supabase.from('decision_ledger_entries').delete().eq('id', id);
  if (error) throw error;
}
