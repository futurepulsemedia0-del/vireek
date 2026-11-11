# 18 — M&A readiness: absorbing an acquired product's customers and data

> **Status: engineering document, DRAFT for counsel review. Not legal advice.** Every item marked **REQUIRES COUNSEL** needs review by a qualified lawyer before anyone acts on it; this document asserts no legal or regulatory compliance.
> Prepared from a static read of the `vireek-main` snapshot (2026-11-10). Evidence = file paths. Anything not proven by a file or an executed test is marked **UNVERIFIED**. The real repository may have moved on: re-check paths before relying on them.

## 1. Scope and what this delivers

| Part | What | Where |
|---|---|---|
| Read-only audit | What already exists for importing / moving tenants, and the gaps | §2 |
| Data-model mapping approach | How an acquired product's data maps onto Vireek | §3 |
| Import framework | Generic, idempotent, resumable import with dry-run report and rollback; CSV reference adapter | §4, `supabase/functions/_shared/import-framework/`, `supabase/functions/import-framework/`, migration `20290210000000_import_framework.sql` |
| Tenant onboarding / migration runbook | Phased, with go/no-go gates and rollback window | §5 |
| Identity + billing consolidation options | Trade-offs, no decision taken | §6 |
| Risk list | Technical + **REQUIRES COUNSEL** items | §7 |

The framework is a **module behind a feature flag and a per-account entitlement, default OFF** (§4.7). Nothing in the existing import wizard, the acquisitions toolkit or tenant export/import was modified.

## 2. Audit of what exists (read-only)

### 2.1 Tenancy model (the invariant everything must respect)
- A tenant is an **account owner** profile: `profiles.id = auth.users.id` (`20260918…create_profiles_and_team_members.sql`). Team members are rows in `team_members` matched by **email**; `get_account_owner_id()` resolves owner-or-member to the owner id and is used by RLS across the schema (≈1,700 `user_id uuid` column declarations over ≈730 migrations — rough `grep` count, UNVERIFIED as an exact figure).
- Consequence: *absorbing* an acquired business means either (a) writing its data into an existing account under that account's `user_id`, or (b) keeping a separate account and linking it (Franchise / Locations).

### 2.2 Existing building blocks

| Capability | Evidence | Fit for M&A | Gap |
|---|---|---|---|
| Import Wizard v2: CSV/XLSX → customers, jobs, invoices, line items, payments, equipment; validate → run → rollback; saved mappings; dedupe by external id / phone / email / name+address | `_shared/data-import/{handler,plan,ledger,ledgerApply}.ts`, `data-import-run`, migrations `20260929…competitor_data_import_engine`, `20270415…import_wizard_rollback`, `20280115…incumbent_ledger_import` | Good for **one-shot, single-entity, ≤5 000 row** loads from competitor exports | Not resumable; single entity per run; source = CSV only; no cross-entity references inside one load; effects table only knows `customer`/`job` |
| Tenant export / import bundle (`vireek-export/1`: tar + NDJSON + sha256) | `tenant-export`, `tenant-import`, `_shared/tenant-export/bundle.ts` | Good for **Vireek → Vireek** moves (same schema) | Fixed 6-table list; upsert **by id**, batches are **not one transaction** (re-run completes it); no mapping layer, so useless for foreign schemas |
| Acquisition Integration Toolkit (30/60/90 tracker, baselines, synergies, import-vs-source checks) | migration `20271115…acquisition_integration_toolkit.sql`, `src/lib/acquisitions.ts`, `src/pages/Acquisitions*.tsx` | The **program-management** layer | `scope_kind='imported'` reads **`data_import_row_effects`** only → rows created by the new framework are not visible to it yet (**follow-up F1**) |
| Multi-brand, Locations, Franchise groups (`business_brands`, `business_locations`, `franchise_*`) | acquisition migration pre-flight list | Needed for brand transition and "linked account" scope | — |
| `external_source` / `external_id` + partial unique index on `customers`, `jobs` | `20260929…engine.sql` | Natural idempotency key | **Only these two tables** have it (≈3 migrations mention `external_source`, UNVERIFIED for others) |
| Feature flags with per-tenant override, server evaluation | `docs/FEATURE_FLAGS.md`, `20270411…feature_flags.sql`, `20280501…release_safety_core.sql`, `_shared/flags/flagEval.ts` | Entitlement mechanism | No separate "module entitlement" table: an entitlement = flag `enabled` + `rollout_pct 0` + tenant override `on` |
| Erasure / retention / data map | `docs/compliance/data-map.md`, `delete-account` | Needed after the deal for data-subject requests | Not specific to acquired data |
| Billing | `profiles.stripe_customer_id / stripe_subscription_id` (`20260826…`), `stripe-webhook`, `manage-subscription-plan`, `create-checkout-session`; customer payments through Stripe Connect (`stripe_connect_accounts`) | See §6 | No tooling to merge two subscriptions |

