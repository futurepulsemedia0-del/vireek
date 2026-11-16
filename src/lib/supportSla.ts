/**
 * Internal support severity (S1–S4) — pure logic, no React, no network.
 * Mirrors supabase/migrations/20290305000000_support_severity_internal_sla.sql
 * and docs/support/severity-matrix.md. Targets live in the DB (support_sla_targets), never here.
 */
import { formatDuration, type TicketPriority } from '@/lib/supportTickets';

export type Severity = 'S1' | 'S2' | 'S3' | 'S4';
export type OverdueKind = 'first_response' | 'resolution';

export const SEVERITIES: readonly Severity[] = ['S1', 'S2', 'S3', 'S4'];

export const SEVERITY_LABEL: Record<Severity, string> = {
  S1: 'S1 · Critical',
  S2: 'S2 · High',
  S3: 'S3 · Medium',
  S4: 'S4 · Low',
};

export interface OverdueTicket {
  id: string;
  severity: Severity;
  severity_confirmed: boolean;
  overdue_kind: OverdueKind;
  overdue_seconds: number;
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/** Same mapping as the insert trigger. S1 is never provisional: only staff can declare it. */
export function provisionalSeverity(priority: TicketPriority): Severity {
  if (priority === 'urgent' || priority === 'high') return 'S2';
  if (priority === 'low') return 'S4';
  return 'S3';
}

export function overdueLabel(row: Pick<OverdueTicket, 'overdue_kind' | 'overdue_seconds'>): string {
  const what = row.overdue_kind === 'first_response' ? 'First response' : 'Resolution';
  return `${what} overdue by ${formatDuration(row.overdue_seconds * 1000)}`;
}
