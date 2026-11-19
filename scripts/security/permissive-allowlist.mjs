// scripts/security/permissive-allowlist.mjs
//
// Reviewed, INTENTIONAL permissive RLS policies (rule `policy-true` of scripts/security/rls-audit.mjs).
// Source of truth for docs/security/permissive-policies.md. The test permissive-allowlist.test.mjs fails when:
//   - a `policy-true` / `anon-write-policy` finding appears that is not listed here (new, unreviewed), or
//   - an entry here no longer matches any finding (stale: the policy was fixed or removed).
//
// To add an entry: review the table (tenant columns? writable? PII?), pick a `kind`, write the reason, and
// get a security owner (.github/CODEOWNERS: /scripts/security/) to approve the PR. Never add a table that
// holds tenant-scoped or personal data just to make the gate pass.
//
// kind:
//   catalog            global read-only reference data
//   aggregate          cross-tenant aggregate, no tenant identifiers
//   community / public deliberately visible to all signed-in users / the public internet
//   public-insert      anonymous INSERT-only form (no client read-back)
//   column-restricted  row policy is `true` but sensitive columns are hidden by column-level GRANT
//   internal-readable  internal metadata deliberately shown in the tenant UI
export const PERMISSIVE_ALLOWLIST = [
  // adn_causes
  { table: "adn_causes", policy: "adn_read_causes", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // adn_tests
  { table: "adn_tests", policy: "adn_read_tests", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // agent_action_catalog
  { table: "agent_action_catalog", policy: "authenticated_select_agent_action_catalog", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // agent_rollback_allowed_tables
  { table: "agent_rollback_allowed_tables", policy: "authenticated_select_rollback_allowlist", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only; shown in the governance UI" },
  // ai_transparency_catalog
  { table: "ai_transparency_catalog", policy: "select_ai_transparency_catalog", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only; AI-disclosure text users must be able to read" },
  // benchmark_cohort_stats
  { table: "benchmark_cohort_stats", policy: "select_benchmark_cohort_stats", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (rows carry contributor_count, size_tier, noise_applied)" },
  // community_categories
  { table: "community_categories", policy: "authenticated users view community categories", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // community_replies
  { table: "community_replies", policy: "authenticated users view community replies", kind: "community", why: "cross-account community by design: any signed-in user reads posts; author_id/author_name are intentionally visible. [VERIFY] product decision; no moderation/hidden state column exists" },
  // community_threads
  { table: "community_threads", policy: "authenticated users view community threads", kind: "community", why: "cross-account community by design (see community_replies); inserts require author_id = auth.uid()" },
  // data_regions
  { table: "data_regions", policy: "anyone_read_data_regions", kind: "public", why: "public region list (residency page); writes are staff-only" },
  // diag_domains
  { table: "diag_domains", policy: "diag_domains_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // diag_hypotheses
  { table: "diag_hypotheses", policy: "diag_hypotheses_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // diag_likelihood_seed
  { table: "diag_likelihood_seed", policy: "diag_likelihood_seed_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // diag_questions
  { table: "diag_questions", policy: "diag_questions_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // docs_feedback
  { table: "docs_feedback", policy: "anyone_can_submit_docs_feedback", kind: "public-insert", why: "public docs \"was this helpful\" form: INSERT-only (SELECT/UPDATE/DELETE revoked), size limits are table CHECKs. No rate limit at this layer" },
  // evidence_products
  { table: "evidence_products", policy: "select_evidence_products", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // failure_atlas_cells
  { table: "failure_atlas_cells", policy: "read_failure_atlas_cells", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // failure_atlas_stats
  { table: "failure_atlas_stats", policy: "read_failure_atlas_stats", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // fie_global_patterns
  { table: "fie_global_patterns", policy: "read_fie_global_patterns", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries n_accounts)" },
  // fx_rates
  { table: "fx_rates", policy: "fx_rates_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // identity_relationship_types
  { table: "identity_relationship_types", policy: "identity_reltypes_select", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // identity_value_dimensions
  { table: "identity_value_dimensions", policy: "read_identity_value_dimensions", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // job_transition_rules
  { table: "job_transition_rules", policy: "select_job_transition_rules", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only (from_status,to_status pairs)" },
  // marketplace_scopes
  { table: "marketplace_scopes", policy: "authenticated_select_marketplace_scopes", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_documents
  { table: "oem_documents", policy: "read_oem_documents", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_equipment_models
  { table: "oem_equipment_models", policy: "read_oem_equipment_models", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_failure_patterns
  { table: "oem_failure_patterns", policy: "read_oem_failure_patterns", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_graph_stats
  { table: "oem_graph_stats", policy: "read_oem_graph_stats", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // oem_issue_parts
  { table: "oem_issue_parts", policy: "read_oem_issue_parts", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_known_issues
  { table: "oem_known_issues", policy: "read_oem_known_issues", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_manufacturers
  { table: "oem_manufacturers", policy: "read_oem_manufacturers", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_model_reliability
  { table: "oem_model_reliability", policy: "read_oem_model_reliability", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // oem_parts
  { table: "oem_parts", policy: "read_oem_parts", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_recalls
  { table: "oem_recalls", policy: "read_oem_recalls", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_serial_rules
  { table: "oem_serial_rules", policy: "read_oem_serial_rules", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_service_bulletins
  { table: "oem_service_bulletins", policy: "read_oem_service_bulletins", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oem_warranty_terms
  { table: "oem_warranty_terms", policy: "read_oem_warranty_terms", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // oin_taxonomy
  { table: "oin_taxonomy", policy: "read_oin_taxonomy", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // outcome_cross_tenant_aggregates
  { table: "outcome_cross_tenant_aggregates", policy: "read_outcome_cross_tenant_aggregates", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries tenant_count, max_tenant_share)" },
  // pack_versions
  { table: "pack_versions", policy: "read_pack_versions", kind: "column-restricted", why: "row list is public to signed-in users; the `artifacts` column (pack content) is hidden by column-level SELECT in 20290304000000 and delivered only through SECURITY DEFINER pack_apply. Client reads only pack_id,version" },
  // pay_disclosures
  { table: "pay_disclosures", policy: "authenticated_read_pay_disclosures", kind: "catalog", why: "versioned disclosure text that users must be able to read before accepting. [COUNSEL] wording/legal_reviewed status is not asserted here" },
  // pen_trades
  { table: "pen_trades", policy: "pen_trades_select", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // pii_field_registry
  { table: "pii_field_registry", policy: "authenticated_read_pii_registry", kind: "internal-readable", why: "read by the tenant Data Governance page (src/lib/dataGovernance.ts). Lists classification metadata only, no data. [VERIFY] product decision to expose it to all signed-in users" },
  // platform_backup_runs
  { table: "platform_backup_runs", policy: "authenticated_read_backup_runs", kind: "column-restricted", why: "tenant Data Governance page shows backup status; storage_path, checksum_sha256, table_row_counts, error_message hidden by column-level SELECT in 20290304000000" },
  // platform_restore_drills
  { table: "platform_restore_drills", policy: "authenticated_read_restore_drills", kind: "column-restricted", why: "tenant Data Governance page shows drill status/RTO/notes; row_count_mismatches hidden by column-level SELECT in 20290304000000" },
  // refrigerant_gwp
  { table: "refrigerant_gwp", policy: "read_refrigerant_gwp", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // roadmap_items
  { table: "roadmap_items", policy: "select_roadmap_items", kind: "public", why: "public ideas board incl. admin_note shown on /feedback by design (src/pages/FeedbackPage.tsx); declined items are filtered by the client only. submitted_by (a user uuid) is visible. [VERIFY] product decision" },
  // security_report_requests
  { table: "security_report_requests", policy: "anyone_request_security_report", kind: "public-insert", why: "public \"request the pentest report\" form: INSERT-only to clients; email/company/message have table CHECKs; SELECT is staff-only" },
  // service_loop_global_priors
  { table: "service_loop_global_priors", policy: "read_service_loop_global_priors", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // service_loop_global_totals
  { table: "service_loop_global_totals", policy: "read_service_loop_global_totals", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count" },
  // subprocessor_notices
  { table: "subprocessor_notices", policy: "public_read_subprocessor_notices", kind: "public", why: "sub-processor change notices are published publicly on purpose; writes are staff-only. created_by (staff uuid) is visible" },
  // success_feature_catalog
  { table: "success_feature_catalog", policy: "success_catalog_read", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // trade_log_types
  { table: "trade_log_types", policy: "read_trade_log_types", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // trade_packs
  { table: "trade_packs", policy: "read_trade_packs", kind: "catalog", why: "global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only" },
  // verification_sources
  { table: "verification_sources", policy: "vs_select", kind: "column-restricted", why: "registry list for the UI; provider and config hidden by column-level SELECT in 20290304000000 (edge function reads them with the service role). Client selects id,source_key,label,jurisdiction,kind,active" },
  // vertical_intelligence_signals
  { table: "vertical_intelligence_signals", policy: "select_vertical_intelligence_signals", kind: "aggregate", why: "cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries tenant_count)" },
  // you_asked_we_built
  { table: "you_asked_we_built", policy: "you_asked_select_all", kind: "public", why: "\"you asked, we built\" announcements shown to signed-in users" },
];

export const key = (table, policy) => `${table}|${policy}`;
