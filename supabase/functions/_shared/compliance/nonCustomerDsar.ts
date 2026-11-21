// supabase/functions/_shared/compliance/nonCustomerDsar.ts
//
// Pure, dependency-free logic for handling VERIFIED data-subject requests from people who are not
// Vireek customers (a tenant's own customers, website visitors, "other"). Shared verbatim by the
// `dsar-non-customer` edge function and unit-tested under Vitest (nonCustomerDsar.test.ts).
//
// Model (Vireek is the PROCESSOR for tenant customer data):
//   * Data Vireek derives itself (geocode + provider-fetched property layers) is cleared by Vireek and the
//     subject is added to a suppression list so it is not re-created.
//   * Tenant-controlled records (customers, leads) are never deleted by Vireek on its own: each affected
//     tenant receives a referral with a deadline and decides. [COUNSEL: confirm roles and the DPA wording]
//   * An "access" request never auto-discloses content; staff receive per-tenant counts only.
//
// The key normalisation here MUST stay identical to public.dsar_suppression_key() in
// supabase/migrations/20290306000000_data_sources_registry.sql.

import type { DsarKind, DsarRelationship } from "./dsar.ts";

export const NON_CUSTOMER_RELATIONSHIPS: readonly DsarRelationship[] = ["customer_of_customer", "website_visitor", "other"];

/** Tenants get this many days less than the DSAR deadline so Vireek can still answer the requester in time. */
export const CONTROLLER_RESPONSE_BUFFER_DAYS = 10;
/** Never give a tenant less than this, even for a request that is already close to its deadline. */
export const CONTROLLER_MIN_RESPONSE_DAYS = 3;

export const TENANT_SOURCE_TABLES = ["customers", "leads"] as const;
export type TenantSourceTable = (typeof TENANT_SOURCE_TABLES)[number];

export type SuppressionKind = "email" | "address";

const MIN_EMAIL_LEN = 5;
const MIN_ADDRESS_LEN = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeEmailKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length >= MIN_EMAIL_LEN && v.indexOf("@") >= 1 ? v : null;
}

/** ASCII alphanumerics only (mirrors the SQL regexp). Returns null when too short to be a safe key. */
export function normalizeAddressKey(parts: ReadonlyArray<string | null | undefined> | string): string | null {
  const joined: string = typeof parts === "string"
    ? parts
    : parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" ");
  const v = joined.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return v.length >= MIN_ADDRESS_LEN ? v : null;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256("<kind>:<normalised value>") as hex, or null when the value cannot be keyed safely. */
export async function suppressionHash(kind: SuppressionKind, value: string | ReadonlyArray<string | null | undefined>): Promise<string | null> {
  const norm = kind === "email" ? normalizeEmailKey(value) : normalizeAddressKey(value);
  return norm ? sha256Hex(`${kind}:${norm}`) : null;
}

export function referralDueAt(dsarDueAt: Date, now: Date = new Date()): Date {
  const target = dsarDueAt.getTime() - CONTROLLER_RESPONSE_BUFFER_DAYS * 86_400_000;
  const floor = now.getTime() + CONTROLLER_MIN_RESPONSE_DAYS * 86_400_000;
  return new Date(Math.max(target, floor));
}

export interface DiscoveryRow {
  tenant_user_id: string;
  source_table: string;
  row_count: number | string;
}

export interface ReferralPlan {
  tenantUserId: string;
  sourceTable: TenantSourceTable;
  rowCount: number;
}

export interface NonCustomerPlan {
  suppressEmail: boolean;
  eraseEnrichment: boolean;
  referrals: ReferralPlan[];
  /** What the handler should leave the DSAR as when it finishes. */
  finalStatus: "completed" | "in_progress";
  note: string;
}

/** Collapses raw RPC rows into valid, de-duplicated referrals; unknown tables and non-positive counts are dropped. */
export function toReferrals(rows: readonly DiscoveryRow[]): ReferralPlan[] {
  const merged = new Map<string, ReferralPlan>();
  for (const r of rows) {
    const table = r.source_table as TenantSourceTable;
    const n = Number(r.row_count);
    if (!TENANT_SOURCE_TABLES.includes(table) || !UUID_RE.test(String(r.tenant_user_id)) || !Number.isFinite(n) || n <= 0) continue;
    const key = `${r.tenant_user_id}|${table}`;
    const prev = merged.get(key);
    if (prev) prev.rowCount += Math.floor(n);
    else merged.set(key, { tenantUserId: r.tenant_user_id, sourceTable: table, rowCount: Math.floor(n) });
  }
  return [...merged.values()].sort((a, b) => (a.tenantUserId + a.sourceTable).localeCompare(b.tenantUserId + b.sourceTable));
}

export function planNonCustomerActions(kind: DsarKind, discovery: readonly DiscoveryRow[]): NonCustomerPlan {
  const referrals = toReferrals(discovery);
  const isDelete = kind === "delete";

  let finalStatus: NonCustomerPlan["finalStatus"] = referrals.length === 0 ? "completed" : "in_progress";
  let note: string;
  if (referrals.length === 0) {
    note = isDelete
      ? "No tenant-held records matched this address. Vireek-derived property data was cleared and the address was added to the suppression list."
      : "No records matched this address in tenant-held data.";
  } else {
    const tenants = new Set(referrals.map((r) => r.tenantUserId)).size;
    note = `Matched records held by ${tenants} business${tenants === 1 ? "" : "es"} that use Vireek. Each has been asked to act as controller of its records; this request closes when every referral is resolved.`;
  }
  // An access request is never auto-completed with content: staff reply to the requester themselves.
  if (kind === "access" && referrals.length > 0) finalStatus = "in_progress";

  return { suppressEmail: isDelete, eraseEnrichment: isDelete, referrals, finalStatus, note };
}

export type EligibilityResult = { ok: true } | { ok: false; code: "not_found" | "not_verified" | "account_flow" | "wrong_relationship" };

/** Only verified, in-progress requests from non-customers that were not already matched to an account owner. */
export function checkEligibility(
  row: { status: string; relationship: string; matched_user_id: string | null } | null,
): EligibilityResult {
  if (!row) return { ok: false, code: "not_found" };
  if (row.status !== "in_progress") return { ok: false, code: "not_verified" };
  if (row.matched_user_id) return { ok: false, code: "account_flow" };
  if (!NON_CUSTOMER_RELATIONSHIPS.includes(row.relationship as DsarRelationship)) return { ok: false, code: "wrong_relationship" };
  return { ok: true };
}

export type HandlerBody = { ok: true; requestId: string; action: "discover" | "process" } | { ok: false; error: string };

export function parseHandlerBody(input: unknown): HandlerBody {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof src.requestId !== "string" || !UUID_RE.test(src.requestId)) return { ok: false, error: "requestId must be a UUID." };
  if (src.action !== "discover" && src.action !== "process") return { ok: false, error: "action must be discover or process." };
  return { ok: true, requestId: src.requestId, action: src.action };
}

/** True when a still-open referral has passed its deadline (used for staff reminders). */
export function isReferralOverdue(r: { status: string; due_at: string }, now: Date = new Date()): boolean {
  return r.status === "open" && new Date(r.due_at).getTime() < now.getTime();
}
