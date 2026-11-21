# Runbook: bank-data provider failure (Plaid and any future aggregator)

Related: `docs/vendor-exit/plaid.md` (exit, not outage), `docs/runbooks/incident-response.md`, `docs/PAY_BY_BANK.md`. Code: `supabase/functions/_shared/bank/provider/*`, `_shared/bank/sync.ts`, `bank-intelligence`, `bank-webhook`. Migration: `20290306000000_bank_provider_resilience.sql`.

> Status: **DRAFT, not drilled.** No outage drill has been run against this code. Vendor-side facts are marked **[VERIFY]**; contractual / privacy questions are marked **[COUNSEL]**. Nothing here is a compliance claim.

## 0. What the system does by itself (design, verified by unit tests with a mock provider; NOT yet by a live outage)

| Layer | Behaviour |
|---|---|
| Adapter | Everything above `provider/types.ts` is vendor-neutral. Plaid specifics live only in `plaidProvider.ts`. |
| Circuit breaker | Provider-side failures (`provider_unavailable`, `rate_limited`, `unknown`) are counted. 2 in a row ⇒ `degraded`; 5 in a row ⇒ `down`: Vireek stops calling the vendor for 30 s, doubling per further failure up to 15 min, then lets **one** probe through. A success closes the circuit. |
| What does NOT trip it | A customer's bank asking them to sign in again (`auth_required`), "history not ready", one bank being unreachable, and our own request bugs. One customer cannot degrade the provider for everybody. |
| Degradation | While `down`/`degraded`, `syncConnection` returns `skipped: "provider_unavailable"` and touches nothing: the connection stays `active`, `last_error` is not set, **no customer is told to reconnect their bank**. Matching, categorisation, forecasts and briefs keep running on data already in Postgres. API response: HTTP 503 with `code: "provider_unavailable"` and `retry_after_seconds` for link/exchange; `sync` returns `degraded: true`. |
| Webhooks | **Never** gated by the circuit. Verification and parsing do not need the vendor to be up. Events that arrive during an outage trigger a skipped sync; the data is picked up by the next successful sync (see §3, gap G1). |
| Freshness | Action `status` of `bank-intelligence` returns, per connection, `providerState`, `freshness` (`fresh` ≤ 36 h / `stale` / `never`), `servingCachedData`, `retryAfterSeconds` and an i18n key (`bank.status.*`). |
| Metering | Every vendor call writes one `bank_pull_usage` row (operation, units, duration, ok/error/blocked, cost). Blocked calls cost a known 0. |
| Consent | Link completion writes an append-only `bank_data_consents` row; disconnect revokes it. Enforcement is OFF by default (`BANK_CONSENT_ENFORCE=true` turns it on). |

## 1. Detect

- `bank_provider_health.state <> 'healthy'` (query below), or log events `bank_provider_state_change`, `bank_sync_degraded`, `bank_provider_error`.
- Customer reports "balances look old". Check `status` for the account first.
- Vendor status page and dashboard **[VERIFY: confirm the current status-page URL and notification channel in the vendor account]**.

```sql
-- current circuit state
select provider, state, consecutive_failures, last_error_kind, last_failure_at, last_success_at, circuit_open_until
from bank_provider_health;

-- last 24 h: calls, errors, blocked, known cost (micro-USD) and calls whose cost is unknown
select * from bank_pull_usage_daily where day >= now() - interval '1 day' order by day desc, provider, operation;
```

## 2. Triage (≈10 min)

1. **Is it us or the vendor?** `last_error_kind` = `provider_unavailable` + vendor status page red ⇒ vendor incident. `rate_limited` ⇒ we are over a limit (check for a runaway loop; see 2.3). `unknown` ⇒ likely our bug or an unmapped vendor error: read `bank_provider_error` logs, add the code to `mapPlaidError`.
2. **Is it one bank?** Many `institution_unavailable` skips for the same `institution_name` and a healthy circuit ⇒ one institution is down; nothing to do but wait. **[VERIFY]** how the vendor signals institution outages; the mapping in `plaidProvider.ts` is unconfirmed.
3. **Runaway cost/volume?** `bank_pull_usage_daily` shows `calls` spiking for one `connection_id`/`user_id` ⇒ look for a webhook loop; reduce load by disabling the nightly/manual trigger, not by editing the breaker.

## 3. Actions during an incident

- **Do not** bulk-mark connections `login_required` or ask customers to reconnect: it does not help and creates support load.
- **Do not** reset the breaker by hand while the vendor is still failing; the probe logic is the safe way back. Emergency override only if the circuit is stuck open although the vendor is demonstrably healthy:
  ```sql
  update bank_provider_health set state='healthy', consecutive_failures=0, circuit_open_until=null where provider='plaid';
  ```
  Record who did it and why in the incident doc.
