# Payroll connectors (Gusto, ADP, Paychex, Rippling)

Exports approved hours, commissions and tips to a payroll provider. Page: `/dashboard/payroll-connectors` (owner or `can_view_billing`).

## How it works
- **Sources**: approved timesheets, approved commission records (negative nets carry forward), paid tips (mapped via `employees.team_member_id`). Only rows not yet on a Vireek pay run.
- **Reservation**: creating an export reserves every source row (`uq_payroll_export_sources_active`). A row can be in one active export only. Voiding releases it.
- **Guard**: triggers on `timesheets`, `commission_records`, `tips` raise `PAYROLL_EXPORT_LOCK` if an exported row is attached to a Vireek pay run, so nothing is paid twice.
- **Gusto**: live API (OAuth). Values are SET (not added) on the matching unprocessed payroll; idempotent; conflicts are left untouched unless "overwrite" is chosen.
- **ADP / Paychex / Rippling**: CSV files. Compare the column layout with your own provider import template before the first real upload.

## Deploy
1. Run `supabase/migrations/20271210000000_payroll_provider_connectors.sql`.
2. `supabase functions deploy payroll-connector`
3. `supabase functions deploy payroll-connector-oauth-callback --no-verify-jwt`
4. Secrets: `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `PAYROLL_STATE_SECRET`, `PAYROLL_TOKEN_ENCRYPTION_KEY`, `SITE_URL` (optional `GUSTO_ENVIRONMENT`, `GUSTO_API_VERSION`).
5. Gusto redirect URI: `https://<project-ref>.supabase.co/functions/v1/payroll-connector-oauth-callback`.

## Not included
Bonus/spiff payouts, GL posting, taxes (the provider handles those).
