# Staff impersonation: enforced limits

Supersedes the "Known limit" section of `staff-impersonate-grant-gate.md` (the grant gate itself is unchanged and still optional).

| Limit | Where it is enforced |
|---|---|
| Session is distinguishable | `custom_access_token_hook` stamps `imp: {sid, staff, exp}` into the JWT of the session created by the staff magic link |
| Expiry | Hook refuses refresh after `expires_at`; hook caps the token `exp`; `impersonation_expired()` re-reads the row; `get_account_owner_id()` returns NULL when expired; sweeper (pg_cron, 1 min) closes the row and deletes the `auth.sessions` row |
| Money | RESTRICTIVE write policies (`imp_block_ins/upd/del`) on money tables; edge guard `blockIfImpersonating` on refund, payout, checkout, billing portal, Stripe Connect, payment-plan and pay-by-bank actions |
| Credentials | RESTRICTIVE `imp_block_all` on every RLS table named `*_secrets`, `*_credentials`, `api_keys`, `*_access_tokens`; `provider-disconnect` guarded |
| Export | `can_export_data()` false while impersonating; `export-run` guarded |
| Audit | `staff_audit_log` (`impersonation_bound`, `impersonation_blocked`, `impersonation_expired`, `impersonation_end`) + the customer's own `audit_log` |
| Visible | `ImpersonationBanner` (countdown, urgent in the last 5 minutes, "End support session") |

## Prerequisites (fail closed)
1. Apply migrations `20290306000000`, `20290306000010`, `20290306000100` in order.
2. Enable the hook (`supabase/config.toml` locally; Dashboard > Authentication > Hooks on hosted): `public.custom_access_token_hook`.
3. Set `IMPERSONATION_CLAIMS_ENABLED=true` on `staff-impersonate`. Without it, new sessions are refused (an unmarked session would be indistinguishable from the owner).
4. Staging check: start a session, open the link, decode the access token: it must contain `imp`. Then confirm `end` and expiry both log the browser out.

## [VERIFY] before production
- The `authentication_method` GoTrue passes for magic-link verification (constant `c_bind_methods` in the hook).
- That GoTrue signs a hook-modified `exp`; if not, the cap is ignored and the other layers still hold.
- That the migration role may `DELETE FROM auth.sessions` (a WARNING is raised and the close continues if not).
- Direct PostgREST access with an already-issued access token is bounded by the token `exp` cap and by `get_account_owner_id()`; tables keyed on `auth.uid()` directly are not covered by the kill switch.

## Known gaps
- Race: if the real owner signs in by magic link/OTP while a staff session is open and unbound, that login is bound instead (fails safe: the owner is restricted until it ends).
- DB-level blocks raise an exception, so they cannot write their own audit row; blocked attempts are audited from the edge layer only. PostgREST-direct blocks are not audited.
- `tenant-export` and other functions not listed in the apply guide are not yet wired to `blockIfImpersonating`.