- **Customer comms** (use `status` keys, adapt for the status page): "Our bank-connection provider is having an issue. Your existing data and reports remain available and are marked with the time they were last updated. New transactions will appear automatically once the provider recovers. No action is needed from you." Do not promise a recovery time.
- **Pay-by-bank:** this runbook covers *data* access only. Payment initiation has its own path (`docs/PAY_BY_BANK.md`); confirm separately whether it is affected.

## 4. Recovery

1. Vendor recovered ⇒ the next call is a probe; on success state returns to `healthy` by itself. Confirm with the health query.
2. **Catch up:** trigger `sync` for affected accounts (customers' manual refresh does this; for all tenants use an operator-run script, see G1). `transactions/sync` is cursor-based, so nothing is lost when a sync was skipped; the cursor resumes where it stopped.
3. Check reconciled transactions flagged `needs_review = true` (the vendor changed amounts after reconciliation); these are never rewritten silently.
4. Look for **orphaned vendor items**: if a customer disconnected during the outage, `removeItem` failed (`bank_item_remove_failed` log) while the stored token was deleted, so the vendor-side item may still exist and may still be billed **[VERIFY billing model]**. Collect those `connection_id`s from logs and remove them from the vendor dashboard.
5. Write the postmortem from `post-incident-template.md`; attach the usage query output.

## 5. Cost metering: how to use it

- `bank_provider_rates` is **empty on purpose**. Vendor pricing is contract-specific **[VERIFY]** and varies by model (per call, per connected item, per month). Finance inserts rows:
  ```sql
  insert into bank_provider_rates (provider, operation, micros_per_unit, note)
  values ('plaid', 'transactions_page', 0 /* micro-USD per unit, from the signed order form */, 'source: <contract ref>');
  ```
  Units: 1 call = 1 unit; a transactions sync page = 1 unit. 1 USD = 1 000 000 micros.
- Until a rate exists, `cost_micros` is `NULL` ("unknown"), and `bank_pull_usage_daily.calls_with_unknown_cost` says how many calls are uncosted. **Do not read `known_cost_micros` as the total bill** while that number is non-zero.
- Per-call metering does not capture subscription-style fees; reconcile against the vendor invoice monthly.
- Retention: `select bank_prune_pull_usage(400);` (refuses < 30 days). Not scheduled by this change.

## 6. Consent records

- Table `bank_data_consents`: one active row per connection; revocation is the only permitted change, and revoked rows are immutable; the history survives deletion of the connection.
- `evidence = 'link_completed'`: the user completed the provider link flow in Vireek. `evidence = 'legacy_inventory'`: created by the migration for connections that predate consent records; it proves only that the connection existed, **not** what the user was shown.
- Vireek's own consent notice text/version is **not** shipped. The API stores `notice_version` / `notice_acknowledged` only if the client sends them. What the notice must say, whether it must be shown before Link, retention of these records, and whether `legacy_inventory` rows are acceptable evidence are **[COUNSEL]** questions.
- Enforcement: set `BANK_CONSENT_ENFORCE=true` on `bank-intelligence` and `bank-webhook` to refuse pulls (`skipped: "consent_missing"`) for connections with no active, unexpired consent. Because of the legacy rows, turning it on does not break existing customers; it blocks only connections with a revoked or missing record.

## 7. Adding / switching a provider

Implement `BankDataProvider` (`provider/types.ts`), map its errors to `ProviderErrorKind`, add the provider id to the CHECK constraints in `bank_provider_health`, `bank_provider_rates`, `bank_pull_usage`, `bank_data_consents` (and `bank_connections.provider`), wire it in `provider/index.ts`, and run `provider.test.ts` plus a shadow run per `docs/vendor-exit/plaid.md` §5. Tokens do not transfer between aggregators **[VERIFY]**.

## 8. Known gaps (as of this change)

- **G1 – no working scheduled catch-up on the live path.** The only cron in the repo (`vireek-bank-nightly-sync`) targets `bank-sync`, which does not compile against the live schema (see "Pre-existing defects" in the delivery report). Catch-up after an outage relies on webhooks (redelivered by the vendor **[VERIFY]**) and customers' manual sync.
- **G2 – access tokens are stored in plaintext** in `bank_connection_secrets.access_token` on the live schema (`crypto.ts` exists but is used only by the non-compiling functions). Not changed here.
- **G3 – half-open probing is best-effort across edge instances.** State is shared through Postgres without a lock, so during recovery a few concurrent probes can slip through. Acceptable at this scale; revisit if the breaker is reused for high-volume providers.
- **G4 – the thresholds (2 / 5 failures, 30 s – 15 min) are defaults, not tuned** on real traffic.
- **G5 – no UI banner yet.** The `status` action and i18n keys' contract exist; rendering them is not part of this change.
