// supabase/functions/_shared/tenant-export/coverage.ts
//
// Export coverage manifest. `tenant-export` has two parts:
//   part=core        the 6 importable tables in bundle.ts (TABLES) — round-trips through tenant-import
//   part=supplement  the tables below — portable records for switching providers; EXPORT-ONLY
//                    (format "vireek-export-supplement/1", never accepted by tenant-import)
// scripts/compliance/export-coverage.mjs compares every table with a `user_id` column in
// supabase/migrations against these lists and fails on gaps. To add a table: it must have `id` and
// `user_id` columns, hold records the customer owns, and contain no credentials.
//
// The script reads this file with regular expressions: keep one quoted name per entry and keep
// EXCLUSION_RULES as plain string patterns.

export const SUPPLEMENTARY_TABLES = [
  // customers and sites
  "customer_sites", "customer_site_buildings", "customer_site_floors", "customer_site_rooms",
  "customer_contacts", "customer_households", "customer_household_members", "customer_notes",
  "customer_communication_preferences", "leads",
  // sales
  "quotes", "quote_versions", "quote_selected_items", "quote_followups",
  // jobs
  "job_line_items", "job_parts_required", "job_cost_entries", "job_technician_assignments",
  "job_payments", "job_tips", "job_photos", "job_summaries", "job_messages", "job_templates", "tasks", "timesheets",
  // money
  "invoice_payments", "invoice_refunds", "payment_requests", "payment_plans", "payment_plan_installments",
  "expenses", "vendor_bills",
  // equipment, warranties, memberships and agreements
  "equipment", "equipment_maintenance_alerts", "warranty_claims",
  "membership_plans", "memberships", "membership_visits", "membership_renewal_cycles",
  "agreement_services", "agreement_assets", "agreement_entitlements", "agreement_pm_plans", "agreement_visits", "agreement_renewals",
  // inventory, vendors, purchasing
  "inventory_locations", "inventory_parts", "inventory_stock_levels", "inventory_transactions", "inventory_vendors",
  "inventory_part_vendors", "inventory_purchase_orders", "inventory_purchase_order_lines",
  "vendors", "vendor_contracts", "purchase_orders", "purchase_order_lines",
  // communication and reputation
  "sms_conversations", "call_dispositions", "call_scripts", "reviews", "review_requests", "documents",
  // account profile, lead events, pest-control records, quote videos, AI insights, agent holds (owned tables; see portability.ts)
  "business_profile", "lead_marketplace_events", "pest_service_plans", "pest_plan_events", "pest_callbacks", "pest_visit_notices",
  "pest_stock", "pest_stock_movements", "pest_region_profiles", "quote_videos", "quote_video_events", "agent_holds", "ai_insights",
] as const;

export type SupplementaryTable = (typeof SUPPLEMENTARY_TABLES)[number];

/**
 * Tables that must never be exported, matched by name. These are classified (not "unreviewed") so the
 * coverage script treats them as decided. A name-pattern is a coarse net: a table caught here by mistake
 * should be renamed or given an explicit entry in SUPPLEMENTARY_TABLES (which wins only if it does not
 * match — the script fails on a table that is both listed and excluded).
 */
export const EXCLUSION_RULES = [
  {
    reason: "secret",
    pattern: "secret|credential|password|api_?key|access_?token|refresh_?token|push_?token|_tokens?$|encryption_keys?$|identity_keys?$|feed_keys?$",
    why: "Credentials and key material are never exported; a customer re-creates connections at the new provider.",
  },
  {
    reason: "operational_counter",
    pattern: "rate_limit|_usage$|_counters?$|nudge_gate|idempotency",
    why: "Throttling and metering state of this platform; meaningless outside it.",
  },
  {
    reason: "platform_process",
    pattern: "^switching_requests$",
    why: "Vireek's own record of the customer's switching request (status, deadlines); it is the process, not portable business data.",
  },
] as const;

export type ExclusionReason = (typeof EXCLUSION_RULES)[number]["reason"];

export function exclusionFor(table: string): ExclusionReason | null {
  for (const r of EXCLUSION_RULES) if (new RegExp(r.pattern, "i").test(table)) return r.reason;
  return null;
}
