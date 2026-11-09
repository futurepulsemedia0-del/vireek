# Vireek — Platform Readiness Audit

**Type:** read-only audit (the audit itself changed no code).
**Date:** 2026-11-08
**Evidence source:** the `vireek-main.zip` snapshot (per the owner it differs from the live code; every finding must be re-verified against the live repository).

## 0. Method and limitations (honest)

- **Done:** static analysis with `grep` and targeted reads of 720 migrations, 461 edge functions, `src/`, CI workflows, `ARCHITECTURE.md` and `docs/FEATURE_FLAGS.md`.
- **Not done (NOT RUN):** running tests, lint, typecheck, build; connecting to a real database; `EXPLAIN`; checking RLS on a live database; running k6/Lighthouse.
- Counts based on regex are **approximate** (for example, RLS enabled through a `DO $$ ... format(...)` loop is not seen by a direct count). Any number labelled "heuristic" must be confirmed.
- There is no `CLAUDE.md` in the repo; `ARCHITECTURE.md`, `ENVIRONMENT.md`, `RUNBOOK.md` and `docs/FEATURE_FLAGS.md` were read instead.
- **Naming note:** the tenant owner column in this repo is `user_id` (the account owner's id), not `accountOwnerId`. Counts in edge functions: `.eq("user_id"` = 1290 vs `.eq("account_owner_id"` = 90.

## 1. Scored matrix (0 to 3)

0 = absent · 1 = partial/fragile · 2 = good with specific gaps · 3 = ready for multi-product

| # | Area | Score | Confidence | Key evidence |
|---|---|:-:|:-:|---|
| 1 | Tenant isolation | **2** | medium | `get_account_owner_id()` used in 515 migrations; about 2,687 `CREATE POLICY`; 1,649 tables with explicit RLS (heuristic); 0 tables whose creating migration never mentions RLS (file-level heuristic). Weaknesses: 391 of 461 functions use the service role with manual scoping; `FORCE RLS` count is zero; the owner column name is inconsistent; no automated test enforces "every query is scoped". |
| 2 | Module entitlements / flags | **1** | high | `feature_flags` plus per-tenant overrides (`docs/FEATURE_FLAGS.md`), but only 5 files in `src/` use `useFeatureFlag` and 0 edge functions read flags; the doc itself says flags are client-visible. No per-account module registry/entitlement found. The only plan gating is `profiles.plan` (text, default `starter`) and `planAllowsWhiteLabel` in `src/lib/whiteLabel.ts`. |
| 3 | Billing / subscription | **2** | medium | `create-checkout-session`, `create-billing-portal-session`, `manage-subscription-plan`, `manage-subscription-cancellation`, `stripe-webhook` (signature plus `billing_events` dedupe), Stripe Connect. Weakness: the dedupe-before-process pattern (gap 2 below); no usage/metering model found (UNVERIFIED). |
| 4 | Identity and roles | **2** | medium | `profiles.role` = owner/admin/member, `profiles.is_staff`, `team_members.permissions` (jsonb), MFA (`_shared/mfa`), migration `20270415000000_universal_identity_layer.sql`. Weakness: only 4 team permission flags (`can_view_billing`, `can_manage_team`, `can_edit_business_profile`, `can_view_all_jobs`) per `20260821101104_create_profiles_and_team_members.sql`. |
| 5 | Permission model for AI agents | **2** | medium | `_shared/governance/agentGovernance.ts`: `authorizeAgentAction` is **fail-closed**, with an approval queue, spend limits, `beforeState`/`rollbackPatch`. `mcp-server` uses `vrk_agent_…` keys with per-tool scopes and every query pinned to `ownerId`; writes go through governance. `api-v1` uses `api_keys.scopes`. |
| 6 | Event / outbox / webhook | **2** | high | Excellent outbound: `webhook-outbox-worker` (`FOR UPDATE SKIP LOCKED` plus lease, backoff with jitter, `Retry-After`, SSRF check, DLQ, v1 signing, secret rotation). Inbound: signatures in stripe/vapi and others, but the idempotency pattern is not uniform. `20260924000000_developer_platform_event_bus.sql` exists. |
| 7 | Audit logging | **2** | medium | `audit_log` (append-only for clients), flag audit, agent decision log and `ai_decision_records`, `billing_events`. `agent_action_log` has a tamper-evident hash chain (`20290201000000_agent_audit_hash_chain.sql`). Weakness: only 19 functions write to `audit_log`; UPDATE/DELETE protection on other sensitive tables (such as `billing_events`) is not uniform. |
| 8 | Integration framework | **2** | medium | `_shared/connector-kernel/kernel.ts` (with tests), QBO/Xero/NetSuite/Intacct/PM sync, OAuth callbacks. Weakness: hundreds of per-integration functions; a uniform adapter plus mock for every third party was not confirmed. |
| 9 | i18n / currency / tax / timezone / units | **1** | high | i18n: 10 locales including fa/ar (RTL). Currency: a `currency` column with a CHECK in only 12 definitions; 179 files in `src/` hardcode `USD`; 15 occurrences of `currency: 'usd'` in edge functions. Tax: `sales_tax`, `tax_center` (US-centric). Timezone: 14 tables default to `America/New_York`. Units (metric/imperial): no unified system found. |
| 10 | Observability | **2** | medium | `src/lib/sentry.ts`, `_shared/observability/*` (OTLP, requestTrace, redact, alertRules), 280 functions with structured JSON logs. Weakness: SLOs/alerts on money paths not confirmed. |
| 11 | Error handling | **2** | medium | Governance is fail-closed; `_shared/http/retry.ts`; but `stripe-webhook` swallowed errors and returned 200. |
| 12 | Security | **2** | medium | Webhook signatures, `timingSafeEqual`, `CRON_SECRET`, `_shared/http/rateLimit.ts` plus the `edge_security_primitives` migration, CI: gitleaks/CodeQL/npm audit. A simple secret search found only test fixtures. Weaknesses: CORS `*` on 324 functions (acceptable for token-based APIs but should be reviewed), JWT config drift (gap 1), `marketing-track` (gap 4). |
| 13 | Performance hotspots | **1** | low | Indicators only: 678 `.select('*')` in `src/`; of 2,419 `CREATE INDEX`, only 765 start with `user_id` (heuristic); 7 tsx files over 60 KB. Positives: `db-perf.yml`, `k6-load.yml`, bundle budget. N+1 and real indexes cannot be confirmed without a database. |
| 14 | Test coverage of critical paths | **2** | medium | 1,016 test files, 39 pgTAP files in `supabase/tests/database`, 66 e2e specs, `npm run test:edge` for the money layer (estimate-recovery, money-recovered, payment reminders, warranty deadlines). Weaknesses: default coverage threshold is 10% (`vite.config.ts`); no automated tenant-scoping test. |

**Total:** 24 of 42 — a strong foundation, but for a multi-product future (payments / agents / supply / financing) it has four structural gaps: entitlements, inbound idempotency, currency/units, and delegation to agents.

## 2. Top 10 gaps (risk × cost-to-fix)

| Rank | Gap | Risk | Cost | Evidence |
|:-:|---|:-:|:-:|---|
| 1 | **JWT config drift:** the header of 125 functions says `--no-verify-jwt`, but `supabase/config.toml` has only 57 `verify_jwt=false` entries (including `stripe-webhook`, `vapi-webhook`, `api-v1`, `mcp-server`, `qbo-webhook`). Auto-deploy is currently off and its precondition (all webhooks listed in config) is not met; once enabled, those webhooks would get 401. | high | S | `.github/workflows/edge-functions.yml` (job `deploy`), `supabase/config.toml` |
| 2 | **`stripe-webhook`: dedupe before processing plus swallowed errors.** The event is inserted into `billing_events` before the handler runs; if the handler fails, 200 is returned and Stripe's retry no longer has any effect, so a side effect (dunning/suspension) is lost forever. If the insert fails with a non-23505 error, processing continues (re-processing possible). | high | S | `supabase/functions/stripe-webhook/index.ts` lines ≈190–210 and 352–365 |
| 3 | **No per-account entitlement layer.** Flags are client-visible and not read in edge functions; the plan is just a string. Every new product (payments, agents, supply) needs a server-side gate. | high | M | `docs/FEATURE_FLAGS.md`, `src/lib/whiteLabel.ts`, `profiles.plan` |
| 4 | **`marketing-track` is public, uses the service role and takes `user_id` from the body**, with no rate limit and no ownership validation, allowing fabricated rows in any tenant's attribution data. | medium | S | `supabase/functions/marketing-track/index.ts` |
| 5 | **Manual tenant scoping in 391 service-role functions** and an inconsistent column name (`user_id` 1290 / `account_owner_id` 90); no automated gate. 10 functions take the owner from input (`agent-runtime`, `chat-alerts-dispatch`, `escalate-emergency`, `fraud-admin`, `intacct-connect`, `knowledge-embed`, `lifecycle-touch-tick`, `marketing-track`, `operational-truth`, `trust-vault`). Most are protected by a secret/staff check, but `knowledge-embed` has no explicit authentication in code (gateway only, and the anon key is a public JWT) — **needs verification**. | high | M–L | the grep above; `supabase/functions/knowledge-embed/index.ts` |
| 6 | **Delegation to agents:** an agent/MCP key should be bound to a delegating human, expiry, aggregate cap and instant revoke; team permissions have only 4 flags. | high (for payment agents) | M | `mcp-server/index.ts`, `agentGovernance.ts`, `team_members.permissions` |
| 7 | **Currency/units/tax:** USD hardcoded in 179 frontend files and 15 edge occurrences; tax is US-centric; no unit system. Blocks international payments and supply. | medium | L | `src/` (`'USD'`), `supabase/functions` (`currency: 'usd'`) |
| 8 | **Inbound idempotency is not uniform** (Stripe uses a table, the rest are ad hoc). Needed: a shared `inbound_webhook_events(provider, event_id, status, processed_at)` table with `received/processed/failed` states. | high | M | `stripe-payment-webhook`, `qbo-webhook`, `xero-webhook`, `vapi-webhook`… |
| 9 | **Audit coverage** for sensitive actions (payments, role changes, API keys, agent actions) is uneven; immutability exists only on some tables. | medium | M | 19 functions with `audit_log`; trigger migrations |
| 10 | **Performance without evidence:** 678 `select('*')`, incomplete `user_id` indexes (heuristic), coverage threshold = 10%. | medium | S–M (measurement) | `src/`, `supabase/migrations`, `vite.config.ts` |

## 3. Minimal fix plan (in order)

1. **(S)** A CI script that compares each function's `--no-verify-jwt` header with `config.toml` (based on `scripts/gen-docs-catalogs.mjs`), then complete `config.toml`. Do not turn on `EDGE_DEPLOY_ENABLED` until then.
2. **(S)** Fix `stripe-webhook`: `status/processed_at` columns on `billing_events`; mark processed after success; return 500 on failure so Stripe retries.
3. **(S)** `marketing-track`: rate limit with `_shared/http/rateLimit.ts`, check that `user_id` exists, limit field sizes. `knowledge-embed`: add an explicit secret/JWT-user check (after confirmation).
4. **(M)** A shared `inbound_webhook_events` table and helper; migrate the money webhooks (stripe, pay, financing) to it.
5. **(M)** Server-side entitlement layer: table `account_modules(owner_id, module_key, enabled, source, expires_at)` plus RPC `has_module(key)` plus an edge helper, default OFF; flags only for rollout, not for security.
6. **(M)** Tenant-scoping gate: (a) a generic pgTAP test that lists every `public` table and reports RLS/policy state; (b) a lint/CI script that flags any `.from()` in service-role functions without `user_id`/`account_owner_id`; (c) an explicit allowlist for approved exceptions.
7. **(M)** Agent delegation model: `agent_delegations(key_id, delegator_user_id, scopes, max_amount_cents, expires_at, revoked_at)` and a check in `authorizeAgentAction`.
8. **(M)** An audit standard for sensitive actions, plus an anti-UPDATE/DELETE trigger on `audit_log`/`billing_events` (without changing current behavior).
9. **(S–M)** Performance measurement: run `db-perf.yml`, `EXPLAIN` on the 20 most frequent queries, report incomplete `user_id` indexes, raise the coverage threshold on money paths.
10. **(L)** Currency/units: `account_settings.currency/unit_system`, a shared formatting util, gradual removal of hardcoded USD; tax only after a business decision (**REQUIRES COUNSEL**).

## 4. "Do NOT build yet" list

- A marketplace or independent execution of agents with real money — until delegation (7) and entitlements (5) exist.
- Multi-currency/international payments and a global tax engine — until the target market is decided and counsel has been consulted.
- New trade packs and supply/financing on the current structure — until the tenant-scoping gate (6) and idempotency (4) exist.
- A new public API version or SDK — until JWT drift (1) is closed and the contract (`api-v1/contract.ts`) is final.
- New third-party integrations without an adapter plus mock (the repo's rule).
- Rewriting RLS or migrating the column name `user_id → account_owner_id` — high risk, little benefit; add a gate and documentation instead.
- Any compliance claim (PCI, SOC2, tax, regulation) — **REQUIRES COUNSEL**.

## 5. Open questions (only the founder can answer)

1. What is the next product priority: payments, agents, supply or financing? (The fix order depends on it.)
2. How are plans and modules priced: per seat, usage or bundle? (This determines the entitlement/metering design.)
3. Which markets outside the US, and when? (Currency, tax, units.)
4. How much money may agents spend without human approval, and who is liable?
5. Does the live repo differ materially from this snapshot in migrations/functions? (Needed to confirm all numbers.)
6. Is `EDGE_DEPLOY_ENABLED` on today, and how is deployment done now (manual CLI with `--no-verify-jwt` or CI)?
7. Does the production database give access to `pg_stat_statements` or a slow-query log so gap 10 can be closed with data?

## 6. UNVERIFIED items

Running tests/lint/typecheck; RLS on a live database; existence of metering; existence of an adapter plus mock for every third party; accuracy of the heuristic numbers; the real gateway behavior for functions not listed in `config.toml`; the full schema of agent keys.

## 7. Remediation status (final update, 2026-11-08)

| Gap | Status | Notes |
|:-:|---|---|
| 1 | Code ready, not applied | `scripts/sync-verify-jwt.mjs` plus CI. In the snapshot `config.toml` is **invalid TOML** (3 duplicate tables). 3 functions need human review: `analyze-equipment-lifecycle`, `careers-sitemap`, `state-of-calls-public`. |
| 2 | Code and migration ready | `claim_billing_event` / `complete_billing_event` plus `throwOnError`. |
| 3 | Code and migration ready | `account_modules` (default OFF, only service_role writes, automatic audit), `has_module` / `has_module_for`, helper `_shared/entitlements/modules.ts`. **No module is wired to it yet** (needs a product decision). |
| 4 | Code ready | `marketing-track`: validation, rate limit, clamping. |
| 5 | Code ready plus review | `knowledge-embed` and `escalate-emergency` fixed. `intacct-connect` (`user_id` is the Intacct user, not the tenant), `operational-truth`, `agent-runtime`, `chat-alerts-dispatch`, `lifecycle-touch-tick` were reviewed and had no issue. `fraud-admin` and `trust-vault` were only skimmed (UNVERIFIED). |
| 6 | **Audit correction** plus a real bug | Agent keys already had `expires_at`, `revoked_at`, `daily_call_limit` and `created_by`; gap 6 was over-rated. Real bug: `mcp-server` did not pass the amount to `authorizeAgentAction`, so `agent_spending_limits` and `auto_approve_max_cents` were never applied to external agents. Fixed (`amountCents`). |
| 7 | Not done | `src/lib/currency.ts` and `format.ts` already exist (display of 7 currencies at fixed rates). The real problem: 10 duplicated `formatMoney`/`formatCents` functions and `currency: "usd"` in `mcp-server`. Must not be built without a founder decision on account currency. |
| 8 | **Audit correction** | `pay-webhook` uses a state-machine RPC and is naturally idempotent. The only real case was Stripe (fixed). `phone-payment-webhook`, `financing-webhook`, `bank-webhook`, `qbo-webhook`, `acct-webhook` were not reviewed (UNVERIFIED). |
| 9 | Not done | `agent_action_log` has a hash chain. An anti-delete trigger on `billing_events` was intentionally not built (its status must be updated) and on `audit_log` it is risky without checking retention jobs. |
| 10 | Tool, evidence and 6 indexes | `scripts/perf-index-audit.mjs`: of 1,460 tenant tables, 310 lack a leading index (heuristic) — list in `01-tenant-index-review-list.md`. Only 6 high-volume tables received `CONCURRENTLY` indexes. |

Audit correction: row 7 of the matrix originally omitted the hash chain; gaps 6, 7 and 8 were reported larger than reality in the first version.
