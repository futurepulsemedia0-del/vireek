# Data monetization ethics and data product approval

> **Status: engineering control, DRAFT for counsel and management review. Not legal advice.** Items marked **[COUNSEL]** need a legal decision; nothing here is a compliance claim or certification (see `src/lib/trust/claims.ts`). Facts about deployed state are **[VERIFY]**: this document was written from a static read of the repository and nothing was run against a live database.
>
> Companions: `supabase/migrations/20290311000000_data_product_reviews.sql`, `supabase/functions/_shared/data-products/guard.ts`, `docs/data/external-data-endpoints.json`, `scripts/data/check-data-product-gates.mjs`, `supabase/tests/database/data_product_reviews.test.sql`, `docs/data/ownership-register.md`, `docs/compliance/cross-tenant-data-flows.md`.

## 1. What this covers

A **data product** is any dataset that Vireek *derives* from customer data (aggregate, cohort, index, pattern, score, report) and releases to someone **outside the tenant that supplied it**: paying subscribers, partners, or the public. Today that is:

| Product key | Endpoint (edge function) | Recipients |
|---|---|---|
| `vireek_insights` | `insights-api` | API subscribers |
| `evidence_marketplace` | `evidence-marketplace-api` | approved partners |
| `state_of_calls` | `state-of-calls-public` | public readers |

**Out of scope:** exports a tenant starts for its own data (`tenant-export`, BI exports, data-room links, financing-partner sharing). There the tenant is the data owner and the recipient. In-product benchmarks shown back to contributing tenants are covered by `cross-tenant-data-flows.md`, not by this approval.

The ownership of derived data is **not decided here**: see the `derived` rows and the open questions in `ownership-register.md` **[COUNSEL]**.

## 2. Rule

> An external data endpoint may release a data product only while an **approved, unexpired, un-revoked** `data_product_reviews` row names that product **and** that endpoint.

Enforced in three places: the database (state machine and approval invariants, section 4), the edge function (`assertDataProductApproved`, section 5) and CI (`npm run data:products:check`, section 6).

## 3. Approval criteria

An approver attests each criterion in `criteria_checklist` (`{"E1": true, ...}`). All eight must be `true` or the database refuses the approval. The ids are mirrored in `public.data_product_required_criteria()`; CI fails if the two lists differ.

