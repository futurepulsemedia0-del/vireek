import type { ReactNode } from 'react';
import type { ConfidenceBand, DeadlineRisk, FindingStatus, FindingType } from '@/lib/supplierAudit/types';

export const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
export const btnPrimary =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const btnGhost =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50';

export const TYPE_LABELS: Record<FindingType, string> = {
  price_deviation: 'Price above agreement',
  rebate_owed: 'Rebate / patronage',
  rebate_accruing: 'Rebate accruing',
  tier_gap: 'Spend to next tier',
  unapplied_credit: 'Unapplied credit',
  warranty_credit_missing: 'Warranty credit missing',
  warranty_credit_short: 'Warranty credit short',
  coop_unclaimed: 'Co-op unclaimed',
  duplicate_invoice: 'Possible duplicate',
};
export const STATUS_LABELS: Record<FindingStatus, string> = {
  open: 'Open', packet_ready: 'Packet ready', claimed: 'Claim sent', partially_recovered: 'Partly recovered', recovered: 'Recovered', dismissed: 'Dismissed', superseded: 'No longer applies',
};
export const PROGRAM_TYPE_LABELS: Record<string, string> = {
  volume_rebate: 'Volume rebate', patronage: 'Patronage', co_op: 'Co-op', price_agreement: 'Price agreement', warranty_credit: 'Warranty credit',
};
const RISK: Record<DeadlineRisk, { label: string; cls: string }> = {
  none: { label: 'No deadline', cls: 'bg-bg-tertiary text-text-secondary' },
  ok: { label: 'On track', cls: 'bg-success-500/10 text-success-500' },
  soon: { label: 'Due within 30 days', cls: 'bg-warning-500/10 text-warning-500' },
  critical: { label: 'Due within 7 days', cls: 'bg-danger/10 text-danger' },
  expired: { label: 'Deadline passed', cls: 'bg-danger/10 text-danger' },
};
const BAND: Record<ConfidenceBand, string> = {
  high: 'bg-success-500/10 text-success-500', medium: 'bg-warning-500/10 text-warning-500', low: 'bg-danger/10 text-danger',
};

export function Pill({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
export const RiskPill = ({ risk }: { risk: DeadlineRisk }) => <Pill cls={RISK[risk].cls}>{RISK[risk].label}</Pill>;
export const BandPill = ({ band, value }: { band: ConfidenceBand; value: number }) => <Pill cls={BAND[band]}>{band} confidence · {Math.round(value * 100)}%</Pill>;

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-text-primary">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className={btnGhost}>Try again</button>}
    </div>
  );
}

export const DISCLAIMER =
  'Program rules here are entered by you from your distributor or manufacturer documents. Amounts are estimates, not promises of eligibility — always verify with your distributor. This is not legal or financial advice.';

/** Dollars input -> integer cents, or null when it is not a clean number (never guessed). */
export function dollarsToCents(v: string): number | null {
  const t = v.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export const centsToDollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
