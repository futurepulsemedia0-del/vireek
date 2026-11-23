# Competitor-switching migration playbook

**Audience:** customer-success and onboarding staff helping an account move from another field-service platform.
**In-app companion:** `/dashboard/migration` (nav label *Switching to Vireek*) — the guided checklist and post-import validation report described below.
**Stage:** days -14 to +30 around the cut-over. Complements [Onboarding](./onboarding.md) and [Time-to-value](./ttv.md).

Marker legend (repo rule): **[VERIFY]** = a fact about a third-party product or export we have not confirmed against a live account. **[COUNSEL]** = a legal/contractual point for counsel; nothing here is legal advice.

---

## 1. What already exists (inventory, verified in the repository)

| Path | What it actually does | Not covered |
|---|---|---|
| **File import wizard** — `supabase/functions/data-import-run` (actions `validate` / `run` / `rollback`), `_shared/data-import/*`, `src/lib/importWizard.ts`, `importPresets.ts`, `importLedgerProfiles.ts`, `ImportsPage` (`/dashboard/imports`) | CSV/Excel import with presets for **ServiceTitan, Jobber, Housecall Pro** and generic CSV. Entities: customers, jobs, invoices, invoice lines, payments, equipment. Dedupe strategies (fill blanks / skip / overwrite), saved mappings, per-row errors, undo (rollback). Provenance via `external_source` + `external_id` makes re-imports idempotent. | Preset headers come from documentation/typical layouts and are **not verified against live exports** (stated in `importLedgerProfiles.ts`). Treat a header miss as "map once, we remember". |
| **Generic import framework** — `_shared/import-framework/*` (CSV adapter, dry-run report, resumable) | Reusable engine behind M&A / tenant imports. | Not wired to the customer-facing wizard. |
| **Tenant bundle import** — `supabase/functions/tenant-import` | Re-imports a Vireek-to-Vireek export bundle (dry-run by default). | Not a competitor importer. |
| **Jobber** — `jobber-oauth-start`, `jobber-oauth-callback`, `jobber-webhook` | OAuth connection used for the **price book** (callback lands on `/dashboard/price-book`); webhook handles app-disconnect. | No customer/job/invoice pull from Jobber's API. Use the file wizard. |
| **ServiceTitan / Housecall Pro** — `price-book-connect-servicetitan`, `price-book-connect-housecallpro` | Price-book connections only. | No history pull. File wizard only. |
| **QuickBooks Online** — `qbo-oauth-*`, `qbo-sync-run`, `qbo-webhook`, `quickbooksRecon.ts` | Ongoing accounting sync (accounts, customers, items, invoices, payments) and a read-only reconciliation audit. | It is a **sync**, not a history importer. Historical invoices from the old FSM come in through the ledger file import. |

**Gap this program fills:** nothing told a customer, after an import, whether the numbers were *right*. Pre-import validation existed; post-import reconciliation did not. This playbook plus `/dashboard/migration` adds: a staged checklist, account-wide control totals, and a validation report (counts, unmatched records, duplicates, money totals).

---

## 2. The five phases

The in-app checklist mirrors these phases; auto steps tick themselves from import history and the validation report, manual steps are ticked by a person and saved per account + source.

### Phase 1 — Prepare (day -14 to -7)
1. Confirm the source system and what the customer wants to bring: customers and jobs are the minimum; invoices, lines, payments and equipment are optional but are what make money reconcile.
2. Ask for exports with **ID columns kept** (customer ID, job ID, invoice ID). Without them re-imports cannot be idempotent and jobs/invoices cannot be linked to customers.
3. Agree a **cut-over date and a change freeze**. Anything entered in the old system after the export must be re-exported.
4. **Control totals:** have the customer read these off the old system's own reports *before* importing — customer count, job count, invoice count, job revenue total, invoice total, payments total, open (unpaid) balance. They are entered on the checklist page and compared to the cent.
5. Invite the team (`/dashboard/team`) so dispatchers and technicians can check their own records.

