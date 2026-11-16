# Alert rules and log conventions

## Log correlation (verified in code, with gaps)
- Edge functions already log JSON lines with an `event` field (`voice_ledger_claim_failed_open`, `voice_front_door_error`, …).
- `_shared/observability/requestTrace.ts` / `traceContext.ts` exist; **not verified** that every voice function stamps `call_id` + `tenant_id`. New code in this change does (`missedCallGuard.ts` logs `tenant_id`, `call_id`).
- Convention to apply when touching a function: `console.error(JSON.stringify({ event, tenant_id, call_id, ... }))`; never log transcripts, phone numbers, bodies (`redact.ts` exists for that).

## Existing rules (`_shared/observability/alertRules.ts`, DEFAULT_RULES — verified)
answer_rate (critical < 0.90, warn < 0.97), call_completion_low, booking_success_low (< 0.70), tool_failure_high, webhook_5xx_high (> 2 %), provider_error_high (> 5 %), turn latency p95 (warn 2.5 s / critical 4 s), ttfw_p95_high, asr_confidence_low.

## Requested coverage vs. reality
| Requested alert | Status |
|---|---|
| Call answer failure rate | **Covered**: `answer_rate_*` |
| Webhook lag | **Missing**. Proposed rule: `now() − max(voice_webhook_events.updated_at where status='processed')` > 10 min while calls exist; or reconcile `missing` > 0 (already pages via `gapSeverity`). Needs a new MetricKey + metric source — not implemented here. |
| Booking failures | **Covered**: `booking_success_low` |
| Payment webhook failures | **Missing** from `alertRules.ts` (no payment MetricKey). Proposed: Stripe webhook 5xx rate > 2 %/10 min and any `dead` payment event. Needs metric source. |
| Sync failures (QuickBooks/Xero/etc.) | **Missing**. Proposed: connector sync failure rate > 20 %/30 min with ≥ 5 runs. Needs metric source. |
| Unrecovered missed calls | **Covered**: `voice-reconcile` returns `page` when `unrecovered > 0` |
Adding the three missing rules requires extending `MetricKey` and the metric collector; deliberately not done blind. All thresholds above are proposals.

## Sentry
- Edge: `_shared/observability/sentry.ts` scrubs messages/stack via `scrubString` (verified).
- Browser: `src/lib/sentry.ts` only deleted `request.cookies` (verified) — **PII gap**: breadcrumbs, request URL/headers/body, `captureError` extras, user IP were unscrubbed. Fixed by `src/lib/sentryScrub.ts` (new, tested) wired in via the edit in the audit report. Session Replay is not enabled in `initSentry` (verified): keep it off or mask all text/inputs if enabled later.
- Native build (`sentryNative`) was **not inspected**; verify it applies the same scrubber.
