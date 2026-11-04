// supabase/functions/_shared/voice-security/ports.ts
//
// Production implementation of the gate / verification ports over Supabase RPCs
// (supabase/migrations/20280501000000_voice_security_controls.sql). The in-memory twin used by tests and the
// red-team harness is memoryPorts.ts. Type-only imports from npm: so this file also loads under vitest.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { PendingResult, StateDelta, VoiceSecurityPorts } from "./gate.ts";
import { hmacHex } from "./stepUp.ts";
import type { CustomerOnFile, VerificationPorts } from "./verifyTools.ts";
import type { AuditRecord, CallRef, CallSecurityState, SecurityMode } from "./types.ts";
import { EMPTY_CALL_STATE } from "./types.ts";
import { canaryFromDigest, type InjectionScanner } from "./outputFilter.ts";

export interface SupabasePortsOptions {
  /** VOICE_OTP_HMAC_SECRET: at least 32 random chars. Binds OTP digests, caller hashes, parameter hashes, canaries. */
  secret: string;
  scanInjection: InjectionScanner;
  /** Sends via the existing compliant SMS path (A2P approval, opt-out, quiet hours). */
  sendSms: (tenantId: string, to: string, body: string, customerId: string) => Promise<boolean>;
}

type Rpc = { data: unknown; error: { message: string } | null };

