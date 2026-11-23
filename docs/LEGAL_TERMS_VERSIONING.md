# Legal document versioning and re-acceptance

Migration: `supabase/migrations/20290306000200_legal_terms_versioning.sql`. Status: **code delivered, not yet deployed or executed**.
All wording below and in `src/locales/*/legalAcceptance.json` is **[COUNSEL]**: it must be reviewed before customers see it.

## What existed before
Only a client-side checkbox on `/signup` (not recorded) and `consent_records` (cookie consent). No versions, no acceptance proof, no gate.
The legal text itself lives in `src/components/sections/TermsContent.tsx` / `PrivacyContent.tsx` (routes `/terms`, `/privacy`) and
`src/lib/legalDocs/*`; this feature does not move it.

## Model
- `legal_document_versions`: immutable once published; `(doc_key, version)` unique and sequential; `effective_at` strictly increasing;
  `is_material`; `changes` = diff summary `[{section, kind: added|changed|removed, summary, i18n?: {lang: summary}}]`;
  `content_path` (same-site route), `content_sha256` (optional hash of the published text); who published and who confirmed legal review.
- `legal_acceptances`: append-only `(user, version, timestamp, source)`; no IP or user agent stored; survives account deletion (`user_id` set null).
- Seeded baselines: `terms` v1 (2026-08-20) and `privacy` v1 (2026-10-31), taken from the "Last updated" lines of the current pages; not material, no counsel confirmation recorded.

## The gate
`legal_acceptance_status()` returns `must_accept` when a published, **material**, already-effective version is newer than the newest version the
user accepted. With no record, the user is deemed to have accepted the version in force when their profile was created **[COUNSEL]** (weaker
evidence than a record; signup also writes an explicit one). Non-material versions never gate.
`ProtectedRoute` redirects to `/legal/accept` (after MFA, before any product page). `/legal/accept`, `/terms` and `/privacy` stay reachable.
The screen shows the diff summary per document in the viewer's language (fallback: the English text), links to the full document and records
acceptance through `accept_legal_versions()` (atomic, idempotent, only effective versions). The hook fails **open** on a read error (same trade-off
as the MFA gate); the record itself is written server-side. A clean "ok" is cached for 5 minutes per tab.

## Publishing a version (staff)
```sql
select public.publish_legal_document_version(
  'terms', 2, 'Terms of Service', now() + interval '30 days', true,
  '[{"section":"Billing","kind":"changed","summary":"Annual plans renew at the then-current price.","i18n":{"fa":"…"}}]'::jsonb,
  '<sha256 of the published text>', '/terms', true);
```
Rules: staff only; legal-review confirmation required (the DB records who confirmed, it does not assert that review happened); a material change needs a
diff summary and 30 days notice (`legal_material_notice_days()`, **proposed default, unvalidated [COUNSEL]**) unless a written waiver reason (>= 10 chars) is
given; both are audit-logged (`legal_document_published`, `legal_terms_accepted`). Update the visible "Last updated" date and text of the page in the same release.
Corrections are a new version; published rows cannot be edited or deleted. `staff_legal_documents()` lists versions with accepted/pending counts.

## Signup
`SignupPage` calls `accept_current_legal_documents('signup')` when a session exists (allowed only for accounts created in the last 24 hours, so it cannot be used
to skip the screen later). With email confirmation there is no session yet; the gate handles the first login.

## Not built (decisions needed)
Staff UI for publishing (SQL/RPC only), advance-notice banner/email before `effective_at`, per-document acceptance for team members acting for an owner
(each person accepts for themselves), Playwright end-to-end test, translations reviewed by native legal reviewers.

## Tests
`supabase/tests/database/legal_terms_versioning.test.sql` (pgTAP), `src/lib/legalAcceptance.test.ts`, `src/i18n/legalAcceptanceKeys.test.ts` (Vitest).
