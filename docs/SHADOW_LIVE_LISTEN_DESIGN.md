# Shadow Mode — live-listen (Mode B) design

Status: **foundation implemented, default OFF; stream receiver not built.** Replay (Mode A) is unchanged — see `docs/SHADOW_MODE.md`.
Legal items are marked **[COUNSEL]** (needs a lawyer; nothing here is legal advice). Unverified vendor/product facts are marked **[VERIFY]**.

## 1. What and why
Replay analyses a call after it ended. Live-listen lets Sarah *hear* a real call while it happens, to produce the same Shadow Card sooner (and later: a live "would have said" panel for the owner). Sarah still **never speaks or acts**. The only new capability is receiving a copy of the caller's audio.

Non-goals: speaking, transferring, dialling, texting, booking, recording audio to disk, outbound-call listening, and any change to how the live call is answered.

## 2. Verified starting point
| Fact | Evidence |
|---|---|
| Only replay exists; `shadow_trials.mode` is CHECK `'replay'` | `20280410000000_shadow_mode.sql` |
| No audio fork in telephony code | no `<Stream>/<Start>/<Connect>` in `_shared/pbx/*` or `pbx-voice` (grep) |
| Consent gate for live mode already written and tested | `evaluateConsent('live_listen', …)` in `_shared/shadow/logic.ts` |
| `counsel_cleared_states`, `telephony_supports_fork` are platform-set only | no RPC writes them |
| Kill-switch + flag machinery exists (fail-closed, audited, two-person resume) | `docs/RELEASE_SAFETY.md` |
| State heuristic is area-code based and covers 13 states only | `_shared/compliance/recordingConsent.ts` |

## 3. Architecture
```
caller ──► telephony provider ──► business line (call answered as today, untouched)
                 │  one-way fork, inbound track only (caller → us)
                 ▼
        stream receiver  [NOT BUILT]  ──► redacted transcript ──► existing shadow pipeline ──► Shadow Card
                 ▲
shadow-live-authorize (built): kill switch → flag → trial → inbound → consent → jurisdiction → ledger row → fork directive
```
Control flow for one call: the telephony webhook asks `shadow-live-authorize` (server-to-server, shared secret). Only on `authorized:true` does it add the returned `<Start><Stream track="inbound_track">` directive. On any other answer — including errors, timeouts and 5xx — the webhook adds nothing. **Absence of an authorization is the safe state.**

### 3.1 One-way audio fork
- Directive: `<Start><Stream url="wss://…" track="inbound_track"/>` — the unidirectional form. `<Connect><Stream>` (bidirectional), `outbound_track` and `both_tracks` are never emitted. **[VERIFY]** against the current Twilio docs that `<Start><Stream>` is unidirectional and that `inbound_track` is the caller's speech; if the line runs through Vapi or another provider the directive differs.
- `buildOneWayForkTwiml` builds it; `assertOneWayForkTwiml` re-checks the final string and refuses anything containing `Connect/Say/Play/Dial/Gather/Record/Sms/Message/Redirect`, `outbound_track`, `both_tracks`. Receiver URL must be `wss://`, on an exact-host allow-list, no credentials/query/fragment.
- The receiver must be **receive-only**: it has no credentials for the telephony API and cannot write to the socket. **[VERIFY]** when built.
- Audio is processed in memory and **never persisted**. Only the redacted transcript derived from it can become a Shadow Card, under the existing redaction and retention rules.

### 3.2 Defence in depth
1. Edge function evaluates the gate (`evaluateLiveListenGate`, pure, unit-tested).
2. `shadow_live_record` RPC **re-reads the trial row** and refuses to authorize unless the four consent facts are true and the jurisdiction is in `counsel_cleared_states`.
3. A table CHECK (`shadow_live_sessions_consent_gate`) makes a non-blocked row impossible without those facts.
4. Directive asserter (3.1).

## 4. Gate order (pinned by tests)
`kill switch` → `flag` → `trial active/unexpired` → `inbound only` → `consent` → `jurisdiction clearance`. Global stops come first so a stopped or OFF capability reads no tenant data and writes nothing. Every unknown (flag RPC failing, kill-switch state unknown, bad clock, null phone, non-NANP number) resolves to **blocked**.

## 5. Consent and disclosure
Required facts (all must be true, per trial): owner attestation that recording + AI analysis is lawful and disclosed; caller disclosure configured on every call; staff told their calls are analysed; provider supports the fork (platform-set). Owner cannot self-clear jurisdictions: `counsel_cleared_states` is platform-set. **[COUNSEL]** who may attest (today any editor-role user; consider owner-only).

