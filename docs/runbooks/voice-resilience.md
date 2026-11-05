# Voice resilience: ladder, failover, safety net, game days

Companion to `voice-fmea.md`. Status labels used throughout: **TESTED** (executed here), **STATIC** (parsed / type-checked only), **NOT LIVE-VERIFIED** (needs a real vendor/staging run).

## 1. Architecture

```
caller → carrier → Twilio number ──► voice-front-door (opt-in, per number)
                                      ├─ L0/L1: <Dial><Sip> to the engine  (VOICE_ENGINE_SIP_URI)
                                      │    └─ engine failed/busy/no-answer → this call drops one level
                                      ├─ L2: emergency key/keyword → else voicemail + Twilio transcription → SMS/in-app to owner
                                      ├─ L3: sequential forward to owner/on-call numbers → then L2
                                      └─ L4: static message + 911 guidance (+ emergency key if any number exists)
Vapi-direct numbers → vapi-webhook assistant-request → ladderResponse(): L1 reduced assistant, L2-4 forward (destination)
voice-health-tick (1/min): probes → outcomes → circuit breakers → component health → ladder (hysteresis) → audit + status + owner alerts
voice-reconcile (15 min): engine/carrier logs vs DB → replay missing calls through the normal webhook → page if unrecovered
voice-resilience-admin: owner settings + carrier wizard; staff switch/pin/chaos
```

Code: `supabase/functions/_shared/voice-resilience/` (pure modules, TESTED) and the four edge functions (STATIC). Migration: `20281101000000_voice_resilience.sql` (applied twice to a local Postgres 16 with stub dependency tables: TESTED; against the real Supabase schema: NOT RUN).

## 2. Degradation ladder

| Level | Behaviour | Needs | Enters when (component health) |
|---|---|---|---|
| 0 | Full AI | engine + tools | engine & tools healthy |
| 1 | Reduced AI: short prompt, no tools; captures name, number, address, emergency | a separate **reduced assistant** per org (`reduced_assistant_id`) | engine degraded, or tools unhealthy |
| 2 | Emergency key, then voicemail with transcription; owner gets SMS (failover Twilio→Telnyx) + in-app | Twilio, SMS | engine down, voicemail + alerting OK |
| 3 | Forward to owner/on-call numbers in order, then voicemail | ≥1 valid E.164 number | engine down and owners cannot be alerted by SMS (a ringing phone *is* the alert) |
| 4 | Static message + 911 guidance (+emergency key if a number exists) | nothing | engine, voicemail and forwarding all down |

Emergency fast path (`emergencyFastPath.ts`): keypad `1` or life-safety keywords (gas, CO, fire/smoke/sparking, flood/burst pipe, shock, Spanish equivalents) at **every** level; the generic word "emergency" can be cancelled by an explicit negation, life-safety words cannot. Biased toward false positives. English/Spanish only.

Hysteresis (`DEFAULT_LADDER`): escalate after 60 s of a worse target (jumps straight to the target); recover one level at a time after 3 min of better target, 1 min minimum dwell; more than 6 transitions/hour freezes recovery (never escalation). Staff pin and per-org forced level override automation (time-boxed). Trade-off, measured in simulation: a 1-minute outage costs about 10 minutes of degraded service.

Per call: if the engine fails on *this* call, `degradeFrom()` moves only that call down immediately, independent of the org-wide level.

## 3. Providers and failover

Ports (`providers.ts`): voice engine, carrier, ASR, TTS, SMS. Selection is a pure policy: org pin / prefer / block, time-boxed platform switch, breaker state, deterministic canary slice (default 5 %) for safe switch-back from `half_open`.