### 2.3 Findings (ranked)
1. **M-1 (high)** No importer can load *several related entities* (customers → jobs → …) in one resumable operation with a report, so large acquisitions need many manual wizard runs and have no end-to-end reconciliation. → §4.
2. **M-2 (high)** Wizard runs cannot resume after a timeout/crash. → §4 (checkpoint + lease).
3. **M-3 (medium)** `tenant-import` is id-keyed and non-transactional; fine for Vireek→Vireek, wrong tool for a foreign product. → documented in §3.5.
4. **M-4 (medium)** No identity or subscription consolidation tooling. → §6 (options only; design decision needed).
5. **M-5 (medium)** Acquisition KPIs for `imported` scope would miss framework-created rows. → follow-up F1.
6. **M-6 (low)** `external_id` coverage is limited to customers/jobs; other entities need a ledger key (the framework ledger provides it without schema changes to those tables).

## 3. Data-model mapping approach

### 3.1 Principle
Never map "their database" to "our database" directly. Map **source → canonical entity → Vireek table**:

```
source export / API  ──adapter──▶  raw records  ──mapping config──▶  canonical values  ──sink──▶  Vireek tables
 (CSV today)                        (read-only)    (declarative JSON)    (typed, validated)       (tenant-scoped)
```
- **Adapter** (code, one per source *kind*): reads a snapshot, pages deterministically, never writes.
- **Mapping config** (JSON, versioned, stored on the run): per entity a stable `key`, per target field `from` column(s) + a closed set of transforms. Reviewable and replayable; contains no code and no secrets.
- **Entity definition** (code, `entities.ts`): the allow-list of importable tables/columns, types, required fields, cross-entity references, unique match keys. Clients never name a table or column.
- **Sink** (code): the only writer; tenant-bound; allow-listed.

