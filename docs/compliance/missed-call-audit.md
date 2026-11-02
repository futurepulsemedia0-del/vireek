# Missed-Call Audit — compliance, cost, operations

Status: **NOT production-ready.** See "Release gate" at the bottom. Nothing here is legal advice; every item marked **[COUNSEL]** needs a qualified lawyer's sign-off before `audit_settings.enabled` is set to true.

## 1. What the feature does (and refuses to do)
- Public page `/audit`. The visitor proves they control a **business number** with a one-time code (Twilio Verify, SMS; voice for landline/toll-free), then explicitly authorises up to **3 AI test calls to that same number**.
- Calls go **only** to the verified number. No other number can ever be dialled (`audit_calls` rows are created only from the verified audit; the dial path re-checks consent, block list, kill switch, window and timezone).
- Each call opens with an AI disclosure, is **not recorded**, asks one scripted question, and ends within 75 s. No transcript, audio or free text is stored (only coarse observations: answered-by, greeting present, ring seconds…). A transient transcript is read once to detect "stop calling me", then discarded.
- Hard caps: 3 calls per audit (`UNIQUE(audit_id, slot)`), never re-dialled, never outside 08:00–21:00 in the **strictest** of the owner's and the number's timezone, never later than 30 min after the chosen time. Anything uncertain **fails closed** (skipped, not dialled).
- Refused numbers: emergency/service codes, premium (900/976), 555, non-US/CA, toll-free for SMS (voice code only), numbers on the blocklist, numbers audited in the last 30 days.

## 2. Consent ledger
`audit_consents` is append-only (trigger). Each row stores: scope, granted, exact text + SHA-256 + version, timestamp, IP, user agent, page URL, lawful-basis string, record hash. Scopes: `otp_message`, `ai_test_calls`, `email_followup` (separate, optional, unticked).
- Deleting an audit **redacts** the receipt (phone, email, IP, UA, URL removed) and keeps the hashed wording proof for `consent_receipt_retention_days` (default 30, max 1825). **[COUNSEL]** decide the retention length.
- Consent text lives in `supabase/functions/_shared/audit/consentText.ts` and is a **draft**.

## 3. Questions for counsel **[COUNSEL]**
1. TCPA / CRTC: is an on-request, AI-voiced test call to the requester's *own* number, authorised by the requester, outside the prior-express-written-consent rules for artificial/prerecorded voice? Does the answer change when the number belongs to a business rather than a person?
2. The OTP is sent **before** the call consent is captured (there is no audit yet). Is the OTP-message consent wording sufficient for a one-time, requested, non-marketing message?
3. Number ownership: OTP proves control of the line, not authority to consent for the business. Is the "I am an authorized representative" attestation + OTP enough? Voicemail-delivered OTPs weaken the proof for landlines — acceptable?
4. State AI-disclosure / bot-disclosure laws (CA, UT, others) and two-party-consent recording laws (we do not record; confirm provider settings keep it that way).
5. Calls reach whoever answers (an employee, a customer). Is the scripted disclosure adequate for them?
6. CAN-SPAM / CASL for follow-up emails (separate opt-in, unsubscribe, postal address). The report email is treated as transactional.
7. Privacy notices (CCPA/CPRA, GDPR if EEA traffic arrives), retention periods (30 days audits), subprocessors list (Twilio, Vapi, Resend, Cloudflare, Supabase).
8. Benchmarks: only aggregate, k ≥ 30; confirm wording in marketing.

## 4. Safety and abuse controls (implemented, tested)
Turnstile bot check; honeypot; ≥ 2.5 s form time; per-IP (6/h), per-number (3/h) and per-email rate limits; blocklists (phone, email, domain, IP); 30-day per-number cooldown; OTP 5 attempts, 10 min expiry, single use, newer request supersedes older; daily start cap (60), daily budget (3000 ¢), per-audit cap (150 ¢) all reserved **atomically before** spending; kill switch (env **and** DB); logs contain no phone/email/token; report tokens are derived by HMAC, only the SHA-256 is stored; shared view is redacted and cannot act as an owner token; reports 404 uniformly for any bad token.

## 5. Cost per audit (vendor prices are ASSUMPTIONS — verify against your invoices, then edit `cost.ts`)
| Case | Items | Estimate |
|---|---|---|
| Typical | SMS code 6 ¢ + 3 calls × ~20 ¢ (≈40 s at ~$0.30/min) + 3 emails 3 ¢ | **≈ $0.69** |
| With line lookup | + 2 ¢ | ≈ $0.71 |
| Worst case reserved | SMS 6 ¢ + 3 × 38 ¢ (75 s cap at $0.30/min) + emails 3 ¢ | **≈ $1.23**, hard cap $1.50 |
| Daily ceiling | `daily_budget_cents` 3000 | $30/day, ≈ 25–45 audits |
Abuse that never completes OTP costs ≤ 6–8 ¢ per attempt and is bounded by the daily budget and rate limits.

