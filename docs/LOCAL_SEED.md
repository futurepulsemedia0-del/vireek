# Local / dev seed flow

How to get a development database with realistic data, using what is actually in the repo:

1. **Demo account + base data** — created by the migration `supabase/migrations/20260821101216_seed_demo_data.sql`.
2. **Equipment health telemetry story** — `demo-seed.sql` (repo root).
3. **Optional: simulated sensor traffic through the real ingest endpoint** — `scripts/telemetry-simulate.mjs`.

> ⚠️ **Dev/staging only.** Item 1 is a *migration*, so it runs on every project you `db push` to, including production, and creates a user with a
> password stored in the file (`demo@vireek.com`). Use a dedicated dev project; see RUNBOOK §8 item 3 before pushing migrations to production.
> `demo-seed.sql` inserts rows directly and must never be run against production.

## 0. Prerequisites

- A **dev Supabase project** (or a local stack — see "Local Supabase CLI" below) and its URL / anon key in `.env` ([ENVIRONMENT.md](../ENVIRONMENT.md) §A).
- All migrations applied (`supabase link --project-ref <dev-ref> && supabase db push`). Known migration-history issues (duplicate versions) are described in RUNBOOK §3.3 — fix or work around them on the dev project first.
- App running: `npm run dev`.

## 1. Demo account and base data (migration seed)

Applying migrations creates (idempotently — it checks for the fixed id `a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11` first):

- auth user `demo@vireek.com` (password is in the migration file), email confirmed;
- a fully onboarded `profiles` row on the `professional` plan;
- a plumbing `business_profile`, one connected `integrations` row (Airtable), six `calls`, four `leads`, three `jobs`, one active technician `team_members` row and one `ai_insights` row.

Sign in at `/login` with that account. Everything is keyed to that fixed user id.
It does **not** create customers or equipment — create them in the UI (Dashboard → Customers → open a customer → add equipment) when a feature needs them.

## 2. Equipment-health telemetry (`demo-seed.sql`)

`demo-seed.sql` generates 6 days of readings at 10-minute steps for the **most recently created** `pio_devices` row, for three metrics:
`vibration_mm_s` (base 4.0), `current_a` (11.0), `temp_delta_f` (18.0). The first ~5 days are normal with small noise; over the last 24 h the values drift
(vibration up, current up, temperature delta down) to mimic a degrading HVAC condenser. It inserts ≈2,600 rows into `pio_telemetry`
(retention job `pio_prune_telemetry` deletes rows older than 45 days, so this survives).

Steps:

1. In the app (signed in as the demo user) make sure a customer with an **active equipment** unit exists.
2. Open **Dashboard → Property Intelligence** (`/dashboard/property-intelligence`) and register a device for that equipment (calls the `pio_register_device` RPC; the device key is shown once — copy it if you also want §3).
3. Run `demo-seed.sql` against the dev database:
   - Supabase Dashboard → SQL Editor → paste the file → Run (runs as a privileged role; `pio_telemetry` has no client INSERT policy), **or**
   - `psql "$DEV_DATABASE_URL" -f demo-seed.sql` (connection string from Dashboard → Project Settings → Database).
4. Verify:
   ```sql
   select metric, count(*), min(recorded_at), max(recorded_at)
   from pio_telemetry
   where device_id = (select id from pio_devices order by created_at desc limit 1)
   group by metric;
   ```
   Expect 3 rows, ≈865 each.
5. In the app, press **Run scan now** on the Property Intelligence page (invokes `property-intelligence-agent` with your user JWT for your account). The edge function must be deployed
   to the dev project with `--no-verify-jwt` (ENVIRONMENT/RUNBOOK §2.3). Outcomes (predictions / missions) appear on the page; customer outreach defaults to *needs owner approval* in Agent Governance.

**Re-running:** timestamps are anchored on `now()`, so a second run adds another overlapping set (the unique key is `device_id, metric, recorded_at`, which rarely collides). To start clean on **dev only**:

```sql
delete from pio_telemetry
where device_id = (select id from pio_devices order by created_at desc limit 1);
```

If the seed inserts nothing, no `pio_devices` row exists yet — do step 2 first.

## 3. Optional — simulated sensors through the real endpoint

`scripts/telemetry-simulate.mjs` feeds the **Building Telemetry Intelligence** feature (a different subsystem from `pio_*`): 5 days of normal HVAC behaviour plus a developing low-refrigerant fault over the last 18 h.

```bash
INGEST_URL="https://<dev-ref>.supabase.co/functions/v1/telemetry-ingest" \
TOKEN="vrk_tg_..." EQUIPMENT_ID="<equipment uuid>" node scripts/telemetry-simulate.mjs
# FAULT=0 for healthy data only
```

Then open `/dashboard/building-telemetry` and press **Run analysis now**. `telemetry-ingest` must be deployed with `--no-verify-jwt`; the `vrk_tg_…` token comes from creating a gateway on that page.

## Local Supabase CLI (optional, unverified)

The repo has no `supabase/config.toml`. `supabase init` would create one, then `supabase start` + `supabase db reset` could apply the migrations and seed locally — but this has **not** been verified
for this repository, and duplicate migration versions (RUNBOOK §3.3) may block it. Prefer a dedicated dev project until that is resolved. Never run `db reset` against a linked remote project.

## Other seed-like helpers

- `scripts/ingest-brand-knowledge.mjs --dry-run` — shows the knowledge chunks built from `src/lib/{pricing,industries,glossary,competitors,integrations,brandFacts}.ts` without keys; a real run needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COHERE_API_KEY` (ENVIRONMENT §F).
- `scripts/generate-rss.mjs` — regenerates blog/changelog feeds.
