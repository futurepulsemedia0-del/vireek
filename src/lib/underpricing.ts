import { formatCents } from './priceBook';

export type MatchType = 'linked' | 'exact_name' | 'keyword';

export interface UnderpricedJobRow {
  job_id: string;
  user_id: string;
  customer_name: string;
  service_type: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  invoice_cents: number;
  matched_price_book_item_id: string;
  matched_service_name: string;
  match_type: MatchType;
  book_price_cents: number;
  underprice_cents: number;
  underprice_pct: number | null;
  total_cost_cents: number | null;
  gross_profit_cents: number | null;
  margin_pct: number | null;
}

export interface TechnicianUnderpricingSummary {
  user_id: string;
  assigned_technician_id: string | null;
  member_name: string | null;
  member_email: string | null;
  matched_job_count: number;
  underpriced_job_count: number;
  total_underpriced_cents: number;
  avg_underprice_pct: number | null;
}

export { formatCents };

export const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  linked: 'Linked to Price Book',
  exact_name: 'Matched by name',
  keyword: 'Matched by keyword',
};

export function isUnderpriced(row: UnderpricedJobRow): boolean {
  return row.underprice_cents > 0;
}

export function severityColor(underpricePct: number | null): string {
  if (underpricePct === null || underpricePct <= 0) return 'bg-bg-tertiary text-text-secondary';
  if (underpricePct < 10) return 'bg-warning-500/10 text-warning-500';
  return 'bg-danger/10 text-danger';
}

export function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct.toFixed(1)}%`;
}

export function technicianLabel(row: { member_name: string | null; member_email: string | null; assigned_technician_id: string | null }): string {
  if (!row.assigned_technician_id) return 'Unassigned';
  return row.member_name ?? row.member_email ?? 'Unknown technician';
}

export interface UnderpricingSummaryStats {
  matchedJobCount: number;
  underpricedJobCount: number;
  totalUnderpricedCents: number;
  avgUnderpricePct: number | null;
}

export function summarizeUnderpricing(rows: UnderpricedJobRow[]): UnderpricingSummaryStats {
  const matchedJobCount = rows.length;
  const underpriced = rows.filter(isUnderpriced);
  const underpricedJobCount = underpriced.length;
  const totalUnderpricedCents = underpriced.reduce((sum, r) => sum + r.underprice_cents, 0);
  const avgUnderpricePct =
    underpriced.length > 0
      ? Math.round((underpriced.reduce((sum, r) => sum + (r.underprice_pct ?? 0), 0) / underpriced.length) * 10) / 10
      : null;
  return { matchedJobCount, underpricedJobCount, totalUnderpricedCents, avgUnderpricePct };
}
