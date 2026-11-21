# Switching process (leaving Vireek) and contract clause drafts

> **Status: DRAFT for counsel and product review. Not legal advice.** Built from a static read of the repository.
> **No SQL was executed against a database**; anything that depends on deployed state is **[VERIFY]**, anything that needs a
> legal or commercial decision is **[COUNSEL]**. The clause texts in section 6 are drafting aids for a lawyer, not contract terms.
>
> Code: `supabase/migrations/20290306000100_switching_requests.sql`, `supabase/functions/switching-request/index.ts`,
> `supabase/functions/_shared/switching/requests.ts`, `supabase/functions/tenant-export/index.ts`,
> `supabase/functions/_shared/tenant-export/{coverage,supplement,bundle}.ts`, `scripts/compliance/export-coverage.mjs`.
> Tests: `requests.test.ts`, `supplement.test.ts`, `export-coverage.test.mjs`, `supabase/tests/database/switching_requests.test.sql`.

## 1. What a customer can do today

| Capability | How | Notes |
|---|---|---|
| Self-serve export, core | `GET tenant-export` (or `?part=core`) | 6 tables (customers, price book, jobs, invoices, calls, audit log). Importable with `tenant-import`. Owner/admin only, filtered by the server-resolved account owner. |
| Self-serve export, supplement | `GET tenant-export?part=supplement` | 64 further business tables (sites, quotes, equipment, memberships, inventory, vendors, reviews, ...). **Export-only**: format `vireek-export-supplement/1`, rejected by import. |
| Switching request | `switching-request` function (`create`, `cancel`, `list`) | One open request per account; status and deadlines recorded; every step logged. |
| Staff handling | `switching-request` (`advance`, `overdue`) | Staff only (`profiles.is_staff`). |

There is **no screen** yet for filing or tracking a request (see section 7).

## 2. Workflow, statuses and deadlines

`requested -> acknowledged -> exporting -> export_ready -> in_transition -> completed`; the tenant can cancel any open request;
staff can reject only before work starts (`requested`, `acknowledged`) and must give a reason of at least 10 characters.

| Deadline | Default (placeholder) | Runs while status is | Stored as |
|---|---|---|---|
| Acknowledge | 3 calendar days from the request **[COUNSEL]** | `requested` | `acknowledge_due_at` |
| Export ready | 30 calendar days from the request **[COUNSEL]** | `acknowledged`, `exporting` | `export_due_at` |
| Retrieval window | 30 calendar days after completion **[COUNSEL]** | after `completed` | `retrieval_ends_at` |

Day counts are columns on each request (`ack_days`, `export_days`, `retrieval_days`), so a signed contract can override them
per customer. `switching_requests_overdue()` lists requests past an acknowledge or export deadline for staff follow-up; nothing
sends reminders automatically yet.

If an EU/UK customer relationship is in scope, counsel must decide whether any statutory switching rules (for example the EU Data Act's
provisions on switching between data-processing services) apply to Vireek's service and, if so, align notice periods, the transition
period, the data-retrieval period and switching charges with them **[VERIFY applicability and current text] [COUNSEL]**. The defaults above are not derived from any statute.

## 3. What the export contains, and what it does not

Verified by `node scripts/compliance/export-coverage.mjs` against `supabase/migrations`:

| Class | Tables | Meaning |
|---|---|---|
| Exported, core | 6 | Importable round trip |
| Exported, supplement | 64 | Portable records, export-only |
| Excluded by rule | 55 | Credentials/key material (`secret`, `credential`, tokens, encryption/identity/feed keys) and platform metering (`*_usage`, rate limits, counters). Never exported: the customer re-creates connections at the new provider |
| **Not yet classified** | **1,331** | Neither exported nor excluded. Many are settings, AI/analytics or derived tables; each needs a decision. Listed in `docs/compliance/export-coverage-baseline.json` |
| Blind spot | 172 | Tables keyed by `owner_id` / `account_id` / `tenant_id` rather than `user_id`; the script counts but does not classify them |

Also **not** in any export: files in storage (photos, recordings, document binaries; rows carry URLs/paths only) **[VERIFY]**, data held by
connected third parties, and anything created after the export time. Because 1,331 tables are unclassified, **do not tell customers the
export is "complete"**; say which categories it covers. The CI command `node scripts/compliance/export-coverage.mjs --check` stops the
gap growing; `--strict` fails until it is zero.

## 4. Operating procedure (staff)

