// Channel adapters on top of the capacity engine for the AI voice agent (vapi-webhook) and SMS auto-reply.
// Every string returned here is meant to be spoken/sent as-is: it never promises more than the engine offers.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkRequestedSlot, getAvailability } from "./capacityBooking.ts";
import { formatSlotLocal, type SlotDecision } from "./capacityEngine.ts";

/** Earliest slot of each of the first days (max `perDay`), up to `limit` — a spread, not 6 times the same morning. */
export function spreadSlots(slots: SlotDecision[], tz: string, limit = 6, perDay = 2): SlotDecision[] {
  const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
  const counts = new Map<string, number>();
  const out: SlotDecision[] = [];
  for (const s of slots) {
    if (!s.offered) continue;
    const k = day(s.start);
    const n = counts.get(k) ?? 0;
    if (n >= perDay) continue;
    counts.set(k, n + 1);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/** Voice tool `check_availability` → text for the assistant. */
export async function voiceCheckAvailability(admin: SupabaseClient, userId: string, args: Record<string, unknown>): Promise<string> {
  const input = { serviceType: str(args.service_type, 120), address: str(args.address, 300), isEmergency: args.emergency === true };
  try {
    const requested = str(args.requested_datetime, 40);
    if (requested) {
      const ms = Date.parse(requested);
      if (!Number.isFinite(ms)) return "That date and time isn't valid — confirm the day and time with the caller and ask again.";
      const v = await checkRequestedSlot(admin, userId, input, ms);
      if (v.enabled) return v.message;
    } else {
      const out = await getAvailability(admin, userId, input, { maxOffered: 40 });
      if (out.enabled) {
        const picks = spreadSlots(out.result.slots, out.loaded.ctx.timezone);
        if (picks.length === 0) return "There are no open times in the booking window — offer to take a message or add the caller to the waitlist. Do not invent a time.";
        return `Open times (about ${out.result.duration_minutes} minutes each): ${picks.map((s) => formatSlotLocal(Date.parse(s.start), out.loaded.ctx.timezone)).join("; ")}. Only offer these times.`;
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "voice_check_availability_failed", error: e instanceof Error ? e.message : String(e) }));
  }
  return "Live availability isn't available right now — offer the caller a time and tell them the office will confirm it.";
}

export type VoiceBookingGuard =
  | { mode: "legacy" }
  | { mode: "blocked"; message: string }
  | { mode: "ok"; technicianId: string; durationMinutes: number; note: string; overbooked: boolean };

/**
 * Called by book_appointment before the insert. When capacity booking is on, a time the engine would not
 * offer is refused (with real alternatives) and an offered time returns the technician to assign up front,
 * so jobs_no_double_booking protects that technician's own calendar. Fails OPEN to legacy on errors.
 */
export async function voiceBookingGuard(admin: SupabaseClient, userId: string, args: { serviceType: string | null; address: string | null; scheduledDatetime: string | null }): Promise<VoiceBookingGuard> {
  if (!args.scheduledDatetime) return { mode: "legacy" };
  const ms = Date.parse(args.scheduledDatetime);
  if (!Number.isFinite(ms)) return { mode: "legacy" };
  try {
    const v = await checkRequestedSlot(admin, userId, { serviceType: args.serviceType, address: args.address }, ms);
    if (!v.enabled) return { mode: "legacy" };
    if (!v.offered || !v.decision?.technician_id) return { mode: "blocked", message: `${v.message} Offer the caller one of these instead.` };
    const startMin = new Date(v.decision.end).getTime() - new Date(v.decision.start).getTime();
    return {
      mode: "ok", technicianId: v.decision.technician_id, durationMinutes: Math.round(startMin / 60_000),
      note: `Smart booking: ${v.decision.explanation}`.slice(0, 600), overbooked: v.decision.overbooked,
    };
  } catch (e) {
    console.error(JSON.stringify({ event: "voice_booking_guard_failed", error: e instanceof Error ? e.message : String(e) }));
    return { mode: "legacy" };
  }
}

/** SMS auto-reply: up to 3 real, typical open times (service-agnostic) the assistant may OFFER (never confirm). */
export async function smsOpenTimes(admin: SupabaseClient, userId: string): Promise<string[]> {
  try {
    const out = await getAvailability(admin, userId, {}, { maxOffered: 40 });
    if (!out.enabled) return [];
    return spreadSlots(out.result.slots, out.loaded.ctx.timezone, 3, 1).map((s) => formatSlotLocal(Date.parse(s.start), out.loaded.ctx.timezone));
  } catch {
    return [];
  }
}
