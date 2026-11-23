// ===========================================================================
// Erasure registry (completeness) — enforced in CI by
// scripts/compliance/check-erasure-coverage.mjs (node scripts/compliance/check-erasure-coverage.mjs --check).
//
// HOW ACCOUNT ERASURE ACTUALLY WORKS (verified in code, not assumed):
//   1. delete-account / data-retention-sweep delete every OWNED_TABLES row by user_id,
//   2. then every TENANT_KEYED_OWNED_TABLES row by its ownerColumn (listed in deletion order),
//   3. then call erase_user_rows(p_user) which deletes from EVERY public table that has a uuid
//      `user_id` column except ERASURE_RPC_EXCLUDED, and reports tables it could not clear as `blocked`
//      (delete-account answers 503 when anything is blocked),
//   4. then erase_sensitive_read_log_for_account(), then auth.admin.deleteUser (FK cascades).
// Therefore a table is covered when it is swept / owned / cascade-deleted, or explicitly exempted below.
// Every table holding personal data must satisfy one of those; the CI check fails otherwise.
//
// RULES FOR EDITING (the CI check parses this file with regexes — keep the literal shapes):
//   * One object per line: { table: "x", category: "y" } with an optional note: "...".
//   * Do not add an exemption to silence the check without a real reason. Category reasons below
//     are engineering statements, NOT legal conclusions; items marked counsel need a lawyer's decision.
// ===========================================================================

export interface ErasureExemptionCategory {
  id: string;
  /** Why rows of this kind are not removed by account erasure. Engineering fact, not legal advice. */
  reason: string;
  /** [COUNSEL] a lawyer must confirm the retention basis before this is relied on. */
  counsel: boolean;
}

export const ERASURE_EXEMPTION_CATEGORIES: ErasureExemptionCategory[] = [
  {
    id: "delete_guarded_ledger",
    reason: "A BEFORE DELETE trigger on this table can raise (append-only / immutability guard), so erase_user_rows() cannot delete the rows and reports the table as blocked. Rows survive account erasure until a retention decision [COUNSEL] and a purge path exist [VERIFY whether any dedicated purge exists].",
    counsel: true,
  },
  {
    id: "erasure_evidence",
    reason: "Evidence of erasure, retention or data-subject decisions; deliberately excluded from erase_user_rows() or kept as the audit trail of the erasure itself. Retention period and content minimisation [COUNSEL].",
    counsel: true,
  },
  {
    id: "dedicated_erasure_rpc",
    reason: "Not swept by erase_user_rows() (keyed by account_id and append-only) but erased by the dedicated erase_sensitive_read_log_for_account() RPC that delete-account calls after the sweep.",
    counsel: false,
  },
  {
    id: "operator_held_records",
    reason: "Vireek-operator records about prospects, website visitors, vendors, staff or the platform's own audit trail. They have no account-owner key, so account deletion does not touch them; removal is by operator process only. No automated purge exists in this repo [VERIFY] and the lawful retention period is undecided [COUNSEL].",
    counsel: true,
  },
  {
    id: "needs_remediation",
    reason: "Known open erasure problem. Each entry carries a note describing it. The check reports these and --strict fails while any remain.",
    counsel: true,
  },
];

/** Default p_exclude of erase_user_rows(); the check compares this with the migrations. */
export const ERASURE_RPC_EXCLUDED: string[] = [
  "deletion_requests",
  "data_subject_requests",
  "audit_log",
  "audit_chain_heads",
  "data_retention_policies",
];

export interface TenantKeyedOwnedTable {
  table: string;
  /** uuid column holding the account owner's user id (these tables have no `user_id`). */
  ownerColumn: string;
}

/**
 * Deleted by delete-account / data-retention-sweep with .eq(ownerColumn, userId).
 * ORDER MATTERS: children before parents (e.g. authz_approval_requests before authz_approval_policies).
 */
