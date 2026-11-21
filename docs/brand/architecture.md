# Vireek brand architecture: naming rules for products and features

Status: Draft for Brand-owner review · Owner: Brand owner (`BRAND_GOVERNANCE.md` §1) · Claims owner: Trust owner
Scope: how product, module and feature names are formed and written. Companion to `BRAND_ARCHITECTURE.md`, which decides *when* a new brand or a parent holding company may exist. This file does not repeat that decision logic.
Related: `docs/naming-guide.md`, `BRAND_GOVERNANCE.md`, `docs/PAY_AND_CAPITAL.md`, `docs/compliance/PUBLIC_CLAIMS_INVENTORY.md`.

Conventions: **[VERIFY]** = a fact or claim that is not in the claims register and has no linked proof. **[COUNSEL]** = needs a lawyer before use. Nothing here is legal advice.

## 0. Sources, and what this document may claim

Two registers exist today and they disagree in shape:

| Register | State on 2026-11-20 |
|---|---|
| `docs/claims-register.json` | `claims: []`. It holds no evidence entries. |
| `src/lib/trust/claims.ts` (`CLAIMS`) | Ten entries. Only `sla.uptime-commitment` is `verified`, and it is a *commitment*, not measured performance. Six are `not_held`, one is `planned`, one `in_progress`. |

Rule for this document and the two that follow it:

1. A claim is stated as fact only if its `claims.ts` status is `verified`, using the wording in `statement`.
2. A `not_held` claim may be stated as the plain negative the register already words (for example, no SOC 2 report is held).
3. Everything else, including every performance, customer, savings, accuracy and "first/only/best" statement, is marked **[VERIFY]** and must not ship in public copy until the Trust owner has registered evidence.
4. Merging the two registers into one is an open decision (see `docs/_audit/proof-of-value.md`). Until then, a claim needs to be correct in both.

## 1. The naming ladder, as applied to what exists today

`BRAND_ARCHITECTURE.md` §2 defines the rungs (product, module, sub-brand, independent brand). This table classifies the names that are actually in the repository. "Status" is a recommendation for the Brand owner to confirm, not a decision already taken.

| Name in code or copy | What it is | Rung | Status | Evidence in repo |
|---|---|---|---|---|
| Vireek | Core platform | Product | Canonical | `config.mjs → NAMING.canonicalName` |
| Vireek Field, Vireek Home, Vireek Pulse | Shipped apps/surfaces | Module | Approved | `NAMING.productNames` |
| Vireek AI Core | Listed as approved | Module | **Conflicts with §3 rule N4.** Flag for Brand owner | `NAMING.productNames`, `capacitor.config.ts` |
| Vireek Pay | Payments surface | Module | In use, not in `NAMING.productNames`. Add or retire | `src/lib/pay.ts` |
| **Vireek Capital** | Pre-screen and partner offers for working capital | Module (regulated) | Conditional, see §4 | `PRODUCT_LABEL.capital` in `src/lib/pay.ts`; `docs/PAY_AND_CAPITAL.md` |
| **Vireek Adaptive Customer Diagnostic** | Customer-facing symptom questionnaire for a job | Feature | Short form "Diagnostic" only in context, see §5 | `src/lib/adaptiveDiagnostic.ts` |
| **Vireek Failure Genome** | Per-equipment failure history plus aggregate pattern layer | Feature | Internal name. Customer label is "Common Failures", see §6 | `src/lib/failureGenome.ts`; `surface.manifest.json` |
| Vireek Insights, Support, Tag, Team, Academy, API, Partner Portal, Help Center | Mixed: some are surfaces, some are content, some are internal | Not classified | Needs classification pass | grep of `src/`, `docs/` |
| Vireek Verified Service, Trusted Service, Outcome Benchmark, Outcome Clearinghouse, Home Passport | Names that imply a verification or a benchmark | Not classified | **Blocked on §7 (implied-claim rule)** | grep of `src/`, `docs/` |

The "Not classified" rows are a finding, not a decision. Classifying them is a task for the Brand owner using §2 of `BRAND_ARCHITECTURE.md`.

## 2. Anatomy of a name

```
Vireek <Noun>            module, separately packaged, same tenant and login
<Feature label>          feature inside a module, plain trade words, no "Vireek" prefix in UI
<Code name>              engineering only, never shown to customers
```

Three layers, three audiences:

| Layer | Audience | Where it appears | Who may change it |
|---|---|---|---|
| Module name | Buyer, sales, press | Marketing site, pricing, contracts, app store | Brand owner |
| Feature label | Daily user (owner, dispatcher, technician) | Navigation, page titles, buttons | Content/i18n owner, within `docs/naming-guide.md` |
| Code name | Engineers | File names, tables, functions, routes | Engineering owner. Never renamed for brand reasons (§8) |

