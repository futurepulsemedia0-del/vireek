// Edge-runtime glue for voice resilience (Deno). Thin, defensive: every helper FAILS OPEN toward "keep answering calls".

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { findEscalationTarget, isValidE164 } from "../voice-hardening/escalation.ts";
import { sendWithFailover, telnyxSms, twilioSms } from "./adapters.ts";
import type { Capability, SmsPort } from "./providers.ts";
import { selectProvider } from "./providers.ts";
import type { Level } from "./ladder.ts";

type Admin = SupabaseClient;

export function recordOutcome(admin: Admin, o: { providerId: string; capability: Capability; ok: boolean; latencyMs?: number; errorCode?: string; userId?: string | null }): Promise<void> {
  return Promise.resolve(
    admin.from("voice_provider_outcomes").insert({
      provider_id: o.providerId, capability: o.capability, ok: o.ok, latency_ms: o.latencyMs ?? null, error_code: o.errorCode ?? null, user_id: o.userId ?? null,
    }),
  ).then(() => undefined, () => undefined); // never let telemetry break a call
}

/** Chaos faults are honored ONLY in an environment that explicitly sets VOICE_CHAOS_ENABLED=true (staging). */
export async function activeChaos(admin: Admin): Promise<Set<string>> {
  if (Deno.env.get("VOICE_CHAOS_ENABLED") !== "true") return new Set();
  try {
    const { data } = await admin.from("voice_chaos_flags").select("fault, until").eq("active", true);
    const now = Date.now();
    return new Set((data ?? []).filter((r: { until: string | null }) => !r.until || Date.parse(r.until) > now).map((r: { fault: string }) => r.fault));
  } catch {
    return new Set();
  }
}

export interface EffectiveLevel { level: Level; source: "org_forced" | "platform" | "default"; }

export async function effectiveLevel(admin: Admin, userId: string, now = Date.now()): Promise<EffectiveLevel> {
  try {
    const [{ data: org }, { data: plat }] = await Promise.all([
      admin.from("voice_org_resilience").select("forced_level, forced_until").eq("user_id", userId).maybeSingle(),
      admin.from("voice_ladder_state").select("level, pin_level, pin_until").eq("scope", "platform").maybeSingle(),
    ]);
    if (org?.forced_level != null && (!org.forced_until || Date.parse(org.forced_until) > now)) return { level: org.forced_level as Level, source: "org_forced" };
    if (plat) {
      const pinned = plat.pin_level != null && plat.pin_until && Date.parse(plat.pin_until) > now;
      return { level: (pinned ? plat.pin_level : plat.level) as Level, source: "platform" };
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "voice_effective_level_failed_open", error: e instanceof Error ? e.message : String(e) }));
  }
  return { level: 0, source: "default" };
}

export interface OrgContact { businessName: string; ownerPhone: string | null; forwardTargets: string[]; language: "en" | "es"; staticMessage?: string; callerId?: string }

export async function loadOrgContact(admin: Admin, userId: string): Promise<OrgContact> {
  const [{ data: prof }, { data: bp }, { data: org }] = await Promise.all([
    admin.from("profiles").select("company_name, phone, forwarding_number").eq("id", userId).maybeSingle(),
    admin.from("business_profile").select("escalation_rules").eq("user_id", userId).maybeSingle(),
    admin.from("voice_org_resilience").select("forward_numbers, language, static_message").eq("user_id", userId).maybeSingle(),
  ]);
  const rules = (bp?.escalation_rules ?? null) as Parameters<typeof findEscalationTarget>[0];
  const raw = [...((org?.forward_numbers ?? []) as string[]), findEscalationTarget(rules, "emergency"), prof?.forwarding_number, prof?.phone];
  const targets = [...new Set(raw.filter((n): n is string => isValidE164(n)))].slice(0, 5);
  return {
    businessName: (prof?.company_name as string | null) || "the office",
    ownerPhone: targets[0] ?? null,
    forwardTargets: targets,
    language: org?.language === "es" ? "es" : "en",
    staticMessage: (org?.static_message as string | null) ?? undefined,
  };
}

