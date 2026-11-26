# Data portability: export format, delivery, verification

Status: DRAFT. **[COUNSEL]** = counsel decides. **[VERIFY]** = confirm against the deployed system. **TODO(owner)** = you must supply.
Public page: `/data-promise` (source `src/lib/dataPromise.ts`). Schema reference (generated): `docs/data-portability/SCHEMA.md`
and `public/data-promise/export-schema.json`. Export code: `supabase/functions/tenant-export`, `_shared/tenant-export/*`, button `FullExportButton` on `/dashboard/exports`.

## What the export is

- Core archive `vireek-export/2` (customers, price_book_items, jobs, invoices, calls, audit_log): tar of `manifest.json` + NDJSON chunks, importable.
- Supplement archive `vireek-export-supplement/1` (77 further account-owned tables, e.g. documents, quotes, business_profile): export only.
- Rows: UTF-8 NDJSON, sorted by `id`, keys sorted. `user_id` and the exact keys password, secret, token, access_token, refresh_token, api_key, signing_secret are removed.
- Recording audio is NOT in the archive. `calls.recording_url` carries the stored link. [VERIFY] whether those links are long-lived or signed and expiring.

## Completeness controls (CI)

| Control | Where |
|---|---|
| Every `OWNED_TABLES` entry is exported or exempted with a reason | `_shared/tenant-export/portability.test.ts` |
| Exempt tables and reasons | `_shared/tenant-export/portability.ts` (`PORTABILITY_EXEMPTIONS`) |
| Tables that carry a `user_id` but are in neither list (whole schema) | `npm run export-coverage:check` (baseline file) |
| Schema docs match the export lists | `npm run export-schema:check` and `scripts/compliance/gen-export-schema.test.mjs` |
| Public claims only for exported, verified-live parts | `src/pages/DataPromisePage.test.tsx`, `EXPORT_PARTS_LIVE` |

Regenerate the schema docs after changing an export list or a migration: `npm run export-schema:write`.

## Delivery time (SLA) — nothing is promised until you fill this in

| Item | Value |
|---|---|
| Self-serve export | Runs in the browser when the owner starts it; duration depends on data volume. No commitment published. |
| Export prepared by us on request | TODO(owner): calendar days operations can meet. Then set `DATA_PROMISE_SLA.assistedExportDays` in `src/lib/dataPromise.ts`. |
| Legal wording of the promise | TODO(counsel) |

`docs/compliance/switching-process.md` contains placeholder day counts marked [COUNSEL]; they are NOT published.

## Known gaps (honest list)

1. **Supplement not verified as wired.** In the uploaded zip `tenant-export/index.ts` does not read `SUPPLEMENTARY_TABLES` and `export-coverage:check` fails on that. Confirm `?part=supplement` works in your deployed function, then set `EXPORT_PARTS_LIVE.supplement = true` in `portability.ts`; the public page then lists those categories.
2. **Bearer-style tokens are exported** (`customers.portal_token`, `invoices.invoice_token`, `quotes.quote_token`, 6 more; listed in `KNOWN_BEARER_TOKEN_COLUMNS`). Decide: strip, or warn in the export README. [DECISION]
3. **Exempt tables:** integrations, lead_marketplace_sources (webhook_token), quote_video_sessions, quote_video_settings (no `id`), agent_caller_events, agent_caller_sessions.
4. **Wider schema:** the coverage script still reports >1,300 tables with a `user_id` that are not reviewed, and does not see tables keyed by owner_id/account_id/tenant_id. The page therefore says the export is not a guarantee of every record.
5. Schema docs are derived from migrations, not a live dump. [VERIFY]
