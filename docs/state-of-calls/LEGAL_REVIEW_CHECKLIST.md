# Legal / privacy review required BEFORE publishing a real edition

Drafts only — not legal advice. Counsel must complete every item; record sign-off in the `review` step of the pipeline (it blocks publishing).

## A. Lawful basis and consent
- [ ] Confirm opt-in consent (checkbox + terms version, logged in `report_consent_events`) is a valid basis in every jurisdiction customers are in (GDPR/UK GDPR, CCPA/CPRA, other US state laws). Decide if consent or legitimate interest applies for the *derivation* step (aggregating customer data), separately from publication.
- [ ] Confirm anonymization standard: the pipeline is practical statistical disclosure control (k ≥ 10, dominance ≤ 35%, ≥ 100 events, rounding, 4 regions), **not formal differential privacy**. Counsel/DPO decide whether outputs count as anonymous (non-personal) data.
- [ ] Decide if a DPIA / legitimate-interest assessment is needed.
- [ ] Confirm the wording of "withdrawal applies to future editions; published aggregates are not recalculated" and the retention of the consent ledger (cascade-deleted with the account).

## B. Contracts
- [ ] Review `TOS_DPA_DRAFT_CLAUSES.md`; add to Terms, DPA/GDPR-DPA and Privacy Policy; bump `REPORT_TERMS_VERSION` in `src/lib/stateOfCalls.ts`.
- [ ] Vireek as processor vs. controller for the derived statistics; sub-processor list unchanged?
- [ ] Enterprise / white-label / franchise agreements: do any prohibit using their data for aggregates? Exclude those accounts (they simply must not opt in) or amend.
- [ ] Customers' own customers: callers are third parties. Confirm call-recording/AI-disclosure notices cover derivation of anonymous counts.

## C. Existing, separate exposure (found while reading the code — decide independently of this report)
- [ ] `compute_platform_benchmarks`, `compute_regional_demand`, `get_benchmark_comparison` share cross-tenant aggregates with **no explicit consent**; `outcome_benchmark_settings.participating` **defaults to true (opt-out)**. Confirm the Terms/Privacy text covers these in-product benchmarks. This report deliberately does not read them.
- [ ] `supabase/functions/data-retention-sweep/index.ts` imports `@/components/trust-pack/SealedContent` (a frontend alias) inside a Deno function; it will not resolve at deploy. Fix before relying on retention sweeps.
- [ ] `OWNED_TABLES` lists `calls.caller_number` but the table column is `caller_phone`; anonymization of that column may silently not happen.
- [ ] DSAR access exports: confirm `report_consent_events` / `report_contribution_settings` appear in a data-subject access export (not verified in this review).

## D. Publication
- [ ] Claims review: "anonymized", "opt-in", "no personal data" are accurate as worded; no ranking/endorsement of named trades or regions; no causal claims; no "industry-wide" claims (contributors ≠ random sample).
- [ ] Expert quotes: written permission, approved wording. Press kit and social cards reviewed.
- [ ] Embeds/CSV licence terms (attribution, no re-identification attempts) added to the page footer/terms.
- [ ] Withdrawal procedure approved (`withdraw` action) and the contact point for take-down requests published.
- [ ] Re-identification risk review of each edition's disclosure report (suppression counts) and of any quarterly-vs-annual differencing.
