import { supabase } from '@/lib/supabase';
import type { SlotDecision, DayDecision } from '../../supabase/functions/_shared/booking/capacityEngine';

export type { SlotDecision, DayDecision } from '../../supabase/functions/_shared/booking/capacityEngine';

/**
 * Client for capacity-based smart booking (edge function `booking-capacity` + policy RPCs in
 * supabase/migrations/20271102000000_capacity_booking.sql). The slot logic itself lives in ONE pure module
 * (supabase/functions/_shared/booking/capacityEngine.ts) shared with voice, SMS and MCP agents.
 */

export interface CapacityPolicy {
  enabled: boolean;
  slot_step_minutes: number;
  default_travel_minutes: number;
  overbook_jobs_per_tech: number;
  overbook_min_cancel_rate_pct: number;
  max_slots_per_day: number;
}

export const DEFAULT_POLICY: CapacityPolicy = {
  enabled: false, slot_step_minutes: 30, default_travel_minutes: 20, overbook_jobs_per_tech: 0, overbook_min_cancel_rate_pct: 10, max_slots_per_day: 12,
};

export const POLICY_LIMITS = {
  slotStep: { min: 5, max: 240 },
  travel: { min: 0, max: 240 },
  overbook: { min: 0, max: 3 },
  cancelPct: { min: 0, max: 100 },
  maxSlots: { min: 1, max: 48 },
} as const;

export function validatePolicy(p: CapacityPolicy): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(p.slot_step_minutes, POLICY_LIMITS.slotStep.min, POLICY_LIMITS.slotStep.max)) e.slot_step_minutes = `Use ${POLICY_LIMITS.slotStep.min}–${POLICY_LIMITS.slotStep.max} minutes.`;
  if (!int(p.default_travel_minutes, POLICY_LIMITS.travel.min, POLICY_LIMITS.travel.max)) e.default_travel_minutes = `Use ${POLICY_LIMITS.travel.min}–${POLICY_LIMITS.travel.max} minutes.`;
  if (!int(p.overbook_jobs_per_tech, POLICY_LIMITS.overbook.min, POLICY_LIMITS.overbook.max)) e.overbook_jobs_per_tech = `Use ${POLICY_LIMITS.overbook.min}–${POLICY_LIMITS.overbook.max} extra jobs.`;
  if (!int(p.overbook_min_cancel_rate_pct, POLICY_LIMITS.cancelPct.min, POLICY_LIMITS.cancelPct.max)) e.overbook_min_cancel_rate_pct = 'Use 0–100%.';
  if (!int(p.max_slots_per_day, POLICY_LIMITS.maxSlots.min, POLICY_LIMITS.maxSlots.max)) e.max_slots_per_day = `Use ${POLICY_LIMITS.maxSlots.min}–${POLICY_LIMITS.maxSlots.max} slots.`;
  return e;
}

export async function loadCapacityPolicy(): Promise<CapacityPolicy> {
  const { data, error } = await supabase.rpc('get_booking_capacity_policy');
  if (error || !data) throw new Error(error?.message ?? 'policy_unavailable');
  const r = data as Partial<CapacityPolicy>;
  return { ...DEFAULT_POLICY, ...r, enabled: r.enabled === true };
}

export async function saveCapacityPolicy(p: CapacityPolicy): Promise<{ ok: true } | { ok: false; reason: 'owner_only' | 'unknown' }> {
  const { error } = await supabase.rpc('update_booking_capacity_policy', {
    p_enabled: p.enabled,
    p_slot_step_minutes: p.slot_step_minutes,
    p_default_travel_minutes: p.default_travel_minutes,
    p_overbook_jobs_per_tech: p.overbook_jobs_per_tech,
    p_overbook_min_cancel_rate_pct: p.overbook_min_cancel_rate_pct,
    p_max_slots_per_day: p.max_slots_per_day,
  });
  if (!error) return { ok: true };
  return { ok: false, reason: (error.message ?? '').includes('owner_only') ? 'owner_only' : 'unknown' };
}

export interface CapacityPreview {
  timezone: string;
  duration_minutes: number;
  overbooking_allowance_per_tech: number;
  cancel_rate: number | null;
  days: DayDecision[];
  slots: SlotDecision[];
}

export async function previewCapacity(input: { serviceType?: string; address?: string; emergency?: boolean; days?: number }): Promise<CapacityPreview> {
  const { data, error } = await supabase.functions.invoke('booking-capacity', {
    body: { action: 'preview', service_type: input.serviceType || undefined, address: input.address || undefined, emergency: input.emergency === true, days: input.days ?? 3 },
  });
  if (error || !data || (data as { error?: string }).error) throw new Error('preview_failed');
  return data as CapacityPreview;
}

// ---------------------------------------------------------------- public booking page

export interface CapacitySlots { slots: Date[]; durationMinutes: number }

/** null = capacity booking is off (or unreachable): the caller keeps its legacy slot engine. */
export async function fetchCapacitySlots(slug: string, serviceType?: string | null): Promise<CapacitySlots | null> {
  try {
    const { data, error } = await supabase.functions.invoke('booking-capacity', { body: { action: 'slots', slug, service_type: serviceType || undefined } });
    if (error || !data || (data as { capacity?: boolean }).capacity !== true) return null;
    const d = data as { slots: { start: string }[]; duration_minutes: number };
    return { slots: d.slots.map((s) => new Date(s.start)), durationMinutes: d.duration_minutes };
  } catch {
    return null;
  }
}

export interface CapacityBookInput {
  slug: string; slot: Date; customerName: string; customerPhone: string; customerEmail: string;
  serviceType: string; notes: string; channel: string; refCode?: string; intakeAnswers: Record<string, string>;
}

export type CapacityBookResult =
  | { mode: 'legacy' }
  | { mode: 'capacity'; ok: true; depositDueCents: number }
  | { mode: 'capacity'; ok: false; reason: 'slot_taken' | 'service_unavailable' | 'intake_required' | 'intake_invalid' | 'unknown' };

export async function bookCapacitySlot(input: CapacityBookInput): Promise<CapacityBookResult> {
  const { data, error } = await supabase.functions.invoke('booking-capacity', {
    body: {
      action: 'book', slug: input.slug, slot_start: input.slot.toISOString(), customer_name: input.customerName, customer_phone: input.customerPhone,
      customer_email: input.customerEmail, service_type: input.serviceType || undefined, notes: input.notes, channel: input.channel,
      ref_code: input.refCode, intake_answers: input.intakeAnswers,
    },
  });
  if (error) {
    // Only an undeployed function means "legacy". A network/5xx failure may have happened AFTER the write,
    // so falling back to the legacy RPC could double-book — report it instead.
    const status = (error as { context?: { status?: number } }).context?.status;
    return status === 404 ? { mode: 'legacy' } : { mode: 'capacity', ok: false, reason: 'unknown' };
  }
  const d = (data ?? {}) as { mode?: string; ok?: boolean; reason?: string; deposit_due_cents?: number };
  if (d.mode === 'legacy') return { mode: 'legacy' };
  if (d.ok) return { mode: 'capacity', ok: true, depositDueCents: d.deposit_due_cents ?? 0 };
  const known = ['slot_taken', 'service_unavailable', 'intake_required', 'intake_invalid'] as const;
  const reason = known.find((k) => k === d.reason);
  return { mode: 'capacity', ok: false, reason: reason ?? 'unknown' };
}
