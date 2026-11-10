# Task 5A — Security, tenancy, authN/Z, AI-agent security, payments/webhooks
Date: 2026-11-09 · Auditor mode: read-only, static only · Snapshot: uploaded ZIP (no .git; may be stale — claim to verify against the live tree)

## 0. Verdict
- **Can one tenant read or alter another tenant's data? UNPROVEN.** Proof level: static code only (regex parsers + targeted reads). Nothing was executed: no local Postgres, no Deno, no network were available.
- Static evidence is mostly *strong* (RLS on ~1840 tables, account-scoped policies, fail-closed webhooks, caller-scoped edge-function pattern, E-003/E-012/E-022). It is **not** sufficient to claim isolation.
- **One concrete suspected cross-tenant write path: SEC-01** (definer RPCs taking a tenant id, no guard, never REVOKEd). Exploitability depends on live default privileges → needs the catalog query in `proposed-tests/rpc_exposure_catalog.sql`.
- Release gate: **not production-ready on security grounds** until SEC-01 and SEC-02 are fixed and Section A is verified by execution.

## 1. Coverage honesty
| Area | Status |
|---|---|
| A. Tenant isolation, schema-level | Static, heuristic. RLS enablement and loose policies done; policy predicates created inside `FOREACH … EXECUTE format()` loops **not resolved**. |
| A. Cross-tenant execution | **NOT RUN** (no DB). Scripts in `proposed-tests/`. |
| A. Storage bucket policies, realtime publications, SECURITY DEFINER trigger scoping | **NOT RUN / not scanned.** |
| A. Edge functions IDOR | Sampled: ~35 of 466 read in detail; client-supplied-id grep on the rest. Not exhaustive. |
| B. AuthN/Z (roles, invite/reset, MFA, sessions) | Only the edge-function auth pattern reviewed. Invites, reset, MFA, passkeys, SCIM, impersonation (`staff-impersonate`, `admin-sso`) **NOT REVIEWED**. |
| C. AI-agent security | **NOT REVIEWED in depth.** Only existence of controls noted (see §4). Tool scopes, prompt-injection paths, PII-to-model, cost caps = BLOCKED by time/scope in this pass. |
| D. Payments/webhooks | Stripe + ~25 public webhooks sampled. PCI raw-card scan **NOT RUN**. Refund permissions (`issue-refund`) **NOT REVIEWED**. |
| E. Appsec/supply chain | Secret scan, XSS, CORS, dynamic SQL done. Dependency audit **NOT RUN** (offline). SSRF, uploads, rate limiting **NOT REVIEWED**. |

## 2. Findings
Tags: [VC]=VERIFIED-CODE, [A]=ASSUMPTION, [U]=UNPROVEN (needs execution). Evidence IDs in `evidence-ledger.md`.

