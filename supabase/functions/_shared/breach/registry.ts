// supabase/functions/_shared/breach/registry.ts
//
// Allowlist for the breach scoping tool: which tables can be scanned, which column identifies the tenant, which column carries
// time, and which data categories a row in that table represents.
//
// Provenance: tenant/time columns were read from supabase/migrations by static inspection (see docs/runbooks/breach-notification.md,
// section 6). They have NOT been executed against a live database [VERIFY]; the scan reports a per-table error instead of
// guessing when a column is missing. Category wording follows docs/compliance/data-map.md (D1..D14) and is NOT a legal classification [COUNSEL].
//
// Pure: no Deno or npm imports.

export type CategoryId =
  | "account_identity"
  | "team_member_identity"
  | "caller_and_lead_identity"
  | "call_content"
  | "call_audio"
  | "customer_job_quote"
  | "payment_records"
  | "bank_data"
  | "integration_credentials"
  | "consent_evidence"
  | "security_logs"
  | "device_identifiers";

export interface DataCategory {
  id: CategoryId;
  /** Short label used in notice drafts. */
  label: string;
  /** Plain-language description of what the category can contain. Written for the tenant, not for engineers. */
  description: string;
  /** docs/compliance/data-map.md class(es). */
  dataMapRef: string[];
  /** True when the category can contain credentials or secrets: the notice then recommends rotation. */
  secrets?: boolean;
}

export const CATEGORIES: Readonly<Record<CategoryId, DataCategory>> = {
  account_identity: { id: "account_identity", label: "Account contact details", description: "the account owner's name, email address, phone number and company name", dataMapRef: [] },
  team_member_identity: { id: "team_member_identity", label: "Team member details", description: "names and email addresses of people invited to the account, and their roles", dataMapRef: [] },
  caller_and_lead_identity: { id: "caller_and_lead_identity", label: "Caller and lead contact details", description: "names, phone numbers and email addresses of callers, leads and customers", dataMapRef: ["D4"] },
  call_content: { id: "call_content", label: "Call records and transcripts", description: "call logs, caller numbers, transcripts and AI-generated summaries or insights", dataMapRef: ["D3", "D4"] },
  call_audio: { id: "call_audio", label: "Call audio", description: "recordings of calls and conversations", dataMapRef: ["D1", "D2"] },
  customer_job_quote: { id: "customer_job_quote", label: "Customer, job and quote records", description: "customer records, job details, quotes and invoices, which can include addresses and notes", dataMapRef: ["D5"] },
  payment_records: { id: "payment_records", label: "Payment records", description: "payment requests, payout records and payment-provider account references (not full card numbers)", dataMapRef: ["D6"] },
  bank_data: { id: "bank_data", label: "Bank connection data", description: "linked bank accounts and transaction records", dataMapRef: ["D7"] },
  integration_credentials: { id: "integration_credentials", label: "Integration connections and API keys", description: "records of connected third-party services and API keys, which can include access tokens", dataMapRef: [], secrets: true },
  consent_evidence: { id: "consent_evidence", label: "Consent and disclosure records", description: "records of consent and AI-disclosure for calls and messages", dataMapRef: ["D11"] },
  security_logs: { id: "security_logs", label: "Audit and request logs", description: "account audit events and API request logs, which can include IP addresses and identifiers", dataMapRef: ["D13"] },
  device_identifiers: { id: "device_identifiers", label: "Device identifiers", description: "push-notification tokens and device identifiers", dataMapRef: ["D14"] },
};

export interface BreachTable {
  /** Table name in the public schema (also the key the UI sends). */
  table: string;
  /** Human label for the staff UI. */
  label: string;
  /** uuid column that identifies the tenant (the account owner). */
  tenantColumn: "user_id" | "account_owner_id" | "id";
  /** timestamp column used for the window. */
  timeColumn: "created_at" | "received_at";
  categories: readonly CategoryId[];
}

