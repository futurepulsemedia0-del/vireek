# Vireek — Runbook

Operational procedures: deploy, rollback, migrations, secrets, backups and incident response.
Derived from the repository (workflows, `vercel.json`, migrations, edge-function headers). Where the repo does not define
a process, the step says **"decide / verify"** — nothing here assumes tooling the code does not show.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [ENVIRONMENT.md](ENVIRONMENT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [docs/LOCAL_SEED.md](docs/LOCAL_SEED.md)

**Golden rules** (from `.github/copilot-instructions.md`, apply to humans too): production data is never modified by hand
without a written reason; no destructive migrations; no database reset; never weaken auth/RLS to "make an error go away".

---

## 0. Systems and where to look

| System | What it runs | Where to look |
|---|---|---|
| Vercel | The SPA (static build) + headers/rewrites from `vercel.json` | Vercel project → Deployments / Logs |
| Supabase | Postgres, Auth, Realtime, Storage, Edge Functions, `pg_cron` | Dashboard → Logs (Edge Functions, Postgres, Auth), Database → Cron |
| GitHub Actions | CI, security, quality gates, edge deploy, preview smoke, nightly AI regression | Repo → Actions |
| Sentry/GlitchTip | Browser errors (only if `VITE_SENTRY_DSN` is set) | Sentry project |
| Stripe / Vapi / Twilio / Resend / Plaid | Webhook senders | Each provider's webhook delivery log |
| Status page | `/status` page + `VITE_STATUS_API_URL` provider; subscribers in `status_subscribers` | Status provider; `notify-status-subscribers` |

The production Supabase project ref is embedded in `vercel.json` (CSP `connect-src` and the agent-card rewrite). **A new
project/environment requires updating that file**, otherwise the browser CSP will block it.

---

## 1. Release checklist (every deploy)

1. PR green: `CI` (lint, typecheck, unit + coverage, build, E2E), `Security`, `Quality Gates`, `Edge Functions` (if functions changed).
2. Migrations in the PR? → follow §3 **before** merging the frontend that depends on them (additive first, code second).
3. Edge functions changed? → follow §2.3 after merge.
4. Merge to `main` → Vercel builds and deploys production automatically (the repo contains no manual Vercel deploy step; **verify**
   the Git integration is connected on the Vercel project).
5. Post-deploy smoke (2 min): open `/`, `/pricing`, `/login`, sign in to the dashboard, open Calls/Jobs (realtime badge says **Live**),
   trigger one low-risk action.
6. Preview deployments are smoke-tested by `vercel-preview-smoke.yml` (needs `VERCEL_AUTOMATION_BYPASS_SECRET`; runs from the default branch's copy).

---

## 2. Deploy

### 2.1 Frontend (Vercel)

- Build: `npm run build` (Vite). Output `dist/`. All routes rewrite to `/index.html`.
- Required Vercel env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (+ optional ones in [ENVIRONMENT.md](ENVIRONMENT.md) §A).
  **Changing a `VITE_*` value requires a redeploy.**
- Security headers/CSP live in `vercel.json`. Adding a new third-party script/connection requires a CSP edit (the inline-script
  hashes `sha256-…` in `script-src` must be regenerated if an inline script in `index.html` changes).
- Emergency maintenance screen without code change: see §6.2.

### 2.2 Database migrations

See §3 — they are applied with the Supabase CLI against the target project.

### 2.3 Edge functions

Each function is its own deploy unit: `supabase/functions/<name>/index.ts` (+ `_shared/`).

```bash
supabase functions deploy <name> --project-ref <ref>                 # JWT verification ON (user-called functions)
supabase functions deploy <name> --project-ref <ref> --no-verify-jwt  # webhooks, cron, device ingest, OAuth callbacks
```

**Getting `--no-verify-jwt` wrong breaks production**: a webhook deployed with JWT verification ON returns 401 to Stripe/Vapi/Twilio;
a user-called function deployed with it OFF loses the platform auth check. The functions whose headers say `--no-verify-jwt`
(45 in the snapshot; regenerate the list with
`grep -rhoE "supabase functions deploy [a-z0-9-]+ --no-verify-jwt" supabase/functions | sort -u`) include: `stripe-webhook`,
`vapi-webhook`, `bank-webhook`, `telemetry-ingest`, `iot-ingest`, `telematics-ingest`, `fleet-telemetry-ingest`, `api-v1`, `mcp-server`,
`dispatch-webhook`, `event-bus-dispatch`, `send-push-notification`, the four `*-oauth-callback` functions, and the cron-style
`weather-surge-check`, `automation-*`, `compute-*`, `property-intelligence-agent`, `predictive-failure`, `home-health-agent`,
`service-guarantee-tick`, `switching-shield`, `workflow-graph-executor`.

The repository has **no `supabase/config.toml`**, so per-function `verify_jwt` settings are not version-controlled. Until you add one
(`[functions.<name>] verify_jwt = false` for each function above), the deploy flag is the only source of truth — which is why the
CI deploy job in `edge-functions.yml` is **disabled by default** (`EDGE_DEPLOY_ENABLED`) and refuses to run without `config.toml`.

Steps:
1. Typecheck locally: `deno check supabase/functions/<name>/index.ts` (CI does this for changed functions).
2. Set any new secrets first (`supabase secrets set …`, see ENVIRONMENT §B).
3. Deploy with the right flag; changes to `_shared/` require redeploying **every function that imports it** (functions are bundled at deploy time).
4. Tail logs (Dashboard → Edge Functions → Logs) and call the function once.
5. Functions needing a schedule: configure the scheduler to send `X-Cron-Secret` (ENVIRONMENT §B7) or rely on the `pg_cron` job a migration created.

One-time project setup items some functions need: private Storage bucket `dr-backups` (for `dr-backup-run`); `app.settings.*` DB settings
(ENVIRONMENT §D); provider webhook URLs `https://<ref>.supabase.co/functions/v1/<function>` registered at Stripe, Vapi, Twilio
(inbound SMS), Plaid, Meta (WhatsApp, with `WHATSAPP_VERIFY_TOKEN`), your email-inbound provider.

---

## 3. Migrations

### 3.1 Rules for a new migration

- File: `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql` — **unique timestamp**, `.sql` extension.
  `scripts/lint-migrations.mjs` (CI job *Migration lint*) rejects bad names, duplicate versions, empty files and, for **new** files,
  destructive SQL (`DROP TABLE/COLUMN/SCHEMA/TYPE`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER … TYPE`, renames) unless the file contains
  `-- lint:allow-destructive <reason>`. It warns on tables without `ENABLE ROW LEVEL SECURITY` (`-- lint:allow-no-rls <reason>`) and
  `SECURITY DEFINER` functions without `SET search_path`.
- Make it **idempotent and additive** (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `ADD COLUMN IF NOT EXISTS`).
- New tenant table checklist: `user_id uuid NOT NULL DEFAULT auth.uid()` (or the owner id), `ENABLE ROW LEVEL SECURITY`, policies with
  `user_id = public.get_account_owner_id()`, indexes for the filter columns, `GRANT EXECUTE` on new RPCs to the right role only.
- Realtime needed? Add the table to `supabase_realtime` in a guarded `DO` block (pattern in `20260901120000_realtime_and_perf_indexes.sql`).
- Scheduled SQL? `cron.schedule(...)` inside a guarded block; jobs that call functions need the `app.settings.*` values.
- Never put real secrets in a migration.

### 3.2 Apply

```bash
supabase link --project-ref <ref>
supabase db push --dry-run   # review what will run
supabase db push
```

Apply to a **staging/dev** project first. The seed demo user migration (`20260821101216_seed_demo_data.sql`) runs on whatever project you
push to — see §8 item 3.

### 3.3 Known migration-history problems (as found in the snapshot)

- **62 migration versions are shared by 2–7 files** (e.g. six files share `20270401000000`). The CLI tracks migrations by version, so
  duplicate versions are a known blocker for fresh applies / `db push` ordering. Existing production state decides how to fix this:
  *do not rename already-applied files* — decide a one-time reconciliation (e.g. `supabase migration repair`) with someone who can inspect `supabase_migrations.schema_migrations`.
- `20260913010000_price_book_sync.sq` has a `.sq` extension and is never applied.
- `20260915_phone_numbers.sql` and `20260916_job_cost_entries.sql` have 8-digit versions (not 14).
- The version range extends into 2027, so every migration created now sorts **before** the latest existing ones; the lint does not enforce ordering for that reason.
- Several legacy migrations contain `DROP TABLE` / `TRUNCATE` (flagged only as legacy warnings by the lint).

### 3.4 Rollback

There are **no down-migrations** and the project policy forbids destructive ones. Roll **forward**: write a new additive migration that fixes the problem.
For data loss use backups (§5). Do not run `supabase db reset` against anything but a throw-away local DB.

---

## 4. Rollback

| What | How |
|---|---|
| Frontend | Vercel → Deployments → pick the last good production deployment → **Promote / Instant Rollback** (platform feature). Or `git revert` the merge commit on `main`. Remember env-var changes need a redeploy too |
| Edge function | Redeploy the previous commit's version: `git checkout <good-sha> -- supabase/functions/<name>` → deploy with the same `--no-verify-jwt` flag as before. (No version history is kept by the repo.) If `_shared/` changed, redeploy all dependants |
| Secrets | `supabase secrets set NAME=<old value>` (keep old values in your secret manager until the change is verified). Functions pick up secrets on the next invocation/cold start (**verify** timing for your plan) |
| Migration | Forward-fix only (§3.4) |
| Feature misbehaving but code is fine | Use the product's own kill switches where they exist: AI governance approval queue / spend limits (`agent_permissions`, `agent_spending_limits`, `ai_budget_limits`), `automation` gate (`_shared/automation/gate.ts`), pause/revoke devices (`pio_set_device_status`), revoke API/agent keys, disable a scheduler |

---

## 5. Backups and disaster recovery

Layers:

1. **Supabase infrastructure backups / PITR** — the strongest layer (plan-dependent: the `dr-backup-run` header refers to PITR / nightly physical backups on Pro and above). *Decide/verify*: plan, retention, and who can trigger a restore.
2. **Application-level logical backup — `dr-backup-run`** (run daily, off-peak): dumps `OWNED_TABLE_NAMES` (`_shared/compliance/ownedTables.ts`) plus `profiles`, `team_members`, `customers`
   (1000-row pages) into a gzip file in the **private** Storage bucket `dr-backups` with a SHA-256, and records the run in `platform_backup_runs`.
   Setup: create the bucket (no public policy), set a scheduler.
3. **Restore drill — `dr-restore-drill`** (run weekly): downloads the latest backup, verifies checksum, decompresses and compares per-table row counts; if `SUPABASE_DB_URL` is available
   it also restores a sample into a throw-away schema `dr_verify_<run-id>` and drops it. Results in `platform_restore_drills`.
   *A failed or missing drill row is an incident (P2) — page the owner.*
4. **Data retention & erasure — `data-retention-sweep`** (daily): applies `data_retention_policies` (`auto_delete_enabled = true`, not under `legal_hold`) and executes `deletion_requests` after the grace period; both paths
   respect `has_active_legal_hold()`. `delete-account` is the user-facing erasure entry point.

**Restore procedure (decide the owner; steps below are what the code supports):**
1. Declare the incident (§6), enable maintenance mode if writes must stop (§6.2).
2. Prefer PITR/physical restore from the Supabase dashboard for a full-database problem.
3. For selected tables: download the latest completed backup from `dr-backups`, verify its checksum against `platform_backup_runs`, restore the needed tables into a **scratch schema first**, diff, then copy rows back inside a transaction.
4. Re-run `dr-restore-drill`, then record the outcome in the incident notes.

---

## 6. Incident response

### 6.1 Triage (first 10 minutes)

1. **Confirm and classify.**
   | Severity | Examples | Target |
   |---|---|---|
   | P1 | Dashboard down; inbound calls not being answered/recorded; data exposure; billing double-charging | Start now, status page update ≤ 15 min |
   | P2 | One integration/feature broken; webhooks failing; backups/drills failing | Same day |
   | P3 | Cosmetic / single customer | Normal queue |
   (*Targets are suggestions — the repo defines none; adjust to your SLA page `/sla`.*)
2. **Open the three dashboards**: Vercel (deploy just happened?), Supabase logs (Edge Functions/Postgres/Auth), provider webhook logs (Stripe/Vapi/Twilio).
3. **Last change?** Recent deploy, migration, secret change or provider outage → roll back (§4) before debugging.
4. Assign an incident lead; keep a timestamped log (who did what).

### 6.2 Communicating and containing

- **Maintenance screen (frontend):** set `VITE_MAINTENANCE_MODE=true` (+ `VITE_MAINTENANCE_TITLE/MESSAGE/ETA`) on Vercel and redeploy; **or**, if `VITE_MAINTENANCE_STATUS_URL` was configured beforehand, edit the remote JSON
  `{"maintenance": true, "title": "...", "message": "...", "eta": "<ISO>"}` (`{"degraded": true}` shows the degraded banner) — no redeploy.
  `/status`, `/privacy`, `/terms`, `/security` stay reachable. The maintenance message states live-call answering is designed to keep running (it is served by Vapi + edge functions, not the SPA).
- **Status page:** update the provider behind `VITE_STATUS_API_URL`; notify subscribers with `notify-status-subscribers` (protected by `STATUS_NOTIFY_WEBHOOK_SECRET` — call with `X-Webhook-Secret`).
- **Stop the bleeding:** unschedule the offending cron/`pg_cron` job (`select cron.unschedule('<name>')` — names in migrations, e.g. `vireek-revenue-protection-scan`), revoke a leaked key (§7), pause devices, tighten AI budget/permissions.

### 6.3 Playbooks

| Symptom | Check | Fix |
|---|---|---|
| Blank page / "missing-env" errors | Vercel env vars `VITE_SUPABASE_*` present for that environment? Console shows `[Vireek] VITE_SUPABASE_URL / … missing` | Set vars, redeploy |
| CSP errors after adding a service/new Supabase project | Browser console CSP violations | Update `connect-src`/`script-src` in `vercel.json` |
| Calls not appearing / call flow broken | Vapi dashboard → server URL delivery log; `vapi-webhook` logs; secret `VAPI_SERVER_SECRET` equals the assistant's Server URL Secret; function deployed `--no-verify-jwt` | Fix secret/flag; Vapi can resend; verify `calls` upserts |
| Stripe events failing | Stripe → Webhooks delivery log; `billing_events` (idempotent by event id); `STRIPE_WEBHOOK_SECRET` matches endpoint | Fix secret/flag, **resend failed events from Stripe** (safe: event ids are deduplicated) |
| Checkout says "Billing is not configured yet" | Missing `STRIPE_SECRET_KEY` or `STRIPE_PRICE_<PLAN>` | Set secrets |
| SMS/email not sent | Twilio/Resend console; secrets `TWILIO_*`, `RESEND_*`; compliance path (A2P registration, DNC/STOP) in `sendCompliantSms` | Fix config / registration |
| AI answers failing | `ai_usage_logs` for the provider chain; provider quota/outage — `ai-core` falls back automatically (Gemini → Groq → Cerebras → Cloudflare → OpenRouter); missing keys make adapters throw `NOT_CONFIGURED` | Add/rotate keys; reorder chain in `_shared/ai-core/registry.ts` (redeploy dependants) |
| Realtime shows "Reconnecting…" | Table in `supabase_realtime` publication? RLS filter uses owner id? Supabase Realtime status | Add table via migration; fix filter |
| Push notifications silent | `app.settings.edge_function_base_url` / `push_dispatch_secret` set? `PUSH_DISPATCH_SECRET` equal? VAPID pair matches `VITE_VAPID_PUBLIC_KEY`? | Set values (trigger no-ops until set) |
| Scheduled automation not running | Scheduler configured? `X-Cron-Secret` matches the function's secret? `cron.job_run_details` for `pg_cron` jobs | Fix scheduler/secret |
| Sensor data not arriving | `iot-ingest` logs (401 = bad/revoked/paused key); device status in Property Intelligence | Re-issue key (shown once) |
| Backup/drill failing | `platform_backup_runs`/`platform_restore_drills` rows; bucket `dr-backups` exists and is private | Fix, re-run, escalate if no valid backup in 48 h |
| Suspected data exposure | Treat as P1: stop the leak, preserve logs, check `audit_log` and Supabase auth/DB logs; see `/vulnerability-disclosure` page for the public commitment; notify per your legal obligations (*decide with counsel*) | Rotate secrets (§7), revoke sessions (Auth), review RLS |

### 6.4 After the incident

Write a short post-mortem (timeline, root cause, detection gap, follow-ups with owners), add a regression test or CI check if the failure was preventable,
and update this runbook.

---

## 7. Secrets: rotation and leak response

- **Scheduled rotation (decide cadence):** webhook/cron secrets and API keys. Pattern for two-sided secrets (e.g. `VAPI_SERVER_SECRET`, `STRIPE_WEBHOOK_SECRET`, `PUSH_DISPATCH_SECRET`):
  generate new → update the **sender** (provider / DB setting) and the **receiver** (`supabase secrets set`) back-to-back → verify a delivery → revoke old.
- **Encryption keys** (`BANK_TOKEN_KEY`, `TELEMATICS_ENCRYPTION_KEY`, `ADS_TOKEN_ENCRYPTION_KEY`): do **not** rotate casually — stored tokens encrypted with the old key become unreadable; plan a re-encrypt or have users reconnect.
- **Leaked secret:** (1) revoke/regenerate at the provider immediately, (2) `supabase secrets set` the new one, (3) if it was committed: rotate anyway (history keeps it), (4) check provider logs for misuse, (5) note in the incident log. For a leaked **service-role key** treat as P1 (Dashboard → Project Settings → API to roll keys; **verify** the exact procedure for your project).
- **Prevention:** `.env` is git-ignored; gitleaks runs in `security.yml`; `VITE_*` values are public by design. Never paste secrets into chats/tickets.
- **User-visible keys:** customer API keys (`api_keys`, SHA-256 hashed), agent keys (`agent_network_*`), device keys (`pio_devices`) can be revoked from the app/RPCs.

---

## 8. Known issues and gaps (found while writing these docs)

1. No `supabase/config.toml` → function `verify_jwt` flags are only in deploy commands (§2.3). Add one before enabling CI deploys.
2. Duplicate/invalid migration versions (§3.3).
3. **`20260821101216_seed_demo_data.sql` creates `demo@vireek.com` with a password written in the file (and a "professional" profile) in whatever project the migrations are applied to.**
   On production this is a known-credential account. *Decide:* remove/disable that user in production (needs a reviewed, non-destructive procedure) and move demo seeding to an opt-in script — see [docs/LOCAL_SEED.md](docs/LOCAL_SEED.md).
4. `ci.yml` does not pass `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`, so authenticated E2E specs are skipped in CI.
5. `scripts/ingest-brand-knowledge.mjs` writes to `brand_knowledge`, but no migration in the repo creates that table (the script header cites `20260915010000_brand_knowledge_rag.sql`, which does not exist here) — verify the table exists in your database.
6. `esbuild` is required by `generate-rss.mjs` / `ingest-brand-knowledge.mjs` but is not in `package.json`.
7. `automation-seasonal-maintenance-reminder` has deploy instructions but no `index.ts` in the snapshot.
8. A duplicate top-level `functions/` folder mirrors two function folders; only `supabase/functions/` deploys.
9. `lint:design` is documented as a CI check but is not in `ci.yml`.
10. `vapi-webhook` header says the `x-vapi-secret` header name was not re-verified against current Vapi docs — verify once.
11. No on-call roster, paging tool or SLA targets are defined in the repo — fill §6.1 with your own.

---

## 9. Routine operations

| Cadence | Task |
|---|---|
| Daily | Glance at Actions (nightly `AI Regression`), `platform_backup_runs`, Sentry new issues |
| Weekly | `dr-restore-drill` result; Dependabot PRs (Mondays); `npm audit` workflow; Lighthouse/bundle trends |
| Monthly | Review AI cost (`ai_usage_logs` vs `ai_budget_limits`), unused API/agent keys, expiring provider credentials (`AI_REGRESSION_TEST_USER_JWT` expires), Plaid/Google/Meta API-version pins (`GOOGLE_ADS_API_VERSION`, `META_GRAPH_VERSION`) |
| Quarterly | Secret rotation, restore rehearsal from `dr-backups`, review this runbook |
