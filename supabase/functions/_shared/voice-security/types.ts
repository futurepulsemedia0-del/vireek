// supabase/functions/_shared/voice-security/types.ts
//
// Shared types for the voice-agent security layer. Pure TypeScript: no Deno / npm imports, so every
// module in this folder runs under vitest AND the Supabase edge runtime.

/** What a tool can do. The tier decides who may call it, how often, and with what proof of identity. */
export type RiskTier =
  | "safety" //         emergencies + human hand-off: NEVER blocked (not even in lockdown)
  | "public" //         facts that are the same for every caller (hours, service area, prices)
  | "booking" //        creates a NEW appointment; no existing data is read back
  | "intake" //         write-only capture of what the caller says (claims, vertical intake, membership answer)
  | "sensitive_read" // reads data about an EXISTING customer
  | "record_write" //   changes an EXISTING record
  | "money" //          moves or exposes money
  | "voice_never"; //   must never be done on a voice channel (password/MFA reset, refunds, address/contact/access change)

/** Where the call came from. Derived from the platform (Vapi `call.type`), never from anything the caller says. */
export type CallKind = "inbound" | "outbound" | "web" | "unknown";

/**
 * none      - no usable caller ID
 * caller_id - a caller ID is present. It is a CLAIM (caller ID is trivially spoofable), not proof.
 * step_up   - known details matched AND a one-time code sent to the number on file was entered (fresh, same customer)
 */
export type VerificationLevel = "none" | "caller_id" | "step_up";

/** Tenant- or global-level kill switch. lockdown = safety tools only; restricted = safety + public only. */
export type SecurityMode = "normal" | "restricted" | "lockdown";

export interface CallRef {
  callId: string | null;
  kind: CallKind;
  callerNumber: string | null;
  dialedNumberId: string | null;
}

/** Per-call security state. Persisted server-side (voice_call_security); the model can never write it. */
export interface CallSecurityState {
  customerId: string | null;
  kdPassedAt: number | null; // epoch ms - known details matched
  otpPassedAt: number | null; // epoch ms - one-time code accepted
  kdFails: number;
  restricted: boolean; // anomaly detector tripped: deny everything above "public" for the rest of the call
  locked: boolean; // verification locked out / canary hit: safety tools only
  riskScore: number; // 0..100
  counters: Record<string, number>; // denied, injection, cross_customer, price_probe, unknown_tool, verify_fail, ...
}

export const EMPTY_CALL_STATE: CallSecurityState = Object.freeze({
  customerId: null,
  kdPassedAt: null,
  otpPassedAt: null,
  kdFails: 0,
  restricted: false,
  locked: false,
  riskScore: 0,
  counters: {},
}) as CallSecurityState;

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** One immutable audit row. `detail` must never contain PII, tool arguments, transcripts or secrets. */
export interface AuditRecord {
  kind: string; // e.g. "tool_denied", "verification_started", "canary_hit", "mode_changed"
  severity: Severity;
  callId: string | null;
  tool: string | null;
  decision: "allow" | "deny" | "minimal" | "challenge" | "info";
  code: string; // stable machine-readable reason, e.g. "needs_step_up"
  detail?: Record<string, string | number | boolean | null>;
}