export const BREACH_TABLES: readonly BreachTable[] = [
  { table: "profiles", label: "Account profiles", tenantColumn: "id", timeColumn: "created_at", categories: ["account_identity"] },
  { table: "team_members", label: "Team members", tenantColumn: "account_owner_id", timeColumn: "created_at", categories: ["team_member_identity"] },
  { table: "leads", label: "Leads", tenantColumn: "user_id", timeColumn: "created_at", categories: ["caller_and_lead_identity"] },
  { table: "customers", label: "Customers", tenantColumn: "user_id", timeColumn: "created_at", categories: ["caller_and_lead_identity", "customer_job_quote"] },
  { table: "calls", label: "Calls", tenantColumn: "user_id", timeColumn: "created_at", categories: ["call_content", "caller_and_lead_identity"] },
  { table: "ai_insights", label: "AI insights", tenantColumn: "user_id", timeColumn: "created_at", categories: ["call_content"] },
  { table: "conversation_recordings", label: "Conversation recordings", tenantColumn: "user_id", timeColumn: "created_at", categories: ["call_audio"] },
  { table: "jobs", label: "Jobs", tenantColumn: "user_id", timeColumn: "created_at", categories: ["customer_job_quote"] },
  { table: "quotes", label: "Quotes", tenantColumn: "user_id", timeColumn: "created_at", categories: ["customer_job_quote"] },
  { table: "invoices", label: "Invoices", tenantColumn: "user_id", timeColumn: "created_at", categories: ["customer_job_quote", "payment_records"] },
  { table: "payment_requests", label: "Payment requests", tenantColumn: "user_id", timeColumn: "created_at", categories: ["payment_records"] },
  { table: "stripe_connect_accounts", label: "Payout (Stripe Connect) accounts", tenantColumn: "user_id", timeColumn: "created_at", categories: ["payment_records"] },
  { table: "instant_payouts", label: "Instant payouts", tenantColumn: "user_id", timeColumn: "created_at", categories: ["payment_records"] },
  { table: "bank_accounts", label: "Bank accounts", tenantColumn: "user_id", timeColumn: "created_at", categories: ["bank_data"] },
  { table: "bank_transactions", label: "Bank transactions", tenantColumn: "user_id", timeColumn: "created_at", categories: ["bank_data"] },
  { table: "integrations", label: "Integrations", tenantColumn: "user_id", timeColumn: "created_at", categories: ["integration_credentials"] },
  { table: "acct_connections", label: "Accounting connections", tenantColumn: "user_id", timeColumn: "created_at", categories: ["integration_credentials"] },
  { table: "payroll_connections", label: "Payroll connections", tenantColumn: "user_id", timeColumn: "created_at", categories: ["integration_credentials"] },
  { table: "api_keys", label: "API keys", tenantColumn: "user_id", timeColumn: "created_at", categories: ["integration_credentials"] },
  { table: "consent_records", label: "Consent records", tenantColumn: "user_id", timeColumn: "created_at", categories: ["consent_evidence"] },
  { table: "call_ai_disclosures", label: "AI disclosure records", tenantColumn: "user_id", timeColumn: "created_at", categories: ["consent_evidence"] },
  { table: "audit_log", label: "Audit log", tenantColumn: "user_id", timeColumn: "created_at", categories: ["security_logs"] },
  { table: "api_request_logs", label: "API request logs", tenantColumn: "user_id", timeColumn: "created_at", categories: ["security_logs"] },
  { table: "device_push_tokens", label: "Push tokens", tenantColumn: "user_id", timeColumn: "created_at", categories: ["device_identifiers"] },
];

const BY_TABLE = new Map(BREACH_TABLES.map((t) => [t.table, t]));
export const getBreachTable = (name: string): BreachTable | undefined => BY_TABLE.get(name);
export const MAX_TABLES_PER_SCAN = BREACH_TABLES.length;
