// supabase/functions/_shared/tenant-export/portability.ts
//
// Decisions that keep the data-portability promise honest. Read by portability.test.ts (CI) and by the public
// /data-promise page (src/lib/dataPromise.ts). Pure data: no Deno, no I/O.
//
//   PORTABILITY_EXEMPTIONS     every account-owned table (OWNED_TABLES) that is NOT exported, with the reason
//   KNOWN_BEARER_TOKEN_COLUMNS credential-like columns that ARE exported today (the key filter only removes exact names)
//   PORTABILITY_CATEGORIES     what the public page may claim, mapped to the tables that back each claim
//   EXPORT_PARTS_LIVE          what is verified as deployed. Flip `supplement` only after checking a real export.
//
// The script scripts/compliance/export-coverage.mjs reads coverage.ts with regular expressions; this file is NOT parsed by it.

export type ExemptionCategory = "credentials" | "temporary_access" | "no_id_column" | "pending_review";

export interface PortabilityExemption {
  table: string;
  category: ExemptionCategory;
  /** Engineering statement, at least 20 characters. Not a legal conclusion. */
  reason: string;
}

export const PORTABILITY_EXEMPTIONS: readonly PortabilityExemption[] = [
  { table: "integrations", category: "credentials", reason: "Connection settings for third-party services (config may hold credentials). The customer reconnects at the new provider." },
  { table: "lead_marketplace_sources", category: "credentials", reason: "Holds a webhook_token that authorises inbound lead delivery; the export key filter does not remove it. Exporting it would leak a credential." },
  { table: "quote_video_sessions", category: "temporary_access", reason: "Holds live video-room join links (room_url) that expire; meaningless outside the platform and a bearer link while valid." },
  { table: "quote_video_settings", category: "no_id_column", reason: "Keyed by user_id with no id column, so the keyset-paged export cannot read it. Needs a single-row export path." },
  { table: "agent_caller_events", category: "pending_review", reason: "Records about external AI agents calling the business (caller_key, vapi_call_id). Content not yet reviewed for third-party personal data." },
  { table: "agent_caller_sessions", category: "pending_review", reason: "Records about external AI agents calling the business (caller_key, vapi_call_id). Content not yet reviewed for third-party personal data." },
];

/**
 * Credential-like columns exported today. The export removes only the exact keys password, secret, token, access_token,
 * refresh_token, api_key, signing_secret, so these bearer-style link tokens are in the files. Each one lets whoever holds
 * the file open the matching customer-facing page. The test fails on any NEW credential-like column so it must be decided.
 * [DECISION] strip them, or document the risk in the export README. Until decided they are listed here.
 */
export const KNOWN_BEARER_TOKEN_COLUMNS: readonly string[] = [
  "customers.portal_token",
  "jobs.reschedule_token",
  "invoices.invoice_token",
  "invoices.trashed_token",
  "quotes.quote_token",
  "quotes.trashed_token",
  "payment_requests.public_token",
  "membership_renewal_cycles.quote_token",
  "review_requests.review_token",
];

export interface PortabilityCategory {
  id: "accounts" | "customers" | "customer_details" | "jobs" | "job_details" | "calls" | "recordings" | "documents";
  label: string;
  description: string;
  /** Tables that back the claim. Every one must be in TABLES (core) or SUPPLEMENTARY_TABLES. */
  tables: readonly string[];
  /** For "recordings": the column that carries the link, and the table it lives in. */
  column?: { table: string; name: string };
}

export const PORTABILITY_CATEGORIES: readonly PortabilityCategory[] = [
  { id: "accounts", label: "Account and business profile", description: "Your business profile and settings stored for your account.", tables: ["business_profile"] },
  { id: "customers", label: "Customers", description: "Customer records.", tables: ["customers"] },
  { id: "customer_details", label: "Customer sites, contacts and notes", description: "Service sites, extra contacts and notes attached to customers.", tables: ["customer_sites", "customer_contacts", "customer_notes"] },
  { id: "jobs", label: "Jobs and invoices", description: "Jobs and invoices.", tables: ["jobs", "invoices"] },
  { id: "job_details", label: "Job line items, parts and payments", description: "Line items, required parts and payments recorded on jobs.", tables: ["job_line_items", "job_parts_required", "job_payments"] },
  { id: "calls", label: "Call records", description: "Call metadata such as who called, when, how long and the outcome.", tables: ["calls"] },
  { id: "recordings", label: "Links to call recordings", description: "The link stored with each call. The audio files themselves are not inside the archive.", tables: ["calls"], column: { table: "calls", name: "recording_url" } },
  { id: "documents", label: "Documents", description: "Document records you uploaded or generated.", tables: ["documents"] },
];

/** What has been VERIFIED as deployed. `core` is wired in the tenant-export handler. Set `supplement` to true only after a real export returned it. */
export const EXPORT_PARTS_LIVE = { core: true, supplement: false } as const;