| Capability | Primary | Secondary in code | Secondary status |
|---|---|---|---|
| SMS | Twilio | **Telnyx** adapter | Request-building TESTED with a fake fetch. NOT LIVE-VERIFIED. Needs Telnyx account, messaging profile, number/registration, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`; then `update voice_providers set enabled=true where provider_id='telnyx'` |
| Carrier | Twilio | none | Needs a second carrier account **and number porting or a second inbound number** (customer forwarding to it). Candidate: Telnyx (SIP/voice) |
| Voice engine | Vapi | none | See section 7; degradation (L2-L4) is the fallback, not a second AI |
| ASR / TTS | engine-internal | interfaces only | Configure the engine's own transcriber/voice fallback plans (dashboard); nothing in-repo calls ASR/TTS ports yet |

Circuit breaker (`circuitBreaker.ts`): window 5 min, ≥5 samples, opens at ≥30 % errors or p95 ≥ 4 s, cool-down 30 s doubling to 10 min, 3 clean probes to close, stale pre-open failures ignored in half-open. Health score 0-100: ≥80 healthy, 40-79 degraded, <40 down. A silent provider is "no data", not "down" (the synthetic probe covers silence).

Switching: automatic (breaker), manual (staff `switch_provider`, ≤24 h), per-org override (`set_org.provider_overrides`).

## 4. Carrier-level safety net (customer's own carrier → Vireek)

Codes (`carrierForwarding.ts`): GSM standard `**61*<num>**<s>#` (no answer, 5-30 s, we recommend 20), `**62*<num>#` (unreachable), `**67*<num>#` (busy); cancel `##61#`/`##62#`/`##67#`; status `*#61#`. Verizon `*71<10-digit>` / `*73` is labelled "commonly documented: confirm with the carrier". Landline/VoIP/PBX: no universal code; the wizard says so. Codes are a guide only; **the test call is the proof**.

Wizard (`voice-resilience-admin`): `wizard_plan` → codes; `wizard_start` places a call from `VOICE_PROBE_FROM` to the account's own saved business number and waits for the forwarded call to arrive at the Vireek number with `ForwardedFrom` = that number (`forward_on` passes), or, after cancelling, for the call to ring out and **not** arrive (`forward_off`). `answered_by_human` tells the user to retry without answering. Safeguards: only the account's own saved number can be rung, ≤5 tests/hour, Vireek number must belong to the account.
Customer caveats shown to the user: turn off carrier voicemail on that line (or forwarding must fire first), some carriers/landlines do not support conditional forwarding, forwarding adds the carrier's per-minute charge.
**The wizard UI page is not built** (see section 9). The logic and backend are.

## 5. No lost events

- Existing: `voice_webhook_events` ledger (idempotent claim, attempts, dead-letter, `replay_dead_voice_events()`), unique `calls.vapi_call_id`.
- New: `voice-reconcile` lists inbound engine calls for the last N hours, ignores calls < 10 min old, replays each missing call through the **normal** `vapi-webhook` with a rebuilt `end-of-call-report` (so tenant resolution, ledger, PCI redaction apply), confirms the row exists, then replays dead ledger rows (minimal data). Carrier side: Twilio inbound calls on front-door numbers with no door record become "call back" rows. Severity: any unrecovered call, ≥5 missing, or ≥5 % missing pages (`SLO_ALERT_WEBHOOK_URL`); a reconcile that cannot run also pages.
- Limits: the rebuilt report shape is NOT LIVE-VERIFIED; calls the webhook cannot attribute to a tenant count as unrecovered (expect noise from non-tenant test calls until filtered); `next_attempt_at` column exists but no worker drains `failed` rows on a timer (reconcile covers them via the engine log instead).

## 6. Setup checklist (order matters)

1. Apply `20281101000000_voice_resilience.sql`. `pg_cron` present ⇒ jobs are scheduled; otherwise call `select public.voice_cron_tick('voice-health-tick','{}')` every minute and `('voice-reconcile','{"hours":6}')` every 15 min from your external cron; daily `select public.voice_purge_outcomes(48)`.
2. `supabase/config.toml`: add `verify_jwt = false` for `voice-front-door`, `voice-health-tick`, `voice-reconcile` (admin keeps JWT verification).
3. Deploy: `supabase functions deploy voice-front-door voice-health-tick voice-reconcile --no-verify-jwt` and `supabase functions deploy voice-resilience-admin`.
4. Secrets (new): `VOICE_FRONT_DOOR_BASE` (public URL of voice-front-door), `VOICE_ENGINE_SIP_URI`, `VOICE_PROBE_FROM`, optional `VOICE_STATUS_COMPONENT_ID`, `TELNYX_*`. Existing and reused: `TWILIO_*`, `VAPI_PRIVATE_KEY`, `VAPI_SERVER_SECRET`, `PUSH_DISPATCH_SECRET`, `STATUS_NOTIFY_WEBHOOK_SECRET`, `SLO_ALERT_WEBHOOK_URL`. **Staging only:** `VOICE_CHAOS_ENABLED=true`.
5. Apply the three `vapi-webhook` edits (delivered separately), redeploy it.
6. Per org: create a **reduced assistant** in Vapi (prompt below), set `reduced_assistant_id`, `forward_numbers`, `language`, `static_message` via `set_org`.
7. In Vapi, configure what you can on each phone number/assistant: `fallbackDestination` to a human number (then **drill it**: a support thread reports it not firing), transcriber/voice/model fallback plans.
8. Point a pilot Twilio number's Voice URL at `voice-front-door?action=inbound` (POST) **only after** the staging drills pass; keep the previous URL written down as the rollback.

