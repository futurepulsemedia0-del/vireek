# Quarterly vendor-exit drill checklist

> **DRAFT — not approved.** This is a procedure, not evidence. No drill has been performed unless a provider page's drill log records one with an evidence reference. Never write a date in "Last drill date" for work that did not happen.

## 0. Plan (first week of each quarter)

1. Run `node scripts/compliance/gen-vendor-exit.mjs --check`; fix errors; read the warnings.
2. Pick this quarter's providers from the **Drill quarters** column in [README.md](README.md) (tier 1 every quarter, tier 2 twice a year, tier 3 once a year). Also include any provider whose measured block changed materially or whose contract/terms changed.
3. Assign a drill lead and a reviewer who did not write the page. Record both names.
4. Set the scope in writing: **tabletop** (walk the steps), **export** (really export and verify data), or **failover** (really run on the alternative in a non-production environment). Tier 1 providers get at least one export or failover drill per year; tabletop alone is not enough twice in a row.

## 1. Per-provider checklist (copy into the drill record)

- [ ] Provider page re-read; the generated block is fresh (`--check` passes).
- [ ] Owner, account id and credential rotation date current in `docs/integrations/providers/OWNER_REGISTER.md` (never paste secret values).
- [ ] Contract, DPA, notice period and data-return/deletion terms located and noted [COUNSEL].
- [ ] Section 2 export executed or walked: record counts and checksums compared with Vireek tables; export stored in a private location; time taken written down.
- [ ] Section 3 alternatives still exist and still fit (feature, region, price class); anything learned tagged [VERIFY] until confirmed from vendor documentation or contract.
- [ ] Section 5 steps executed up to the declared scope; blockers listed; rollback confirmed.
- [ ] Effort estimate in section 4 adjusted from what the drill showed; reasons noted.
- [ ] Customer-visible impact and notice obligations reviewed (sub-processor list, tenant notice) [COUNSEL].
- [ ] Findings logged with owner and due date (template in `docs/compliance/internal-audit-program.md`, section 6).

## 2. Pass / fail

- **Pass:** the declared scope finished, data counts reconciled, no unresolved blocker for a tier 1 provider.
- **Pass with findings:** scope finished, gaps recorded with owners and dates.
- **Fail:** export incomplete or unverifiable, or the alternative could not run. Re-drill within one quarter.

## 3. Record the result

1. Add a row to the provider page's drill log and set **Last drill date** to the real date (`YYYY-MM-DD`).
2. Store the drill record (PDF or markdown) where the team keeps records; note its location.
3. Register it as evidence (hash plus pointer, no content):

```
node scripts/compliance/evidence.mjs manual --collector manual.vendor_review \
  --attested-by "Full Name" --document-ref "<where the record lives>" \
  --document-file ./drill-record.pdf --note "Q? vendor-exit drill: <providers>"
```

   Pushing to the evidence store needs `COMPLIANCE_INGEST_URL` and `COMPLIANCE_INGEST_TOKEN` (see the header of `scripts/compliance/evidence.mjs`).
4. Run `node scripts/compliance/gen-vendor-exit.mjs` to refresh the README index and commit.

## 4. Quarter sign-off

| Quarter | Providers drilled | Lead | Reviewer | Date | Record location |
|---|---|---|---|---|---|
| — | none recorded | — | — | — | — |
