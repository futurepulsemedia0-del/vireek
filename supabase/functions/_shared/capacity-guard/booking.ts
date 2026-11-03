// supabase/functions/_shared/capacity-guard/booking.ts
//
// Layers active Capacity Guard holds onto a loaded BookingContext as pseudo-jobs for ONE request, so the existing
// capacity engine (public page, AI voice agent, SMS, MCP) automatically hides held slots from requests that may not use them.
// Fails OPEN: any error returns the context unchanged (the guard must never take booking down).
//
// LIMITATION (documented): holds are enforced in the engine, not inside book_capacity_slot(); a caller that writes jobs
// without going through the engine (e.g. a human dispatcher in the dashboard) is intentionally not blocked.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { BookingContext, BookingRequest, BusyJob } from '../booking/capacityEngine.ts';
import { isHighValueRequest, selectBlockingHolds, type HoldRow, type TradeRule } from './engine.ts';

export interface GuardFlags { campaignAttributed?: boolean; hasAgreement?: boolean }

export async function applyGuardHolds(admin: SupabaseClient, ownerId: string, ctx: BookingContext, req: BookingRequest, flags: GuardFlags = {}): Promise<BookingContext> {
  try {
    const { data: s } = await admin.from('capacity_guard_settings').select('enabled, mode, trade_rules').eq('user_id', ownerId).maybeSingle();
    if (!s || s.enabled !== true || s.mode !== 'live') return ctx;
    const to = new Date(ctx.now + (ctx.windowDays + 2) * 86_400_000).toISOString();
    const { data } = await admin.from('capacity_holds').select('id, kind, technician_id, slot_start, slot_end, shadow')
      .eq('user_id', ownerId).eq('status', 'active').gte('slot_end', new Date(ctx.now).toISOString()).lt('slot_start', to).limit(2000);
    const rows: HoldRow[] = ((data ?? []) as Record<string, unknown>[]).map((h) => ({
      id: h.id as string, kind: h.kind as 'value' | 'campaign', technicianId: h.technician_id as string,
      start: Date.parse(h.slot_start as string), end: Date.parse(h.slot_end as string), shadow: h.shadow === true,
    }));
    const rules = (Array.isArray(s.trade_rules) ? s.trade_rules : []) as TradeRule[];
    const highValue = isHighValueRequest({ serviceType: req.serviceType, isEmergency: req.isEmergency, isVip: req.isVip, hasAgreement: flags.hasAgreement === true }, rules);
    const blocking = selectBlockingHolds(rows, { highValue, campaignAttributed: flags.campaignAttributed === true });
    if (blocking.length === 0) return ctx;
    const pseudo: BusyJob[] = blocking.map((h) => ({ id: `hold:${h.id}`, technician_id: h.technicianId, start: h.start, end: h.end, lat: null, lon: null }));
    return { ...ctx, jobs: [...ctx.jobs, ...pseudo] };
  } catch (e) {
    console.error(JSON.stringify({ event: 'capacity_guard_holds_failed_open', error: e instanceof Error ? e.message : String(e) }));
    return ctx;
  }
}
