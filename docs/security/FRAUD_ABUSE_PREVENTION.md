# Fraud & abuse prevention (toll fraud, SMS pumping, free-tier farming)

Single choke point: `supabase/functions/_shared/fraud/guard.ts` (`guardOutbound`). Pure policy modules sit beside it
and are unit-tested. State lives in the `fraud_*` tables (migration `20280402000000_fraud_abuse_prevention.sql`).

## 1. Threat model

| Threat | Entry points in Vireek | Controls | Residual risk / status |
|---|---|---|---|
| Toll fraud via forwarding / transfer / outbound to premium or international numbers | `pbx/runtime.createLeg`, `pbx-voice` direct forward, `csr-call-transfer`, `live-call-control`, `outbound-dialer`, `dialer-call`, `proxy-call-bridge`, `call-bridge-voice` (every leg), tenant-editable `forwarding_number` / `phone` | `evaluateDestination`: strict E.164 (no DTMF/pause chars), NANP premium + Caribbean one-ring ranges, premium national prefixes, never-routable codes, fail-closed unknown codes, per-plan allowlist, international off until verified; per-call duration cap + settlement | Prefix/country lists are an initial list: review with the carrier rate deck. Vapi duration-limit override name not live-verified (overruns are detected as `DURATION_OVERRUN`) |
| SMS pumping on verification codes | Supabase Auth phone OTP | `otp-request` (CAPTCHA, per-IP/phone/prefix/global limits, country policy) issues a single-use ticket; `auth-send-sms-hook` sends only with a ticket, so direct `/auth/v1/otp` calls send nothing; uniform responses | Hooks/Auth contract not live-verified. Homeowner portal has phone-only sign-in, so there is no email/passkey fallback on that page |
| Free-tier farming | Signup, number provisioning, inbound AI minutes | Before-User-Created hook (disposable domains + DB list, alias canonicalization, IP/device/domain velocity); outbound + cloning locked until verified; ramp caps; lifetime cost cap; inbound free-minute hard stop (forwards to the owner's domestic number so emergencies are not dropped) | No IP-reputation provider (needs an external paid API); device id is client-supplied (additive signal only) |
| Outbound dialer misuse (robocalls, spam) | `outbound-dialer`, `dialer-call`, `sendCompliantSms` | verification gate, daily call/SMS/cost caps, consent-ledger gate (off/log/enforce), per-campaign approval for accounts younger than N days, anomaly sweep -> throttle/suspend, DNC + quiet hours + A2P (existing) | Consent gate ships in log-only mode until you have captured consent data |
| Spoofed identity | Caller-ID on PBX legs | Caller ID comes from the account's own numbers (existing) | No STIR/SHAKEN work here |
| Voice-cloning abuse | `clone-voice` | unlock flag, plan check, cost reservation, kill switch, suspension | No consent recording of the voice owner |
| Price/data scraping via calls | AI inbound agent | Out of scope | Not addressed |
| Stolen-card / chargeback abuse | Stripe checkout | Ramp caps, daily cost cap, anomaly sweep, **`charge.dispute.created` => automatic suspension + case + page** | Dispute fee amount is an assumption |

## 2. Maximum possible loss per signup (30-day horizon)

Generated from `maxLossPerSignupCents()`; tests prove no sequence of allowed actions exceeds the discretionary part and that list prices match `pricing.ts`.

| Plan | Unverified | Verified | outbound/SMS/clone (cap) | refunded price + dispute fee |
|---|---|---|---|---|
| free | $7.55 | $12.55 | $5.00 | $0.00 |
| starter | $145.45 | $595.45 | $450.00 | $94.00 |
| professional | $321.50 | $1821.50 | $1500.00 | $214.00 |
| business | $711.50 | $5211.50 | $4500.00 | $414.00 |
| enterprise | $965.00 | $15965.00 | $15000.00 | $15.00 |

Assumptions (edit in `planLimits.ts`, calibrate against invoices): domestic call 12c/min (the existing `DEFAULT_VOICE_COST_PER_MIN`),
standard-international 30c/min, SMS 2c (domestic) / 8c (standard), number rental 115c/month, dispute fee $15.
The free figure includes 50 included inbound AI minutes at 12c, now enforced by the inbound hard stop (`free_minutes_mode`:
`monthly` = current product behaviour, `lifetime` = strict). Reservations are worst case and are refunded on call completion.

## 3. Operations

* Kill switches / shadow mode: `/staff/abuse` (or `fraud_settings`). `enforce=false` logs would-be denials but allows traffic.
* Emergency lane: domestic hand-offs and `purpose:"emergency"` SMS/calls, plus 911/112/999, bypass kill switch, suspension,
  throttle, verification and caps (own runaway ceiling of 200/day); destination policy still applies.
* Suspensions/throttles are reversible (`fraud_set_org_status`), audited (`audit_log`, `fraud_events`), open one case per account,
  notify the owner with an appeal path (`fraud-admin` action `appeal`).
* Rollout switches (`/staff/abuse`): `consent_mode` (off|log|enforce), `campaign_approval_days`, `free_minutes_mode`.
* Settlement: guard returns `eventRef`; callers `attachCallRef()` the provider call id; completion webhooks call `settleCall()` which refunds unused reservation.
* Cron: `fraud-sweep` `{"task":"sweep"}` every 5 min, `{"task":"weekly_report"}` Mondays; header `X-Cron-Secret`.
* Secrets: `SEND_SMS_HOOK_SECRET`, `BEFORE_USER_CREATED_HOOK_SECRET`, `FRAUD_HASH_PEPPER`, `CRON_SECRET`; Stripe event `charge.dispute.created` must be enabled on the platform webhook; optional
  `FRAUD_ONCALL_SCHEDULE_ID`, `FRAUD_ALERT_SLACK_WEBHOOK`, `FRAUD_ALERT_EMAIL`. Frontend: `VITE_TURNSTILE_SITE_KEY`.
