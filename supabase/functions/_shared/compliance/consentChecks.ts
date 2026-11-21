// supabase/functions/_shared/compliance/consentChecks.ts
//
// I/O side of the pre-contact compliance gate. Decisions live in reassignedNumber.ts and
// revocation.ts (pure, unit-tested); this file loads facts, applies them, and writes the audit log.
//
// Invariants (read before changing anything):
//   1. FAIL CLOSED. Any lookup error, missing provider, timeout or unparseable answer => block.
//   2. NO LOG, NO CONTACT. An "allow" that cannot be written to consent_checks is converted to a
//      retryable block, so there is never a contact without an audit row.
//   3. Revocation is checked FIRST and is never cached: every contact reads the ledger directly.
//   4. Nothing here weakens the existing DNC / quiet-hours / consent checks; it is an additional gate.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decideReassigned,
  loadReassignedConfig,
  resolveAdapter,
  type CachedResult,
  type ReassignedConfig,
  type ReassignedNumberAdapter,
} from "./reassignedNumber.ts";
import { loadRevocationConfig, parseRevocation, type RevocationChannel } from "./revocation.ts";

export type ContactChannel = "call" | "sms" | "email";
type EnvGetter = (key: string) => string | undefined;

export interface GateInput {
  ownerId: string;
  channel: ContactChannel;
  phoneE164?: string | null;
  email?: string | null;
  /** Calling code / feature that asked, for the audit log (e.g. "outbound-dialer"). */
  source: string;
  /** Run the reassigned-number check (voice and SMS to a phone number). Default: true for call/sms. */
  checkReassigned?: boolean;
  /** Date of the consent being relied on. If omitted the latest granted STL consent is used, then `fallbackConsentAt`. */
  consentCapturedAt?: string | null;
  /** Used only when no consent record exists; logged as a fallback so counsel can see it. */
  fallbackConsentAt?: string | null;
}

export type GateResult =
  | { allow: true }
  | { allow: false; reason: string; retryable: boolean };

export interface GateDeps {
  admin: SupabaseClient;
  getEnv: EnvGetter;
  now?: Date;
  adapter?: ReassignedNumberAdapter | null; // injectable for tests
  fetchImpl?: typeof fetch;
}

const SUBJECT_ERR = "INVALID_INPUT";

async function writeCheck(
  admin: SupabaseClient,
  row: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await admin.from("consent_checks").insert(row);
  return !error;
}

function lower(e: string | null | undefined): string | null {
  const v = (e ?? "").trim().toLowerCase();
  return v || null;
}

async function latestGrantedConsentAt(admin: SupabaseClient, owner: string, phone: string): Promise<string | null> {
  const { data, error } = await admin
    .from("speed_to_lead_consents")
    .select("captured_at, granted")
    .eq("account_owner_id", owner)
    .eq("phone_e164", phone)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`consent_lookup_failed: ${error.message}`);
  return data && (data as { granted: boolean }).granted === true ? ((data as { captured_at: string }).captured_at ?? null) : null;
}

async function cachedClear(admin: SupabaseClient, owner: string, phone: string): Promise<CachedResult | null> {
  const { data, error } = await admin
    .from("consent_checks")
    .select("created_at, adapter, provider_status, provider_reference, consent_captured_at")
    .eq("account_owner_id", owner)
    .eq("phone_e164", phone)
    .eq("check_type", "reassigned_number")
    .eq("decision", "allow")
    .eq("provider_status", "not_reassigned")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`cache_lookup_failed: ${error.message}`);
  if (!data) return null;
  const d = data as { created_at: string; adapter: string | null; provider_reference: string | null; consent_captured_at: string | null };
  if (!d.consent_captured_at) return null;
  return {
    status: "not_reassigned",
    adapter: d.adapter ?? "unknown",
    reference: d.provider_reference,
    checkedAt: new Date(d.created_at),
    consentCapturedAt: new Date(d.consent_captured_at).toISOString(),
  };
}

/**
 * Gate to run immediately before a call / SMS / email. Returns allow=false for any doubt.
 * Callers MUST treat allow=false as "do not contact"; when retryable, re-queue instead of failing.
 */
