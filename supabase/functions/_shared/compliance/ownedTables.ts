// supabase/functions/_shared/compliance/ownedTables.ts
//
// Single source of truth for "every table that stores account-scoped data
// via a `user_id` column with no ON DELETE CASCADE back to auth.users."
// Used by both delete-account (full erasure) and data-retention-sweep
// (scheduled erasure/anonymization). If you add a new account-scoped
// table, add it here once — both call sites pick it up automatically.
//
// `pii` lists the columns that DATA_RETENTION_SWEEP anonymizes instead of
// hard-deleting when a policy has anonymize_instead_of_delete = true (kept
// in sync with the `pii_field_registry` table — see the DR/governance
// migration). delete-account always hard-deletes regardless of this list,
// since a full account erasure has no "keep the row, scrub it" mode.

export interface OwnedTable {
  table: string;
  /** Columns to null out on anonymize (retention sweep only). */
  pii?: string[];
  /** Column used to test age against a retention policy. */
  dateColumn?: string;
}

export const OWNED_TABLES: OwnedTable[] = [
  { table: "jobs", dateColumn: "created_at" },
  { table: "leads", pii: ["name", "phone", "email"], dateColumn: "created_at" },
  { table: "calls", pii: ["caller_number", "recording_url", "transcript"], dateColumn: "created_at" },
  { table: "quotes", dateColumn: "created_at" },
  { table: "payment_requests", dateColumn: "created_at" },
  { table: "ai_insights", dateColumn: "created_at" },
  { table: "review_requests", dateColumn: "created_at" },
  { table: "integrations", dateColumn: "created_at" },
  { table: "business_profile" },
];

/** Just the plain table names, for call sites that don't need PII/date info. */
export const OWNED_TABLE_NAMES = OWNED_TABLES.map((t) => t.table);
