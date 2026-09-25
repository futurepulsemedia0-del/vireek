/**
 * Decision Debt System — client library.
 *
 * "Technical debt" for decisions: every open item accrues a running
 * dollar cost (daily_financial_cost x days outstanding) and a
 * severity-weighted operational debt score, both computed client-side
 * here so the list view never has to trust a stale server snapshot.
 *
 * Server counterpart: supabase/migrations/20261203000000_decision_debt_system.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type DebtCategory = 'pricing' | 'staffing' | 'process' | 'customer' | 'vendor' | 'marketing' | 'equipment' | 'policy' | 'custom';
export type DebtStatus = 'open' | 'in_progress' | 'resolved' | 'abandoned';
export type OperationalSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DecisionDebtItem {
  id: string;
  title: string;
  description: string | null;
  category: DebtCategory;
  status: DebtStatus;
  operational_severity: OperationalSeverity;
  daily_financial_cost: number;
  identified_at: string;
  decision_needed_by: string | null;
  linked_decision_id: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// THE MATH
// ============================================================

/** Operational severity contributes a fixed daily "operational debt" weight, independent of dollars. */
const SEVERITY_DAILY_WEIGHT: Record<OperationalSeverity, number> = {
  low: 1,
  medium: 3,
  high: 7,
  critical: 15,
};

export interface DebtAccrual {
  daysOutstanding: number;
  accruedFinancialDebt: number;
  accruedOperationalDebt: number;
  isOverdue: boolean;
  daysOverdue: number;
}

/** Clock runs from identified_at to resolved_at (if resolved/abandoned) or to now (if still open). */
export function computeAccrual(item: DecisionDebtItem, now: Date = new Date()): DebtAccrual {
  const start = new Date(item.identified_at).getTime();
  const end = item.resolved_at ? new Date(item.resolved_at).getTime() : now.getTime();
  const daysOutstanding = Math.max(0, Math.floor((end - start) / 86_400_000));

  const accruedFinancialDebt = daysOutstanding * item.daily_financial_cost;
  const accruedOperationalDebt = daysOutstanding * SEVERITY_DAILY_WEIGHT[item.operational_severity];

  let isOverdue = false;
  let daysOverdue = 0;
  if (item.decision_needed_by && (item.status === 'open' || item.status === 'in_progress')) {
    const deadline = new Date(`${item.decision_needed_by}T00:00:00`).getTime();
    if (now.getTime() > deadline) {
      isOverdue = true;
      daysOverdue = Math.floor((now.getTime() - deadline) / 86_400_000);
    }
  }

  return { daysOutstanding, accruedFinancialDebt, accruedOperationalDebt, isOverdue, daysOverdue };
}

export interface DebtPortfolioSummary {
  totalOutstandingItems: number;
  totalAccruedFinancialDebt: number;
  totalAccruedOperationalDebt: number;
  overdueCount: number;
  oldestItem: DecisionDebtItem | null;
}

/** Summarize only the still-open (open/in_progress) items — resolved/abandoned don't keep accruing. */
export function summarizePortfolio(items: DecisionDebtItem[], now: Date = new Date()): DebtPortfolioSummary {
  const outstanding = items.filter((i) => i.status === 'open' || i.status === 'in_progress');
  let totalAccruedFinancialDebt = 0;
  let totalAccruedOperationalDebt = 0;
  let overdueCount = 0;
  let oldestItem: DecisionDebtItem | null = null;

  for (const item of outstanding) {
    const accrual = computeAccrual(item, now);
    totalAccruedFinancialDebt += accrual.accruedFinancialDebt;
    totalAccruedOperationalDebt += accrual.accruedOperationalDebt;
    if (accrual.isOverdue) overdueCount += 1;
    if (!oldestItem || new Date(item.identified_at) < new Date(oldestItem.identified_at)) oldestItem = item;
  }

  return {
    totalOutstandingItems: outstanding.length,
    totalAccruedFinancialDebt,
    totalAccruedOperationalDebt,
    overdueCount,
    oldestItem,
  };
}

// ============================================================
// FORMAT / LABELS
// ============================================================

export function formatDollars(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

export const CATEGORY_LABELS: Record<DebtCategory, string> = {
  pricing: 'Pricing',
  staffing: 'Staffing',
  process: 'Process',
  customer: 'Customer',
  vendor: 'Vendor / Contract',
  marketing: 'Marketing',
  equipment: 'Equipment',
  policy: 'Policy',
  custom: 'Other',
};

export const STATUS_LABELS: Record<DebtStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
};

export const SEVERITY_LABELS: Record<OperationalSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const SEVERITY_COLORS: Record<OperationalSeverity, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger/20 text-danger',
};

// ============================================================
// CRUD
// ============================================================

export async function fetchDebtItems(): Promise<DecisionDebtItem[]> {
  const { data, error } = await supabase
    .from('decision_debt_items')
    .select('*')
    .order('identified_at', { ascending: true })
    .limit(300);
  if (error) throw error;
  return (data as DecisionDebtItem[]) ?? [];
}

export interface CreateDebtItemInput {
  title: string;
  description: string;
  category: DebtCategory;
  operational_severity: OperationalSeverity;
  daily_financial_cost: number;
  decision_needed_by: string | null;
  linked_decision_id: string | null;
}

export async function createDebtItem(input: CreateDebtItemInput, userId: string): Promise<DecisionDebtItem> {
  const { data, error } = await supabase
    .from('decision_debt_items')
    .insert({
      user_id: userId,
      title: input.title.trim(),
      description: input.description.trim() || null,
      category: input.category,
      operational_severity: input.operational_severity,
      daily_financial_cost: input.daily_financial_cost,
      decision_needed_by: input.decision_needed_by,
      linked_decision_id: input.linked_decision_id,
    })
    .select()
    .single();
  if (error) throw error;
  return data as DecisionDebtItem;
}

export async function updateDebtStatus(id: string, status: DebtStatus, resolutionNotes?: string): Promise<void> {
  const isClosing = status === 'resolved' || status === 'abandoned';
  const { error } = await supabase
    .from('decision_debt_items')
    .update({
      status,
      resolution_notes: resolutionNotes?.trim() || null,
      resolved_at: isClosing ? new Date().toISOString() : null,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteDebtItem(id: string): Promise<void> {
  const { error } = await supabase.from('decision_debt_items').delete().eq('id', id);
  if (error) throw error;
}
