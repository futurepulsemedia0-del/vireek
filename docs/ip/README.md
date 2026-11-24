# IP program kit

Status: DRAFT operating kit. **This is not legal advice.** Every legal step is marked **[COUNSEL]** and must be approved by qualified intellectual-property counsel before it is relied on. Facts that were not confirmed from a primary source are marked **[VERIFY]**. Nothing in this folder claims that Vireek owns, has filed, or has registered any patent, trademark, copyright or trade secret.

Audience: founders, engineering leads, the brand owner (`BRAND_GOVERNANCE.md` §1) and the designated legal contact (to be named, see `docs/OWNERS.md`).

## What is here

| File | Use it when | Output |
| --- | --- | --- |
| [01-invention-disclosure-template.md](01-invention-disclosure-template.md) | Someone thinks they built something new and useful | One filled disclosure, sent to the legal contact |
| [02-trade-secret-register.md](02-trade-secret-register.md) | Deciding what stays secret and proving it is handled that way | A register of assets (pointers and controls, never the secret itself) |
| [03-trademark-clearance-checklist.md](03-trademark-clearance-checklist.md) | Before using or filing any new name, logo, or sub-brand in a market | A dated clearance record per mark and market |
| [04-competitor-ip-monitoring.md](04-competitor-ip-monitoring.md) | On a fixed cadence, and when a competitor ships something similar | A monitoring log reviewed by counsel |
| [05-defensive-publication-criteria.md](05-defensive-publication-criteria.md) | A disclosure is not worth patenting but should not be patentable by someone else | A publish / keep-secret / patent decision record |

## How the pieces connect

```
invention disclosure (01)
        |
        v   counsel triage [COUNSEL]
   +----+---------------------+------------------------+
   |                          |                        |
 keep secret                patent                  publish defensively
   |                          |                        |
 register (02)         outside counsel           criteria + record (05)
```

A disclosure is the single entry point. Counsel picks one route per invention; the choice is recorded on the disclosure, the register, or the publication record. Trademark (03) and competitor monitoring (04) are independent loops that feed new disclosures and register entries.

## Rules that apply to every file here

1. **Never put a secret in a document.** The register, the disclosure form, the monitoring log and publication drafts hold descriptions at the level you could show a customer, plus a pointer to where the protected material lives. Credentials, keys, salts, model prompts, and customer data never go in `docs/`.
2. **Disclosure before publication.** Nothing in 01 is posted, presented, open-sourced, or put in a public repo, blog, conference talk, or investor deck until counsel has decided the route. Public disclosure can end rights in some jurisdictions and cannot be undone. **[COUNSEL]**
3. **Customer data is not an invention.** Customers own their business data (`src/lib/legalDocs/intellectualProperty.ts`, section "Customer content and data"). Do not describe a customer's data, pricing, or scripts in any disclosure or publication. Cross-tenant learning is covered by `docs/compliance/cross-tenant-data-flows.md`.
4. **Logs are internal records, not legal conclusions.** Wording such as "similar to", "overlaps with" or "infringes" does not belong in a log; counsel makes those calls. **[COUNSEL]**
5. **Existing artifacts are reused, not duplicated.** Open-source licences: `docs/compliance/oss-license-policy.md`. Public IP and trademark wording: `/intellectual-property` and `/trademark-policy` (`src/pages/TrademarkPolicyPage.tsx`). Brand naming gate: `docs/brand/BRAND_ARCHITECTURE.md` §5. Insurance: `docs/compliance/insurance-program.md`. Legal-process handling: `docs/compliance/legal-request-process.md`.

## Open items (cannot be closed by engineering)

- Name the legal contact and a backup in `docs/OWNERS.md`. Until then every "send to the legal contact" step has no recipient. **[COUNSEL]**
- Engage IP counsel; record the engagement date and scope here once it exists. **[COUNSEL]**
- Confirm that employee and contractor agreements contain invention-assignment and confidentiality terms. Not reviewed here; the agreements were not in the repository. **[COUNSEL] [VERIFY]**
- Confirm the legal entity that owns the marks and inventions (`docs/brand/06-entity-dependency-audit.md`; `LEGAL_ENTITY` in `src/lib/legalEntity.ts` is empty in the snapshot reviewed). **[COUNSEL] [VERIFY]**
