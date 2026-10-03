// supabase/functions/_shared/emergency/startIncident.ts
//
// One call any edge function (escalate-emergency, vapi-webhook, ...) uses to hand an emergency to the
// Autonomous Emergency Network. Safe by construction:
//   * does nothing (returns skipped) unless the owner switched the Emergency Network ON;
//   * idempotent — the same call or the same caller within 30 minutes is one incident;
//   * NEVER throws: the emergency flow that called it must not break because the network layer did.
// The incident is processed within a minute by the cron-driven orchestrator; we also nudge it immediately.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export interface StartIncidentParams {
  userId: string;
  source: "call" | "portal" | "manual" | "api";
  customerName?: string | null;
  customerPhone?: string | null;
  address?: string | null;
  description?: string | null;
  hazards?: string[];
  callId?: string | null;
  customerId?: string | null;
  insuranceInvolved?: boolean;
}

export interface StartIncidentResult {
  started: boolean;
  skipped?: string;
  incidentId?: string;
  existing?: boolean;
  tier?: string;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startEmergencyIncident(admin: SupabaseClient, p: StartIncidentParams): Promise<StartIncidentResult> {
  try {
    const { data, error } = await admin.rpc("create_emergency_incident", {
      p_user_id: p.userId,
      p_source: p.source,
      p_customer_name: p.customerName ?? null,
      p_customer_phone: p.customerPhone ?? null,
      p_address: p.address ?? null,
      p_description: p.description ?? null,
      p_hazards: p.hazards ?? [],
      p_call_id: p.callId && UUID.test(p.callId) ? p.callId : null,
      p_customer_id: p.customerId && UUID.test(p.customerId) ? p.customerId : null,
      p_insurance_involved: p.insuranceInvolved ?? false,
    });
    if (error) throw new Error(error.message);

    const res = (data ?? {}) as { skipped?: boolean; reason?: string; incident_id?: string; existing?: boolean; tier?: string };
    if (res.skipped) return { started: false, skipped: res.reason ?? "skipped" };
    if (!res.incident_id) return { started: false, error: "no incident id returned" };

    // Best-effort immediate processing; the cron picks it up within a minute if this is cut short.
    if (!res.existing) nudge(res.incident_id);
    return { started: true, incidentId: res.incident_id, existing: Boolean(res.existing), tier: res.tier };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "emergency_network_start_failed", user_id: p.userId, error: message }));
    return { started: false, error: message };
  }
}

function nudge(incidentId: string): void {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  const request = fetch(`${url}/functions/v1/emergency-network-orchestrator`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ incident_id: incidentId }),
  }).catch((e) => console.error(JSON.stringify({ event: "emergency_network_nudge_failed", error: String(e) })));
  // Keep the worker alive until the request has been sent (Supabase Edge Runtime).
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(request);
}
