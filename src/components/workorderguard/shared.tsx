import type { Flag, FlagCode } from '@/lib/workOrderGuard';

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function FlagBadge({ flag }: { flag: Flag }) {
  const tone = flag.level === 'violation' ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return (
    <li className={`rounded-xl border px-3 py-2 text-sm ${tone}`}>
      <span className="font-semibold">{flag.level === 'violation' ? 'Rule broken: ' : 'Heads up: '}{flag.title}</span>
      <span className="block text-xs text-text-secondary">{flag.detail}</span>
    </li>
  );
}

export const RULE_LABELS: Record<FlagCode, string> = {
  accept_expiring: 'Accept window expiring', accept_late: 'Accepted/declined late', accept_missed: 'Accept window missed',
  over_nte: 'Over NTE without approved proposal', checkin_out_of_range: 'Check-in outside radius', checkin_before_proposal: 'Check-in before proposal approval',
  invoice_due_soon: 'Invoice due soon', invoice_late: 'Invoice late', invoice_overdue: 'Invoice overdue', duplicate_invoice: 'Duplicate invoice',
  wo_expiring_90d: 'Work order expiring', invoice_after_90d: 'Invoiced after eligibility window', wo_ineligible: 'Work order ineligible',
  sales_tax: 'Sales tax on invoice', management_fee: 'Management fee line', breakdown_missing: 'Invoice breakout incomplete', breakdown_mismatch: 'Breakout does not add up',
};
