# Permissive RLS policies — review

Scope: every `policy-true` finding and the single `anon-write-policy` finding of `scripts/security/rls-audit.mjs`.
Method: static replay of `supabase/migrations` (same engine as the audit), then reading each table's DDL, its other
policies, and its client/edge-function usage. Nothing here was executed against a database [VERIFY] (see "Verification").

## Counts

| | Count |
|---|---:|
| `policy-true`, as in the committed `docs/security/rls-audit.md` | 56 |
| `policy-true`, static replay of the current migrations, **before** this change | 61 |
| `policy-true`, after migration `20290304000000` | 57 |
| `anon-write-policy`, before → after | 1 → 0 |

The committed audit is stale: five tables are in the replay but not in its list (`docs_feedback`,
`job_transition_rules`, `outcome_cross_tenant_aggregates`, `pack_versions`, `you_asked_we_built`). The
`docs/security/rls-baseline.json` and `docs/security/rls-audit.json` files that `rls-audit.mjs --check` needs are not in the
repository, so that gate cannot pass as shipped. Regenerating them (`npm run security:rls`) was deliberately not done here: it would rewrite
the generated `rls_catalog.test.sql` and a frozen-baseline decision belongs to the security owner.

## Bugs (fixed)

| Table | Policy (before) | Why it was a bug | Fix (migration `20290304000000`) |
|---|---|---|---|
| `demo_bookings` | `public_insert_demo_bookings` (`WITH CHECK (true)`), `admin_select/update/delete_demo_bookings` | INSERT unbounded and `status` client-chosen. The "admin" policies test `profiles.role = 'admin'`, the **tenant** role (default role of an account is `owner`; `admin` is a customer's own admin), so any customer admin could read, edit and delete Vireek sales leads (names, work emails, phones). | INSERT bounded (`status = 'scheduled'`, `slot_end > slot_start`, lengths, email shape). Read/update/delete → `is_vireek_staff()`. |
| `onboarding_bookings` | `anyone can request onboarding slot`, `Only admins read onboarding bookings` | Same two defects (read open to every tenant admin; INSERT unbounded). | Same fix. |
| `status_subscribers` | `public_insert_status_subscribers`, `admin_select/delete_status_subscribers` | Subscriber emails, phones and `unsubscribe_token` readable and deletable by any tenant admin. | INSERT bounded; read/delete → staff only. |
| `newsletter_subscribers` | `insert_newsletter_subscriber` (`WITH CHECK (true)`) | Unbounded `email` / `source`. (No SELECT policy exists, so no read exposure.) | INSERT bounded (email shape/length, `source` 1–64). |
| `support_conversations`, `support_messages` | `update_conversation` (and select/insert policies) `TO authenticated, anon` | This is the single `anon-write-policy` finding. Visitors use Supabase anonymous auth (`src/lib/supportChat.ts` `signInAnonymously()`), whose JWT role is `authenticated`; a true `anon` caller has `auth.uid() = NULL` so the policy never matched. Not exploitable, but dead `anon` surface that the audit rightly flags. | Policies now `TO authenticated` only. Behaviour for chat visitors is unchanged. Existing trigger `support_ticket_before_update` already pins non-staff columns. |
| `platform_backup_runs`, `platform_restore_drills` | `authenticated_read_*` (`USING (true)`) | The tenant Data Governance page does show DR status, so row access is intentional, but the page read `select('*')`, exposing `storage_path`, `checksum_sha256`, per-table `table_row_counts` (platform-wide row volumes) and `error_message` to every tenant. | Column-level SELECT: only the columns the UI renders. `src/lib/dataGovernance.ts` now names its columns. |
| `pack_versions` | `read_pack_versions` | `artifacts` (the pack content) readable by every signed-in user regardless of the `packs:<id>` entitlement. Delivery happens inside SECURITY DEFINER `pack_apply`. | Column-level SELECT without `artifacts`. Client already read only `pack_id, version`. |
| `verification_sources` | `vs_select` | `provider` and `config` (jsonb used by the edge function) readable by all signed-in users. | Column-level SELECT without them; client already selected 6 safe columns. |

Four of the 61 `policy-true` findings disappear because their INSERT policy is now bounded (`demo_bookings`,
`onboarding_bookings`, `newsletter_subscribers`, `status_subscribers`). The other 57 stay, as reviewed entries below.

## Intentional policies (allowlist)

The machine-readable list is `scripts/security/permissive-allowlist.mjs`; `scripts/security/permissive-allowlist.test.mjs`
fails on any new unreviewed permissive policy and on any stale entry. Aggregates marked [VERIFY] depend on the
producing jobs enforcing a minimum contributor count, which was not checked here.

| Table | Policy | Verdict | Justification |
|---|---|---|---|
| `adn_causes` | `adn_read_causes` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `adn_tests` | `adn_read_tests` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `agent_action_catalog` | `authenticated_select_agent_action_catalog` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `agent_rollback_allowed_tables` | `authenticated_select_rollback_allowlist` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only; shown in the governance UI |
| `ai_transparency_catalog` | `select_ai_transparency_catalog` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only; AI-disclosure text users must be able to read |
| `benchmark_cohort_stats` | `select_benchmark_cohort_stats` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (rows carry contributor_count, size_tier, noise_applied) |
| `community_categories` | `authenticated users view community categories` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `community_replies` | `authenticated users view community replies` | intentional — community | cross-account community by design: any signed-in user reads posts; author_id/author_name are intentionally visible. [VERIFY] product decision; no moderation/hidden state column exists |
| `community_threads` | `authenticated users view community threads` | intentional — community | cross-account community by design (see community_replies); inserts require author_id = auth.uid() |
| `data_regions` | `anyone_read_data_regions` | intentional — public | public region list (residency page); writes are staff-only |
| `diag_domains` | `diag_domains_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `diag_hypotheses` | `diag_hypotheses_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `diag_likelihood_seed` | `diag_likelihood_seed_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `diag_questions` | `diag_questions_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `docs_feedback` | `anyone_can_submit_docs_feedback` | intentional — public form | public docs "was this helpful" form: INSERT-only (SELECT/UPDATE/DELETE revoked), size limits are table CHECKs. No rate limit at this layer |
| `evidence_products` | `select_evidence_products` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `failure_atlas_cells` | `read_failure_atlas_cells` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `failure_atlas_stats` | `read_failure_atlas_stats` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `fie_global_patterns` | `read_fie_global_patterns` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries n_accounts) |
| `fx_rates` | `fx_rates_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `identity_relationship_types` | `identity_reltypes_select` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `identity_value_dimensions` | `read_identity_value_dimensions` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `job_transition_rules` | `select_job_transition_rules` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only (from_status,to_status pairs) |
| `marketplace_scopes` | `authenticated_select_marketplace_scopes` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_documents` | `read_oem_documents` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_equipment_models` | `read_oem_equipment_models` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_failure_patterns` | `read_oem_failure_patterns` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_graph_stats` | `read_oem_graph_stats` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `oem_issue_parts` | `read_oem_issue_parts` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_known_issues` | `read_oem_known_issues` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_manufacturers` | `read_oem_manufacturers` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_model_reliability` | `read_oem_model_reliability` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `oem_parts` | `read_oem_parts` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_recalls` | `read_oem_recalls` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_serial_rules` | `read_oem_serial_rules` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_service_bulletins` | `read_oem_service_bulletins` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oem_warranty_terms` | `read_oem_warranty_terms` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `oin_taxonomy` | `read_oin_taxonomy` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `outcome_cross_tenant_aggregates` | `read_outcome_cross_tenant_aggregates` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries tenant_count, max_tenant_share) |
| `pack_versions` | `read_pack_versions` | intentional row access + **columns restricted (fixed)** | row list is public to signed-in users; the `artifacts` column (pack content) is hidden by column-level SELECT in 20290304000000 and delivered only through SECURITY DEFINER pack_apply. Client reads only pack_id,version |
| `pay_disclosures` | `authenticated_read_pay_disclosures` | intentional — reference catalog | versioned disclosure text that users must be able to read before accepting. [COUNSEL] wording/legal_reviewed status is not asserted here |
| `pen_trades` | `pen_trades_select` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `pii_field_registry` | `authenticated_read_pii_registry` | intentional — internal metadata | read by the tenant Data Governance page (src/lib/dataGovernance.ts). Lists classification metadata only, no data. [VERIFY] product decision to expose it to all signed-in users |
| `platform_backup_runs` | `authenticated_read_backup_runs` | intentional row access + **columns restricted (fixed)** | tenant Data Governance page shows backup status; storage_path, checksum_sha256, table_row_counts, error_message hidden by column-level SELECT in 20290304000000 |
| `platform_restore_drills` | `authenticated_read_restore_drills` | intentional row access + **columns restricted (fixed)** | tenant Data Governance page shows drill status/RTO/notes; row_count_mismatches hidden by column-level SELECT in 20290304000000 |
| `refrigerant_gwp` | `read_refrigerant_gwp` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `roadmap_items` | `select_roadmap_items` | intentional — public | public ideas board incl. admin_note shown on /feedback by design (src/pages/FeedbackPage.tsx); declined items are filtered by the client only. submitted_by (a user uuid) is visible. [VERIFY] product decision |
| `security_report_requests` | `anyone_request_security_report` | intentional — public form | public "request the pentest report" form: INSERT-only to clients; email/company/message have table CHECKs; SELECT is staff-only |
| `service_loop_global_priors` | `read_service_loop_global_priors` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `service_loop_global_totals` | `read_service_loop_global_totals` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count |
| `subprocessor_notices` | `public_read_subprocessor_notices` | intentional — public | sub-processor change notices are published publicly on purpose; writes are staff-only. created_by (staff uuid) is visible |
| `success_feature_catalog` | `success_catalog_read` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `trade_log_types` | `read_trade_log_types` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `trade_packs` | `read_trade_packs` | intentional — reference catalog | global reference catalog (no tenant data); read-only for clients, writes are service-role/staff only |
| `verification_sources` | `vs_select` | intentional row access + **columns restricted (fixed)** | registry list for the UI; provider and config hidden by column-level SELECT in 20290304000000 (edge function reads them with the service role). Client selects id,source_key,label,jurisdiction,kind,active |
| `vertical_intelligence_signals` | `select_vertical_intelligence_signals` | intentional — aggregate | cross-tenant AGGREGATE published by design; no tenant identifiers. [VERIFY] the producing job enforces a minimum contributor count (carries tenant_count) |
| `you_asked_we_built` | `you_asked_select_all` | intentional — public | "you asked, we built" announcements shown to signed-in users |

