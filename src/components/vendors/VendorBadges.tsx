import type { ReactNode } from 'react';
import { RISK_CLASS, RISK_LABELS, TIER_CLASS, TIER_LABELS } from '@/lib/vendorManagement';
import type { RiskLevel, VendorPerformance, VendorTier } from '@/lib/vendorManagement';

export function Pill({
  className = '',
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: VendorTier }) {
  return <Pill className={TIER_CLASS[tier]}>{TIER_LABELS[tier]}</Pill>;
}

export function RiskBadge({ level, score }: { level: RiskLevel; score: number }) {
  return (
    <Pill className={RISK_CLASS[level]} title={`Risk score ${score}/100 (higher = riskier)`}>
      {RISK_LABELS[level]}
    </Pill>
  );
}

const GRADE_CLASS: Record<NonNullable<VendorPerformance['grade']>, string> = {
  A: 'bg-success-500/10 text-success-500',
  B: 'bg-success-500/10 text-success-500',
  C: 'bg-bg-tertiary text-text-secondary',
  D: 'bg-warning-500/10 text-warning-500',
  F: 'bg-danger/10 text-danger',
};

export function PerformanceBadge({ performance }: { performance: VendorPerformance }) {
  if (performance.score === null || performance.grade === null) {
    return <span className="text-xs text-text-secondary">Not enough data</span>;
  }
  return (
    <Pill
      className={GRADE_CLASS[performance.grade]}
      title={`Based on ${performance.sample} measured events (deliveries, receipts, evaluations)`}
    >
      {performance.score} · {performance.grade}
    </Pill>
  );
}
