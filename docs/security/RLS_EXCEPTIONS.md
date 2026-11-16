# RLS exceptions (reviewed from `node scripts/security/rls-audit.mjs`, static replay of migrations)

Status: DRAFT. A human owner must confirm each row against the live DB with `supabase/tests/manual/rls_verify_live.sql`.

## A. Public INSERT forms (`with check (true)` for anon/authenticated)
| Table | Reason | Required control |
|---|---|---|
| demo_bookings, onboarding_bookings | Marketing booking forms | Turnstile + rate limit at the endpoint |
| docs_feedback, newsletter_subscribers, status_subscribers, security_report_requests | Public forms | Turnstile + rate limit; no SELECT policy for clients |

## B. Authenticated-read reference catalogs (SELECT `true`)
adn_causes, adn_tests, agent_action_catalog, agent_rollback_allowed_tables, ai_transparency_catalog, benchmark_cohort_stats,
diag_*, evidence_products, failure_atlas_*, fie_global_patterns, fx_rates, identity_relationship_types, identity_value_dimensions,
job_transition_rules, marketplace_scopes, oem_*, oin_taxonomy, pack_versions, pay_disclosures, pen_trades, refrigerant_gwp,
service_loop_global_*, success_feature_catalog, trade_log_types, trade_packs, verification_sources,
vertical_intelligence_signals, you_asked_we_built, roadmap_items (anon+authenticated), data_regions and subprocessor_notices (public).
Reason: shared platform reference data with no tenant column. Rule: never add a tenant identifier to these tables.

## C. NEEDS REVIEW (not yet justified)
- platform_backup_runs, platform_restore_drills: readable by every tenant; likely should be staff-only.
- outcome_cross_tenant_aggregates: confirm no tenant-identifying or small-cohort values.
- community_threads / community_replies / community_categories: community content visible to all authenticated users; confirm that author ids are acceptable to expose.
- pii_field_registry: metadata only; confirm it contains no real data.

## D. Scoped, not exceptions
- support_conversations.update_conversation: limited to `visitor_id = auth.uid()` or staff (anonymous-auth visitors). Consider a column allow-list.

## E. RLS on, zero policies = service-role only (intentional)
Categories (full list in `docs/security/rls-audit.md`): `*_secrets`, `*_credentials`, `*_connection_secrets` (encrypted tokens), `*_rate_limit*` and `*_usage` counters,
queues/outboxes/log tables (`wallet_push_outbox`, `marketing_event_queue`, `webhook_event_claims`), platform config (`app_release_policy`, `slo_definitions`),
`mfa_enforcement_policy`, `mfa_recovery_*`, `trusted_devices`, `sealed_*`. Rule: no client grants; edge functions use the service role.