| ID | Criterion | What the review must be able to show |
|---|---|---|
| E1 | Purpose limitation | A specific purpose that fits what contributors were told. For every source flow, the `wording_fit` in `cross_tenant_flows` is `exact`, or `partial` with a recorded [COUNSEL] decision. `none` is not acceptable. This is an attestation: the database records it but cannot verify it. |
| E2 | Contributor consent | Only tenants with active consent for the mapped Service Data Exchange domain (or the product's own opt-in) contribute. No opt-out defaults. Withdrawal removes the tenant from the next build. |
| E3 | No identifiers | The released fields contain no tenant, customer, technician, address, phone, e-mail, free text or stable pseudonymous id. Checked against the released schema, not against intent. |
| E4 | Disclosure control | Minimum cohort size, minimum distinct values and any dominance cap, noise or rounding are stated in the privacy summary. `min_cohort_size` is recorded. For external release without personal data it is at least 5 (the lowest k any existing flow uses); this is an engineering floor, not a statistical or legal guarantee. Noise described as "differential-privacy-inspired" must not be sold as formal DP. |
| E5 | Re-identification assessment | Written assessment, including combination with the recipient's own data and with earlier releases. Risk recorded as `low`, `medium` or `high`. `high` cannot be approved. |
| E6 | Recipient terms | A licence or contract that bans re-identification and limits use is in place for every recipient class; public products have published terms of use. **[COUNSEL]** |
| E7 | Withdrawal and audit trail | Release can be retracted (immutable releases with a retract path, revocable keys). Each recipient's access is logged. Revoking the review stops the endpoint (section 5). |
| E8 | Acceptable use | The product cannot reasonably be used to surveil or profile identifiable people or businesses, to price-discriminate against a contributing tenant, or to make employment, credit or insurance decisions about identifiable people. A product whose main value depends on such use is rejected. |

### Hard stops (the approver must reject; only the first and third are also enforced by the database)

* Personal data of a tenant's customers, callers or technicians released to a third party without a counsel-approved basis. If `contains_personal_data` is true the database also requires a `counsel_reference` **[COUNSEL]**.
* Any source that is opt-out by default.
* `high` re-identification risk.
* Raw call audio, transcripts or recordings.

## 4. Review lifecycle (database)

`data_product_reviews` holds one row per review: product, purpose, recipients (`internal | subscriber | partner | public`), covered endpoints, source flows, privacy review, approver and decision.

| Step | RPC (staff only; identity = `auth.uid()`) | Result |
|---|---|---|
| 1 Request | `data_product_request_review(...)` | `pending`; one open review per product |
| 2 Privacy review | `data_product_record_privacy_review(id, risk, min_cohort_size, summary, criteria, counsel_reference)` | stamps reviewer and time |
| 3 Decide | `data_product_decide(id, 'approved' or 'rejected', reason, valid_days)` | stamps approver and time |
| 4 Revoke | `data_product_revoke(id, reason)` | stops the gate within the cache window |

Enforced by trigger, whatever the caller:

* The approver and the privacy reviewer are real staff (`is_vireek_staff`), taken from the session, never from an argument.
* **The approver cannot be the requester, and the privacy reviewer cannot be the requester.** There is no solo exception. With a single staff member nothing can be approved: that is intended.
* Approval needs a complete privacy review, risk below `high`, all criteria true, at least one covered endpoint, and an expiry no more than 366 days out (default 365, so every product is re-reviewed at least yearly).
* A decided review is frozen. Changing purpose, recipients, endpoints or sources means a **new review**; the old approval stays valid until it expires or is revoked, so revoke it when the change replaces it.
* `approved` can only move to `revoked`. Reviews cannot be deleted; `data_product_review_events` is an append-only history.

## 5. Runtime gate (edge functions)

`assertDataProductApproved(client, productKey, endpoint, headers)` calls `public.data_product_gate(key, endpoint)` after the caller is authenticated and before data is read. Denial reasons: `no_review`, `pending`, `rejected`, `revoked`, `expired`, `endpoint_not_covered`, `invalid_arguments`.

* **Modes** (`DATA_PRODUCT_GATE_MODE`): unset or `shadow` logs only; any other value **enforces** (a typo fails closed). Enforce answers 403 on denial and 503 when the gate itself is unavailable.
* Positive decisions are cached for 60 seconds per instance, denials never, so a revocation reaches every instance within about a minute. `state-of-calls-public` is also cached by a CDN (`s-maxage=3600`), which can keep serving a copy for up to an hour after a revocation. **[VERIFY]** the CDN configuration.
* **Release sequence:** apply the migration → deploy functions (still `shadow`) → request / review / approve the three seeded products → watch the `[data-product-gate]` logs for `shadow-denied` → set `DATA_PRODUCT_GATE_MODE=enforce`. Until that last step the control **records and logs but does not block**.

## 6. CI

`npm run data:products:check` fails when:

* a registered function does not call `assertDataProductApproved` with its own product key and function name, or does not import the guard;
* a product or endpoint has no review path in a migration;
* a function outside `docs/data/external-data-endpoints.json` uses the guard, or its header describes a partner-facing / subscriber / public-egress / data-product endpoint;
* the criteria ids here and in `data_product_required_criteria()` differ.

**Limits.** The check proves wiring, not approval state in any database. A new external endpoint that nobody registers and whose header does not use those words will not be found by CI: reviewers must treat "releases derived data outside the tenant" as a registration trigger. Tenant data tables are covered separately by the ownership register gate (`npm run data:register:check`).

## 7. Open questions **[COUNSEL]**

1. Who owns a derived aggregate (Vireek, the contributing tenants, jointly), and what do contributor terms and the DPA allow for external release?
2. Is a `partial` wording fit between a flow and its Service Data Exchange consent enough for external commercial release (E1)?
3. Which recipient terms satisfy E6 for each class, including the public report?
4. Is a counsel reference needed for products without personal data, or only for those with it (current rule)?
5. Is a 5-tenant floor adequate for any external release, or should commercial products require more (Insights already uses 10)?
6. Are in-product benchmarks shown to contributors covered by the consent wording, or do they also need this approval?
