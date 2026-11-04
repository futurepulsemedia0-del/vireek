// supabase/functions/_shared/voice-security/verifyTools.ts
//
// The two tools that let a caller step up: request_verification (texts a one-time code to the number ON FILE)
// and verify_caller (code + known details). Pure orchestration over ports so it is fully testable; the Supabase /
// Twilio wiring is in ports.ts.
//
// Anti-enumeration: every response is identical whether or not an account exists, and a failed check never says
// WHICH factor failed. The model never receives the code, the record, or the stored values.

import {
  generateOtp, matchKnownDetails, normalizeSpokenCode, otpDigest, MAX_CHALLENGES_PER_CALL, MAX_CHALLENGES_PER_NUMBER_DAY, MAX_KNOWN_DETAIL_FAILS, MAX_OTP_ATTEMPTS, OTP_TTL_SECONDS,
  computeLevel,
} from "./stepUp.ts";
import type { AuditRecord, CallRef, CallSecurityState } from "./types.ts";

export interface CustomerOnFile { id: string; name: string | null; address: string | null; phone: string | null }

export interface VerificationPorts {
  nowMs(): number;
  /** Server secret used to bind OTP digests (VOICE_OTP_HMAC_SECRET). */
  secret: string;
  findCustomerByPhone(tenantId: string, callerNumber: string): Promise<CustomerOnFile | null>;
  getCallState(tenantId: string, call: CallRef): Promise<CallSecurityState>;
  issueChallenge(a: { tenantId: string; callId: string; customerId: string; digest: string; callerHash: string; ttlSeconds: number; maxPerCall: number; maxPerNumberDay: number }): Promise<{ ok: boolean; reason: string }>;
  checkChallenge(a: { tenantId: string; callId: string; digest: string; maxAttempts: number }): Promise<{ ok: boolean; reason: string; customerId?: string }>;
  recordKnownDetails(a: { tenantId: string; callId: string; customerId: string; passed: boolean; maxFails: number }): Promise<{ locked: boolean }>;
  /** Sends to the number ON FILE, never to a number the caller supplies. Resolves true when queued/sent. */
  sendSms(tenantId: string, to: string, body: string, customerId: string): Promise<boolean>;
  hmac(message: string): Promise<string>;
  audit(tenantId: string, rec: AuditRecord): Promise<void>;
}

const SENT = "If an account matches this number, a 6-digit code has been texted to the number on file. Ask the caller to read it out, together with two details on file (for example the ZIP code and last name), then call verify_caller. Do not confirm whether an account exists.";
const UNAVAILABLE = "Verification isn't available on this call. Tell the caller the office will call them back on the number on file, and offer to transfer them to a team member.";
const NOT_VERIFIED = "That could not be verified. Do not say which part was wrong and do not reveal any account details. The caller may try once more; otherwise offer a callback from the office or a transfer to a team member.";
const NEED_BOTH = "Verification needs both the one-time code and two details on file. Ask the caller for what is still missing, then call verify_caller again.";
const VERIFIED = "The caller is verified for the next 15 minutes. You may now share and change their own account details, one request at a time, confirming each change back to them.";

const auditRec = (kind: string, code: string, call: CallRef, decision: AuditRecord["decision"], severity: AuditRecord["severity"] = "info", detail?: AuditRecord["detail"]): AuditRecord =>
  ({ kind, severity, callId: call.callId, tool: kind.startsWith("verify") ? "verify_caller" : "request_verification", decision, code, detail });

export async function requestVerification(p: VerificationPorts, tenantId: string, call: CallRef): Promise<string> {
  if (!call.callId || !call.callerNumber) return UNAVAILABLE;
  const state = await p.getCallState(tenantId, call);
  if (state.locked) return UNAVAILABLE;

  const customer = await p.findCustomerByPhone(tenantId, call.callerNumber);
  const callerHash = await p.hmac(`caller|${call.callerNumber.replace(/\D/g, "").slice(-10)}`);
  if (!customer?.phone) {
    // Same answer as the success path: no account enumeration. Nothing is sent.
    await p.audit(tenantId, auditRec("verification_started", "no_account", call, "info"));
    return SENT;
  }

  const code = generateOtp();
  const digest = await otpDigest(p.secret, { userId: tenantId, callId: call.callId, customerId: customer.id, code });
  const issued = await p.issueChallenge({ tenantId, callId: call.callId, customerId: customer.id, digest, callerHash, ttlSeconds: OTP_TTL_SECONDS, maxPerCall: MAX_CHALLENGES_PER_CALL, maxPerNumberDay: MAX_CHALLENGES_PER_NUMBER_DAY });
  if (!issued.ok) {
    await p.audit(tenantId, auditRec("verification_started", issued.reason, call, "deny", "medium"));
    return UNAVAILABLE;
  }
  const sent = await p.sendSms(tenantId, customer.phone, `Your verification code is ${code}. It expires in 5 minutes. Never share it with anyone who calls you.`, customer.id);
  await p.audit(tenantId, auditRec("verification_started", sent ? "otp_sent" : "otp_send_failed", call, sent ? "challenge" : "deny", sent ? "info" : "medium"));
  return sent ? SENT : UNAVAILABLE;
}

export interface VerifyArgs { code?: string; zip?: string; street_number?: string; last_name?: string }

export async function completeVerification(p: VerificationPorts, tenantId: string, call: CallRef, args: VerifyArgs): Promise<string> {
  if (!call.callId || !call.callerNumber) return UNAVAILABLE;
  const state = await p.getCallState(tenantId, call);
  if (state.locked) return UNAVAILABLE;

  const customer = await p.findCustomerByPhone(tenantId, call.callerNumber);
  const detailsGiven = Boolean(args.zip || args.street_number || args.last_name);
  const code = args.code ? normalizeSpokenCode(args.code) : null;
  if (!detailsGiven && !args.code) return NEED_BOTH;

  let failed = false;
  if (!customer) {
    failed = true; // still burn a known-details failure so enumeration by phone number is rate-limited
    await p.recordKnownDetails({ tenantId, callId: call.callId, customerId: "00000000-0000-0000-0000-000000000000", passed: false, maxFails: MAX_KNOWN_DETAIL_FAILS });
  } else {
    if (detailsGiven) {
      const kd = matchKnownDetails(args, customer);
      const r = await p.recordKnownDetails({ tenantId, callId: call.callId, customerId: customer.id, passed: kd.passed, maxFails: MAX_KNOWN_DETAIL_FAILS });
      if (!kd.passed) failed = true;
      if (r.locked) failed = true;
    }
    if (args.code) {
      if (!code) failed = true;
      else {
        const digest = await otpDigest(p.secret, { userId: tenantId, callId: call.callId, customerId: customer.id, code });
        const c = await p.checkChallenge({ tenantId, callId: call.callId, digest, maxAttempts: MAX_OTP_ATTEMPTS });
        if (!c.ok) failed = true;
      }
    }
  }

  if (failed) {
    await p.audit(tenantId, auditRec("verify_failed", "not_verified", call, "deny", "medium"));
    return NOT_VERIFIED;
  }
  const after = await p.getCallState(tenantId, call);
  if (computeLevel(after, call.callerNumber, p.nowMs()) === "step_up") {
    await p.audit(tenantId, auditRec("verify_succeeded", "step_up", call, "allow"));
    return VERIFIED;
  }
  return NEED_BOTH;
}
