// supabase/functions/_shared/agent-callers/runtime.ts
// Supabase-backed ports for engine.ts. Every method fails SAFE (see engine.ts `safe`): a DB error becomes
// "a team member will follow up", never an invented answer.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { commitCapacityBooking, getAvailability } from "../booking/capacityBooking.ts";
import { formatSlotLocal } from "../booking/capacityEngine.ts";
import { spreadSlots } from "../booking/voiceBooking.ts";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import { sendEmail } from "../notify/deliver.ts";
import { evaluateAddress, loadTenantServiceAreas } from "../service-areas/resolve.ts";
import type { PriceItemLite } from "../price-book/match.ts";
import { EMPTY_STATE, type CallContext, type Ports, type SessionState } from "./engine.ts";
import type { Coverage, OfferedWindow } from "./protocol.ts";
import { callerKey } from "./safety.ts";
import { normalizeAgentCallerSettings, type AgentCallerSettings } from "./settings.ts";
import type { AgentEventType } from "./funnel.ts";

export async function loadAgentSettings(admin: SupabaseClient, userId: string): Promise<AgentCallerSettings> {
  try {
    const { data } = await admin.from("agent_caller_settings").select("*").eq("user_id", userId).maybeSingle();
    return normalizeAgentCallerSettings(data as Record<string, unknown> | null);
  } catch {
    return normalizeAgentCallerSettings(null); // feature off
  }
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RuntimeArgs {
  admin: SupabaseClient;
  userId: string;
  vapiCallId: string;
  callerNumber: string | null;
  ctx: CallContext;
  callId?: string | null;
}

/** Loads (or creates) the per-call session row and returns ports bound to it. */
export async function buildPorts(a: RuntimeArgs): Promise<Ports> {
  const { admin, userId, vapiCallId } = a;
  const key = await callerKey(userId, a.callerNumber);
  let sessionId: string | null = null;
  let cached: SessionState | null = null;
  let tz = "UTC"; // set by windows(); alternatives are labelled in the business timezone

  async function session(): Promise<string | null> {
    if (sessionId) return sessionId;
    const { data } = await admin
      .from("agent_caller_sessions")
      .upsert({ user_id: userId, vapi_call_id: vapiCallId, caller_key: key, call_id: a.callId ?? null }, { onConflict: "user_id,vapi_call_id", ignoreDuplicates: false })
      .select("id, state")
      .maybeSingle();
    sessionId = (data?.id as string | undefined) ?? null;
    if (data?.state && typeof data.state === "object") cached = { ...EMPTY_STATE, ...(data.state as Partial<SessionState>) };
    return sessionId;
  }

  return {
    async loadState() {
      await session();
      if (cached) return structuredClone(cached);
      const { data } = await admin.from("agent_caller_sessions").select("state").eq("user_id", userId).eq("vapi_call_id", vapiCallId).maybeSingle();
      cached = { ...EMPTY_STATE, ...((data?.state as Partial<SessionState> | undefined) ?? {}) };
      return structuredClone(cached);
    },
    async saveState(s) {
      cached = structuredClone(s);
      const d = s.detection;
      await admin.from("agent_caller_sessions").update({
        state: s, kind: d?.kind ?? null, confidence: d?.confidence ?? null, platform_claimed: d?.platformClaimed ?? null, updated_at: new Date().toISOString(),
      }).eq("user_id", userId).eq("vapi_call_id", vapiCallId);
    },
    async recordEvent(type: AgentEventType, detail = {}) {
      const sid = await session();
      await admin.from("agent_caller_events").insert({ user_id: userId, session_id: sid, vapi_call_id: vapiCallId, caller_key: key, event_type: type, detail });
    },
    async loadPriceItems() {
      const { data } = await admin
        .from("price_book_items")
        .select("id, service_name, category, pricing_model, price_cents, price_max_cents, unit_label, keywords, agent_quotable")
        .eq("user_id", userId)
        .eq("active", true);
      return (data ?? []) as PriceItemLite[];
    },
    async coverage(zip): Promise<Coverage> {
      const areas = await loadTenantServiceAreas(admin, userId);
      const verdict = await evaluateAddress(areas, zip);
      if (verdict.status === "in_area") return { status: "in_area", travelFeeCents: typeof verdict.area.travel_fee_cents === "number" ? verdict.area.travel_fee_cents : null };
      if (verdict.status === "out_of_area") return { status: "out_of_area", travelFeeCents: null };
      return { status: verdict.status === "no_areas_configured" ? "no_areas_configured" : "unknown", travelFeeCents: null };
    },
    async windows(service, zip): Promise<OfferedWindow[] | null> {
      const out = await getAvailability(admin, userId, { serviceType: service, address: zip }, { maxOffered: 40 });
      if (!out.enabled) return null;
      tz = out.loaded.ctx.timezone;
      return spreadSlots(out.result.slots, tz, 3, 1).map((s, i) => ({ id: (["W1", "W2", "W3"] as const)[i], label: formatSlotLocal(Date.parse(s.start), tz), startIso: new Date(s.start).toISOString() }));
    },
    async abuseCounts() {
      const { data } = await admin.rpc("agent_caller_counts", { p_user: userId, p_caller_key: key, p_dest_key: null });
      const c = (data ?? {}) as Record<string, number>;
      return { callerQuotes24h: c.caller_quotes_24h ?? 0, callerDistinctServices24h: c.caller_services_24h ?? 0, callerDistinctZips24h: c.caller_zips_24h ?? 0, tenantQuotes1h: c.tenant_quotes_1h ?? 0 };
    },
    async holdsToday() {
      const { data } = await admin.rpc("agent_caller_counts", { p_user: userId, p_caller_key: key, p_dest_key: null });
      return Number((data as Record<string, number> | null)?.holds_24h ?? 0);
    },
    async summaryCounts(destination) {
      const { data } = await admin.rpc("agent_caller_counts", { p_user: userId, p_caller_key: key, p_dest_key: await sha(`${userId}|${destination}`) });
      const c = (data ?? {}) as Record<string, number>;
      return { toDestination24h: c.dest_summaries_24h ?? 0, tenant24h: c.tenant_summaries_24h ?? 0 };
    },
    async commit({ window, service, zip, mode, code, expiresAtIso }) {
      const out = await commitCapacityBooking(admin, userId, {
        serviceType: service, address: zip, startMs: Date.parse(window.startIso), customerName: "AI agent lead",
        notes: `AI agent caller (${mode === "hold" ? "hold" : "booking"} ${code})`, channel: "ai_agent",
      });
      if (out.status === "unavailable") return { status: "unavailable", alternatives: out.alternatives.map((s) => formatSlotLocal(Date.parse(s.start), tz)) };
      if (out.status !== "booked") return { status: "error" };
      const note = mode === "hold" ? `AI AGENT HOLD ${code} — pending owner approval. ` : `AI agent booking ${code}. `;
      await admin.from("jobs").update({ dispatch_note: note }).eq("id", out.jobId).eq("user_id", userId);
      const { error } = await admin.from("agent_holds").insert({
        user_id: userId, vapi_call_id: vapiCallId, call_id: a.callId ?? null, job_id: out.jobId, code,
        status: mode === "hold" ? "held" : "confirmed", mode, service, zip, window_start: window.startIso, expires_at: expiresAtIso,
        platform_claimed: cached?.detection?.platformClaimed ?? null,
      });
      if (error) {
        // The slot is reserved but untracked: release it rather than leave an orphan the sweeper cannot see.
        await admin.from("jobs").update({ job_status: "cancelled" }).eq("id", out.jobId).eq("user_id", userId).eq("job_status", "scheduled");
        return { status: "error" };
      }
      return { status: "ok" };
    },
    async sendSms(to, body) {
      const r = await sendCompliantSms(admin, userId, to, body, { purpose: "service", source: "agent_caller_summary" });
      return r.ok;
    },
    async sendEmail(to, subject, text, html) {
      return (await sendEmail(to, subject, html, text)).ok;
    },
    now: () => new Date(),
    random: () => crypto.getRandomValues(new Uint8Array(6)),
  };
}