| ID | Sev | Likelihood | Blast radius | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|---|---|
| SEC-01 | **High** | Medium–High [U] | Cross-tenant write (pricing surge mode, agent tasks, marketplace queues) | SECURITY DEFINER RPCs that take a tenant id (`p_user_id`) or a bare row id, have **no caller check** and **no REVOKE from PUBLIC** anywhere: `activate_weather_surge`, `record_weather_alert`, `compute_market_intelligence`, `enqueue_marketplace_event`, `claim_agent_task`, `create_agent_task` (+ more; static candidate pool 219, many false positives). `activate_weather_surge` is only `GRANT … TO service_role`, which does not remove PUBLIC's default EXECUTE. [VC] absence of guard/revoke; [U] whether live DB lets `anon`/`authenticated` execute. | E-007, E-008, E-009 | New migration: `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role;` for each service-only RPC; run Q1/Q2 to get the definitive list; add a CI test failing on any definer function executable by anon without an allowlist entry; consider `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon`. | S–M |
| SEC-02 | **High** | Medium | Spoofed inbound messages in a tenant's inbox; outbound WhatsApp via tenant token to attacker-chosen recipient [A: recipient = `message.from`]; KB content disclosure; cost abuse | `whatsapp-webhook` POST accepts any JSON; tenant resolved only from client-supplied `phone_number_id` (not secret); uses service role. `messenger-webhook` already does this correctly (Meta HMAC, fails closed). | E-013, E-012 | Verify `X-Hub-Signature-256` with `META_APP_SECRET` using existing `verifyMetaSignature` from `_shared/dmChannels/protocol.ts`, on the raw body, fail closed; add rate limit per phone_number_id. | S |
| SEC-03 | Medium | Medium | Billing state drift (subscription/dunning) | `stripe-webhook` records event id *before* processing; a handler exception is swallowed with HTTP 200, and Stripe retries then hit the dedupe and are dropped → event permanently lost. | E-014 | Mark event `processing`/`done`; on error delete or flag the row and return 500 so Stripe retries; or process inside the same transaction as the dedupe insert. | S |
| SEC-04 | Medium | Medium [U] | Data/abuse via anon-callable token RPCs | 59 anon-granted RPCs (portal, booking, quote/invoice by token, `get_dashboard_snapshot(text)`, `get_job_room`, `get_project_progress`). Security rests on token entropy and per-RPC checks I did not read; no evidence of DB-level rate limiting/enumeration throttling. | E-010 | Verify token types (uuid v4 / ≥128-bit), constant-shape errors, add throttling at edge/WAF; review each for PII returned. | M |
| SEC-05 | Medium | Medium | Spam/storage abuse | `WITH CHECK (true)` anon INSERT on `demo_bookings`, `status_subscribers`, `onboarding_bookings`, `newsletter_subscribers`, `security_report_requests`, `docs_feedback`; no row-size/rate guard seen. | E-004 | Route through rate-limited edge function or add length CHECKs + captcha/turnstile. | S |
| SEC-06 | Medium | High | Info disclosure across tenants (metadata) | `authenticated USING (true)` on tables that look platform-internal or cross-tenant: `platform_backup_runs`, `platform_restore_drills`, `outcome_cross_tenant_aggregates`, `benchmark_cohort_stats`, `community_threads/replies`, `you_asked_we_built`, `pii_field_registry`, `agent_action_catalog`. Most others (`oem_*`, `diag_*`, `fx_rates`) are plausibly global reference data. | E-004 | Confirm each is intended-global; restrict backup/restore tables to staff; check k-anonymity of aggregate tables. | S |
| SEC-07 | Medium | Medium | Fresh-environment/DR failure (security-relevant: RLS may not be applied) | Migration hygiene: **123 duplicate 14-digit versions (E-023, added in 5B)**, `<timestamp>_daily_briefing.sql` (literal placeholder), two 8-digit-prefix files, 3 files dated 2029 (apply after anything dated later). Ordering/version collisions can break `db reset`/restore or skip RLS statements. | E-019 | Rename to unique 14-digit versions in the correct order (coordinate with already-applied versions); add CI check. | S |
| SEC-08 | Low–Med [U] | Low | Cross-tenant read if helper wrong | 25 views lack `security_invoker`. bi_* views rely on `security_barrier` + `bi_tenant_id()` (SECURITY DEFINER, uses `session_user` for reader roles, else `get_account_owner_id()`). Design is sound on paper; `perf.*` view grants not checked. | E-005 | Run Q4; execute reader-role tests; confirm `perf` schema not exposed via PostgREST. | S |
| SEC-09 | Low | Medium | Secret leakage via logs | `email-webhook` shared secret passed in URL query; payload shape "NOT LIVE-VERIFIED". | E-015 | Use header-based secret/provider signature. | S |
| SEC-10 | Low | — | — | `.env` (anon key, DSN, VAPID public) is in the ZIP though gitignored. Anon-role only; no service key found. Git history **BLOCKED** (no .git). | E-021 | Exclude `.env` from archives; rotate if it was ever committed. | S |
| SEC-11 | Low | Low | — | CORS `*` on 328 functions. Not an auth bypass if auth is Bearer-only [A: no cookie auth]. | E-018 | Restrict to app origins where cheap. | S |
| SEC-12 | Info | — | — | `dangerouslySetInnerHTML` ×3, PodcastPage uses static literals; no user data. | E-017 | Keep static or sanitize. | — |

