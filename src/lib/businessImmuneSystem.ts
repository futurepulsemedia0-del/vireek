// src/lib/businessImmuneSystem.ts
//
// Types, labels and pure helpers for the Business Immune System.
// Mirrors the pattern already used in src/lib/serviceRecovery.ts.

export type ImmuneCategory =
  | 'revenue_shock'
  | 'reputation_threat'
  | 'operational_overload'
  | 'financial_irregularity'
  | 'integration_failure';

export type ImmuneStatus = 'active' | 'acknowledged' | 'contained' | 'resolved' | 'dismissed';
export type ImmuneSeverity = 'low' | 'medium' | 'high' | 'critical';

export const CATEGORY_LABELS: Record<ImmuneCategory, string> = {
  revenue_shock: 'Revenue Shock',
  reputation_threat: 'Reputation Threat',
  operational_overload: 'Operational Overload',
  financial_irregularity: 'Financial Irregularity',
  integration_failure: 'Integration Failure',
};

export const CATEGORY_DESCRIPTIONS: Record<ImmuneCategory, string> = {
  revenue_shock: 'Bookings or revenue-generating activity has dropped sharply against its normal baseline.',
  reputation_threat: 'Negative sentiment or critical service-recovery signals are spiking.',
  operational_overload: 'Missed calls, delays, or unhandled work are piling up faster than normal.',
  financial_irregularity: 'Margin floor is being blocked or overridden more than usual — pricing discipline is slipping.',
  integration_failure: 'A connected integration has entered an error state and may be silently losing data.',
};

export const STATUS_LABELS: Record<ImmuneStatus, string> = {
  active: 'Active',
  acknowledged: 'Acknowledged',
  contained: 'Contained',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const STATUS_COLORS: Record<ImmuneStatus, string> = {
  active: 'bg-danger/10 text-danger',
  acknowledged: 'bg-warning-500/10 text-warning-500',
  contained: 'bg-accent/10 text-accent',
  resolved: 'bg-success-500/10 text-success-500',
  dismissed: 'bg-bg-tertiary text-text-secondary',
};

export const SEVERITY_COLORS: Record<ImmuneSeverity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger/20 text-danger',
};

export function severityLabel(score: number): ImmuneSeverity {
  if (score >= 85) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function isOpenImmuneSignal(status: ImmuneStatus): boolean {
  return status === 'active' || status === 'acknowledged' || status === 'contained';
}

export function byActiveSeverityThenRecency<T extends { status: ImmuneStatus; severity_score: number; detected_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const openDiff = Number(isOpenImmuneSignal(b.status)) - Number(isOpenImmuneSignal(a.status));
    if (openDiff !== 0) return openDiff;
    if (b.severity_score !== a.severity_score) return b.severity_score - a.severity_score;
    return new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime();
  });
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Deterministic 0-100 "health score" derived from currently-open signals. */
export function immuneHealthScore(activeSignals: { severity_score: number }[]): number {
  if (activeSignals.length === 0) return 100;
  const penalty = activeSignals.reduce((sum, s) => sum + s.severity_score, 0) / 3;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}
