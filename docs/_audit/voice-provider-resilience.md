# Audit: voice provider independence and resilience

Date: 2026-11-13. Environment: sandbox with the uploaded ZIP only. **No `node_modules`, no network, no Deno, no Postgres.**

## Verification status
| Check | Result | Evidence |
|---|---|---|
| New unit tests (provider 13, missedCallGuard 5, sentryScrub 5) | **PASSED (via a minimal vitest shim, not real vitest)** | `node --test` with a sandbox-only `vitest` stub: 23/23 |
| Chaos harness `scripts/chaos/voice-all.ts` | **PASSED** 63/63 checks (real Node run) | models the DB ledger in memory, not Postgres |
| `tsc --noEmit` | **NOT RUN** (no dependencies) | run `npm run typecheck` |
| Real `vitest run` / `eslint .` / pgTAP / Playwright | **NOT RUN** | run `npm test && npm run lint` |
| Any call against live Vapi/Twilio/ElevenLabs/Supabase | **NOT RUN** | everything is static or fake-fetch |

## What was verified in the repo (before changing)
- A voice-engine abstraction (`_shared/voice-engine`) and a resilience stack (`_shared/voice-resilience`: ladder L0-L4, circuit breaker, TwiML fallback, reconcile, game-day sim) **already exist and are tested**. They were extended, not duplicated.
- `vapi-webhook` ledger (`voice-hardening/ledger.ts`) dedupes ONLY `end-of-call-report`, keyed `(user_id, vapi_call_id, event_type)`; fails open if the ledger is down. Tool-call dedupe relies on `bookingIdempotency`.
- `voice-front-door` creates the `calls` lead row only in `vm-transcript` or on emergency → **gap**: silent hang-up or missing Twilio transcription = no lead row, no alert (only `voice_fallback_calls`).
- Browser Sentry scrubbed only `request.cookies` → **PII gap**. Edge Sentry/`redact.ts` are fine.
- Dashboard `loadData` fetched `leads`, `ai_insights`, `calls`, `jobs` **without limit** (5 of 7 queries), and `calls`/`jobs` are fetched twice (top 20 + all).
- `calls (user_id, call_datetime desc)` index already exists → **no migration added** (no proven need; none can be proven without staging EXPLAIN).

## Changed / added files
New: `supabase/functions/_shared/voice/{provider,vapiProvider,mockProvider,livekitProvider,registry}.ts`, `provider.test.ts`; `_shared/voice-resilience/missedCallGuard.ts` + `.test.ts`; `scripts/chaos/{voice-all,voice-webhook-chaos,voice-provider-5xx,voice-llm-tts-timeout,voice-twilio-failure}.ts`, `scripts/chaos/lib/harness.ts`; `load/k6/{booking-and-overview,webhook.dupes}.load.js`; `src/lib/sentryScrub.ts` + test; `scripts/dr/restore-drill.sh`; docs: `docs/voice/{PROVIDER_COUPLING,ENGINE_DECISION}.md`, `docs/SLO.md`, `docs/observability/ALERT_RULES.md`, `docs/perf/explain-hot-paths.sql`, `docs/runbooks/{voice-provider-outage,database-outage,restore-drill-log}.md`, this report.
Edited (instructions given in chat): `voice-front-door/index.ts`, `src/pages/DashboardPage.tsx`, `src/lib/sentry.ts`, `package.json`.

## Bug found and fixed in my own design
A first draft gave `status-update(ended)` and `end-of-call-report` the same dedupe key; out-of-order delivery would have let the thin event shadow the rich one and lose the transcript. Keys are now distinct (`<id>:status:ended` vs `<id>:ended`) and a chaos scenario asserts it.

## NOT done, and why
- **No existing call site was migrated to `VoiceProvider`** (zero-regression rule; `vapi-webhook` is 2,801 lines and untestable here). Interface + adapter are additive.
- `createAssistant`, `listPhoneNumbers`, `endCall("end-call")` are **UNVERIFIED against live Vapi** (no existing repo usage).
- Vapi exposes no per-delivery event id that I could verify; dedupe keys are derived.
- Missing alert rules (webhook lag, payment webhook, sync failures): documented with proposals; need new metrics.
- Dashboard still computes period metrics client-side over a capped row set; the real fix is a server-side aggregate RPC.
- Other dashboard code (lines outside `loadData`) was not audited for N+1.
- No second engine built; ENGINE_DECISION lists unknown costs/latency as unknown.
- No migration, no EXPLAIN results (needs staging DB).

## Residual risks
1. `missedCallGuard` inserts a `calls` row (`status=new_lead`, `source_channel=voice_fallback`) for every degraded inbound call, including hang-ups. If any DB trigger/automation fires on new `calls` rows (other than emergency), owners may get extra notifications/leads. **Check triggers on `calls` in staging before release.** It uses insert-if-absent so a later voicemail transcript upsert enriches the row.
2. Dashboard row caps (2000/2000/2000/200) make period metrics undercount for tenants above the cap.
3. If Twilio itself is down, nothing we serve reaches the caller; only carrier-side forwarding helps.
4. Ledger fails open: during a ledger outage, duplicate processing is possible (by design, preferring no lost lead).
5. `voice-reconcile` lookback window not verified against a long DB outage.

## Needs human (staging)
1. `npm run typecheck && npm test && npm run lint` and `npm run chaos:voice`.
2. Run `docs/perf/explain-hot-paths.sql` on staging; add an index migration only if a plan proves it.
3. k6: `booking-and-overview.load.js` (smoke first), `webhook.dupes.load.js`, existing `webhook.soak.js`; fill real p95/error numbers into `docs/SLO.md` and remove "proposed" only after measuring.
4. Restore drill with `scripts/dr/restore-drill.sh`; record RTO/RPO in `restore-drill-log.md`.
5. Live game-day: `docs/runbooks/voice-first-staging-drill.md` with `VOICE_CHAOS_ENABLED=true` on staging; confirm a real call never hears silence and a `calls` row + alert appear.
6. Vendor invoices/latency for ENGINE_DECISION; Vapi API verification for the three unverified operations.
7. Verify native Sentry (`sentryNative`) uses the scrubber; fill on-call roster/paging tool in incident-response (TBD in repo).
8. Deploy `voice-front-door` yourself (I deployed nothing, ran no migrations, touched no secrets).
