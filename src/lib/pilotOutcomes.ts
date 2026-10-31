/**
 * Pilot outcome measurement — client library.
 * Reads RLS-scoped tables and builds the numbers with the SAME pure engine the edge function (weekly email)
 * uses, so the page and the email cannot disagree. Nothing is computed from free-typed figures except
 * the two manual admin-hours inputs.
 */
import { supabase } from '@/lib/supabase';
import {
  attributionsToCsv,
  buildPilotResults,
  type AttributionRow,
  type BaselineRow,
  type ClaimInput,
  type EligibleJobRow,
  type PilotResults,
  type SettingsRow,
} from '../../supabase/functions/_shared/pilot-outcomes/engine';

export { PILOT_EMAIL_TEMPLATE_VERSION, computeFeeCents } from '../../supabase/functions/_shared/pilot-outcomes/engine';
export type { PilotResults, AttributionRow } from '../../supabase/functions/_shared/pilot-outcomes/engine';

export interface PilotSettingsView extends SettingsRow {
  email_enabled: boolean;
  email_template_approved_version: string | null;
  email_template_approved_at: string | null;
}

export interface PilotData {
  results: PilotResults;
  attributions: AttributionRow[];
  settings: PilotSettingsView | null;
}

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadPilotData(): Promise<PilotData> {
  const [b, s] = await Promise.all([
    supabase.from('pilot_outcome_baselines').select('*').maybeSingle(),
    supabase.from('pilot_outcome_settings').select('current_admin_hours_per_week, fee_bps, email_enabled, email_template_approved_version, email_template_approved_at').maybeSingle(),
  ]);
  if (b.error) throw new Error(b.error.message);
  if (s.error) throw new Error(s.error.message);

  const claims = await fetchAll<ClaimInput>((a, z) =>
    supabase.from('warranty_claims').select('id, job_id, status, created_at, submitted_at, credit_received_cents, credit_received_at').order('id').range(a, z));
  const attributions = await fetchAll<AttributionRow>((a, z) =>
    supabase.from('pilot_attributions').select('source_type, source_id, claim_id, invoice_id, job_id, amount_cents, action_type, action_at, recovered_at').order('recovered_at', { ascending: false }).order('id').range(a, z));
  const eligibleUnfiled = await fetchAll<EligibleJobRow>((a, z) =>
    supabase.from('warranty_eligible_jobs').select('job_id, invoice_amount, completed_at').order('job_id').range(a, z));

  const settings = (s.data ?? null) as PilotSettingsView | null;
  return {
    results: buildPilotResults({
      nowIso: new Date().toISOString(), baseline: (b.data ?? null) as BaselineRow | null, settings, claims, attributions, eligibleUnfiled,
    }),
    attributions,
    settings,
  };
}

async function edgeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  const msg = ctx ? await ctx.json().then((j: { error?: string }) => j.error).catch(() => undefined) : undefined;
  return msg || (error as Error).message || 'Request failed';
}

/** Owner-only. Idempotent: stores any newly attributable recovered money. */
export async function syncPilotAttributions(): Promise<void> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  const { error } = await supabase.functions.invoke('money-recovered-run', {
    body: { action: 'pilot_sync' },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw new Error(await edgeError(error));
}

export async function sendPilotEmail(action: 'pilot_send_test' | 'pilot_send_now'): Promise<{ ok: boolean; message: string }> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  const { data, error } = await supabase.functions.invoke('money-recovered-run', {
    body: { action },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw new Error(await edgeError(error));
  const d = data as { ok?: boolean; sent?: boolean; reason?: string; error?: string };
  const ok = d.ok === true || d.sent === true;
  return { ok, message: ok ? 'Email sent.' : (d.error || d.reason || 'Email was not sent.') };
}

export const parseHours = (raw: string): number | null => {
  const v = Number(raw.trim().replace(',', '.'));
  return raw.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 168 ? Math.round(v * 100) / 100 : null;
};

export async function captureBaseline(hours: number): Promise<void> {
  const { error } = await supabase.rpc('pilot_capture_baseline', { p_admin_hours: hours });
  if (error) throw new Error(error.message);
}

export async function savePilotSettings(p: { hours: number | null; emailEnabled: boolean; approveVersion: string | null }): Promise<void> {
  const { error } = await supabase.rpc('pilot_save_settings', {
    p_hours: p.hours, p_email_enabled: p.emailEnabled, p_approve_template_version: p.approveVersion,
  });
  if (error) throw new Error(error.message);
}

export function downloadAttributionsCsv(rows: AttributionRow[]): void {
  const blob = new Blob([attributionsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pilot-attributions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