Not findings (checked): secret-shaped strings are placeholders/test fixtures (E-016); 0 definer functions without `SET search_path` (E-006, heuristic); UPDATE policies without explicit WITH CHECK inherit USING in Postgres; no `EXECUTE '…' ||` concatenation in migrations.

## 3. Positive evidence (facts, not praise)
- Edge-function auth pattern is consistent where read (E-022); webhook signatures verified fail-closed in 12+ functions (E-012); Stripe verified with `constructEventAsync`.
- 72 DB test files exist incl. `rls_catalog.test.sql` — **NOT RUN here**, so maturity stays L2–L3 until executed.

## 4. AI-agent security (limited)
[VC] Controls exist in schema: tenant/global kill switch (`voice_security_controls`: normal/restricted/lockdown), OTP challenges with HMAC digests, rate counters, confirm-before-write `voice_pending_actions`, canaries, immutable audit (`voice_audit_*`, `agent_audit_hash_chain`), `agent_action_catalog`, rollback allowlist. Their *enforcement in code paths* (vapi-webhook tool dispatch, agent-runtime, consumer-agent, site-assistant), prompt-injection handling of caller text/OCR/notes, PII minimisation to models, and cost caps were **not reviewed**. Treat as unverified.

## 5. Top security blockers (ordered)
1. SEC-01 definer RPC exposure (confirm via Q1/Q2 on a local DB, then REVOKE).
2. SEC-02 WhatsApp webhook signature.
3. Execute `proposed-tests/cross_tenant_attack.sql` + existing `supabase/tests/database/*` against a local DB (turns UNPROVEN into YES/NO).
4. SEC-03 Stripe event loss.
5. SEC-04 token-RPC entropy/throttling review.
6. SEC-07 migration ordering/placeholders.
7. SEC-06 platform tables readable by all tenants.
8. Complete sections B, C, D(refunds, PCI), E(deps, SSRF, uploads, rate limits) — not done in this pass.
Only 2 items reach High; no Blocker is *verified*, but isolation is unproven.

## 6. Safe to defer
SEC-09, SEC-10 (after confirming no git history exposure), SEC-11, SEC-12, SEC-05 if forms are low-traffic and monitored.

## 7. Maturity (security capability)
Tenant isolation: L2 (implemented, tests exist but not run by me). Webhook verification: L2–L3 for sampled functions. AI-agent security: L1–L2 (controls exist; enforcement unverified). L5: none found.

## Evidence index
E-001 … E-022 → `docs/audit/evidence-ledger.md`.

## NOT RUN / BLOCKED
- NOT RUN: all DB execution (cross-tenant attacks, `rls_catalog.test.sql`, Q1–Q4), Deno tests, `npm audit`/SCA, build/typecheck.
- BLOCKED: git history (no .git); live Supabase default privileges; storage/realtime configuration; real provider behaviour (Twilio/Stripe/Meta) — mocks only, none run.
- NOT REVIEWED: ~430 edge functions not read line-by-line; invites/reset/MFA/SCIM/impersonation; refunds; PCI scope; SSRF; uploads; rate limiting; AI tool scopes.

## Questions only the founder can answer
1. Is this ZIP identical to the deployed branch? (You said earlier it is an outdated snapshot.)
2. On the live project, did you ever change Supabase default function privileges (`ALTER DEFAULT PRIVILEGES`) or run a bulk `REVOKE … ON ALL FUNCTIONS`?
3. Which WhatsApp/Meta app secret is configured, and is the WhatsApp channel live for any paying tenant?
4. Are `platform_backup_runs` / `community_*` intentionally visible to all tenants?
5. Can I get a local Postgres (or a Supabase branch DB) to execute the attack scripts?
