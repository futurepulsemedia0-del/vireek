# RLS baseline (`docs/security/rls-baseline.json`)

The baseline freezes the **legacy** findings of `node scripts/security/rls-audit.mjs`. CI (`security-gates.yml`) runs `--check`, which fails when:

- a finding exists that is **not** in the baseline (a new table without RLS, a new `using (true)` policy, an unwrapped `auth.uid()`, …);
- a baseline entry no longer occurs (a fix must shrink the baseline);
- the baseline file is **missing or malformed**. It is never treated as "empty" (that silently disabled the ratchet before);
- `docs/security/rls-audit.{md,json}` or `supabase/tests/database/rls_catalog.test.sql` is stale.

## Commands

| Goal | Command |
|---|---|
| Check (CI) | `npm run security:rls:check` |
| Regenerate the audit docs + pgTAP | `npm run security:rls` |
| Shrink the baseline after fixing findings | `npm run security:rls:baseline` |
| Bootstrap a missing baseline (once, then review the diff) | `npm run security:rls:baseline` |
| Grow an existing baseline (needs reviewer sign-off) | `node scripts/security/rls-audit.mjs --update-baseline --allow-growth` |

`--update-baseline` refuses to add findings to an existing baseline unless `--allow-growth` is passed. A finding with rule `no-rls` must never be frozen (`scripts/security/rls-baseline.test.mjs` enforces it).

## Format

```json
{ "version": 1, "note": "…", "findings": [ { "rule": "policy-true", "table": "docs_feedback" } ] }
```

One entry per unique `(table, rule)` pair, sorted. Rules: `no-rls`, `rls-no-policy`, `policy-true`, `anon-write-policy`, `policy-unwrapped-auth`, `policy-column-unindexed`.

## Needs human review before it is trusted [VERIFY]

The baseline above was regenerated from the current migrations because the original file was absent. Regenerating freezes **everything that exists today**, including findings that were never reviewed. Compared with the last committed audit report, these appeared after it:

- **`rls-no-policy` (113 tables)**: confirm each is meant to be service-role-only (deny-by-default). Credential, token, OTP and consent tables deserve a second look (`provider_credentials`, `fraud_otp_tickets`, `voice_enroll_otps`, `oauth_state_consumed`, `document_share_links`, `evidence_photo_shares`, `home_passport_share_links`, …).
- **`policy-true` (5 tables)**: `docs_feedback`, `job_transition_rules`, `outcome_cross_tenant_aggregates`, `pack_versions`, `you_asked_we_built`. Reconcile with `RLS_EXCEPTIONS.md` (sections A–C).
- **`anon-write-policy` (1)**: `support_conversations`. An anonymous role can write; confirm the intended control (rate limit / Turnstile) or remove it.

Runtime proof is `supabase/tests/database/rls_catalog.test.sql` (pgTAP) against a real database; the static replay is best effort.
