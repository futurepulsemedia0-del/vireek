// supabase/functions/_shared/audit/ports.ts
// Everything the service needs from the outside world, as interfaces. Real implementations: supabaseStore.ts and
// providers.ts. Test/e2e implementations: memoryStore.ts and mock.ts. The service itself has no I/O of its own.

import type { RawCallReport } from "./outcome.ts";
import type {
  AnswerKind, Assumptions, AuditStatus, BusinessHours, CallObservations, CallStatus, Condition, ScoreResult,
} from "./types.ts";
import type { ConsentScope } from "./consentText.ts";

export interface AuditSettings {
  enabled: boolean;
  otp_enabled: boolean;
  calls_enabled: boolean;
  followups_enabled: boolean;
  allowed_countries: string[];
  retention_days: number;
  cooldown_days: number;
  disabled_reason: string | null;
}

export interface VerificationRow {
  id: string;
  phone_e164: string;
  phone_hash: string;
  email: string;
  email_hash: string;
  business_name: string;
  trade: string;
  timezone: string;
  channel: "sms" | "voice";
  ip_hash: string;
  user_agent: string | null;
  provider_ref: string | null;
  otp_consent_text_version: string;
  otp_consent_text_sha256: string;
  status: "pending" | "verified" | "expired" | "locked" | "superseded";
  attempts: number;
  created_at: string;
  expires_at: string;
  verified_at: string | null;
}

export interface AuditRow {
  id: string;
  token_hash: string;
  share_token_hash: string | null;
  verification_id: string | null;
  phone_e164: string;
  phone_hash: string;
  email: string;
  email_hash: string;
  business_name: string;
  trade: string;
  timezone: string;
  business_hours: BusinessHours | null;
  status: AuditStatus;
  followup_opt_in: boolean;
  assumptions: Partial<Assumptions>;
  score: ScoreResult | null;
  cost_cents_reserved: number;
  cost_cents_actual: number;
  created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

export interface CallRow {
  id: string;
  audit_id: string;
  slot: 1 | 2 | 3;
  condition: Condition;
  scheduled_for: string;
  window_end: string;
  status: CallStatus;
  skip_reason: string | null;
  vapi_call_id: string | null;
  claimed_at: string | null;
  placed_at: string | null;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  ended_reason: string | null;
  ring_seconds: number | null;
  duration_seconds: number | null;
  answer_kind: AnswerKind | null;
  observations: CallObservations;
  cost_cents: number;
}

export interface ClaimedCall {
  call_id: string;
  audit_id: string;
  slot: number;
  condition: Condition;
  scheduled_for: string;
  window_end: string;
  phone_e164: string;
  timezone: string;
  business_name: string;
}

export interface ConsentInsert {
  audit_id: string | null;
  verification_id: string | null;
  scope: ConsentScope;
  granted: boolean;
  phone_e164: string;
  phone_hash: string;
  email: string;
  text_version: string;
  text_sha256: string;
  text_snapshot: string;
  captured_at: string;
  ip_address: string | null;
  user_agent: string | null;
  page_url: string | null;
  basis: string;
  evidence: Record<string, unknown>;
  record_sha256: string;
}

export interface EmailJob {
  id: string;
  audit_id: string;
  step: 0 | 1 | 2;
  kind: "transactional" | "followup";
  send_at: string;
  status: "queued" | "sending" | "sent" | "skipped" | "failed";
}

export type BlockKind = "phone_hash" | "email_hash" | "email_domain" | "ip_hash";

export interface AuditStore {
  getSettings(): Promise<AuditSettings>;
  consumeRate(key: string, max: number, windowSeconds: number): Promise<boolean>;
  isBlocked(kind: BlockKind, value: string): Promise<boolean>;
  addBlock(kind: BlockKind, value: string, reason: string): Promise<void>;
  tryStart(): Promise<boolean>;
  reserveDaily(cents: number): Promise<boolean>;
  reserveAudit(auditId: string, cents: number): Promise<"ok" | "audit_cap" | "daily_budget">;
  bump(field: "starts" | "otp_sent" | "calls_placed" | "emails_sent", n?: number): Promise<void>;
  cooldownActive(phoneHash: string): Promise<boolean>;
  claimNumber(phoneHash: string): Promise<boolean>;
  releaseNumber(phoneHash: string): Promise<void>;

