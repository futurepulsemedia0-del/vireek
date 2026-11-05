# Voice observability: setup, data model, privacy, cost

## What is recorded
| Where | What | Retention |
|---|---|---|
| `call_traces` | one row per call: provider names, per-turn latencies, TTFW, ASR confidence, barge-ins, tool counts, flags, compact timeline (numbers only) | numeric row 400 d; healthy-call timeline cleared after 30 d; flagged-call timeline 90 d |
| `call_trace_events` | live tool-call events (name, outcome, duration, retry visibility) | 14 d |
| `call_inspector_audit` | who opened what and why | forever, append-only (trigger blocks UPDATE/DELETE) |
| `observability_alert_*` | alert state, delivery log, maintenance windows | log 180 d |
| OTLP backend (optional) | sampled spans (default 10%; errors, flagged and slow calls always) | per vendor |

**Never stored or exported:** transcript text, audio, names, phone numbers, e-mails. Every span attribute is scrubbed in `otlp.ts` regardless of caller; free-text keys are dropped. Bad-call flags carry turn indexes and templated titles only.

## Correlation
`traceId = first 32 hex of SHA-256("vireek:call:" + vapiCallId)`. Every webhook request of a call, in any isolate, derives the same id (no lookup). Log lines of `vapi-webhook` carry `traceId` next to the per-request `requestId`. Outbound hops can send `traceparent` (`outboundTraceHeaders`).

## One-time setup
1. Run migration `20280402000000_voice_observability.sql` (idempotent; lint-clean; **review it in a staging DB first**).
2. Deploy: `supabase functions deploy observability-alerts call-inspector vapi-webhook call-quality-review --no-verify-jwt` (`call-inspector` verifies the staff JWT itself; deploy it **with** JWT verification if you prefer: `supabase functions deploy call-inspector`).
3. Secrets (all optional except where noted):
   - `PUSH_DISPATCH_SECRET` (already set) - authenticates the cron call.
   - `PAGERDUTY_ROUTING_KEY` - PagerDuty Events API v2 integration key.
   - `ALERT_SLACK_WEBHOOK_URL` - Slack incoming webhook (`#voice-alerts`).
   - `ALERT_TICKET_WEBHOOK_URL` - SEV4 digest target; falls back to Slack.
   - `ALERT_RUNBOOK_BASE_URL` - e.g. `https://github.com/<org>/<repo>/blob/main` so pages link to runbooks.
   - `OTEL_EXPORTER_OTLP_ENDPOINT` (https only), `OTEL_EXPORTER_OTLP_HEADERS` (`Authorization=Basic ...`), `OTEL_TRACES_SAMPLE_RATIO` (default `0.1`), `OTEL_SERVICE_NAME`, `OTEL_ENVIRONMENT`.
4. No pg_cron? Schedule `select public.synthetic_cron_tick('observability-alerts','{}')` every 2 min and `select public.obs_purge(14,30,90)` daily.
5. Verify: open `/staff/voice-observability` as staff; place a test call; the call appears within a minute of the end-of-call report.

## Maintenance windows
`insert into observability_maintenance (scope_key, rule_key, starts_at, ends_at, reason) values ('*', null, now(), now() + interval '2 hours', 'planned provider migration');` (max 24 h; state keeps tracking, nothing is sent).

## Choosing the telemetry backend (vendor-neutral OTLP)
| Option | Pros | Cons | Fit |
|---|---|---|---|
| **Grafana Cloud** (Tempo + Mimir) | native OTLP, generous free tier, dashboards + alerting in one place, can also query Postgres | you run two query languages (TraceQL/PromQL); tracing UX less ad-hoc than Honeycomb | **Recommended default**: cheapest path to dashboards + traces |
| **Honeycomb** | best-in-class high-cardinality trace exploration, great for "why is this call slow" | event-based pricing grows with volume, fewer built-in infra dashboards | best if debugging is the main pain |
| **SigNoz** (cloud or self-host) | open source, OTLP native, one tool for traces/metrics/logs | self-hosting means you operate ClickHouse; cloud is younger | good if you want no vendor lock-in |
| **Axiom** | very cheap ingest/retention, OTLP | lighter tracing UI | good for long retention at low cost |
| **Datadog** | broadest product, APM, on-call | costliest at scale; vendor-specific features pull you away from OTLP | only if already standardised on it |
Because the exporter is plain OTLP/HTTP JSON, switching vendors = changing two secrets.

Grafana can also read SLI tables directly with a read-only role (optional, **not run**): create a role with column-level `select` on `call_traces` excluding `timeline` and `user_id`, and point a PostgreSQL data source at it.

## Cost notes (estimates, verify against your invoices)
- Postgres: a typical call row is a few KB (about 40 events); at 10,000 calls/day that is tens of MB/day before timelines are cleared at 30 days. Live events are small and purged at 14 days.
- Telemetry vendor: spans per call = 1 root + one per turn/tool (about 20-40). At 10% sampling plus always-keep for errors/flagged calls, volume is roughly 10-20% of calls.
- PagerDuty: per-seat licence. Slack: existing workspace. No other paid accounts required.

## Required accounts
PagerDuty (or any Events-API-v2-compatible pager) - recommended; Slack workspace with an incoming webhook - recommended; one OTLP backend - optional; everything else (Vapi, Supabase, status page) already exists.

## Grafana dashboards (optional, vendor dashboards over the same data)
1. Run `20280402000200_voice_observability_grafana.sql` (creates PII-free views `obs_grafana_calls`, `obs_grafana_alerts` and a NOLOGIN role `grafana_voice_ro`).
2. An admin enables login manually with a password from your secret manager: `ALTER ROLE grafana_voice_ro LOGIN PASSWORD '...'`. Connect Grafana through the **read replica or pooler**, never the primary with a write role.
3. Add a PostgreSQL data source, then Dashboards -> Import -> upload `ops/grafana/voice-observability.dashboard.json` and pick that data source. 13 panels: answer rate, completion, turn p50/p95/p99, TTFW, booking success, tool failures, per-LLM-provider and per-region latency, per-country-code answer rate, flagged calls, ASR confidence/barge-ins, audio quality, alerts by severity.
4. The in-app staff page (`/staff/voice-observability`) stays the source for the call inspector; Grafana is for trend/exec views. Grafana alerting is intentionally NOT used: alert rules live in code (`alertRules.ts`) so they are tested and versioned.

## Sentry for edge functions
Set `SENTRY_DSN` (https), optional `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`. Every instrumented function reports thrown errors (deduplicated per minute, max 20/min per isolate, message and stack PII-scrubbed, no request data). Verify once after deploy: call any function in a way that throws, or temporarily throw in a staging function, and confirm the event shows `function` and `trace_id` tags. This envelope client is not verified against a live Sentry project yet.

## Instrumenting all edge functions
`node scripts/instrument-edge-functions.mjs` (dry run) then `--apply`. Add `"check:edge-instrumented": "node scripts/instrument-edge-functions.mjs --check"` to package.json scripts and run it in CI so new functions cannot ship uninstrumented. Functions with unusual `Deno.serve` shapes are listed as skipped and need a manual wrap: `Deno.serve(instrument("name", handler))`.
