# Terms acceptance evidence, grace period and staff history

Extends `docs/LEGAL_TERMS_VERSIONING.md`. Migration: `supabase/migrations/20290312000000_terms_acceptance_evidence.sql` (run after `20290306000200`). Status: **code delivered, not executed**. All user-facing wording is **[COUNSEL]**.

## What is recorded
Every acceptance row now holds: user, document key + version, `accepted_at`, `source`, **`content_sha256`** (copied from the version at the moment of acceptance), **IP address** and the header it came from (`ip_source`), **user agent**, **`account_owner_id`**, and a whitelisted `context` (`plan_id`, `from_plan_id`, `billing_interval`, `authority_confirmed`, `signer_title`).

| Moment | source | Written by |
|---|---|---|
| Sign-up checkbox | `signup` | `accept_current_legal_documents` (terms + privacy; MSA excluded) |
| Re-acceptance screen | `gate` | `accept_legal_versions` |
| Plan change / new checkout (`/dashboard/billing/plans`) | `plan_change` | `record_legal_click_through` (terms), before the money call, best effort |
| MSA click-through (`/msa`, signed in) | `msa_click_through` | `record_legal_click_through` (msa), must succeed |

Click-throughs are separate evidence events (not one row per version) and **do not clear a pending re-acceptance** [COUNSEL].

## Gate and grace
`legal_gate_settings.grace_days` (default **0** = unchanged: blocked from the effective date). With N days, a material version blocks at `effective_at + N`; until then the user sees a banner and may accept early at `/legal/accept`. `non_gating_doc_keys` (default `{msa}`) lists documents that never gate: the MSA binds only customers who signed it.
Change the grace on `/staff/legal-terms` (reason required, audit-logged `legal_grace_days_changed`).
**Limit:** the block is a client route gate (`ProtectedRoute`), like the MFA gate. It does not stop direct API calls. Server-side enforcement on money or voice paths is an open decision.

## Document hash
`node scripts/legal/hash-legal-doc.mjs <file>` hashes the exact published text (normalised newlines). Pass it as `p_content_sha256` to `publish_legal_document_version`. Baseline versions have **no hash**; their acceptances record none. `/staff/legal-terms` marks missing hashes.

## Staff history
Account panel (`/staff/customers` -> account) shows the history; each read is audit-logged (`legal_acceptance_history_viewed`). RPC: `staff_legal_acceptance_history(user_id | email, doc_key, limit, before)`.

## IP and user agent: privacy and reliability
- [VERIFY] The IP comes from request headers seen by PostgREST (`cf-connecting-ip`, `x-real-ip`, first `x-forwarded-for`). Which one your Supabase gateway sets authoritatively is unverified; `ip_source` shows what was used. Unparseable values are stored as NULL.
- Personal data. Retention period and lawful basis: TODO(counsel). Redaction: `staff_redact_legal_network_data(p_before, p_user_id, p_reason)` nulls IP/UA/source only; hash, version and time stay.
- Update the privacy policy text if it does not already cover this. TODO(counsel)

## Not covered
Onboarding plan step (`src/pages/onboarding/PlanStepPage.tsx`) has no agreement line, so it records nothing; owner-only restriction for the MSA click-through; MSA signer name capture; mandatory hash on material versions; Playwright end-to-end test; translations of the new strings by native legal reviewers.

## Tests
`supabase/tests/database/legal_terms_evidence.test.sql` (pgTAP, 42 assertions), `src/lib/legalEvidence.test.ts` (Vitest). Existing `legal_terms_versioning.test.sql` should still pass (same behaviour at grace 0). **None executed by the author.**