### 3.2 Mapping procedure (per acquired product)
1. **Inventory** the source: tables/exports, row counts, primary keys, what is customer-owned vs. company-owned, what is personal data.
2. **Classify each source object** as *Map* (has a Vireek entity), *Archive* (keep read-only elsewhere, not imported), or *Drop* (documented decision). Nothing is dropped silently: the dry-run report lists every unmapped column the operator chose to ignore (a mapping simply omits it) and the checklist in §5 requires sign-off.
3. **Choose the stable key** per entity (the source's own id). No stable key → `allowPositionalKeys` (re-import of a *changed* file is then not idempotent; accepted only for throw-away loads).
4. **Normalise** with the closed transform set: `trim lower upper collapse_space phone_e164 email money money_cents number integer boolean date timestamp enum truncate`. Enumerations (status, type) must be mapped explicitly; an unmapped value is an **error**, not a guess.
5. **Resolve references** by source key (`jobs.customer_ref = "CustID"`); a reference to a record that was not imported is an error (`REF_NOT_FOUND`).
6. **Reconcile**: compare the report's control totals (`sums`, row counts) with figures taken from the *seller's* system (the acquisitions toolkit already stores such controls: `acquisition_source_controls`).

### 3.3 Reference mapping (framework entities today)

| Entity | Table | Source key → | Notable rules |
|---|---|---|---|
| `customers` | `customers` | `external_id` (+ `external_source = fw:<scope>`) | `matchKeys: phone, email` (unique per tenant): conflicts with **existing** customers are reported up front (`MATCH_KEY_CONFLICT`), never merged silently; `customer_type` must map to `residential`/`commercial`; rows are created `source='import'`, `lifecycle_stage='active'` (same as the wizard) |
| `jobs` | `jobs` | `external_id` | `customer_ref → customer_id`; `job_status` ∈ scheduled/en_route/in_progress/completed/cancelled; `invoice_status` ∈ not_sent/sent/paid; `invoice_amount` is a control-total field |

Not yet covered by the framework (use the wizard's ledger imports or add an entity definition + allow-listed table in `supabaseSink.ts`): invoices, line items, payments, equipment, price book, service agreements/memberships, technicians, calls/recordings, documents/photos, tax settings. See follow-up F2.

### 3.4 Merge-vs-create for overlapping customers
The most common M&A reality is that the acquired customer base overlaps with the buyer's. The framework deliberately does **not** merge: overlaps surface as `MATCH_KEY_CONFLICT` in the dry-run. Options for the operator: (a) fix the source data, (b) import into a separate account/location and merge later with an explicit review, (c) a future "merge candidates" workflow (follow-up F3). Silent merging risks attaching one person's history to another.

### 3.5 Why not `tenant-import` for foreign data
`tenant-import` assumes Vireek-shaped rows with Vireek ids and upserts by id. Use it only for Vireek→Vireek moves; everything else goes through mapping.

## 4. Import framework

### 4.1 Layout
```
supabase/functions/_shared/import-framework/
  types.ts        contracts (SourceAdapter, TargetSink, ImportStore, mapping config)
  hash.ts         fingerprint (change detection), deterministic UUIDs — NOT cryptographic
  mapping.ts      validateMapping, mapRecord, entityOrder
  engine.ts       runImport (dry_run | commit), rollbackRun
  report.ts       ValidationReport builder (no source values, capped samples)
  entities.ts     customers + jobs definitions (allow-list)
  adapters/csv.ts reference adapter (one CSV per entity)
  supabaseStore.ts / supabaseSink.ts   Postgres implementations (caller-JWT client)
  memory.ts       in-memory store + sink (tests, experiments) with fault injection
  handler.ts      transport-agnostic request handler (unit-tested)
supabase/functions/import-framework/index.ts   Deno entry (thin)
supabase/migrations/20290210000000_import_framework.sql
```

### 4.2 Guarantees and how they are achieved

| Guarantee | Mechanism | Test |
|---|---|---|
| **Dry-run is side-effect free** and produces a validation report | `mode: dry_run` only calls reads (adapter, ledger, sink `get/findByKey/findByField`) | `engine.test.ts › dry run` |
| **Idempotent** | per-row ledger `(tenant, scope, entity, source key) → fingerprint, target id`; unchanged fingerprint ⇒ no write; new records get a **deterministic id** (`tenant+scope+entity+key`) and carry `external_source/external_id`, so a lost ledger still cannot create a duplicate (PK / unique index) | `is idempotent…`, crash test |
| **Resumable** | checkpoint `(entityIndex, cursor)` saved **in the same transaction** as the batch's ledger rows (`import_fw_save_batch`); lease (2 min, heartbeat per batch) stops two workers; a call stops at its time budget with `status: paused` and the client calls `start` again with the **same files** | `pauses at the deadline…`, `refuses a second worker…` |
| **Crash-safe** | write-ahead `import_fw_effects` *before* the target is touched; a crash between applying and saving is repaired on resume | `survives a crash between applying a batch and saving it` |
| **Exact rollback** | effects hold `before`/`after`; created rows are deleted only if still equal to what was written, updated rows restored only if unchanged since; FK-blocked rows are reported and retryable; ledger rows are dropped so a later run re-evaluates | `rollback › …` |
| **Tenant isolation** | store and sink are constructed for one tenant, every query also filters `user_id`; no upsert-by-id; RLS on all new tables; ids include the tenant | `tenant isolation › …` |
| **Source/mapping drift** | resume refused (`SOURCE_CHANGED` / `MAPPING_CHANGED`); starting with a different file *supersedes* the open run (its effects stay rollback-able) | `refuses to resume…`, `supersedes…` |
| **Fail-safe on bad data** | circuit breaker (default 25 % errors after 50 rows); transient sink errors are retried then **pause** the run (never recorded as row errors) | `circuit breaker`, `retries transient…` |
| **PII minimisation / audit** | row errors store position + code + generic message only; `import_fw_row_errors` is append-only (no UPDATE/DELETE policy); logs contain codes, not values | `mapping.test.ts`, `engine.test.ts` |

### 4.3 Semantics worth knowing
- `dedupe` (mapping option): `fill_blanks` (default, like the wizard) never overwrites a filled column; `overwrite` applies source changes; `skip` never changes an existing record. The strategy is part of the row fingerprint, so changing it re-evaluates rows.
- Empty source values are **omitted**, never written as NULL: an import cannot clear existing data.
- Duplicate keys inside the file: first row wins, later ones are skipped with a warning.
- A record deleted by a human after import is **not** re-created (`TARGET_MISSING` warning).
- Roll back **newest run first** (`NEWER_RUN_EXISTS` otherwise; `force` exists for operators who know why).
- Positions are spreadsheet row numbers over *non-empty* rows (the shared CSV parser drops blank lines).

### 4.4 Request API (`POST /functions/v1/import-framework`, caller JWT)
```jsonc
// dry run → { report }
{ "action": "dry_run", "scope_key": "acme-2027", "mapping": { … }, "files": { "customers": "<csv text>", "jobs": "<csv text>" } }
// commit / resume → { run_id, status, complete, failure, checkpoint, report }; repeat with identical files while status = "paused"
{ "action": "start",   "scope_key": "acme-2027", "mapping": { … }, "files": { … } }
{ "action": "status",  "scope_key": "acme-2027" }
{ "action": "rollback","scope_key": "acme-2027", "run_id": "…" }
```
Errors: `403 module_disabled | forbidden`, `400 bad_request | bad_scope | unknown_action | unknown_source`, `422 mapping_invalid | source_invalid` (with `details`), `409 run_busy | source_changed | mapping_changed | newer_run_exists | not_rollbackable | lease_lost`, `404 run_not_found`.

### 4.5 Mapping config example
```json
{
  "version": 1,
  "source": "csv",
  "options": { "timezone": "America/Chicago", "dedupe": "fill_blanks", "maxErrorRatio": 0.1 },
  "entities": {
    "customers": {
      "key": { "from": "ID" },
      "fields": {
        "name": { "from": ["First", "Last"], "required": true },
        "phone": { "from": "Phone", "transforms": [{ "op": "phone_e164" }] },
        "email": { "from": "Email", "transforms": [{ "op": "email" }] },
        "customer_type": { "from": "Type", "transforms": [{ "op": "enum", "map": { "res": "residential", "com": "commercial" } }] }
      }
    },
    "jobs": {
      "key": { "from": "JobID" },
      "fields": {
        "customer_ref": { "from": "CustID" },
        "customer_name": { "from": "Customer", "required": true },
        "invoice_amount": { "from": "Amount", "transforms": [{ "op": "money" }] },
        "job_status": { "from": "Status", "transforms": [{ "op": "enum", "map": { "done": "completed", "booked": "scheduled" } }] },
        "scheduled_datetime": { "from": "When", "transforms": [{ "op": "timestamp" }] }
      }
    }
  }
}
```

### 4.6 Adding a source or an entity
- **New source (e.g. a competitor API):** implement `SourceAdapter` (read-only, deterministic paging, a snapshot `fingerprint()`), register it in `handler.ts`. Third-party credentials stay in Supabase secrets, never in mapping configs or code; wrap the HTTP client behind the adapter and ship a mock for tests. No scraping.
- **New entity:** add a definition to `entities.ts` **and** an allow-list entry (`TABLE_CONFIG`) in `supabaseSink.ts`; confirm the table has `user_id`, RLS, and decide how its unique constraints behave (`matchKeys`).

### 4.7 Entitlement and rollout (default OFF)
- Migration seeds flag `import_framework` with `enabled=false, rollout_pct=0`.
- Entitle **one** account: set `enabled=true` (keeps everyone else off because `rollout_pct=0`) and add a tenant override `on` for that account (staff tools → `staff_set_flag_override`, or `feature_flag_overrides`).
- Enforcement is server-side in two places: the edge handler (`403 module_disabled`) and RLS (`import_framework_enabled()` is in every write policy and both RPCs). Reads of history stay available to import-permitted users.
- Permission: `can_run_data_imports()` (owner or member with `can_edit_business_profile`), the same gate as the wizard.
- **Kill switch:** `UPDATE feature_flags SET enabled=false WHERE key='import_framework'`. Runs already in progress stop at their next batch (RLS write fails) and stay `paused`/resumable or rollback-able once re-enabled.

### 4.8 Environment / secrets
No new secrets. The function uses `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the caller's JWT. No service-role key is used.

### 4.9 Known limits
- CSV text is sent in the request body (≤ 30 MB body, ≤ 12 M chars and 200 000 rows per file); a resume re-sends the same files. Storage-backed sources are follow-up F4.
- One time-budgeted call ≈ 40 s; throughput not benchmarked (**UNVERIFIED**).
- Only `customers` and `jobs` entities; no UI (a UI would follow the repo's page patterns and is out of this task's scope).
- Postgres objects were **not executed** in this environment (§8).

## 5. Tenant onboarding / migration runbook (acquired business → Vireek)

Roles: **Integration lead** (owner), **Data engineer**, **Account owner** (buyer side), **Counsel**, **Finance**. Use the Acquisition Integration Toolkit for the dated tracker; this is the technical sequence.

### Phase 0 — Before close (no personal data moves) — **REQUIRES COUNSEL** for everything touching data access
- [ ] Counsel confirms *what data may be accessed pre-close* and under which agreement (NDA / clean-team rules). Until then use **synthetic or aggregated** samples only.
- [ ] Inventory (§3.2); pick scope: `imported` (into an existing account) vs. `linked_account` (own account + Franchise link) vs. `external`.
- [ ] Decide the identity and billing path (§6) and the customer-notice plan (§7, R-P1/R-C1).

### Phase 1 — Day 0–7: prepare
- [ ] Entitle the target account for `import_framework`; confirm `can_run_data_imports()` for the operator.
- [ ] Take a Vireek-side backup/export of the target account (`tenant-export`) — rollback insurance for the *existing* data.
- [ ] Obtain the seller export via the agreed channel (encrypted, access-logged; **not** email). Record file hashes.
- [ ] Obtain **control totals from the seller's own system** (counts, balances) and enter them in the toolkit's source controls.
- [ ] Write the mapping config (§4.5) in a PR-reviewed file; keep it with the migration scope key (`acme-2027`).

### Phase 2 — Day 7–21: dry-run loop (repeat until clean)
- [ ] `dry_run` → read `report`: `canCommit`, `blockers`, per-entity counts, `issueCounts`, `sums`.
- [ ] Resolve: `MATCH_KEY_CONFLICT` (overlapping customers), `ENUM_UNMAPPED`, `REF_NOT_FOUND`, `PHONE_INVALID`/`EMAIL_INVALID` (warnings: values dropped), `KEY_*`.
- [ ] Compare `sums` / row counts with the seller control totals; every difference gets an explanation in writing.
- [ ] Sample-check 20 records per entity by eye against the source.
- [ ] **Gate A (go/no-go):** `canCommit=true`, differences explained, counsel sign-off on data scope, Finance sign-off on totals.

### Phase 3 — Cutover window
- [ ] Freeze source writes (or take a final snapshot) and re-run the dry-run on the **final** files.
- [ ] `start`; while `status = "paused"` call `start` again with the **same files** (the snapshot fingerprint must match).
- [ ] `completed_with_errors` is acceptable only if each error code is understood; export `import_fw_row_errors` (position + code) for the remediation list.
- [ ] Run the toolkit's automated import-vs-source checks; compare with the report totals.

### Phase 4 — Verify (first 14 days: rollback window)
- [ ] Spot-check in the UI: customer history, job counts by status, invoice totals by month.
- [ ] Confirm **no outbound messages** were triggered by imported rows (see risk T-3) and no automation fired on historical jobs.
- [ ] Keep the run open for rollback: `rollback` is exact but only for rows not edited since; the longer the wait, the more rows become `kept_modified`.
- [ ] **Gate B:** Finance + operations accept; then record the run as the system of record.

### Phase 5 — Decommission the source (after retention decisions)
- [ ] Counsel decides retention/deletion of the seller's copy and of the staging files (**REQUIRES COUNSEL**).
- [ ] Delete the uploaded files and any local copies; keep the mapping config and the report (contain no source values).

### Rollback decision table
| Situation | Action |
|---|---|
| Run still `running`/`paused`, mapping wrong | `start` with the corrected mapping (supersedes), or `rollback` newest-first |
| Completed, defects found within the window | `rollback` the run; fix; re-run (ledger was invalidated for reverted rows) |
| `rolled_back_partial` | read `blocked` (FK dependants exist: remove those first) and `kept_modified` (human edits: decide manually); re-run `rollback` |
| Need to stop everything | disable the flag (§4.7) |
| Need to remove the module | migration rollback notes (top of `20290210000000_import_framework.sql`); roll runs back first |

## 6. Identity and billing consolidation — options (no decision taken)

### 6.1 Staff / account identity
| Option | How | Pros | Cons / open questions |
|---|---|---|---|
| **A. Re-home into the buyer's account** | Invite each acquired employee to the buyer account as a `team_members` row (email match); roles via custom roles | One tenant, one set of KPIs; reuses existing invite flow (UNVERIFIED in detail) | Email reuse across tenants (a person already owning a Vireek account); team size/plan limits; permissions review |
| **B. Keep separate accounts, link via Franchise/Locations** | Acquired business keeps its account; `linked_account` scope in the toolkit | No identity migration; clean reversal; matches toolkit design | Duplicated settings; cross-account reporting only through the existing SECURITY DEFINER dashboards |
| **C. SSO / identity federation** | Corporate IdP in front of both | Single sign-on for staff | No evidence of enterprise SSO in the snapshot (UNVERIFIED); passkeys/social login exist (`docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md`) |

Customer-facing identities (portal tokens, saved payment methods, review links) belong to the *business* that collected them: moving them is **REQUIRES COUNSEL** (R-P2, R-C2) and technically not portable for stored cards (R-B2).

### 6.2 Billing / subscription
| Option | How | Pros | Cons / open questions |
|---|---|---|---|
| **A. Consolidate to one Vireek subscription** | Cancel acquired account's plan at a boundary; its users join the buyer plan | One invoice; simplest ops | Proration/credits; seat pricing; plan limits (minutes) |
| **B. Keep separate subscriptions until natural renewal** | Link accounts, merge at renewal | No billing surgery; reversible | Two invoices; parent visibility only via reports |
| **C. Parent-pays (invoiced) umbrella** | Enterprise-style invoicing for linked accounts | Fits PE roll-ups | Needs a commercial decision; not built (UNVERIFIED what `franchise-royalty-issue` covers) |

Customer payments run through Stripe Connect (`stripe_connect_accounts`). **Connected-account ownership, payout destinations and stored payment methods may not be transferable between accounts: confirm with Stripe — UNVERIFIED — and with counsel (R-B1).** Never export or import card data; tokens stay in the processor.

## 7. Risk list

Severity: H/M/L. **REQUIRES COUNSEL** items are not engineering decisions.

### 7.1 Contracts, privacy, regulatory — all **REQUIRES COUNSEL**
| ID | Risk | Sev | Note |
|---|---|---|---|
| R-C1 | Customer agreements may need assignment/consent on change of control; warranties and maintenance plans carry obligations | H | Review before migrating agreements/memberships |
| R-C2 | Contracts with the acquired company's vendors, telephony and software providers; licence transfer | M | Includes call-recording and AI-voice providers |
| R-C3 | Employment/contractor data (technicians, payroll) transfer and notice | H | Jurisdiction-specific |
| R-P1 | Legal basis and notice for re-using the acquired customers' personal data in Vireek; purpose limitation; notices to data subjects | H | Applies to EU/UK/CA/AU/US-state regimes (see `docs/compliance/data-map.md`) |
| R-P2 | Whether the buyer becomes controller/processor for the data; DPA/subprocessor chain; cross-border transfer mechanism | H | Founder is Germany-based (EU exposure) |
| R-P3 | Call recordings, consent evidence and AI-disclosure history collected under the seller's scripts | H | Do not import recordings until reviewed |
| R-P4 | Marketing/SMS/email consent and opt-outs (TCPA, CASL, PECR, GDPR e-privacy) — consents may not transfer | H | Suppress outbound to imported contacts until cleared |
| R-P5 | Data-subject requests received during/after migration; retention schedule of the seller's data | M | Existing erasure tooling covers Vireek tables only (UNVERIFIED for imported provenance) |
| R-B1 | Payment-processor account/merchant agreements; PCI scope; payout continuity | H | |
| R-B2 | Stored cards/payment tokens cannot be moved by Vireek | M | Customers may need to re-enter payment methods |
| R-T1 | Sales-tax registration/nexus for the acquired footprint; tax history carry-over | M | Finance + counsel |

### 7.2 Technical risks (engineering owns)
| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| T-1 | Overlapping customers merged wrongly | H | No silent merge; `MATCH_KEY_CONFLICT` surfaced in dry-run |
| T-2 | Mapping error creates systematically wrong data (e.g. status or money) | H | Closed transforms; enum mapping explicit; control totals; rollback window |
| T-3 | **DB triggers/automations fire on imported rows** (found AFTER-INSERT triggers on `jobs` such as `trg_chat_jobs_ins`, `trg_marketplace_job_insert`, `trg_fcs_jobs`) — may notify customers, post to marketplaces or create follow-ups for historical jobs | H | **UNVERIFIED** what each does for imported rows. Before first commit: read each trigger, test on staging, suppress outbound channels for the import window. The existing wizard has the same exposure |
| T-4 | Deterministic ids are derived from a non-cryptographic hash | L | A crafted collision can only make one row fail on PK; sinks are tenant-filtered and never upsert by id |
| T-5 | `restore` / guarded delete is read-compare-write (small race with a concurrent human edit) | L | Window is milliseconds; kept-modified detection covers the common case |
| T-6 | Edge-function time limit | M | Budgeted calls + resume; throughput UNVERIFIED |
| T-7 | PII in uploaded files and request bodies (platform request logging) | M | Confirm platform logging does not capture bodies (**UNVERIFIED**); use short-lived access and delete files after the window |
| T-8 | `import_fw_save_batch` / RLS policies not executed against Postgres here | M | Run the DB checks in §8 before enabling for any account |
| T-9 | Acquisition KPIs ignore framework-created rows | M | Follow-up F1 |
| T-10 | Case/format differences in phone and email matching vs. the DB unique indexes (phone is stored E.164 by the transform; the wizard may store another shape — UNVERIFIED) | M | Dry-run `findByField` check uses the same stored form; verify on staging with real samples |

## 8. Verification status (this delivery)

| Check | Result | Evidence |
|---|---|---|
| Unit/logic tests (43) for hashing, mapping, CSV adapter, engine (dry-run, idempotency, resume, crash, retries, lease, rollback, tenant isolation), handler | **PASSED** (executed on Node 22 through a temporary `vitest`-API shim, see report) | run output |
| Same tests under the real `vitest` runner | **NOT RUN** (dependencies not installed, no network) | — |
| Strict TypeScript check of all new files | **PASSED** with the Supabase client and `vitest` stubbed as `any` (only error was pre-existing `tenant-export/bundle.ts` TS lib typing, unrelated) | `tsc` output |
| `npm run lint:migrations` rules on the new migration | **PASSED** (ran the repo's `checkMigrationSql`) | — |
| `lint:flags` | **PASSED** (2 flags, 0 errors) | — |
| Migration on a fresh DB and on the current schema | **NOT RUN** (no Postgres) — static review only | — |
| RLS / RPC behaviour (`import_fw_save_batch`, lease, policies), cross-tenant at DB level | **NOT RUN** | add pgTAP test (follow-up F5) |
| Supabase store/sink against a real DB, edge function end-to-end | **NOT RUN / UNVERIFIED** | — |
| ESLint, full test suite, build, e2e | **NOT RUN** | — |

## 9. Follow-ups
- **F1** Link framework runs to `acquisitions` (`acquisition_import_links` references `data_import_jobs`; either bridge framework effects into `data_import_row_effects` or teach `acq_scope` about `import_fw_effects`).
- **F2** More entities (invoices/line items/payments/equipment via the wizard's ledger planners; price book; agreements; technicians).
- **F3** "Merge candidates" workflow for overlapping customers.
- **F4** Storage-backed sources (upload once, resume without re-sending) and a UI page (loading/empty/error/success states, mobile, a11y, route + nav).
- **F5** pgTAP tests in `supabase/tests/database/` for the new tables/RPCs (RLS per role, flag OFF/ON, lease, atomic batch).
- **F6** Staging rehearsal of triggers (T-3) and throughput benchmark.
- **F7** Regenerate catalogs: `python3 scripts/docs/gen-catalogs.py` (adds the new function/tables to `docs/generated/*`).