## Observations not changed (out of scope)

- Public INSERT forms (`docs_feedback`, `security_report_requests`, `newsletter_subscribers`, `status_subscribers`,
  `demo_bookings`, `onboarding_bookings`) have no rate limit at the RLS layer. Add one in an edge function or at the API gateway.
- `community_threads` INSERT only checks `author_id = auth.uid()`; `is_pinned`, `status`, `upvote_count` are client-writable if column
  grants allow it. Not a permissive-`true` finding, so not reviewed. [VERIFY]
- Many policies are written `TO public` with `auth.uid() = …`. They deny a real `anon` caller (`auth.uid()` is NULL) and are not reachable
  without a JWT; the audit test excludes them for that reason.
- `package.json` lines for other audit rules (`policy-unwrapped-auth`, `rls-no-policy`) were not part of this task.

## Verification

| Check | Result |
|---|---|
| `node --test scripts/security/permissive-allowlist.test.mjs` (every finding reviewed, none stale, anon never writes except bounded INSERT, lead tables staff-gated) | **PASSED** (6/6, `npm run test:security:permissive`, static replay of the migrations incl. the new one) |
| `supabase/tests/database/permissive_policies.test.sql` (pgTAP: anon cannot write; unauthenticated reads only on public tables; tenant admin vs staff; column-level SELECT; visitors) | **NOT RUN** — no Postgres available when authored |
| Migration executed / idempotency re-run | **NOT RUN** (static check only: statements split, parentheses balanced) |
| `npm test` (Vitest) still passes with the new `node:test` files under `scripts/` | **NOT RUN** [VERIFY] — same pattern as `scripts/motion` / `scripts/lib`; `vitest` is not installed here |
| `npm run typecheck` for the `dataGovernance.ts` change | **NOT RUN** — dependencies not installed |

Deploy order: client (`src/lib/dataGovernance.ts`) first or together with the migration; an old client doing `select('*')` on the two DR tables
gets "permission denied" afterwards. Rollback is described in the migration header.
