// Handler for the MCP/A2A tool `check_availability` (definition: mcpTool.ts). Used only by supabase/functions/mcp-server.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkRequestedSlot, getAvailability } from "./capacityBooking.ts";

type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };

/** Handler used by supabase/functions/mcp-server. Scoped to the key's account (ownerId). */
export async function runCheckAvailability(admin: SupabaseClient, ownerId: string, a: Record<string, unknown>): Promise<Outcome> {
  const input = {
    serviceType: (a.service_type as string | undefined) ?? null,
    address: (a.address as string | undefined) ?? null,
    lat: (a.lat as number | undefined) ?? null,
    lon: (a.lon as number | undefined) ?? null,
    isEmergency: a.emergency === true,
  };
  try {
    const out = await getAvailability(admin, ownerId, input, { includeHidden: a.include_hidden === true, maxOffered: 200 });
    if (!out.enabled) {
      return { ok: true, data: { enabled: false, note: "Capacity-aware booking is not enabled for this business. Use check_schedule instead." } };
    }
    const { result, loaded } = out;
    const days = typeof a.days === "number" ? a.days : 7;
    const dayKeys = new Set(result.days.slice(0, days).map((d) => d.date));
    const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: loaded.ctx.timezone }).format(new Date(iso));
    const inRange = result.slots.filter((s) => dayKeys.has(dayOf(s.start)));
    const offered = inRange.filter((s) => s.offered).slice(0, 40).map((s) => ({
      start: s.start, end: s.end, technician_id: s.technician_id, technician_name: s.technician_name, overbooked: s.overbooked, explanation: s.explanation,
    }));
    const hidden = a.include_hidden === true
      ? inRange.filter((s) => !s.offered).slice(0, 40).map((s) => ({ start: s.start, end: s.end, reason: s.reasons[0], explanation: s.explanation }))
      : undefined;
    let requested: unknown;
    if (typeof a.requested_start === "string") {
      const v = await checkRequestedSlot(admin, ownerId, input, Date.parse(a.requested_start));
      requested = {
        offered: v.offered, message: v.message, explanation: v.decision?.explanation,
        technician_id: v.decision?.technician_id, alternatives: v.alternatives.map((s) => ({ start: s.start, end: s.end, technician_id: s.technician_id })),
      };
    }
    return {
      ok: true,
      data: {
        enabled: true, timezone: loaded.ctx.timezone, predicted_duration_minutes: result.duration_minutes,
        days: result.days.slice(0, days).map((d) => ({ date: d.date, demand: d.demand, offered: d.offered })),
        offered, hidden, requested,
        note: "Only times in `offered` can be promised. Final confirmation happens when the booking is committed.",
      },
    };
  } catch {
    return { ok: false, code: "query_failed", message: "Could not compute availability." };
  }
}
