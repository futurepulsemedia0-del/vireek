# Landscaping pack (Trade Pack #3)

Recurring maintenance contracts, crew routes with day-of re-routing, visit checklists with before/after photos, seasonal
add-ons, batch recurring invoicing with pause/resume, and crew productivity metrics.

**Default: OFF.** Two independent switches must both be on for a tenant; otherwise nothing is visible and every RPC raises
`landscaping_not_enabled`:

1. Feature flag `landscaping_pack` (seeded `enabled=false, rollout_pct=0`; override per tenant with `staff_set_flag_override`).
2. Account entitlement `packs:landscaping` (new generic table `account_entitlements`):
   ```sql
   -- as a Vireek staff user (is_vireek_staff):
   select public.staff_set_account_entitlement('<tenant owner uuid>', 'packs:landscaping', true, 'pilot');
   select public.staff_set_account_entitlement('<tenant owner uuid>', 'packs:landscaping', false, 'ended');  -- revoke
   ```
   Every grant/revoke is written to the append-only `account_entitlement_events`.

## Where things live
| Concern | File |
|---|---|
| Migration (tables, RLS, RPCs) | `supabase/migrations/20290301000000_landscaping_pack.sql` |
| pgTAP tests | `supabase/tests/database/landscaping_pack.test.sql` |
| Pure engine (recurrence, weather, routing, billing, metrics) | `src/lib/tradePacks/landscaping/*` |
| Pack manifest | `src/lib/tradePacks/landscaping/manifest.ts` (in `GATED_TRADE_PACKS`, **not** `TRADE_PACKS`) |
| Client API + access gate | `src/lib/landscapingApi.ts`, `src/lib/landscapingMappers.ts` |
| UI | `src/pages/LandscapingPage.tsx`, `src/components/landscaping/*` (route `/dashboard/landscaping`) |
| Cron | `supabase/functions/landscaping-cron` |

## Design rules worth knowing
- **Source of truth for visit generation is the database** (`landscape_plan_visits` → `_landscape_generate_contract`). The TS engine mirrors it for previews;
  `recurrence.test.ts` pins the rules and `landscaping_pack.test.sql` pins the SQL side (DST, holiday shift).
- Visit N falls on `start_date + 7·N days`; visits exist only inside a season and when N is a multiple of that season's interval. Holiday shifts never drift later visits.
- `preferred_time` is restricted to 05:00–20:59 so the DST gap/overlap hours never apply.
- **Idempotency keys:** `(contract_id, occurrence_n)` for maintenance visits, `(contract_id, addon_id, event_key)` for rounds/snow events,
  `(makeup_for)` for make-ups, `(contract_id, period)` for billing. Re-running anything creates nothing new.
- Visits are created together with a normal `jobs` row (so crews see them in their usual schedule) with `invoice_amount = NULL`: landscaping bills **only** through `landscape_run_billing()` (draft invoices, never sent automatically, no payment provider involved).
- Day-of re-routing parks the affected jobs 1000 years ahead and then writes final back-to-back times in one transaction, because `jobs` has a non-deferrable no-overlap constraint. Any genuine clash rolls everything back with `slot_conflict`.
- Weather: an **unknown forecast never skips a visit**. No provider is wired by default (`LANDSCAPING_WEATHER_PROVIDER=none`); dispatchers can still skip by hand.
- Pause windows never overlap (exclusion constraint). Visits in a pause are cancelled (jobs too) and not billed; a flat monthly fee is prorated by active days.
- Voiding a draft invoice releases its billing month so it can be billed again.

## Operations
Environment (documented only; never in code):
| Variable | Where | Purpose |
|---|---|---|
| `LANDSCAPING_CRON_SECRET` | edge function secret | `X-Cron-Secret` header for `landscaping-cron` (fails closed when unset) |
| `LANDSCAPING_WEATHER_PROVIDER` | edge function secret | `none` (default) or `mock`; a real provider needs a reviewed `WeatherAdapter` |

Deploy and schedule:
```bash
supabase functions deploy landscaping-cron --no-verify-jwt
supabase secrets set LANDSCAPING_CRON_SECRET=<long-random-string>
```
Schedule hourly (generation) — same mechanism as `recurring-jobs-cron` (pg_cron + pg_net, `X-Cron-Secret` header). The weather step targets *tomorrow's* visits, so an hourly run is enough.

Rollback: see the header comment of the migration. The non-destructive off switch is turning the flag off or revoking the entitlement.

## REQUIRES COUNSEL
The pack records what crews did; it does not decide what is lawful where you work. Review before relying on them: the default holiday set,
weather thresholds, fertilizer/herbicide application rules (no regulated-product ledger is shipped in this pack), snow-removal liability terms, retention of photos and customer property data, and tax handling on invoices.

## Known limitations / follow-ups
- No real weather provider (adapter interface + mock only).
- Automatic monthly billing is intentionally not scheduled: invoices are drafts a human reviews. A per-tenant auto-bill setting is a possible follow-up.
- Staff UI for granting the entitlement is not included (SQL RPC above).
- A pause that is later shortened does not recreate visits whose date is already in the past.