Reduced-assistant prompt (starting point): "You are the after-hours receptionist for {{business}}. Do not book, quote or look anything up. Collect, one at a time: full name, callback number, service address, a one-sentence description. If the caller mentions gas, smoke, fire, flooding, sparking or says it is an emergency, say you are connecting them now and transfer to the on-call number immediately. Then thank them and end the call."

## 7. Secondary-vendor research (what was and was not verified)

- **Vapi `fallbackDestination`**: documented/answered by Vapi support as applying when no assistant/squad is set or the assistant-request to the server URL fails; one user report says it did not trigger in a bad-endpoint test, no confirmed fix in the thread. Treat as unproven.
- **Telnyx** (secondary SMS/SIP candidate): third-party comparison (famulor.io, 2026) lists Voice API ≈ $0.002/min, inbound SIP from ≈ $0.0032/min, local number ≈ $1.00/mo, versus Twilio inbound local ≈ $0.0085/min and number ≈ $1.15/mo. Vendor-list prices from a secondary source, US only; SMS prices were not listed. **Get a real quote.**
- **Retell AI / other managed voice-agent platforms** as a secondary engine: I did **not** retrieve verified pricing or SLA terms. Switching engines means porting prompts, tools (`book_appointment`, `flag_emergency_call`, …) and webhooks; estimate weeks, not days. Recommendation: do this only after the ladder has run in production, and as a cold standby for L1 (reduced assistant) first, which needs only a prompt and a transfer number.

## 8. Game days (staging only)

Run `node scripts/gameday/voice-gameday.mjs --i-am-on-staging` (NOT RUN: no staging environment here), or by hand with `set_chaos`. Faults are injected as failing outcomes in `voice-health-tick` (honored only when `VOICE_CHAOS_ENABLED=true`), so the real breaker → ladder → announce path runs without touching vendors. Chaos does not test Twilio/Vapi behaviour itself; for those drills also do the manual step.

| # | Drill | Inject | Expect | Manual verification |
|---|---|---|---|---|
| 1 | Kill provider webhook | `engine_down`; also point a staging Vapi number's server URL at a dead host | ladder 2 within ~3 min; calls to a front-door number reach voicemail; owner SMS | Place a call: emergency key forwards; leave a voicemail → transcript SMS; check `voice_fallback_calls`; verify Vapi `fallbackDestination` behaviour |
| 2 | Add latency | `engine_slow` | breaker opens on p95, ladder ≥1 | Time to first word on a test call |
| 3 | Fail TTS | engine-side: switch the staging assistant voice to an invalid voice id | engine call ends with error; per-call degrade at the front door | Confirm the call still lands in voicemail |
| 4 | Expire keys | rotate `VAPI_PRIVATE_KEY` to garbage in staging | health probe 401 → breaker → ladder 2; reconcile pages | Restore key; confirm switch-back after canary/probes |
| 5 | DB slow | `tools_down` (+ a real `pg_sleep` on a lookup) | ladder 1 with reduced assistant | Reduced assistant captures details; emergency scan flags |
| 6 | SMS provider down | `sms_down` | no ladder change if Telnyx enabled; ladder 3 if only Twilio observed | Owner still told (in-app) |
| 7 | Carrier + engine down | `carrier_down` + `engine_down` | ladder 4 | Static message plays, 911 guidance |

