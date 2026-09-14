import { supabase } from '@/lib/supabase';

export interface OnboardingSlot {
  start: Date;
  end: Date;
}

export interface BookOnboardingSlotParams {
  fullName: string;
  workEmail: string;
  companyName: string;
  phone?: string;
  planTier?: string;
  message?: string;
  slotStart: Date;
}

export type BookOnboardingSlotResult =
  | { ok: true }
  | { ok: false; reason: 'SLOT_NOT_AVAILABLE' | 'INVALID_EMAIL' | 'UNKNOWN' };

const SLOT_MINUTES = 45;
const BUSINESS_START_HOUR = 10;
const BUSINESS_END_HOUR = 16;
const MIN_LEAD_TIME_HOURS = 24; // onboarding needs more prep than a sales demo

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateCandidateSlots(rangeStart: Date, rangeEnd: Date): OnboardingSlot[] {
  const slots: OnboardingSlot[] = [];
  const day = new Date(rangeStart);
  day.setHours(0, 0, 0, 0);

  while (day < rangeEnd) {
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) {
      for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
        for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
          const start = new Date(day);
          start.setHours(hour, minute, 0, 0);
          if (start < rangeStart || start >= rangeEnd) continue;
          const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
          slots.push({ start, end });
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return slots;
}

export async function getOnboardingOpenSlots(rangeStart: Date, rangeEnd: Date): Promise<OnboardingSlot[]> {
  const candidates = generateCandidateSlots(rangeStart, rangeEnd);
  const earliestAllowed = Date.now() + MIN_LEAD_TIME_HOURS * 60 * 60 * 1000;

  const { data: booked, error } = await supabase.rpc('get_booked_onboarding_slot_starts', {
    p_start: rangeStart.toISOString(),
    p_end: rangeEnd.toISOString(),
  });

  if (error) throw error;

  const bookedTimes = new Set((booked ?? []).map((row: { slot_start: string }) => new Date(row.slot_start).getTime()));

  return candidates.filter((slot) => slot.start.getTime() >= earliestAllowed && !bookedTimes.has(slot.start.getTime()));
}

export async function bookOnboardingSlot(params: BookOnboardingSlotParams): Promise<BookOnboardingSlotResult> {
  if (!EMAIL_RE.test(params.workEmail.trim())) {
    return { ok: false, reason: 'INVALID_EMAIL' };
  }

  const slotEnd = new Date(params.slotStart.getTime() + SLOT_MINUTES * 60_000);

  const { error } = await supabase.from('onboarding_bookings').insert({
    full_name: params.fullName.trim(),
    work_email: params.workEmail.trim(),
    company_name: params.companyName.trim(),
    phone: params.phone?.trim() || null,
    plan_tier: params.planTier || null,
    message: params.message?.trim() || null,
    slot_start: params.slotStart.toISOString(),
    slot_end: slotEnd.toISOString(),
  });

  if (!error) return { ok: true };
  if (error.code === '23505') return { ok: false, reason: 'SLOT_NOT_AVAILABLE' };

  console.error('bookOnboardingSlot failed:', error);
  return { ok: false, reason: 'UNKNOWN' };
}