export async function smsPorts(admin: Admin, callKey: string, userId?: string | null): Promise<SmsPort[]> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN"), from = Deno.env.get("TWILIO_FROM_NUMBER");
  const tk = Deno.env.get("TELNYX_API_KEY"), tfrom = Deno.env.get("TELNYX_FROM_NUMBER");
  const all = new Map<string, SmsPort>();
  if (sid && tok && from) all.set("twilio", twilioSms({ accountSid: sid, authToken: tok, from }));
  if (tk && tfrom) all.set("telnyx", telnyxSms({ apiKey: tk, from: tfrom, messagingProfileId: Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? undefined }));
  try {
    const [{ data: provs }, { data: health }, { data: sw }, orgRes] = await Promise.all([
      admin.from("voice_providers").select("provider_id, capability, priority, enabled").eq("capability", "sms"),
      admin.from("voice_provider_health").select("provider_id, capability, state, score").eq("capability", "sms"),
      admin.from("voice_platform_switch").select("force_provider_id, until").eq("capability", "sms").maybeSingle(),
      userId ? admin.from("voice_org_resilience").select("provider_overrides").eq("user_id", userId).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const sel = selectProvider({
      capability: "sms", callKey, now: Date.now(),
      platformSwitch: sw ? { capability: "sms", forceProviderId: String(sw.force_provider_id), until: Date.parse(String(sw.until)) } : null,
      orgOverrides: ((orgRes.data?.provider_overrides ?? []) as { capability: "sms"; mode: "pin" | "prefer" | "block"; providerId: string }[]).filter((o) => o.capability === "sms"),
      providers: (provs ?? []).map((p: Record<string, unknown>) => ({ id: String(p.provider_id), capability: "sms" as const, priority: Number(p.priority), enabled: Boolean(p.enabled) && all.has(String(p.provider_id)) })),
      health: (health ?? []).map((h: Record<string, unknown>) => ({ providerId: String(h.provider_id), capability: "sms" as const, state: h.state as "closed", score: Number(h.score) })),
    });
    const order = [sel.providerId, ...sel.fallbacks].filter((x): x is string => !!x);
    const ports = order.map((id) => all.get(id)).filter((p): p is SmsPort => !!p);
    if (ports.length) return ports;
  } catch { /* fall through to static order */ }
  return [...all.values()];
}

/** SMS with failover + outcome telemetry. Returns false (never throws) so callers can fall back to in-app + push. */
export async function sendOwnerSms(admin: Admin, userId: string | null, to: string, body: string, callKey: string): Promise<boolean> {
  const ports = await smsPorts(admin, callKey, userId);
  const r = await sendWithFailover(ports, { to, body }, (providerId, ok, latencyMs, error) => {
    void recordOutcome(admin, { providerId, capability: "sms", ok, latencyMs, errorCode: error?.slice(0, 60), userId });
  });
  return r.ok;
}

export async function notifyInApp(admin: Admin, userId: string, title: string, message: string, type = "voice_resilience"): Promise<void> {
  try {
    await admin.from("notifications").insert({ user_id: userId, type, title, message, action_url: "/dashboard/calls" });
  } catch { /* best effort */ }
}

export async function loadLadderRouting(admin: Admin, userId: string): Promise<import("./vapiRouting.ts").LadderRouting> {
  const [{ data: org }, contact] = await Promise.all([
    admin.from("voice_org_resilience").select("reduced_assistant_id").eq("user_id", userId).maybeSingle(),
    loadOrgContact(admin, userId),
  ]);
  return { reducedAssistantId: (org?.reduced_assistant_id as string | null) ?? null, forwardTarget: contact.forwardTargets[0] ?? null, language: contact.language };
}

export async function loadReducedAssistantId(admin: Admin, userId: string): Promise<string | null> {
  const { data } = await admin.from("voice_org_resilience").select("reduced_assistant_id").eq("user_id", userId).maybeSingle();
  return (data?.reduced_assistant_id as string | null) ?? null;
}