Record each run in `docs/runbooks/gameday-results/` (script writes JSON). Results so far: **simulated clock only** (`gameday.test.ts`: TESTED): engine kill → L2 ≤3 simulated minutes, recovery one level at a time; tools failure → L1; one SMS provider down → stays L0; all SMS + engine down → L3; carrier + engine down → L4. **No staging drill has been run.**

## 9. RTO / RPO / SLOs (honest)

- **RTO for answering a call** (some defined handling, never silence): design target ≈ 2-3 min from engine failure to L2/L3 for new calls on **front-door numbers** (60 s hysteresis + 1 tick), instantly for the call that hits the failure (per-call degrade). Numbers pointed directly at the engine: **no in-repo guarantee**; depends on the unproven Vapi fallback. Full AI restore: ≈ 5-10 min after the vendor recovers (breaker probes + 3 min hysteresis per level).
- **RPO for call records**: normally 0 (idempotent webhook). If the webhook is lost, recovery by reconcile within ≤ 15 min + grace 10 min; a call the engine no longer holds is unrecoverable. Minimal ledger replay has no transcript. Voicemail audio stays at Twilio (copy to storage not implemented; the owner gets the transcript).
- **SLO proposals** (not yet enforced; measure with `voice_resilience_slis` + existing `slo_definitions`): call-answer rate ≥ 99.5 % (answered = AI or a defined fallback outcome; source: synthetic probe + `voice_fallback_calls`); time-to-first-word p95 ≤ 2.5 s (source: probe `answer_latency_ms`, `voice_call_latency`; not derivable from new tables); completion rate (call produces a stored record) ≥ 99.9 % (source: reconcile unrecovered = 0). Thresholds are proposals, unmeasured.

## 10. Communication

Ladder change ⇒ row in `voice_ladder_events`, public incident via `synthetic_open_incident/resolve` (generic copy, no vendors/tenant data) + `notify-status-subscribers`, in-app notice to every account with a number, SMS to the account phone at L≥2 and on recovery (`alert_sms=false` opts out). Copy in English and Spanish (`incidentCopy.ts`). Needs `slo_definitions.voice_availability.component_id` or `VOICE_STATUS_COMPONENT_ID`.

## 11. What needs vendors, contracts, number porting or cost

| Item | Why | Needed |
|---|---|---|
| Telnyx account + messaging profile + registered number | Secondary SMS (owner alerts) | New account, 10DLC/toll-free registration, per-message cost |
| Second carrier / SIP trunk + second inbound numbers | Carrier failover | New account; customers add a conditional-forward to the second number; **porting** only if you want the second carrier as primary |
| Twilio-owned numbers for each customer line | Front door can only protect numbers whose Voice URL you control | Port or buy numbers; Vapi-native numbers cannot be fronted |
| Engine SIP URI (Vapi or alternative) | L0/L1 through the front door | Confirm SIP endpoint and auth with Vapi; likely a plan/limit check |
| Reduced assistant per org (+ optional second engine account) | L1 | Vapi assistants (cost per minute while used); alternative engine = new contract |
| `VOICE_PROBE_FROM` Twilio number | Wizard test calls | One number |
| Staging environment with its own Twilio/Vapi/Supabase | Game days | Required before any pilot |
| Customers' carrier plans | Conditional forwarding availability and per-minute charges | Per customer; some landlines/VoIP lack it |

## 12. NOT done / not verified

- No UI page for the wizard, ladder status, or overrides (backend and API exist; the repo's design-system/i18n/axe/Playwright rules were therefore not exercised). Owner-facing strings in SMS/notifications are server-side EN/ES, not i18next.
- No Playwright/axe tests (no UI). Vitest-style tests were run with Bun's runner through a shim because the npm registry is blocked in this session; `vitest run` itself was not run.
- Edge functions and `runtime.ts` are parse-checked only (no Deno here). Nothing was run against Twilio, Vapi, Telnyx or a real Supabase project.
- Vapi `destination` response, SIP dialing, `ForwardedFrom` behaviour per carrier, rebuilt end-of-call-report shape: unverified.
- No secondary AI engine. No ASR/TTS secondary. No in-repo copy of voicemail audio. No timer worker for `next_attempt_at`.
- RLS written for tenant tables, never exercised with real JWTs; cross-tenant tests against a real database not run.
