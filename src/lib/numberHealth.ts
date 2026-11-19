// src/lib/numberHealth.ts
// Client for number reputation monitoring (migration 20290310000100_number_health.sql, edge function number-health-poll).
// Pure logic is shared with the scheduled function: supabase/functions/_shared/number-health/core.ts.

import { supabase } from '@/lib/supabase';
import {
  buildRemediation,
  isStale,
  remediationProgress,
  severityOf,
  type AttestationLevel,
  type HealthSeverity,
  type HealthStatus,
  type RemediationStepId,
  type SpamLabel,
} from '../../supabase/functions/_shared/number-health/core';

export {
  REMEDIATION_STEP_IDS,
  buildRemediation,
  isStale,
  remediationProgress,
  severityOf,
  type AttestationLevel,
  type HealthSeverity,
  type HealthStatus,
  type RemediationStepId,
  type SpamLabel,
} from '../../supabase/functions/_shared/number-health/core';

export interface NumberHealthRow {
  phone_number_id: string;
  provider: string;
  provider_live: boolean;
  spam_label: SpamLabel;
  attestation: AttestationLevel;
  label_sources: string[];
  status: HealthStatus;
  checked_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  remediation_done: Record<string, boolean>;
}

export interface NumberHealthView {
  row: NumberHealthRow | null;
  severity: HealthSeverity;
  stale: boolean;
  steps: RemediationStepId[];
  progress: { done: number; total: number };
}

/** RLS already limits rows to the signed-in account owner; the explicit id list just keeps the query small. */
export async function fetchNumberHealth(phoneNumberIds: readonly string[]): Promise<Map<string, NumberHealthRow>> {
  if (phoneNumberIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('number_health')
    .select('phone_number_id, provider, provider_live, spam_label, attestation, label_sources, status, checked_at, last_attempt_at, consecutive_failures, last_error_code, remediation_done')
    .in('phone_number_id', [...phoneNumberIds]);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as NumberHealthRow[]).map((r) => [r.phone_number_id, r]));
}

export function viewOf(row: NumberHealthRow | null | undefined, now: Date = new Date()): NumberHealthView {
  const r = row ?? null;
  const spam: SpamLabel = r?.spam_label ?? 'unknown';
  const att: AttestationLevel = r?.attestation ?? 'unknown';
  const steps = buildRemediation({ spamLabel: spam, attestation: att, providerLive: r?.provider_live ?? false });
  return {
    row: r,
    severity: severityOf({ spamLabel: spam, attestation: att }),
    stale: isStale(r?.checked_at ? new Date(r.checked_at) : null, now),
    steps,
    progress: remediationProgress(steps, r?.remediation_done),
  };
}

export async function checkNumberHealthNow(): Promise<{ checked: number; skippedRecent: number; failed: number; live: boolean }> {
  const { data, error } = await supabase.functions.invoke('number-health-poll', { body: { mode: 'user' } });
  if (error) throw new Error(error.message);
  const d = data as { checked?: number; skipped_recent?: number; failed?: number; live?: boolean };
  return { checked: d.checked ?? 0, skippedRecent: d.skipped_recent ?? 0, failed: d.failed ?? 0, live: !!d.live };
}

export async function setRemediationStep(phoneNumberId: string, step: RemediationStepId, done: boolean): Promise<Record<string, boolean>> {
  const { data, error } = await supabase.rpc('number_health_set_step', { p_number_id: phoneNumberId, p_step: step, p_done: done });
  if (error) throw new Error(error.message);
  return ((data as { remediation_done?: Record<string, boolean> } | null)?.remediation_done) ?? {};
}