export const TENANT_KEYED_OWNED_TABLES: TenantKeyedOwnedTable[] = [
  { table: "access_requests", ownerColumn: "account_owner_id" },
  { table: "account_module_events", ownerColumn: "owner_id" },
  { table: "ai_usage_logs", ownerColumn: "account_id" },
  { table: "authz_abac_policies", ownerColumn: "tenant_id" },
  { table: "authz_access_grants", ownerColumn: "tenant_id" },
  { table: "authz_approval_requests", ownerColumn: "tenant_id" },
  { table: "authz_approval_policies", ownerColumn: "tenant_id" },
  { table: "authz_delegations", ownerColumn: "tenant_id" },
  { table: "authz_field_masks", ownerColumn: "tenant_id" },
  { table: "authz_guest_invites", ownerColumn: "tenant_id" },
  { table: "authz_ownership_transfers", ownerColumn: "tenant_id" },
  { table: "authz_record_acl", ownerColumn: "tenant_id" },
  { table: "equipment_tag_events", ownerColumn: "owner_user_id" },
  { table: "equipment_tag_requests", ownerColumn: "owner_user_id" },
  { table: "equipment_tags", ownerColumn: "owner_user_id" },
  { table: "field_form_templates", ownerColumn: "owner_id" },
  { table: "identity_event_payloads", ownerColumn: "owner_user_id" },
  { table: "identity_external_refs", ownerColumn: "owner_user_id" },
  { table: "identity_grants", ownerColumn: "owner_user_id" },
  { table: "reporting_entity_access", ownerColumn: "owner_id" },
  { table: "support_attachments", ownerColumn: "account_owner_id" },
  { table: "support_conversations", ownerColumn: "account_owner_id" },
];

export interface ErasureExemption {
  table: string;
  category: string;
  /** Overrides / extends the category reason for this table. */
  note?: string;
}