### 5.1 State matrix
The code treats the states below as *possibly* all-party-consent (the repo's existing, non-exhaustive area-code heuristic — **[VERIFY]** the list; it is a default, not a legal opinion). Every cell of "Requirement" is **[COUNSEL]**: the product does not encode statutes, it only blocks until the platform records clearance.

| Jurisdiction in code | Detected by | Live-listen behaviour | Requirement (disclosure wording, who consents, B2B exceptions) |
|---|---|---|---|
| CA, FL, PA, IL, MA, MI, WA, MD, CT, MT, NH, DE, NV | caller area code | **Blocked** until the state code is in `counsel_cleared_states` | **[COUNSEL]** per state |
| NANP number, area code not on the list | caller area code | **Blocked** until `NANP_UNLISTED` is in `counsel_cleared_states` (the list is not exhaustive, so "unlisted" is not assumed one-party) | **[COUNSEL]** |
| Non-NANP / missing / malformed number | — | **Always blocked** (`jurisdiction_unknown`) | **[COUNSEL]** (GDPR/ePrivacy and national interception rules) |
| Outbound calls | — | **Always blocked** | n/a |

Known limits to put in front of counsel: area code ≠ caller location (mobile numbers move); the *business's* state and the staff member's state may differ from the caller's; two-state calls; AI-disclosure statutes; whether a processor/service-provider role (GDPR/CCPA) changes the analysis; call-recording vs. live-interception vs. transcription distinctions. **[COUNSEL]**
Caller disclosure wording is owner-configured; the existing `buildRecordingConsentNotice` (all-party "this call may be recorded… okay?") is the only wording in the product and is **not** reviewed for live-listen. **[COUNSEL]**

## 6. Retention
| Artifact | Stored? | Retention |
|---|---|---|
| Raw audio | **No** | none |
| Redacted transcript / Shadow Card | Yes (existing) | trial `retention_days`, default 30, 1–90; `purge_after`; owner delete-on-request |
| `shadow_live_sessions` row (call_ref, last-4, jurisdiction, consent booleans, timestamps) | Yes | trial `retention_days` (same window) |
| `shadow_live_events` (no PII: ids, kind, reason, jurisdiction) | Yes, append-only | 365 days, then purged **[COUNSEL]** — confirm how long consent evidence must be kept vs. minimised |
Phone numbers are never stored (last 4 only). Purge: `shadow-live-authorize {action:"purge"}` hourly (secret-protected) → `shadow_live_purge_expired()`. Open (`authorized`) sessions are never purged. **[COUNSEL]** regulated-industry limits and subprocessor (transcription vendor) retention.

## 7. Kill switches (three layers)
1. **Flag `shadow_live_listen`** (shipped OFF, 0 %, `risk=critical`): exposure increases need a second approver (existing guard). Lowering is one click.
2. **Kill switch `shadow_live_listen`** (critical): global or per-account stop, audited (`kill_switch_audit`), resume needs a second staff member. Edge cache 15 s; unknown state > 10 min fails closed.
3. **Per-call**: an open stream re-checks flag + switch every `LIVE_RECHECK_SECONDS` (20 s) and hard-stops at `LIVE_SESSION_MAX_SECONDS` (2 h) via `shouldContinueStreaming`; the receiver then calls `{action:"end", reason:"kill_switch"}`. Worst case from pressing *Stop* to audio no longer processed: ≈ 15 s cache + 20 s tick (**[VERIFY]** by drill once the receiver exists). After stopping, `shadow_live_kill_sessions(NULL,'kill_switch')` closes the ledger.
The existing monthly kill-switch drill covers it automatically (it iterates all switches).

## 8. Security
Server-to-server secret `SHADOW_LIVE_SECRET` (≥ 24 chars, constant-time compare; function refuses to run without it), `verify_jwt=false` in `config.toml` because the caller is a webhook. Tenant data: sessions/events are SELECT-only for tenants, scoped by `get_account_owner_id()`; all writes service-role. No phone numbers or transcripts in logs. Stream receiver (future) must authenticate each socket with the `session_id` it was given, re-verify the ledger row is `authorized`, and refuse sessions older than 2 h.

## 9. Failure modes
| Failure | Result |
|---|---|
| Authorize function down / slow / 5xx | webhook adds no fork; call unaffected |
| Flag RPC fails | OFF |
| Kill-switch snapshot unknown | stopped |
| Trial row missing / DB error | blocked, `trial_inactive` |
| Receiver URL/hosts not configured | blocked, `receiver_not_configured` (recorded) |
| Duplicate webhook delivery | same `call_ref` → same session id, no second event |
| Ledger refuses (backstop) | `record_failed`, nothing authorized |

## 10. Not built yet (explicit)
- The stream **receiver** (WebSocket → streaming speech-to-text → redacted transcript → Shadow Card). Needs a long-lived-connection host; Supabase edge functions are the wrong fit **[VERIFY]**.
- `shadow_cards.source` has no `live_call` value (its CHECK is untouched); a later expand-migration adds it.
- Webhook wiring in `pbx-voice` / provider callback: intentionally **not** touched; one call to `shadow-live-authorize` before returning TwiML.
- Owner UI (live panel, session list). Sessions are readable via RLS already.
- Platform tooling to set `telephony_supports_fork` / `counsel_cleared_states` (today: SQL by an operator, after counsel sign-off).

## 11. Rollout plan
1. Deploy migration + function (flag OFF): no behaviour change. 2. Counsel sign-off per state; operator records `counsel_cleared_states`. 3. Build + drill receiver in staging. 4. Flag ON for one internal account (override), drill the kill switch. 5. Approved exposure per account only; never a percentage rollout (consent is per account and per jurisdiction).

## 12. Deploy (when you choose to)
`supabase db push` → `supabase secrets set SHADOW_LIVE_SECRET=<≥32 random chars>` (+ `SHADOW_LIVE_STREAM_URL`, `SHADOW_LIVE_STREAM_HOSTS` once a receiver exists) → `supabase functions deploy shadow-live-authorize` → schedule `{"action":"purge"}` hourly with the header `x-shadow-live-secret`.

## 13. Tests
`_shared/shadow/liveListen.test.ts` (gate matrix, directive, stream rule, static isolation), `supabase/tests/database/shadow_live_listen.test.sql` (defaults, grants, backstop, RLS, idempotency, audit immutability, purge).

## 14. Open decisions for you / counsel
Owner-only attestation? Retention of consent evidence? Is `NANP_UNLISTED` ever acceptable? Disclosure wording per state? Transcription subprocessor + DPA? Re-trial policy? Non-US lines (out of scope: always blocked).