## 3. Rules

**N1. One name per thing.** A capability has exactly one module name, one feature label, and one code name. A second spelling in copy is a defect.

**N2. Say the outcome in feature labels.** Plain trade words, three words at most (`docs/naming-guide.md` rules 1–4). The metaphor stays in the code name.

**N3. Module names follow `Vireek <Noun>`.** One common English noun, Title Case, no abbreviation (`BRAND_ARCHITECTURE.md` §4).

**N4. Capability words are not names.** "AI", "Smart", "Auto" and "Intelligence" describe how something works. They do not belong in a module name (`Vireek AI <X>` is already prohibited). *Open item:* `Vireek AI Core` is on the approved list and conflicts with this rule. Either it is an engineering label that should not be customer-facing, or it needs an explicit exception from the Brand owner.

**N5. Regulated nouns are reserved.** `Capital`, `Pay`, `Credit`, `Loan`, `Lending`, `Insurance`, `Bank`, `Warranty`, `Guarantee` and `Certified` imply a regulated or contractual activity. A name containing one needs a written note from the Trust owner on what Vireek does and does not do **[COUNSEL]**, and the page must say who performs the regulated activity.

**N6. A name must not claim what the register does not hold.** `Verified`, `Trusted`, `Certified`, `Benchmark`, `Guaranteed`, `Assured`, `Official` and `#1` are claims in a name (§7).

**N7. Casing and form.** "Vireek" in prose, never "VIREEK" or "vireek" (except URLs, handles, code). A module name is not pluralised and is not used as a verb ("Vireek Pay it" is wrong).

**N8. Don't rename routes, tables or identifiers.** Labels change, URLs and identifiers do not (`docs/naming-guide.md` rule 7). Old names stay searchable through `old` and `synonyms` in the surface manifest.

**N9. Translations.** The module name stays in Latin script in every locale. Feature labels are translated through `t()`. Machine-drafted translations are queued for native review (ar, fa, hi, ja, zh first).

## 4. Capital

**What exists** (`docs/PAY_AND_CAPITAL.md`, `supabase/functions/capital-manage/index.ts`): a pre-screen built from the account's paid and unpaid invoices, receivable pledging, and storage of partner offers with mandatory disclosure fields. A licensed lending partner makes the credit decision. The code comment is explicit that Vireek never decides credit. State: sandbox, nothing live until a partner is contracted and staff flip the product on.

**Naming rules for Capital**

1. Always "Vireek Capital" on first use per page, then "Capital" only when the heading above it says Vireek Capital. Never "Vireek Loans", "Vireek Credit", "Vireek Funding" or "Vireek Lending".
2. Never use the word "Capital" alone as a brand in the UI chrome. In navigation the label is the plain outcome: for example "Working capital" with Vireek Capital named on the page.
3. Never "we lend", "we fund", "we approve", "instant approval", "guaranteed offers", or a rate/limit in a name. The partner approves; copy says "offers from our lending partner".
4. Any page that shows an offer must show the partner name and the disclosure fields the system already requires (total repayment, finance charge, term, estimated APR).
5. While the product is sandbox: the product name may not appear on the public pricing or marketing pages as available. The in-app sandbox banner stays. Availability claim: **[VERIFY]** (no entry in either register).
6. Licensing, state coverage, partner name and any "regulated" wording: **[COUNSEL]** **[VERIFY]**.
7. "Capital" in the *parent-company* sense (holding entity in `BRAND_ARCHITECTURE.md`) and "Vireek Capital" the product are different things. The parent name, once chosen, must not contain "Capital" for this reason, and must pass the §5 naming gate there.

## 5. Diagnostic

**What exists**: the "Adaptive Customer Diagnostic" lets staff send a customer a link, asks a bounded series of questions about a complaint, flags hazards, and lets staff confirm the real outcome afterward. It has a catalog of supported complaint types; unsupported types fall back to the customer's own description.

**Naming rules for Diagnostic**