export function createSupabasePorts(admin: SupabaseClient, o: SupabasePortsOptions): VoiceSecurityPorts & VerificationPorts {
  if (!o.secret || o.secret.length < 32) throw new Error("VOICE_OTP_HMAC_SECRET must be at least 32 characters");

  const rpc = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = (await admin.rpc(fn, args)) as Rpc;
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const hm = (m: string) => hmacHex(o.secret, m);

  return {
    secret: o.secret,
    nowMs: () => Date.now(),
    hmac: hm,
    scanInjection: o.scanInjection,

    async getMode(tenantId): Promise<SecurityMode> {
      const m = await rpc("voice_get_mode", { p_user_id: tenantId });
      return m === "restricted" || m === "lockdown" ? m : "normal";
    },

    async getCallState(tenantId, call: CallRef): Promise<CallSecurityState> {
      if (!call.callId) return { ...EMPTY_CALL_STATE, counters: {} };
      const d = obj(await rpc("voice_call_state_get", { p_user_id: tenantId, p_call_id: call.callId }));
      const num = (x: unknown) => (typeof x === "number" ? x : null);
      return {
        customerId: typeof d.customerId === "string" ? d.customerId : null,
        kdPassedAt: num(d.kdPassedAt),
        otpPassedAt: num(d.otpPassedAt),
        kdFails: num(d.kdFails) ?? 0,
        restricted: d.restricted === true,
        locked: d.locked === true,
        riskScore: num(d.riskScore) ?? 0,
        counters: Object.fromEntries(Object.entries(obj(d.counters)).filter(([, v]) => typeof v === "number")) as Record<string, number>,
      };
    },

    async bumpCallState(tenantId, call, d: StateDelta) {
      if (!call.callId) return;
      await rpc("voice_call_state_bump", { p_user_id: tenantId, p_call_id: call.callId, p_counters: d.counters ?? {}, p_risk: d.risk ?? 0, p_restricted: d.restricted ?? false, p_locked: d.locked ?? false });
    },

    async rateConsume(tenantId, key, limit, windowSeconds) {
      return (await rpc("voice_rate_consume", { p_user_id: tenantId, p_key: key, p_limit: limit, p_window_seconds: windowSeconds })) === true;
    },

    async audit(tenantId, rec: AuditRecord) {
      try {
        const detail: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(rec.detail ?? {}).slice(0, 12)) detail[k.slice(0, 32)] = typeof v === "string" ? v.slice(0, 120) : v;
        await rpc("voice_audit_append", { p_user_id: tenantId, p_kind: rec.kind, p_severity: rec.severity, p_call_id: rec.callId, p_tool: rec.tool, p_decision: rec.decision, p_code: rec.code, p_detail: detail });
      } catch (e) {
        // Auditing must never break a call; the failure itself is visible in the function logs.
        console.error(JSON.stringify({ event: "voice_audit_failed", kind: rec.kind, error: e instanceof Error ? e.message : String(e) }));
      }
    },

    async isCanary(tenantId, values) {
      const variants = new Set<string>();
      for (const raw of values) {
        const v = raw.trim().toLowerCase();
        if (!v) continue;
        variants.add(v);
        variants.add(v.replace(/[^a-z0-9]/g, ""));
        const digits = v.replace(/\D/g, "");
        if (digits.length >= 10) variants.add(digits.slice(-10));
      }
      if (!variants.size) return false;
      const digests = await Promise.all([...variants].map((x) => hm(`canary|${x}`)));
      return (await rpc("voice_canary_hit", { p_user_id: tenantId, p_digests: digests })) === true;
    },

    async pendingCreate(tenantId, callId, tool, paramsHash, summary, ttlSeconds) {
      const id = await rpc("voice_pending_create", { p_user_id: tenantId, p_call_id: callId, p_tool: tool, p_params_hash: paramsHash, p_summary: summary, p_ttl_seconds: ttlSeconds });
      if (typeof id !== "string") throw new Error("voice_pending_create returned no id");
      return id;
    },

    async pendingConsume(tenantId, callId, tool, paramsHash, id, minAgeMs): Promise<PendingResult> {
      const r = await rpc("voice_pending_consume", { p_user_id: tenantId, p_call_id: callId, p_tool: tool, p_params_hash: paramsHash, p_id: id, p_min_age_ms: minAgeMs });
      return r === "ok" || r === "expired" || r === "too_soon" || r === "mismatch" ? r : "missing";
    },

    // ---- verification ----
    async findCustomerByPhone(tenantId, callerNumber): Promise<CustomerOnFile | null> {
      const want = callerNumber.replace(/\D/g, "").slice(-10);
      if (want.length !== 10) return null;
      const { data, error } = await admin.from("customers").select("id, name, address, phone").eq("user_id", tenantId).ilike("phone", `%${want.slice(-4)}`).limit(25);
      if (error) throw new Error(`customers lookup: ${error.message}`);
      const hits = ((data ?? []) as CustomerOnFile[]).filter((c) => (c.phone ?? "").replace(/\D/g, "").slice(-10) === want);
      return hits.length === 1 ? hits[0] : null; // ambiguous (shared number) => treat as no account: never guess whose data it is
    },

    async issueChallenge(a) {
      const r = obj(await rpc("voice_otp_issue", { p_user_id: a.tenantId, p_call_id: a.callId, p_customer_id: a.customerId, p_digest: a.digest, p_caller_hash: a.callerHash, p_ttl_seconds: a.ttlSeconds, p_max_per_call: a.maxPerCall, p_max_per_number_day: a.maxPerNumberDay }));
      return { ok: r.ok === true, reason: String(r.reason ?? "error") };
    },
    async checkChallenge(a) {
      const r = obj(await rpc("voice_otp_check", { p_user_id: a.tenantId, p_call_id: a.callId, p_digest: a.digest, p_max_attempts: a.maxAttempts }));
      return { ok: r.ok === true, reason: String(r.reason ?? "error"), customerId: typeof r.customerId === "string" ? r.customerId : undefined };
    },
    async recordKnownDetails(a) {
      const r = obj(await rpc("voice_kd_record", { p_user_id: a.tenantId, p_call_id: a.callId, p_customer_id: a.customerId, p_passed: a.passed, p_max_fails: a.maxFails }));
      return { locked: r.locked === true };
    },
    sendSms: (tenantId, to, body, customerId) => o.sendSms(tenantId, to, body, customerId),
  };
}

/** Registers a decoy identifier (HMAC digest only is stored). Call from an admin script, see docs/security. */
export async function registerCanary(admin: SupabaseClient, secret: string, tenantId: string, kind: "phone" | "email" | "name" | "address", value: string): Promise<void> {
  const v = value.trim().toLowerCase();
  const norm = kind === "phone" ? v.replace(/\D/g, "").slice(-10) : v.replace(/[^a-z0-9@.]/g, kind === "email" ? "" : "");
  const { error } = await admin.rpc("voice_canary_register", { p_user_id: tenantId, p_kind: kind, p_digest: await hmacHex(secret, `canary|${norm}`) });
  if (error) throw new Error(error.message);
}

/**
 * Prompt canaries for a tenant: current and previous 30-day epoch (so rotation never leaves a leak undetected).
 * The first value is placed in the assistant prompt as {{security_ref}}; any appearance in a transcript, SMS or
 * tool result means the prompt / context was echoed to a caller.
 */
export async function promptCanaries(secret: string, tenantId: string, nowMs: number): Promise<string[]> {
  const epoch = Math.floor(nowMs / (30 * 86_400_000));
  return Promise.all([epoch, epoch - 1].map(async (e) => canaryFromDigest(await hmacHex(secret, `prompt|${tenantId}|${e}`))));
}
