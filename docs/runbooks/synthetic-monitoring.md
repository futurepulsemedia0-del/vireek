# Synthetic monitoring and SLOs (voice pipeline)

## How it works
`synthetic-probe` (cron, every minute) makes a Vapi **probe caller assistant** dial a **target number** whose production assistant belongs to a **synthetic tenant**. A minute later it verifies, from the product's own rows (`calls`, `jobs`) and the webhook sink, five SLIs: availability, answer latency, speech-recognition accuracy, booking success, webhook delivery. `slo-evaluate` (every 5 min) burns error budgets, opens/resolves incidents and notifies status subscribers. `status-feed` publishes them.

Region = the market the target number serves. Create one target (and ideally one synthetic tenant) per region, with a probe caller number from that region.

## One-time setup
1. Run the migration `20271102000000_synthetic_monitoring_slo.sql` (idempotent).
2. Create one **synthetic tenant** per region (a normal account with its own Vapi assistant + phone number, price book and open schedule), then run (replace the id):
   `update profiles set is_synthetic_tenant = true where id = '<tenant-user-id>';`
3. In Vapi create the **probe caller assistant** (any voice). System prompt: `{{probe_script}}`. First message mode: wait for the callee to speak. Add a Vapi phone number for it per region.
4. In each synthetic tenant: Integrations -> Webhook URL =
   `https://<project-ref>.supabase.co/functions/v1/synthetic-webhook-sink?t=<sink_token>` (the token is created with the target, see step 5; read it once with `select sink_token from synthetic_probe_targets where label = '...'` in the SQL editor).
5. Register a target (replace every value):
```sql
insert into synthetic_probe_targets
  (region, label, target_number, tenant_user_id, probe_caller_number, probe_phone_number_id, probe_assistant_id, interval_minutes)
values
  ('us-east', 'Main line', '+15551230001', '<synthetic-tenant-user-id>', '+15551230002', '<vapi-probe-phone-number-id>', '<vapi-probe-assistant-id>', 15);
```
6. Deploy: `supabase functions deploy synthetic-probe slo-evaluate synthetic-webhook-sink status-feed --no-verify-jwt`
7. Secrets already used elsewhere: `VAPI_PRIVATE_KEY`, `PUSH_DISPATCH_SECRET`, `STATUS_NOTIFY_WEBHOOK_SECRET`, `SITE_URL`. Optional: `supabase secrets set SLO_ALERT_WEBHOOK_URL=<slack incoming webhook>`.
8. No pg_cron? Schedule `select public.synthetic_cron_tick('synthetic-probe','{"action":"dispatch"}')` and `...'{"action":"verify"}'` every minute, `select public.synthetic_cron_tick('slo-evaluate','{}')` every 5 minutes, `select public.synthetic_purge_artifacts(3,100)` daily.

## Reading results
`/staff/reliability` shows budgets, burn rates, per-region latency, targets and runs. A run with status `error` is a probe-side fault and never counts against an SLO.

## Tuning
Thresholds: `SLI_THRESHOLDS` in `_shared/synthetic/metrics.ts`. Objectives: `update slo_definitions set objective = 0.999 where key = 'voice_availability';`. Burn-rate rules: `DEFAULT_RULES` in `_shared/synthetic/slo.ts`.

## Load and soak (k6)
`load/k6/api-v1.load.js` and `load/k6/webhook.soak.js`, staging only (production hosts are refused). Run from GitHub Actions: **k6 load and soak**, or locally, see the header of each file.
