// supabase/functions/_shared/lead-marketplace/types.ts
//
// Pure types + constants shared by the parsers, the auto-responder and the
// ingestion pipeline. No Deno / npm imports here on purpose: everything in
// this folder except runtime.ts and emailEntry.ts runs unchanged under
// vitest, which is how the parsers and the pipeline are unit-tested.

export const MARKETPLACE_PROVIDERS = ["angi", "homeadvisor", "thumbtack", "nextdoor", "google_lsa"] as const;
export type MarketplaceProvider = (typeof MARKETPLACE_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<MarketplaceProvider, string> = {
  angi: "Angi",
  homeadvisor: "HomeAdvisor",
  thumbtack: "Thumbtack",
  nextdoor: "Nextdoor",
  google_lsa: "Google Local Services",
};

export function isMarketplaceProvider(value: unknown): value is MarketplaceProvider {
  return typeof value === "string" && (MARKETPLACE_PROVIDERS as readonly string[]).includes(value);
}

/** Contract: first response to a marketplace lead within this many ms of receipt. */
export const SLA_MS = 60_000;

export interface ParsedLead {
  provider: MarketplaceProvider;
  externalId: string | null;
  name: string | null;
  /** E.164-style, e.g. +15551234567 */
  phone: string | null;
  email: string | null;
  service: string | null;
  location: string | null;
  message: string | null;
  costCents: number | null;
  /** Non-fatal observations (heuristic phone scan, suspicious cost, ...). Shown in the UI. */
  warnings: string[];
}

export type ParseFailureReason = "invalid_payload" | "no_recognized_fields" | "unrecognized_sender";

export type ParseResult =
  | { ok: true; lead: ParsedLead }
  | { ok: false; reason: ParseFailureReason; detail: string };

export type AutoRespondStatus =
  | "pending"
  | "sent"
  | "failed"
  | "deferred_quiet_hours"
  | "skipped_disabled"
  | "skipped_no_contact"
  | "not_applicable";

export interface SourceRow {
  id: string;
  user_id: string;
  provider: MarketplaceProvider;
  enabled: boolean;
  auto_respond_enabled: boolean;
  default_cost_cents: number | null;
  booking_url: string | null;
  timezone: string;
  sms_quiet_hours: boolean;
}

export interface EventRow {
  id: string;
  user_id: string;
  provider: MarketplaceProvider;
  lead_id: string | null;
  status: "received" | "lead_created" | "parse_failed" | "error";
  auto_respond_status: AutoRespondStatus;
  attempt_count: number;
  received_at: string; // ISO
  parsed: ParsedLead | null;
}

export interface NewEvent {
  user_id: string;
  source_id: string;
  provider: MarketplaceProvider;
  received_via: "webhook" | "email";
  dedupe_key: string | null;
  external_id: string | null;
  parsed: ParsedLead;
  raw_payload: string;
  cost_cents: number | null;
  cost_source: "parsed" | "default" | null;
  received_at: string; // ISO
}

export interface NewFailedEvent {
  user_id: string;
  source_id: string;
  provider: MarketplaceProvider;
  received_via: "webhook" | "email";
  parse_error: string;
  raw_payload: string;
  received_at: string;
}

export interface NewLead {
  user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  service_interested: string | null;
  notes: string | null;
  stage: "new";
  source: MarketplaceProvider;
  source_cost_cents: number | null;
  source_external_id: string | null;
}

export interface EventPatch {
  status?: EventRow["status"];
  lead_id?: string;
  auto_respond_status?: AutoRespondStatus;
  auto_respond_channel?: string | null;
  auto_respond_error?: string | null;
  auto_respond_ai?: boolean;
  responded_at?: string;
  response_ms?: number;
  parse_error?: string | null;
}

export interface TenantInfo {
  companyName: string | null;
  /** "<token>@<INBOUND_EMAIL_DOMAIN>" so customer replies route back into the inbox. */
  replyToAlias: string | null;
}

export interface IngestStore {
  getSourceByToken(token: string): Promise<SourceRow | null>;
  getSource(userId: string, provider: MarketplaceProvider): Promise<SourceRow | null>;
  getTenant(userId: string): Promise<TenantInfo>;
  /** Insert, or return the existing row when (user_id, dedupe_key) already exists. */
  insertEvent(row: NewEvent): Promise<{ created: boolean; event: EventRow }>;
  insertFailedEvent(row: NewFailedEvent): Promise<void>;
  updateEvent(id: string, patch: EventPatch): Promise<void>;
  /** Atomically bump attempt_count iff it still equals `expected`. false = someone else claimed it. */
  claimEvent(id: string, expected: number): Promise<boolean>;
  insertLead(row: NewLead): Promise<string>;
  markLeadResponded(leadId: string, atIso: string): Promise<void>;
  /** Events needing another auto-response attempt (pending > 90 s old, failed, deferred). */
  listRetryable(nowMs: number, limit: number): Promise<EventRow[]>;
  purgeRawPayloads(olderThanIso: string): Promise<void>;
}

export type SendResult = { ok: true } | { ok: false; reason: string; detail?: string };

export interface Responders {
  sendSms(userId: string, to: string, body: string): Promise<SendResult>;
  sendEmail(args: {
    userId: string;
    to: string;
    subject: string;
    text: string;
    replyTo: string | null;
    fromName: string | null;
  }): Promise<SendResult>;
  /** Optional. Returns a candidate SMS body or null; the caller validates it and falls back to the template. */
  composeAiSms?(args: { extraInstructions: string; userContent: string; timeoutMs: number }): Promise<string | null>;
  now(): number;
}