### Phase 2 — Import (day -7 to -3)
1. Order matters: **customers → jobs → invoices → invoice lines → payments → equipment.** Later files link to earlier ones by the old system's customer/invoice ID.
2. Use *Validate* in the wizard first; fix mapping issues; then *Run*. Default dedupe is "fill blanks" — it never overwrites what the account has typed.
3. Export row errors from import history and fix at the source file; re-run (idempotent).
4. Connect or build the price book (`/dashboard/price-book`). Optionally connect QuickBooks (`/dashboard/accounting`).

### Phase 3 — Validate (day -3 to -1)
Open `/dashboard/migration`, pick the source, enter control totals, and work the report to zero failures.

| Check group | Meaning | Fail vs warn |
|---|---|---|
| Counts | created + updated + skipped + errors = rows in the file; file rows = old system's count; created records still exist | **fail** when not equal |
| Unmatched | Jobs/invoices without a customer; invoices pointing at a job not found; payments without an invoice; jobs without an amount | **warn** — fix IDs in the source file and re-import |
| Duplicates | Customers sharing a normalised email, phone (last 10 digits) or name + address with an imported customer | **warn** — merge in Customers |
| Money | Job revenue, invoice total, payments total, open balance vs control totals; invoices whose lines don't add up to their total | **fail** on *any* difference, even one cent; lines mismatch is a **warn** |

Verdict: **blocked** (any fail) → **review** (warnings only) → **ready**. Do not cut over while *blocked*. A cent-level money difference is usually: tax rounding, a voided or deleted invoice still in the export, a date-range mismatch between the two reports, or a credit applied differently — find the cause rather than adjusting the control total.

Then a human **spot-check**: ten customers and ten jobs side by side (name, address, phone, date, amount).

### Phase 4 — Cut over (day 0)
1. Forward or port the business number only when the team is ready. Number porting timelines and carrier requirements: **[VERIFY]** with the carrier.
2. Parallel run for an agreed short period; compare daily totals.
3. Re-run the import for anything created in the old system since the export, then re-run the validation report.

### Phase 5 — Stabilise (day +1 to +30)
1. Train the team: `/dashboard/learn` (owner, dispatcher, technician courses).
2. Keep the old system **read-only**, plus the export files, until finance/tax needs are met. Contract notice periods, data-retention obligations and exit/transfer rights in the old vendor's terms: **[COUNSEL]**.
3. Week-one review: re-run validation, review import history, close open items; log the account's switching experience for the next migration.

---

## 3. Per-source notes

All export instructions are inside the wizard (`PRESETS[].howToExport`). Menu names and column headers in third-party products change; every statement below is **[VERIFY]** against a live account before it is quoted to a customer.

- **ServiceTitan** — Customers and Jobs reports to Excel/CSV. Typical signals the preset looks for: business unit, job type, job number, completed-on. Very large files: the legacy `data-import-run` path caps a run at 5,000 rows; check the wizard's current limit **[VERIFY]** and split files by date range if needed.
- **Jobber** — Clients export and Jobs/Visits report. Client first/last name and business name are separate columns; the preset handles both.
- **Housecall Pro** — Customers and Jobs exports. Same file-wizard path.
- **QuickBooks users** — QuickBooks stays your books. Connect it for new activity; import *history* from the FSM export. After both, the QuickBooks reconciliation audit can compare Vireek's invoices with QuickBooks (read-only).
- **Anything else / spreadsheets** — choose *CSV / Excel* and map once; mappings are saved per source + type.

## 4. Known limits (state them honestly)
- Money control totals are US-format dollars; multi-currency accounts should reconcile one currency at a time. **[VERIFY]** against the multi-currency work before using with non-USD data.
- The duplicate scan compares every customer in the account to the imported ones; it is read-only and never merges automatically.
- The validation report reflects what is in Vireek *now*. If someone edits imported records afterwards, totals can legitimately change; re-run it right before cut-over.
- Equipment links to customers by construction (`customer_id` is required), so there is no "unmatched equipment" check.

## 5. Escalation
Blocked verdict after two fix-and-re-import cycles → engineering ticket with: source, import job IDs (from Data Imports history), the CSV export of the validation report (contains counts and money only, no customer data), and the control totals used.

## 6. Success measures (existing signals only)
Time from first import to cut-over; checklist completion %; validation verdict at cut-over; week-4 health band from [Time-to-value](./ttv.md).