export const ERASURE_EXEMPTIONS: ErasureExemption[] = [
// --- erasure_evidence: excluded from erase_user_rows() on purpose (evidence of erasure / retention decisions)
  { table: "deletion_requests", category: "erasure_evidence" },
  { table: "data_subject_requests", category: "erasure_evidence" },
  { table: "audit_log", category: "erasure_evidence" },
  { table: "audit_chain_heads", category: "erasure_evidence" },
  { table: "data_retention_policies", category: "erasure_evidence" },
  { table: "authz_org_deletion_requests", category: "erasure_evidence" },
// --- dedicated_erasure_rpc: erased by erase_sensitive_read_log_for_account(), called from delete-account
  { table: "sensitive_read_log", category: "dedicated_erasure_rpc" },
  { table: "sensitive_read_alerts", category: "dedicated_erasure_rpc" },
  { table: "sensitive_read_settings", category: "dedicated_erasure_rpc" },
// --- needs_remediation: known open problems (reported by the check; --strict fails on them)
  { table: "ai_incidents", category: "needs_remediation", note: "tenant_id references profiles with NO ON DELETE action: once an incident row exists, deleting the profile (auth.users cascade) fails. Decide retention vs deletion [COUNSEL] and then change the FK or register the table as tenant-keyed." },
// --- operator_held_records: Vireek-operator records about prospects, visitors, vendors or staff (no account owner key)
  { table: "audit_consents", category: "operator_held_records" },
  { table: "audit_verifications", category: "operator_held_records" },
  { table: "audits", category: "operator_held_records" },
  { table: "blog_subscribers", category: "operator_held_records" },
  { table: "churn_save_audit", category: "operator_held_records" },
  { table: "compliance_review_events", category: "operator_held_records" },
  { table: "compliance_rule_versions", category: "operator_held_records" },
  { table: "demo_bookings", category: "operator_held_records" },
  { table: "dmca_notices", category: "operator_held_records" },
  { table: "evidence_partners", category: "operator_held_records" },
  { table: "feature_flag_audit", category: "operator_held_records" },
  { table: "homeowner_profiles", category: "operator_held_records" },
  { table: "insights_subscribers", category: "operator_held_records" },
  { table: "job_applications", category: "operator_held_records" },
  { table: "job_board_feeds", category: "operator_held_records" },
  { table: "kill_switch_audit", category: "operator_held_records" },
  { table: "newsletter_subscribers", category: "operator_held_records" },
  { table: "onboarding_bookings", category: "operator_held_records" },
  { table: "ovb_agents", category: "operator_held_records" },
  { table: "ovb_correction_requests", category: "operator_held_records" },
  { table: "ovb_run_results", category: "operator_held_records" },
  { table: "ovb_submissions", category: "operator_held_records" },
  { table: "pn_suppliers", category: "operator_held_records" },
  { table: "public_event_registrations", category: "operator_held_records" },
  { table: "public_events", category: "operator_held_records" },
  { table: "resource_downloads", category: "operator_held_records" },
  { table: "sales_inquiries", category: "operator_held_records" },
  { table: "security_report_requests", category: "operator_held_records" },
  { table: "sla_incidents", category: "operator_held_records" },
  { table: "staff_audit_log", category: "operator_held_records" },
  { table: "status_subscribers", category: "operator_held_records" },
  { table: "subprocessor_notice_deliveries", category: "operator_held_records" },
  { table: "subprocessor_subscribers", category: "operator_held_records" },
  { table: "warranty_registrations", category: "operator_held_records" },
// --- delete_guarded_ledger: a BEFORE DELETE trigger can raise, so erase_user_rows() cannot remove the rows
  { table: "account_entitlement_events", category: "delete_guarded_ledger" },
  { table: "agent_action_audit", category: "delete_guarded_ledger" },
  { table: "agent_action_log", category: "delete_guarded_ledger" },
  { table: "agent_action_requests", category: "delete_guarded_ledger" },
  { table: "agent_audit_chain", category: "delete_guarded_ledger" },
  { table: "asset_decision_log", category: "delete_guarded_ledger" },
  { table: "asset_measurements", category: "delete_guarded_ledger" },
  { table: "authz_events", category: "delete_guarded_ledger" },
  { table: "business_activity_events", category: "delete_guarded_ledger" },
  { table: "churn_save_events", category: "delete_guarded_ledger" },
  { table: "commercial_statement_items", category: "delete_guarded_ledger" },
  { table: "commercial_statements", category: "delete_guarded_ledger" },
  { table: "commission_records", category: "delete_guarded_ledger" },
  { table: "compiled_workflow_audit", category: "delete_guarded_ledger" },
  { table: "cost_ledger", category: "delete_guarded_ledger", note: "Append-only cost ledger keyed by account_id on purpose (see 20281110000000_economics_cost_ledger.sql); no contact data." },
  { table: "demand_opportunity_events", category: "delete_guarded_ledger" },
  { table: "dispatch_optimizer_audit", category: "delete_guarded_ledger" },
  { table: "evidence_consent_log", category: "delete_guarded_ledger" },
  { table: "evidence_photo_captures", category: "delete_guarded_ledger" },
  { table: "evidence_photo_derivatives", category: "delete_guarded_ledger" },
  { table: "evidence_photo_locations", category: "delete_guarded_ledger" },
  { table: "external_invoice_lines", category: "delete_guarded_ledger" },
  { table: "external_invoices", category: "delete_guarded_ledger" },
  { table: "external_payments", category: "delete_guarded_ledger" },
  { table: "fair_sale_events", category: "delete_guarded_ledger" },
  { table: "financing_audit_events", category: "delete_guarded_ledger" },
  { table: "financing_consents", category: "delete_guarded_ledger" },
  { table: "findings_package_items", category: "delete_guarded_ledger" },
  { table: "fraud_events", category: "delete_guarded_ledger" },
  { table: "home_passport_pilot_audit", category: "delete_guarded_ledger" },
  { table: "identity_entities", category: "delete_guarded_ledger" },
  { table: "identity_events", category: "delete_guarded_ledger" },
  { table: "identity_provenance", category: "delete_guarded_ledger" },
  { table: "identity_relationships", category: "delete_guarded_ledger" },
  { table: "install_sov_lines", category: "delete_guarded_ledger" },
  { table: "job_evidence_chain_entries", category: "delete_guarded_ledger" },
  { table: "job_regulation_snapshots", category: "delete_guarded_ledger" },
  { table: "job_transition_log", category: "delete_guarded_ledger" },
  { table: "landscape_contract_events", category: "delete_guarded_ledger" },
  { table: "landscape_route_changes", category: "delete_guarded_ledger" },
  { table: "leak_cases", category: "delete_guarded_ledger" },
  { table: "leak_verification_tests", category: "delete_guarded_ledger" },
  { table: "location_consent_log", category: "delete_guarded_ledger" },
  { table: "loyalty_ledger", category: "delete_guarded_ledger" },
  { table: "lpts_ledger", category: "delete_guarded_ledger" },
  { table: "marketplace_agent_audit", category: "delete_guarded_ledger" },
  { table: "marketplace_agent_ledger", category: "delete_guarded_ledger" },
  { table: "module_entitlement_audit", category: "delete_guarded_ledger" },
  { table: "no_surprise_requests", category: "delete_guarded_ledger" },
  { table: "ops_policy_changes", category: "delete_guarded_ledger" },
  { table: "outcome_clearing_events", category: "delete_guarded_ledger" },
  { table: "outcome_measurements", category: "delete_guarded_ledger" },
  { table: "pack_events", category: "delete_guarded_ledger" },
  { table: "parts_sourcing_audit", category: "delete_guarded_ledger" },
  { table: "pen_events", category: "delete_guarded_ledger" },
  { table: "pen_ledger_entries", category: "delete_guarded_ledger" },
  { table: "pesticide_usage_reports", category: "delete_guarded_ledger" },
  { table: "phone_payment_audit_events", category: "delete_guarded_ledger" },
  { table: "phone_payment_sessions", category: "delete_guarded_ledger" },
  { table: "pilot_attributions", category: "delete_guarded_ledger" },
  { table: "pilot_outcome_baselines", category: "delete_guarded_ledger" },
  { table: "project_daily_log_amendments", category: "delete_guarded_ledger" },
  { table: "project_daily_logs", category: "delete_guarded_ledger" },
  { table: "proof_ledger", category: "delete_guarded_ledger" },
  { table: "protection_contracts", category: "delete_guarded_ledger" },
  { table: "protection_ledger", category: "delete_guarded_ledger" },
  { table: "pw_job_assignments", category: "delete_guarded_ledger" },
  { table: "pw_wage_determinations", category: "delete_guarded_ledger" },
  { table: "pw_wage_rates", category: "delete_guarded_ledger" },
  { table: "regional_legal_documents", category: "delete_guarded_ledger" },
  { table: "regulation_edges", category: "delete_guarded_ledger" },
  { table: "regulation_jurisdictions", category: "delete_guarded_ledger" },
  { table: "regulation_nodes", category: "delete_guarded_ledger" },
  { table: "regulation_versions", category: "delete_guarded_ledger" },
  { table: "remote_resolution_cases", category: "delete_guarded_ledger" },
  { table: "remote_resolution_signals", category: "delete_guarded_ledger" },
  { table: "safety_consent_log", category: "delete_guarded_ledger" },
  { table: "safety_events", category: "delete_guarded_ledger" },
  { table: "safety_incident_events", category: "delete_guarded_ledger" },
  { table: "speed_to_lead_consents", category: "delete_guarded_ledger", note: "Consent ledger kept by design (docs/compliance/speed-to-lead-assumptions.md A4); legal-hold basis must be confirmed by counsel." },
  { table: "truth_decisions", category: "delete_guarded_ledger" },
  { table: "truth_evidence", category: "delete_guarded_ledger" },
  { table: "truth_facts", category: "delete_guarded_ledger" },
  { table: "truth_verifications", category: "delete_guarded_ledger" },
  { table: "value_event_reviews", category: "delete_guarded_ledger" },
  { table: "value_events", category: "delete_guarded_ledger" },
  { table: "voice_autopilot_audit", category: "delete_guarded_ledger" },
  { table: "voice_call_events", category: "delete_guarded_ledger" },
  { table: "voice_security_audit", category: "delete_guarded_ledger" },
  { table: "warranty_claim_actions", category: "delete_guarded_ledger" },
  { table: "warranty_claims", category: "delete_guarded_ledger" },
  { table: "webhook_replay_audit", category: "delete_guarded_ledger" },
  { table: "work_order_visits", category: "delete_guarded_ledger" },
  { table: "workflow_events", category: "delete_guarded_ledger" },
];

/** Category lookup used by tests and admin tooling. */
export function erasureExemptionFor(table: string): (ErasureExemption & { reason: string; counsel: boolean }) | undefined {
  const e = ERASURE_EXEMPTIONS.find((x) => x.table === table);
  if (!e) return undefined;
  const c = ERASURE_EXEMPTION_CATEGORIES.find((x) => x.id === e.category);
  return { ...e, reason: e.note ?? c?.reason ?? "", counsel: c?.counsel ?? true };
}