## 6. Kill switch and incident runbook
- **Instant (no DB):** set Edge secret `AUDIT_KILL_SWITCH=1`. New starts get 503; scheduled calls are not dialled; the runner keeps finishing/cleaning up. Delete/unsubscribe/report-view keep working.
- **DB:** `select audit_staff_set_enabled(false, 'reason');` (staff only) or `update audit_settings set enabled=false, disabled_reason='…';` with the service role. Sub-switches: `otp_enabled`, `calls_enabled`, `followups_enabled`.
- **Unwanted-call complaint:** add the number: `insert into audit_blocklist(kind,value,reason) values ('phone_hash','<hmac>','complaint');` (hash with the pepper via `hashIdentifier`), then cancel its audit and delete on request. Anyone who says "stop" on a test call is auto-blocked and their remaining calls/follow-ups cancelled.
- **Provider incident:** flip `calls_enabled=false`; stuck calls are parked as `failed/dial_state_unknown` and never retried; owners are not penalised (inconclusive calls are excluded from the score).
- **Monitoring:** `select audit_ops_summary();` (staff) — starts, OTPs, calls, spend vs budget, failure counts.

## 7. Environment variables (Edge Function secrets)
`AUDIT_ENV` (`production` default; `mock` is refused on a hosted Supabase URL), `AUDIT_PEPPER`, `AUDIT_TOKEN_SECRET`, `AUDIT_LINK_SECRET`, `AUDIT_CRON_SECRET` (≥ 24 chars), `AUDIT_BASE_URL` (https://vireek.com), `AUDIT_ALLOWED_ORIGINS`, `AUDIT_POSTAL_ADDRESS` (required for follow-ups), `AUDIT_KILL_SWITCH`, `AUDIT_LOOKUP` (`1` to enable Twilio Lookup), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `VAPI_API_KEY`, `AUDIT_VAPI_PHONE_NUMBER_ID`, `AUDIT_VAPI_VOICE_JSON`, `VAPI_WEBHOOK_SECRET` (already used by vapi-webhook), `RESEND_API_KEY`, `AUDIT_EMAIL_FROM`, `AUDIT_EMAIL_REPLY_TO`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. Frontend: `VITE_SUPABASE_URL` (existing).
Secrets must be different per environment; never reuse the pepper (changing it invalidates cooldown/blocklist hashes).

## 8. Staging checklist (everything below is NOT RUN — needs live vendors)
1. Apply migration; confirm `audit_settings.enabled=false`; run `scripts/db-tests/audit-migration.pglite.mjs`.
2. Create Twilio Verify service; confirm SMS + voice OTP, wrong/expired code behaviour, `status:"approved"` parsing.
3. Vapi: confirm the inline-assistant payload accepted (`firstMessageMode`, `artifactPlan.recordingEnabled:false`, `analysisPlan.structuredDataPlan`, `serverMessages`, `metadata.vireek_audit_call_id`), that the webhook receives `status-update`/`end-of-call-report` with that metadata, that `cost` is USD, and that **no recording/transcript is stored** in the Vapi dashboard.
4. Place the three calls to a test line you own: business hours (answered), lunch (voicemail), after hours (no answer). Verify scores/timeline and that nothing dials outside 08:00–21:00.
5. Resend domain (SPF/DKIM/DMARC), List-Unsubscribe one-click POST against `audit-api`, postal address present.
6. Turnstile site/secret; CSP allows `challenges.cloudflare.com`.
7. pg_cron: schedule the two jobs from the migration footer (replace secret placeholders); confirm the runner returns 401 without `X-Cron-Secret`.
8. Kill switch drills (env and DB); delete flow; retention purge after 30 days (set `retention_days=1` in staging).
9. Real-browser Lighthouse/axe on `/audit` and a report with the real stylesheet (e2e a11y here ran unstyled).

## 9. Release gate — do not enable until ALL are true
- [ ] **[COUNSEL]** sign-off on §3 and on `consentText.ts`; privacy policy / subprocessors updated.
- [ ] Staging checklist §8 completed with live vendors and results recorded.
- [ ] Vendor prices in `cost.ts` reconciled with real invoices.
- [ ] Full app typecheck/build/e2e green on the real repo (the supplied ZIP was corrupted — see INSTALL-AUDIT.md).
- [ ] On-call owner named for the kill switch.