export async function gateContact(input: GateInput, deps: GateDeps): Promise<GateResult> {
  const { admin, getEnv } = deps;
  const now = deps.now ?? new Date();
  const phone = (input.phoneE164 ?? "").trim() || null;
  const email = lower(input.email);
  const base = {
    account_owner_id: input.ownerId,
    phone_e164: phone,
    email,
    channel: input.channel,
    source: input.source.slice(0, 80),
  };

  if (!input.ownerId || (!phone && !email)) return { allow: false, reason: SUBJECT_ERR, retryable: false };

  // 1. Revocation (never cached).
  try {
    const { data, error } = await admin.rpc("consent_revocation_active", { p_owner: input.ownerId, p_phone: phone, p_email: email });
    if (error) throw new Error(error.message);
    if (data === true) {
      await writeCheck(admin, { ...base, check_type: "revocation", decision: "block", reason: "REVOKED", retryable: false });
      return { allow: false, reason: "REVOKED", retryable: false };
    }
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await writeCheck(admin, { ...base, check_type: "revocation", decision: "block", reason: "CHECK_UNAVAILABLE", retryable: true, detail });
    return { allow: false, reason: "CHECK_UNAVAILABLE", retryable: true };
  }

  // 2. Reassigned-number check (voice/SMS only).
  const wantReassigned = (input.checkReassigned ?? true) && !!phone && input.channel !== "email";
  if (!wantReassigned) {
    const ok = await writeCheck(admin, { ...base, check_type: "revocation", decision: "allow", reason: null, retryable: false });
    return ok ? { allow: true } : { allow: false, reason: "AUDIT_LOG_UNAVAILABLE", retryable: true };
  }

  const config: ReassignedConfig = loadReassignedConfig(getEnv);
  let consentAt: string | null = input.consentCapturedAt ?? null;
  let usedFallback = false;
  let cached: CachedResult | null = null;
  try {
    if (!consentAt) consentAt = await latestGrantedConsentAt(admin, input.ownerId, phone!);
    if (!consentAt && input.fallbackConsentAt) {
      consentAt = input.fallbackConsentAt;
      usedFallback = true;
    }
    if (consentAt) cached = await cachedClear(admin, input.ownerId, phone!);
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await writeCheck(admin, { ...base, check_type: "reassigned_number", decision: "block", reason: "CHECK_UNAVAILABLE", retryable: true, detail });
    return { allow: false, reason: "CHECK_UNAVAILABLE", retryable: true };
  }

  if (!consentAt && config.mode !== "off") {
    await writeCheck(admin, {
      ...base, check_type: "reassigned_number", decision: "block", reason: "NO_CONSENT_DATE", retryable: false,
      detail: "no consent timestamp available to run the reassigned-number check against",
    });
    return { allow: false, reason: "NO_CONSENT_DATE", retryable: false };
  }

  const adapter = deps.adapter !== undefined ? deps.adapter : resolveAdapter(config, deps.fetchImpl);
  const decision = await decideReassigned(
    { phoneE164: phone!, consentCapturedAt: consentAt ?? now.toISOString() },
    { adapter, config, now, cached },
  );

  const common = {
    ...base,
    check_type: "reassigned_number",
    adapter: decision.adapter,
    provider_status: decision.status,
    provider_reference: decision.reference,
    consent_captured_at: consentAt,
  };

  if (decision.allow) {
    const ok = await writeCheck(admin, {
      ...common, decision: "allow", reason: decision.source === "mode_off" ? "MODE_OFF" : null, retryable: false,
      detail: usedFallback ? "consent date is a caller-supplied fallback [COUNSEL]" : decision.source === "cache" ? "reused recent clear result" : null,
    });
    return ok ? { allow: true } : { allow: false, reason: "AUDIT_LOG_UNAVAILABLE", retryable: true };
  }

  await writeCheck(admin, { ...common, decision: "block", reason: decision.reason, retryable: decision.retryable, detail: decision.detail.slice(0, 300) });
  return { allow: false, reason: decision.reason, retryable: decision.retryable };
}

// ---------------------------------------------------------------------------
// Inbound revocation (SMS / voice / email)
// ---------------------------------------------------------------------------

export interface InboundRevocationInput {
  ownerId: string;
  channel: RevocationChannel;
  text: string | null | undefined;
  subject?: string | null;
  structured?: Record<string, unknown> | null;
  phoneE164?: string | null;
  email?: string | null;
  /** Idempotency key: provider message SID / call id / email Message-ID. */
  sourceRef?: string | null;
  source: string;
}

export interface InboundRevocationResult {
  revoked: boolean;
  recorded: boolean;
  revocationId: string | null;
  matched: string | null;
  error?: string;
}

/**
 * Parses an inbound message and, if it is a revocation, records it and fans out.
 * Returns recorded=false with an error when a revocation was detected but could NOT be stored:
 * callers must surface that (log + alert) because it is the one case a revocation can be lost.
 */
export async function recordInboundRevocation(input: InboundRevocationInput, deps: Pick<GateDeps, "admin" | "getEnv">): Promise<InboundRevocationResult> {
  const sig = parseRevocation({ channel: input.channel, text: input.text, subject: input.subject, structured: input.structured });
  if (!sig.revoked) return { revoked: false, recorded: false, revocationId: null, matched: null };

  const phone = (input.phoneE164 ?? "").trim() || null;
  const email = lower(input.email);
  if (!phone && !email) return { revoked: true, recorded: false, revocationId: null, matched: sig.matched, error: "no_subject" };

  const cfg = loadRevocationConfig(deps.getEnv);
  const { data, error } = await deps.admin.rpc("consent_record_revocation", {
    p_owner: input.ownerId,
    p_phone: phone,
    p_email: email,
    p_channel: input.channel,
    p_scope: cfg.scope,
    p_match_kind: sig.matchKind,
    p_matched: sig.matched,
    p_wrong_number: sig.wrongNumber,
    p_source: input.source.slice(0, 80),
    p_source_ref: input.sourceRef ? input.sourceRef.slice(0, 200) : null,
    p_window_hours: cfg.windowHours,
  });
  if (error) return { revoked: true, recorded: false, revocationId: null, matched: sig.matched, error: error.message.slice(0, 200) };
  return { revoked: true, recorded: true, revocationId: (data as string | null) ?? null, matched: sig.matched };
}
