# OSHA recordkeeping (Forms 300 / 300A / 301)

Roadmap item 109. Engineering description, **not legal advice**. Status: DRAFT · Owner: `TODO(owner)` · Counsel: `TODO(counsel)`.

## What exists
- Tab **Site safety → OSHA records** (managers only). Component `src/components/safety/OshaRecordkeepingPanel.tsx`.
- Tables (migration `20290312000000_osha_recordkeeping.sql`): `osha_settings`, `osha_cases`, `osha_case_counters`, `osha_annual_summaries`, `osha_audit_events`.
- Reuse of the incident ledger (`safety_incidents`): an **injury** incident can be reviewed and promoted to a case (`incident_id`, one case per incident, idempotent). The case is a copy, so `safety_purge_expired()` deleting the incident never deletes the OSHA record (FK `ON DELETE SET NULL`).
- Exports: Form 300 log CSV (privacy cases masked server-side) and Form 300A summary CSV. **Official OSHA form PDFs are not generated.** `TODO(owner)`: decide whether to fill the official forms or only submit the CSV data.
- Totals are computed in SQL from non-voided cases. After certification the totals are frozen in `certified_totals`.

## Access
Read: account owner's managers (`safety_can_manage()`) through RLS. Write/export: SECURITY DEFINER RPCs only. Technicians and other roles see nothing. `TODO(counsel)`: employee and representative access rights (log, own Form 301) and the request workflow.

## Retention (config)
`osha_settings.retention_years` (default 5, minimum 5). Per case: `retain_until = Dec 31 of case year + retention_years`. Nothing deletes a case. `osha_cases_past_retention()` only lists them.
`TODO(counsel)`: confirm period, and conflict with account erasure (`erase_user_rows()` will delete these rows when an account is erased).

## Things the app deliberately does not do
Decide recordability; compute days away/restricted; submit to OSHA electronically; post the summary; handle severe-injury / fatality reports; apply state-plan variations. `TODO(counsel)` for each.

## Supply before use
Establishment identity and NAICS (`TODO(owner)`), certifier wording and who may certify (`TODO(counsel)`), privacy-reason list review (`TODO(counsel)`), 180-day cap check (`TODO(counsel)`), amendment procedure for a certified year (`TODO(counsel)`).

## Database verification (not yet run)
No Postgres was available when this was written, so the SQL has only been checked statically. Before release, in a throwaway database:
1. Apply the migration twice (second run must be a no-op).
2. As manager A: create settings; promote an injury incident twice (second call returns `existing: true`); create a privacy case; export 300 (name shows `Privacy Case`); save inputs; certify; certify again (`already_certified`).
3. As technician A and as manager B (other tenant): `select` from every `osha_*` table returns 0 rows; every RPC raises `42501` or `P0002`.
4. As `authenticated`: `insert/update/delete` on every `osha_*` table is denied.
5. Void a case in a certified year: must raise.

## Tests
`npm run test:scripts:osha` — core logic, TS/SQL value drift, static RLS/grant checks.
