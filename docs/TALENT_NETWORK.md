# Talent Network

Job board and vetted worker network for tradespeople, built into the existing tenant model.

| Piece | Where |
|---|---|
| Schema, RLS, RPCs, storage bucket | `supabase/migrations/<ts>_talent_network.sql` |
| Orchestrator (reference emails, background-check start) | `supabase/functions/talent-network` |
| Provider webhook (Checkr) | `supabase/functions/talent-background-webhook` (`verify_jwt = false`) |
| Pure logic + tests | `supabase/functions/_shared/talent-network/engine.ts`, `src/lib/talentNetwork.ts` |
| Public pages | `/talent`, `/talent/jobs/:slug`, `/talent/reference/:token` |
| Worker portal | `/talent/me` |
| Business dashboard | `/dashboard/talent` (owner, `can_manage_team` or `can_view_billing`) |

## Flow

1. Worker signs up (normal Vireek account), creates a profile, accepts the sharing terms, adds licenses/certifications (optional document upload) and references.
2. Business publishes a **job** or an overflow **gig**. Publishing requires a pay range, a location, gig dates, and a finished Vireek onboarding.
3. Worker applies. A snapshot of what was shared is stored with the application (consent evidence). Businesses can read a worker only through an application to their own posting.
4. Business moves the applicant through Reviewing → Interview → Offer, verifies licenses against the issuing board and records an attestation, reads references.
5. **Background check** (if the posting requires it) can start only at the Offer stage. The candidate authorizes it in the provider's hosted flow. Vireek stores status and clear/consider only.
6. `consider` forces an individualized-assessment note. Adverse action follows: record the pre-adverse notice, wait 5 business days, then finalize. A hire is blocked while the check is unresolved and this block cannot be overridden.
7. **Hire** (one transaction): pending technician account (`team_members`), payroll record (`employees`), verified credentials copied into `technician_credentials` (feeds the existing compliance dispatch gate), engagement checklist. The client then emails the standard team invite via `send-team-invite`.
8. Business tracks onboarding (agreement, W-4/W-9, I-9 for W-2, direct deposit). Only completion timestamps are stored.
9. When the engagement ends, both sides rate. Ratings are double-blind: visible when both submit or 14 days after completion.

## Deploy checklist

1. Run the migration (rename the file so its timestamp is newer than your latest migration).
2. Deploy functions: `supabase functions deploy talent-network` and `supabase functions deploy talent-background-webhook --no-verify-jwt`.
3. Add to `supabase/config.toml`:
   ```toml
   [functions.talent-background-webhook]
   verify_jwt = false
   ```
4. Set secrets (below).
5. Schedule the daily credential sweep (SQL, no HTTP needed):
   ```sql
   select cron.schedule('talent-credential-sweep', '15 6 * * *', $$select public.talent_sweep_credentials()$$);
   ```
6. Optional: add `/talent` to `scripts/seo/routes.mjs` so it is prerendered and in the sitemap.

## Required provider credentials

| Secret | Required for | Notes |
|---|---|---|
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Reference request emails | Same Resend account as other mail. Without it the "Request" button returns "Email is not configured". |
| `SITE_URL` | Links inside reference emails | e.g. `https://vireek.com` |
| `CHECKR_API_KEY` | Background checks + webhook signature | Optional. Without it the feature reports "not configured" and posting flags still work as policy. Use the **staging** key first. |
| `CHECKR_DEFAULT_PACKAGE` | Which screening package to order | Package slug configured in your Checkr dashboard (e.g. `tasker_standard`). |
| `CHECKR_API_BASE` | Staging/testing | Defaults to `https://api.checkr.com/v1`. |

Checkr dashboard: create the webhook `https://<project>.supabase.co/functions/v1/talent-background-webhook` and subscribe to `invitation.completed`, `invitation.expired`, `report.created`, `report.completed`, `report.suspended`, `report.canceled`.

> The Checkr request shapes and the `X-Checkr-Signature` HMAC scheme were written from Checkr's public API documentation and could not be exercised against a live account here. Confirm them against the current docs in staging before enabling in production. The adapter is isolated in two small functions, so another provider (Sterling, GoodHire, Certn) is a contained change.

Not provided: automated primary-source license lookup. Verification today is the hiring business's attestation (recorded per company). `talent_system_set_credential_verification` is ready for an automated checker to call with the service role.

## Legal review points (have counsel sign off before launch)

1. **FCRA / consumer-reporting-agency risk.** Vireek must not assemble worker data and furnish it to businesses for employment decisions. The design keeps workers in control (profile shared only by their own application), uses the provider as the CRA, and stores no report content. Counsel should confirm this keeps Vireek outside CRA status, including ratings and references shown to businesses.
2. **Background-check process.** Stand-alone disclosure and written authorization are delivered by the provider's hosted flow. Pre-adverse and adverse-action notices must be sent by the employer or provider; Vireek only records the steps and enforces a 5-business-day wait (confirm the right waiting period per state/city).
3. **Fair-chance / ban-the-box laws** (e.g. CA, NYC, IL, many others). Checks are blocked until a conditional offer. Confirm local rules on timing, individualized assessment content, and notices.
4. **Worker classification.** `1099` gig engagements can be misclassified (ABC-test states such as CA, MA, NJ). Vireek flags it; classification is the business's legal call.
5. **Pay transparency.** Publishing requires a pay range. Confirm per-state content rules (benefits, how ranges are stated).
6. **Anti-discrimination.** Requirements must be job-related. Consider adding posting-content guidance and an EEO statement. No demographic data is collected.
7. **I-9, W-4, W-9, SSNs.** Never collected or stored. Employers must not demand I-9 documents before hire; the checklist records completion only.
8. **Privacy (GDPR/CCPA/others).** Workers can export and delete their data (`talent_export_my_data`, `talent_delete_my_profile`). Businesses retain hiring records (EEOC/OFCCP and state retention periods) after a worker deletes. Confirm retention periods, the privacy notice text, and the consent copy shown at profile creation (`TERMS_VERSION = 'v1'`).
9. **References.** Responses are confidential from the worker. Referee identity is self-reported by the worker. Confirm disclosure language and defamation exposure; consider a referee consent line.
10. **Ratings.** Double-blind, with a 14-day reveal. Confirm moderation and dispute policy (no edit/delete flow exists yet) and the effect of ratings on gig access.
11. **Licensed-work rules.** `requires_license` is a hire gate, not legal advice on supervision, apprenticeship or reciprocity.
12. **Terms of service** for the board: who is the contracting party, platform fees (none today), indemnities, and prohibited postings.

## Operational notes

- Credential documents live in the private bucket `talent-docs`, readable by the owner and by a business only while an application from that worker is active.
- `talent_*` functions are deny-by-default; the allow-lists are at the bottom of the migration and asserted by `src/lib/talentNetworkMigration.test.ts`.
- Provider webhooks are idempotent (`talent_provider_events`).
- Refreshing a background check after failure is allowed up to 3 checks per application.
