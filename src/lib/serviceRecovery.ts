import { supabase, type ServiceRecoverySignal } from '@/lib/supabase';

export type { ServiceRecoverySignal };

/**
 * Service Recovery & Complaint Prevention — dashboard client library.
 *
 * Rows are written only by the service-recovery-agent Edge Function's
 * service-role client (see supabase/functions/service-recovery-agent).
 * This module reads them and handles what a human does here: resolving,
 * escalating, or dismissing a signal.
 */

export type SignalType = ServiceRecoverySignal['signal_type'];
export type SignalStatus = ServiceRecoverySignal['status'];
export type Severity = ServiceRecoverySignal['severity'];
export type RecommendedChannel = ServiceRecoverySignal['recommended_channel'];

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  eta_missed: 'Missed ETA', technician_delayed: 'Technician Delay', technician_delay: 'Technician Delay',
  negative_sentiment: 'Negative Sentiment', customer_dispute: 'Customer Dispute', broken_promise: 'Broken Promise',
  negative_review: 'Negative Review', payment_dispute: 'Payment Dispute', other: 'Other',
};
export const SIGNAL_TYPE_OPTIONS: SignalType[] = ['payment_dispute','customer_dispute','negative_sentiment','negative_review','broken_promise','eta_missed','technician_delay','other'];
export const SEVERITY_LABELS: Record<Severity, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const SEVERITY_COLORS: Record<Severity, string> = {
  low: 'bg-bg-tertiary text-text-secondary', medium: 'bg-accent/10 text-accent',
  high: 'bg-warning-500/10 text-warning-500', critical: 'bg-danger/10 text-danger',
};
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const STATUS_LABELS: Record<SignalStatus, string> = {
  open: 'Open', playbook_enrolled: 'Playbook running', escalated: 'Escalated', action_queued: 'Sending…',
  action_sent: 'Response sent', resolved: 'Resolved', ignored: 'Ignored',
};
export const STATUS_COLORS: Record<SignalStatus, string> = {
  open: 'bg-danger/10 text-danger', playbook_enrolled: 'bg-accent/10 text-accent', escalated: 'bg-warning-500/10 text-warning-500',
  action_queued: 'bg-accent/10 text-accent', action_sent: 'bg-accent/10 text-accent',
  resolved: 'bg-success-500/10 text-success-500', ignored: 'bg-bg-tertiary text-text-secondary',
};
const OPEN_STATUSES: ReadonlySet<SignalStatus> = new Set(['open', 'playbook_enrolled', 'escalated', 'action_queued']);
export function isOpenSignal(status: SignalStatus): boolean { return OPEN_STATUSES.has(status); }
export function bySeverityThenRecency<T extends { severity: Severity; detected_at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime());
}
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function fetchServiceRecoverySignals(): Promise<ServiceRecoverySignal[]> {
  const { data, error } = await supabase
    .from('service_recovery_signals')
    .select('*')
    .order('severity_score', { ascending: false })
    .order('detected_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as ServiceRecoverySignal[]) ?? [];
}

export async function resolveSignal(id: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: note || null })
    .eq('id', id);
  if (error) throw error;
}

export async function escalateSignal(id: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'escalated', resolution_note: note || null })
    .eq('id', id);
  if (error) throw error;
}

export async function ignoreSignal(id: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'ignored', resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Client-side only — never persisted. */
export function isHighSeverity(s: ServiceRecoverySignal): boolean {
  return s.status === 'open' && s.severity_score >= 75;
}
