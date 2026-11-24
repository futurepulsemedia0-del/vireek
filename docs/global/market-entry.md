# Market-entry readiness

How Vireek decides that a regional pack (US, CA, GB, EU, AU) is ready to be sold in. Not legal advice. Anything legal is marked **[COUNSEL]**, any fact taken from a vendor, regulator or market that has not been checked against a primary source is marked **[VERIFY]**.

## What already exists (do not rebuild)

| Capability | Where |
| --- | --- |
| Packs, 31 country profiles, phone/postal/subdivision rules, payment methods per country | `src/lib/regionalPacks/packData.ts` |
| Tax, privacy regimes, holidays, validation | `src/lib/regionalPacks/pack*.ts` |
| Pack switch per tenant (`set_regional_pack`) | `supabase/migrations/20271021000000_regional_packs.sql` |
| Region flag + module entitlement (default off, US always allowed) | `src/lib/regionConfig/gate.ts`, `20290301000000_region_config_foundation.sql` |
| Charge currencies and delayed debit methods | `supabase/functions/_shared/payments/regionalMethods.ts` |
| UI language tiers | `src/i18n/locales.config.ts` |
| Human support window (one window, America/New_York) | `src/lib/supportHours.ts` |
| Recording-consent hypotheses | `docs/compliance/voice-consent-and-ai-disclosure.md` |
| Residency decision (proposed) | `docs/compliance/adr-0001-data-residency.md` |

This task adds the missing piece: one checklist that says, per country, what is still open.

## The checklist

Defined once in `config/global/market-entry.json` (`items`). Six categories, 19 items.

| Category | Items | Source of truth |
| --- | --- | --- |
| Legal entity | contracting entity **[COUNSEL]**; seller tax registration **[COUNSEL]** **[VERIFY]**; local representative **[COUNSEL]** | manual entry |
| Payments | methods and currency in code; payments/e-invoicing matrix row complete; processor account capability **[VERIFY]** | first two: derived from code and `config/global/payments-einvoicing.json`, third: manual |
| Telephony numbers | number inventory **[VERIFY]**; number registration **[COUNSEL]** **[VERIFY]**; recording consent and AI disclosure **[COUNSEL]** | manual entry |
| Support hours | coverage window; local-language macros and escalation | manual entry |
| Compliance rules | privacy tooling; marketing consent **[COUNSEL]**; transfer basis **[COUNSEL]**; sub-processor list **[VERIFY]** | manual entry |
| Localization | UI language; phone/postal/address rules; holiday calendar; legal pages **[COUNSEL]** | first three derived from code, last manual |

**Derived items** (`probe` in the config) are computed from the code on every run, so they cannot be claimed by hand and cannot go stale: `payment_methods`, `billing_matrix`, `ui_locale`, `country_profile`, `holiday_calendar`. A Tier C / Beta language shows as *in progress*, a missing language as *not started* (falls back to English).

## Rules the tooling enforces

1. A manual item is **done** only with `evidence`. A repo file is written `repo:path/to/file` and must exist.
2. A **[VERIFY]** item also needs `source` and `verifiedOn`.
3. A **[COUNSEL]** item also needs `reviewer` and `reviewedOn`. The same applies to marking it `not_applicable`.
4. `not_applicable` and `blocked` need a `note`.
5. Dates must be real `YYYY-MM-DD` and not in the future.
6. A country is **ready** only when every item is `done` or `not_applicable`. A pack is ready only when every one of its countries is. EU therefore needs all 27.
7. Missing information is `not_started`. It is never treated as done.
8. A warning appears when the pack data in `packData.ts` was last verified more than 365 days ago.

## Recording status

`markets.<COUNTRY>.<itemId>` overrides `packs.<PACK>.shared.<itemId>`; shared entries apply to every country in the pack (use them for decisions that really are pack-wide, such as the EU contracting entity).

```json
{
  "packs": { "EU": { "shared": {
    "legal_entity.contracting_entity": {
      "state": "done",
      "evidence": "Board resolution 2027-02-11, folder legal/entities",
      "reviewer": "Name, firm",
      "reviewedOn": "2027-02-10"
    }
  } } },
  "markets": { "DE": {
    "localization.legal_pages": { "state": "in_progress", "note": "Impressum draft with counsel" }
  } }
}
```

## Running the report

```bash
npm run report:market-entry                      # markdown, all packs, to stdout
npm run report:market-entry -- --pack EU --detail
npm run report:market-entry -- --format json --out reports/market-entry/latest.json
npm run report:market-entry -- --strict          # exit 3 while any pack is not ready
npm run lint:market-entry                        # config validation only (exit 2 on errors)
npm run test:scripts:market-entry
```

The script needs no network and no secrets. It loads the `.ts` data files with Node's type stripping (Node 22.6+ with `--experimental-strip-types`, already used by other scripts here). Exit codes: `0` ok, `2` bad flag or invalid config, `3` `--strict` and not ready. `reports/market-entry/` is git-ignored.

Use `--strict` as a release gate only for the pack being launched (`--pack GB --strict`), not for all five.

## Baseline as shipped

On 2026-11-20 every pack reports NOT READY. Only derived items and the privacy-tooling code check are resolved; every **[COUNSEL]** and **[VERIFY]** item is open. That is the honest starting point, not a defect. Nothing here asserts that Vireek holds an entity, registration, number, certification or counsel opinion in any market.

## Payments and e-invoicing

Local payment methods and tax-invoice requirements per region live in `docs/global/payments-einvoicing.md`.

## Changing the checklist

Add an item in `config/global/market-entry.json`, give it `tags`, run `npm run lint:market-entry`, and the report picks it up for every country. New derived checks go into `PROBES` in `scripts/lib/marketEntry.mjs` with a test.
