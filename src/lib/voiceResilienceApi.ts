// Network layer for /dashboard/voice-resilience. Pure helpers live in voiceResilience.ts.
import { supabase } from '@/lib/supabase';
import type { CarrierFamily, CheckKind, CheckStatus, ForwardCode, VoiceStatus } from '@/lib/voiceResilience';
import { buildManualPayload, scheduleFromRow, type CheckRow, type DrillSchedule, type ManualDraft, type ManualRow } from '@/lib/voiceDrills';

export class VoiceApiError extends Error {
  constructor(public readonly status: number | undefined, message: string) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('voice-resilience-admin', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let message = error.message;
    if (ctx && typeof ctx.clone === 'function') {
      try {
        const j = (await ctx.clone().json()) as { error?: string };
        if (j?.error) message = j.error;
      } catch { /* non-JSON error body */ }
    }
    throw new VoiceApiError(ctx?.status, message);
  }
  return data as T;
}

export const fetchVoiceStatus = () => call<VoiceStatus>({ action: 'status' });

export const saveOrgSettings = (patch: Record<string, unknown>) => call<{ ok: true }>({ action: 'set_org', ...patch });

export const setForcedLevel = (level: number | null, minutes?: number) =>
  call<{ ok: true }>({ action: 'set_org', forced_level: level, ...(level == null ? {} : { forced_minutes: minutes }) });

export const fetchWizardPlan = (family: CarrierFamily, vireekNumber: string, ringSeconds = 20) =>
  call<{ codes: ForwardCode[]; warning: string }>({ action: 'wizard_plan', family, vireek_number: vireekNumber, ring_seconds: ringSeconds });

export const startWizardCheck = (kind: CheckKind, vireekNumber: string, businessNumber: string, ringSeconds = 20) =>
  call<{ check_id: string; instruction: string }>({ action: 'wizard_start', kind, vireek_number: vireekNumber, business_number: businessNumber, ring_seconds: ringSeconds });

export const fetchWizardStatus = (checkId: string) =>
  call<{ status: CheckStatus; kind: CheckKind; outbound_status: string | null }>({ action: 'wizard_status', check_id: checkId });

/** The account's own Vireek numbers (RLS limits this to the signed-in account). */
export async function fetchVireekNumbers(ownerId: string): Promise<string[]> {
  const { data, error } = await supabase.from('phone_numbers').select('phone_number').eq('account_id', ownerId).eq('status', 'active');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { phone_number: string }) => r.phone_number);
}

// ---- drill schedule + evidence log (src/lib/voiceDrills.ts) ----
export interface DrillData { schedule: DrillSchedule; checks: CheckRow[]; manual: ManualRow[] }

/** Reads go straight to the tables (RLS limits them to the signed-in account); writes go through the edge function. */
export async function fetchDrillData(ownerId: string): Promise<DrillData> {
  const [s, c, m] = await Promise.all([
    supabase.from('voice_drill_schedules').select('enabled, interval_days').eq('user_id', ownerId).maybeSingle(),
    supabase.from('voice_forward_checks').select('id, kind, status, started_at, finished_at').eq('user_id', ownerId).order('started_at', { ascending: false }).limit(200),
    supabase.from('voice_drill_evidence').select('id, kind, outcome, note, created_at').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(200),
  ]);
  if (s.error || c.error || m.error) throw new Error((s.error ?? c.error ?? m.error)!.message);
  return { schedule: scheduleFromRow(s.data), checks: (c.data ?? []) as CheckRow[], manual: (m.data ?? []) as ManualRow[] };
}

export const saveDrillSchedule = (s: DrillSchedule) => call<{ ok: true }>({ action: 'drill_set', enabled: s.enabled, interval_days: s.interval_days });
export const logManualDrill = (d: ManualDraft) => call<{ ok: true }>(buildManualPayload(d));