1. Request arrives (`requested`): the 3-day acknowledge clock starts. Confirm identity of the requester is an account owner/admin (the function already enforces it).
2. `acknowledged`: tell the customer the self-serve export exists (both parts), the planned date, and any fee **[COUNSEL]**.
3. `exporting`: if assisted export is needed (large account, truncated tables at 100,000 rows per table, unclassified tables the customer asks for), prepare it and note the manifest checksums in the staff note.
4. `export_ready`: customer confirms receipt of both archives and verifies checksums (manifest `sha256` per file).
5. `in_transition` (optional): parallel running until the customer's cutover date.
6. `completed`: retrieval window starts; after `retrieval_ends_at` the normal account-erasure path applies (`deletion_requests`, retention sweep). Legal holds still block erasure.

Escalate any request past a deadline to the privacy/legal owner. Do not delete data on a customer's behalf outside the erasure workflow.

## 5. Known limits

- A table with more than 100,000 rows is truncated in the export and flagged `truncated: true` in the manifest.
- A supplement table that does not exist in a deployment is skipped and listed under `skipped` in the manifest.
- The supplement is not importable anywhere (not by Vireek, not by `tenant-import`).
- Export contains personal data of the customer's own customers; the customer is the controller of it **[COUNSEL: confirm roles]**.

## 6. Contract clause drafts **[COUNSEL]**

Square brackets are decisions for counsel. These are starting points to be rewritten, not approved language.

**6.1 Right to switch.** "Customer may at any time terminate this Agreement or move some or all of the Services to another provider
or to its own systems by giving Vireek [__] days' written notice (a 'Switching Request') through [the in-product process / notice address].
[Alignment with any mandatory statutory switching rules: __.]"

**6.2 Acknowledgement and plan.** "Vireek will acknowledge a Switching Request within [3] [business/calendar] days and will confirm
the categories of data that will be provided, the format, and any charge under 6.6."

**6.3 Data export.** "Vireek will make available the Customer Data listed in [Schedule __] in an open, documented, machine-readable
format (currently tar archives of NDJSON files with a JSON manifest and SHA-256 checksums) within [30] days of the Switching Request.
Credentials, security keys and Vireek's own operational data are excluded. [Categories not yet covered by the export: __.]"

**6.4 Continuity during transition.** "Until the Switching Request is completed or the Agreement ends, Vireek will keep providing the
Services under the existing terms [for up to __ days]. Customer remains responsible for fees for that period."

**6.5 Retrieval window and deletion.** "After completion Customer may retrieve Customer Data for [30] days. Thereafter Vireek will
delete or anonymise Customer Data within [__] days, except where law or a legal hold requires retention, and will confirm deletion on request."

**6.6 Charges.** "[No charge for self-serve export.] [Assisted export or extended transition: __.] [Any charge will be disclosed
before work begins and will not exceed Vireek's actual costs.]"

**6.7 Personal data of Customer's own customers.** "Customer is the controller [and Vireek the processor] of personal data in the export
[COUNSEL: confirm]. On completion Vireek will, at Customer's choice, return or delete that data in line with the data processing terms."

**6.8 Third parties and integrations.** "Connections to third-party services (accounting, payments, telephony, advertising) are held by Customer
and are not transferred; Customer will re-establish them with the new provider."

**6.9 No lock-in by design.** "Vireek will not impose technical, contractual or commercial obstacles that prevent or unreasonably delay
a Switching Request, [other than those listed in 6.6]."

## 7. Open items (not done by this change)

| # | Item | Owner |
|---|---|---|
| 1 | Screen for owners to file, view and cancel a request (Data Governance settings); staff queue with overdue list | Product |
| 2 | Automatic reminders and escalation for overdue requests; email to the customer on each status change | Engineering |
| 3 | Classify the 1,331 unclassified tables (export, exclude with reason, or justify) and shrink the baseline | Engineering + product |
| 4 | Decide on the 172 owner_id/account_id/tenant_id tables | Engineering |
| 5 | Export of storage files (photos, recordings, documents) | Engineering |
| 6 | Importable format for the supplement (needs per-table FK remap in `tenant-import`) | Engineering |
| 7 | Confirm statutory applicability, deadlines, fees and all clause text | Counsel |
| 8 | Add an i18n/RTL UI for the existing `FullExportButton` supplement download (it is plain English today) | Product |

## 8. How to verify

```bash
node scripts/compliance/export-coverage.mjs --check
node --test scripts/compliance/export-coverage.test.mjs
npx vitest run supabase/functions/_shared/switching supabase/functions/_shared/tenant-export
supabase test db     # includes switching_requests.test.sql
```