1. Module-level name: "Vireek Adaptive Customer Diagnostic" in documents; "Customer Diagnostic" on first use in UI; "the diagnostic" afterward (lowercase). Not "Vireek Diagnostics", not "AI Diagnostic".
2. **"Diagnostic" is a questionnaire, not a diagnosis.** Copy must not say the product diagnoses a fault, identifies the cause, or replaces a technician's inspection. Preferred verbs: "asks", "collects", "prepares", "flags".
3. Do not reuse the word for other things. Existing neighbours: *diagnostic fee* (a charge a business may levy), the *Failure Atlas* "best diagnostic test" field (a field test a technician performs), and platform diagnostics (health checks). Each keeps its own plain label; none may be written "Vireek Diagnostic".
4. Hazard flags must never be described as safety certification or a guarantee of safety.
5. Any accuracy figure ("correct X% of the time") is **[VERIFY]**. The panel records whether the outcome matched; a rate computed from that is an internal measure until the Trust owner registers it with a method and sample size.
6. Customer-facing messages are sent under the tenant's name (`BRAND_ARCHITECTURE.md` §6), so the module name must not appear in what the customer sees unless the tenant has chosen to show Vireek.

## 6. Failure Genome

**What exists**: a per-unit "DNA" of ten strands built in Postgres, plus a population layer of aggregate patterns that is cross-tenant, aggregate-only and reached through RPCs. `docs/naming-guide.md` forbids metaphors such as "genome" in labels, and `surface.manifest.json` already renames the route label to **Common Failures** (old name and synonyms "genome", "failure patterns" kept searchable).

**Naming rules for Failure Genome**

1. **Customer-facing label: "Common Failures".** "Failure Genome" is a code name and an internal engineering/data-science name. It may appear in engineering docs, and in analyst or investor material only with the plain label alongside, for example: "Common Failures (internally, the Failure Genome)".
2. "Genome", "DNA" and "strand" are metaphors for the data model. Do not use them in buyer-facing headings or in onboarding.
3. Do not use "Failure Genome" for the Failure Atlas, the Parts Intelligence modules, or Outcome Benchmark. They are different features with different data.
4. Describe the data honestly: patterns come from the participating accounts' recorded jobs and are shown only in aggregate. How many accounts, how many jobs, and how it improves over time are **[VERIFY]**.
5. The cross-tenant layer depends on the consent and aggregation rules in `docs/compliance/cross-tenant-data-flows.md`. Copy that describes sharing must match that document and needs **[COUNSEL]** review. Do not say "anonymous" or "anonymised"; say "aggregated", which is what the code enforces, unless counsel approves otherwise.
6. "Predicts failures" is not permitted. Preferred: "shows which failures are most common for a make, model and age".

## 7. Names that carry a claim

| Name or phrase | Claim implied | Rule |
|---|---|---|
| Verified Service, Verified | Someone checked something | Needs a written verification method, an owner, and a date shown on the page. Until then **[VERIFY]**, rename or drop |
| Trusted Service | Third-party trust standard | Same. Do not pair with a badge or seal |
| Outcome Benchmark, Outcome Intelligence | Comparative data exists at sufficient scale | **[VERIFY]**: population size, period, method |
| Home Passport | Authoritative record of a home | Must not imply an official or government document **[COUNSEL]** |
| Partner Certification, Certified | Credential issued by Vireek | Must state who issues it and what it does not mean. Never imply an industry or regulator credential |

None of these names is blocked by this document. They are blocked by the claims rule: a name that implies proof is treated as a claim and goes through the register.

## 8. What this document does not rename

Company legal name, domain, shipped URLs, database objects, package and bundle identifiers, API paths, tenant data. These need their own decision and migration plan.

## 9. Review checklist for any PR that adds or changes a name

- [ ] Rung chosen using `BRAND_ARCHITECTURE.md` §2 (module, feature, or code name only)
- [ ] One name per thing (N1); no second spelling anywhere
- [ ] Feature label is plain trade words, three words or fewer (N2)
- [ ] No capability word as a name (N4); no regulated noun without a Trust owner note (N5)
- [ ] No claim-bearing word without a register entry (N6, §7)
- [ ] Old name added to `old` and `synonyms` in `surface.manifest.json` if renamed
- [ ] i18n keys present in `en`, `ar`, `de`, `es`, `fa`, `fr`, `hi`, `ja`, `zh`
- [ ] Anything unverified carries **[VERIFY]**; anything legal carries **[COUNSEL]**

## 10. Open decisions for the Brand owner

1. Is `Vireek AI Core` customer-facing? (N4)
2. Add `Vireek Pay` and `Vireek Capital` to `NAMING.productNames`, or keep them as feature names inside the Pay module?
3. Which of the "Not classified" names in §1 become modules, which become features, which are retired?
4. Merge `docs/claims-register.json` and `src/lib/trust/claims.ts` into one register, and which one is canonical?

## 11. Change log

| Date | Change | Approved by |
|---|---|---|
| 2026-11-20 | Initial draft | _assign_ |
