# Service Level Objectives (PROPOSED)

**Every number below is PROPOSED, not measured and not a contractual commitment.** Baselines must come from the staging load runs in `/load/k6` and a month of production metrics. Do not publish these externally until measured.

| Journey | SLI | Proposed SLO (30 d) | k6 proof |
|---|---|---|---|
| Public booking page load | HTTP 200 on `/book/:slug`; p95 latency | availability 99.9 %, p95 < 800 ms | `booking-and-overview.load.js` scenario `page` |
| Booking read RPCs (`get_booking_public_settings`, `get_booking_busy_window`) | p95 latency, 5xx rate | p95 < 500 / 800 ms, 5xx < 0.5 % | scenario `booking_read` |
| Booking create (`create_public_booking_windowed`) | p95, 5xx (4xx `slot_taken` excluded) | p95 < 1.5 s, 5xx < 0.5 % | scenario `booking_write` (opt-in) |
| `vapi-webhook` ingestion | 2xx rate, p95 | 2xx ≥ 99.5 %, p95 < 1 s, p99 < 2.5 s (matches thresholds already in `webhook.soak.js`) | `webhook.soak.js`, `webhook.dupes.load.js` |
| Inbound call is never silent | fraction of inbound calls that reach AI **or** a fallback (voicemail/forward/static) | 99.99 % | gameday + chaos (`scripts/chaos`), staging drill |
| Lead durability | calls with provider record but no `calls` row after reconcile | 0 unrecovered (page on any) | `voice-reconcile` + `gapSeverity` |
| Dashboard overview | PostgREST p95 for bounded calls/jobs queries | p95 < 1 s at 2,000 rows | scenario `overview` |
| Public API v1 | p95 / error | p95 < 800 ms, errors < 0.5 % (existing thresholds in `api-v1.load.js`) | `api-v1.load.js` |

Error budget (proposed): 99.9 % ⇒ 43 min/30 d. Burn-rate alerts: see `docs/observability/ALERT_RULES.md`.
Load-test rules: staging only (`lib.js` refuses production hosts), start with `PROFILE=smoke`, never run `booking_write` against a tenant with real customers.
