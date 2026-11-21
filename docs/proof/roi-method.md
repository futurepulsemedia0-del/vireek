# Customer outcome proof kit: ROI method (`roi-method-v1`)

Code: `src/lib/outcomeProof/` · Database: `supabase/migrations/20290309000000_outcome_proof_kit.sql` · Page: `/dashboard/outcome-cases`
Related: `docs/brand/category-narrative.md` §7, `docs/brand/analyst-plan.md` (gate G3), `BRAND_GOVERNANCE.md` §3 and §6.
**[COUNSEL]** = needs a lawyer. **[VERIFY]** = not proven here. Nothing in this file is legal advice.

## 1. What it is, and what it reuses

The results ledger (`value_events`, migration `20271121000000`) already stores each recovered-revenue, saved-time and avoided-cost figure with an `evidence_ref`, a `measured`/`estimated` flag, and the owner's review decisions. `src/lib/customerStories.ts` already labels the public stories "illustrative" until consent is recorded, and `value_settings.case_study_consent` is a coarse account-level opt-in.

The kit adds only what was missing for a publishable case study: a frozen snapshot of the ledger rows behind a figure, per-case scoped and revocable consent bound to that snapshot, an append-only audit trail, and a verification level. It does not change the ledger, the settings, or the existing stories.

## 2. Inputs and selection (done in SQL, `outcome_case_create`)

| Rule | Detail |
|---|---|
| Tenant | `get_account_owner_id()`, never an argument. Needs `reports_can_access` (owner, or member with `can_view_billing`) |
| Period | Inclusive UTC dates, at most 366 days, must end before today |
| Events | All ledger events of the account with `occurred_at` in the period are copied into the snapshot, included or not |
| Excluded: `owner_review_not_due_to_vireek` | The owner's newest review of the event says "not due to Vireek" |
| Excluded: `superseded_by_measured` | An estimate that a measured event of the same type names in `supersedes_ref` (no double counting) |
| Excluded: `other_currency` | A money event whose currency differs from the case currency (no conversion is attempted) |
| Cost | The owner-entered figure, else the account's `subscription_cents_override`, else none |

These selection rules mirror `value_effective_events()`. Excluded rows stay in the snapshot with their reason.

## 3. Arithmetic (`computeOutcome`, TypeScript)

- Money = `recovered_revenue` + `avoided_cost`, integer minor units.
- **Low** = measured money only. **High** = measured + estimated money. The result is a range.
- **ROI** = (value − cost) / cost for each end of the range. It can be negative and is not clamped.
- Saved time is reported in minutes and is **not** converted to money (no hourly rate is assumed).
- **No number is shown** if any of these hold: cost unknown; fewer than 5 measured money events (estimates do not count toward the minimum); period shorter than 28 days. The reasons are listed in the output.
- No annualising, no extrapolation, no averaging across customers, no rounding up.
- The minimum of 5 matches `DEFAULT_ROI.minOutcomes` in `supabase/functions/_shared/economics/roi.ts`; a test keeps them equal.

Limits of the method (state them to anyone who asks): measured value is what the ledger recorded as paid or confirmed, not proof that Vireek caused it; the cost is the owner's recorded figure; the ledger's own attribution rules apply (`docs/_audit/proof-of-value.md`).

## 4. Audit trail to the source

1. Each snapshot row stores the ledger event id and its `evidence_ref`. The ledger is append-only, so the referenced rows cannot be edited after the fact.
2. `snapshot_sha256` covers the method version, period, currency, cost, and every source row (ordered by event id; `evidence_ref` escaped). SQL (`outcome_case_canonical`) and TypeScript (`canonicalString`) use the same format. A pgTAP test pins the hash of a fixed fixture to the value the TypeScript code produces.
3. The page and the exporters recompute the hash from the rows they load. A mismatch blocks public output ("integrity check failed").
4. `outcome_case_audit` (append-only) records creation, consent granted or withdrawn, every export (written before the file is produced), and any verification.
5. Public copy shows counts and the hash, not event-level references. The full list stays in the audit copy for the account.

This is tamper-evidence for the account's own data plus a log. It is not a third-party attestation.

## 5. Consent

- Only the account owner (not a team member) can give or withdraw consent, through `outcome_case_set_consent`.
- Scope is explicit: business name, person name and role, quote. Figures are always covered. A quote is shown only if the consent row carries that exact text.
- Each row stores signer, role, consent-text version and its SHA-256, and the snapshot hash it applies to. Rows are never updated or deleted; the newest row wins. A withdrawal grants nothing.
- A consent for one snapshot does not cover a later snapshot of the same period.
- Withdrawal stops future exports from this app. It cannot recall material already published or copied **[COUNSEL]**.
- The consent wording in `api.ts` (`CONSENT_TEXT`, version `draft-0`) is a placeholder. **[COUNSEL]** Replace it and bump the version before asking a real customer.

## 6. Verification level and the required notice

Default: `not_independently_audited`. Every Markdown and PDF output carries **"Not independently audited."**

The level changes only when staff record, through `outcome_case_record_verification`, a named verifier and an `https` evidence link. The output then names the verifier, date and link. If any part is missing the notice stays "Not independently audited." A recorded verification cannot be edited or undone. The function stores what staff provide; it does not judge whether the verifier is independent. That judgment belongs to the Trust owner.

## 7. Publication gate (`publicationGate`)

Public output is produced only when all hold: latest consent is "granted"; it was given for this snapshot hash; the rows still hash to the snapshot; the method produced a number. Otherwise the audit copy is labelled DRAFT and the public buttons stay disabled. This gate is a process control inside this app. It does not stop someone copying numbers by hand.

## 8. Using a case in marketing

A case study is not a claim-register entry. Before it appears on a public page, the Trust owner checks it against `docs/claims-register.json` and `src/lib/trust/claims.ts` (`customers.counts` is `not_held`, so no counts or aggregates), and customer name use is a separate decision. Nothing in the kit publishes automatically.

## 9. Not built, and why

| Item | Reason |
|---|---|
| Staff workflow to publish approved cases, and a staff list view | Needs a decision on who may read tenant cases and on counsel-approved consent text |
| Translations of `outcomeProof.json` | English only; other locales fall back to English until native review (ar, fa, hi, ja, zh first) |
| Surface-manifest entry for the new route | Run `npm run docs:surface` and classify the route (the manifest is not in the ZIP) |
| Migration applied, pgTAP run, real Vitest/tsc/eslint | Not run: no dependencies installed, no Postgres, no network in the authoring environment |
| Fix to `/roi` wording ("verified", "named") vs "illustrative" in `CaseStudies.tsx` | Unrelated file; flagged in `docs/brand/category-narrative.md` §7 |

## 10. Operating steps

1. `supabase db push` (apply `20290309000000_outcome_proof_kit.sql`), then `supabase test db`.
2. `npm run typecheck`, `npx vitest run src/lib/outcomeProof`, `npm run lint`, `npm run i18n:keys`, `npm run lint:locale`, `npm run claims:check`.
3. Open `/dashboard/outcome-cases` with a sandbox account that has at least 5 measured events over 28+ days.
4. Rollback: see the header of the migration. Export consent rows first; dropping the tables deletes consent evidence.