  insertVerification(v: VerificationRow): Promise<void>;
  getVerification(id: string): Promise<VerificationRow | null>;
  updateVerification(id: string, patch: Partial<VerificationRow>): Promise<void>;
  supersedePending(phoneHash: string, exceptId: string): Promise<void>;

  createAudit(a: AuditRow): Promise<void>;
  getAuditByTokenHash(hash: string): Promise<AuditRow | null>;
  getAuditByShareHash(hash: string): Promise<AuditRow | null>;
  getAudit(id: string): Promise<AuditRow | null>;
  updateAudit(id: string, patch: Partial<AuditRow>): Promise<void>;
  deleteAudit(id: string): Promise<boolean>;

  insertCalls(rows: CallRow[]): Promise<void>;
  listCalls(auditId: string): Promise<CallRow[]>;
  getCall(id: string): Promise<CallRow | null>;
  getCallByProviderId(providerCallId: string): Promise<CallRow | null>;
  updateCall(id: string, patch: Partial<CallRow>): Promise<void>;
  cancelPendingCalls(auditId: string, reason: string): Promise<number>;
  claimDueCalls(limit: number): Promise<ClaimedCall[]>;
  releaseStuck(): Promise<number>;
  listStaleDialing(placedBeforeIso: string, limit: number): Promise<CallRow[]>;
  completeReady(): Promise<string[]>;

  insertConsent(c: ConsentInsert): Promise<void>;
  hasConsent(auditId: string, scope: ConsentScope): Promise<boolean>;

  addEvent(auditId: string, kind: string, detail?: Record<string, unknown>): Promise<void>;

  queueEmails(rows: Omit<EmailJob, "id" | "status">[]): Promise<void>;
  claimDueEmails(limit: number): Promise<EmailJob[]>;
  finishEmail(id: string, status: "sent" | "skipped" | "failed", info?: { skip_reason?: string; provider_id?: string }): Promise<void>;
  skipQueuedFollowups(auditId: string, reason: string): Promise<void>;
  suppressEmail(emailHash: string, reason: string): Promise<void>;
  isEmailSuppressed(emailHash: string): Promise<boolean>;

  purgeExpired(): Promise<Record<string, number>>;
  benchmark(): Promise<unknown | null>;
}

export interface OtpProvider {
  start(toE164: string, channel: "sms" | "voice"): Promise<{ ref: string | null }>;
  check(toE164: string, code: string, ref: string | null): Promise<boolean>;
}

export type PlaceResult = { ok: true; providerCallId: string } | { ok: false; definitive: boolean; reason: string };

export interface CallProvider {
  place(i: { auditCallId: string; toE164: string; businessName: string }): Promise<PlaceResult>;
  fetchReport(providerCallId: string): Promise<RawCallReport | null>;
}

export interface Mailer {
  send(m: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }): Promise<{ id: string | null }>;
}

export interface LineLookup {
  lookup(e164: string): Promise<{ type: string | null }>;
}

export interface BotCheck {
  verify(token: string, ip: string | null): Promise<boolean>;
}

export interface AuditEnv {
  pepper: string; // hashes of phone/email/ip
  tokenSecret: string; // derives report tokens
  linkSecret: string; // signs unsubscribe links
  baseUrl: string; // https://vireek.com
  functionsUrl: string; // https://<ref>.supabase.co/functions/v1
  postalAddress: string | null; // CAN-SPAM; follow-ups refuse to send without it
  killSwitch: boolean; // AUDIT_KILL_SWITCH=1: instant, no DB needed
  turnstileSiteKey: string | null;
  lookupEnabled: boolean;
}

export interface AuditDeps {
  store: AuditStore;
  otp: OtpProvider;
  calls: CallProvider;
  mailer: Mailer;
  lookup: LineLookup | null;
  bot: BotCheck;
  env: AuditEnv;
  now: () => Date;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  pageUrl: string | null;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}
