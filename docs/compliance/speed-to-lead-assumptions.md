# Speed-to-lead voice callback: compliance assumptions for counsel review

Status: DRAFT for review by qualified telecom/privacy counsel. This is an engineering record of what the
code assumes. It is **not legal advice**, and nothing here has been approved by a lawyer. Research was
current as of October 2026; every item marked **[VERIFY]** should be confirmed before launch.

## 1. What the feature does

A web-form or ad lead arrives with a consent checkbox. If the lead is eligible, an AI voice agent calls
within the response target (default 60 s of server receipt), qualifies, and books or hands off to a human.
Code: `supabase/functions/_shared/speed-to-lead/` (decisions in `core.ts`, I/O in `runtime.ts`),
intake in `supabase/functions/speed-to-lead-intake/`, schema in `20271102000000_speed_to_lead.sql`.

## 2. Assumptions encoded in code

| # | Assumption | Where enforced | Notes / open question |
|---|-----------|----------------|-----------------------|
| A1 | An AI-generated voice is an "artificial or prerecorded voice" under the TCPA (FCC Declaratory Ruling, Feb 2024). | Consent scope `ai_voice_call` is required for every call. | Court decisions differ on written vs. non-written consent for some artificial-voice calls **[VERIFY]**. We design for the strictest reading: express **written** consent everywhere. Secondary sources found during research disagree on newer FCC actions in 2026; do not rely on this document for them. |
| A2 | Consent is obtained by an unchecked checkbox plus the exact disclosure text, per source, versioned. | `speed_to_lead_sources.disclosure_text/version`; intake holds leads whose `disclosure_version` is stale. | Counsel to approve the default wording (`defaultDisclosure()` in `src/lib/speedToLead.ts`): AI/automated voice, calls to the number given, not a condition of purchase, how to revoke. E-SIGN compliance of the checkbox **[VERIFY]**. |
| A3 | Consent is specific to the seller named on the form. | One ledger per account; sources are per account. | The 1:1 consent rule was vacated by the Eleventh Circuit (2025). We do not buy, share or resell leads; lead-generator forms that list multiple sellers are out of scope. |
| A4 | Proof must survive litigation (claims commonly reach back ~4 years). | Append-only ledger (UPDATE blocked, DELETE blocked for 5 years), SHA-256 of disclosure text and of the whole record, IP, user agent, URL, form id, timestamps, optional third-party proof URL. | Hashes give tamper evidence, not non-repudiation. Consider a certificate vendor (e.g. TrustedForm-style) via `trustedform_cert_url`. **Retention vs. deletion requests (CCPA/other)**: the ledger is exempt from account deletion by design; counsel to confirm the legal-hold basis. |
| A5 | Revocation can be made in any reasonable way and must be honored promptly. | In-call opt-out detection (customer lines only) writes a revocation row, DNC entry and cancels queued calls immediately; managers can revoke from the dashboard; DNC and revocation are checked at **every** dial. | FCC rules treat "stop"-type replies as reasonable revocation; the "revoke-all" provision (revocation applies to all robocalls/texts from the caller) has its effective date delayed to **January 31, 2027** as of the last order we found **[VERIFY]**. Our suppression already applies per number across all features that use `dnc_suppressions`; inbound email/SMS-STOP revocations are **not** yet wired to this ledger. |
| A6 | Federal calling hours are 8:00 AM-9:00 PM recipient local time; several states end the day at 8:00 PM and cap solicitation calls at 3 per 24 h on the same subject (e.g. FL, OK, MD; WA hours). | Account quiet-hours gate (purpose `marketing`, never overridable) + narrower window (default 9:00-20:00, DB-clamped to 8:00-21:00) + hard cap of 3 attempts per rolling 24 h per number, regardless of settings. | Recipient timezone is inferred (customer record, address, area code) with the business timezone as fallback; area codes are not residency. Counsel to decide whether to assume the strictest state rule nationwide (current default effectively does for hours and attempts). The 3/24 h cap counts only this feature's calls to a number, not other campaigns **[VERIFY]**. |
| A7 | A call placed inside the window may run past the window end. | Window checked at dial start only. | Counsel to confirm; mitigation is to narrow the window end. |
| A8 | National/State DNC registry does not excuse a number after the person later says stop, and written consent may override a registry listing for that seller. | Internal DNC (`dnc_suppressions`) always blocks. The optional external registry scrub (`DNC_SCRUB_API_URL`) also blocks (stricter than the consent-overrides-registry reading). | Without a registry provider configured, registry listings are not checked at all. Counsel to decide if a scrub is mandatory before launch. |
| A9 | The AI must identify itself and the business, and offer a way to opt out. | First message override and the brief require AI disclosure up front; brief tells the agent to honor stop requests. Recording notice reuses `recordingConsent.ts`. | Compliance depends on the Vapi assistant prompt including `{{speed_to_lead_context}}`. The first message is applied by override, but the LLM's behavior is not guaranteed. Consider an automated transcript audit. |
| A10 | Voicemail: the AI does not intentionally leave a message; retries follow the schedule. | Outcome `voicemail` is treated as no contact and retried (max 3/24 h). | Leaving a prerecorded/AI voicemail may be a separate consent question; configure voicemail detection in Vapi to hang up if desired **[VERIFY]**. |
| A11 | Only US/Canada (+1 NANP) numbers are auto-dialed. | `parseNanpPhone`; other regions are saved as leads, never called. | Canadian numbers fall under CRTC rules (not modeled); counsel to decide whether to exclude +1 Canadian area codes. |
| A12 | Leads older than the freshness limit (default 48 h) are not auto-called. | `lead_ttl_hours`, intake `stale_submission`. | Ensures consent is contemporaneous with the call. |
| A13 | A sender token must not be exposed in browsers. | No CORS; per-source rate limit (30/min); per-number 24 h cap; tokens stored only as SHA-256. | A leaked token could still submit someone else's number with `consent: true`. Residual risk: third-party-submitted consent. Consider double opt-in (SMS confirm) for high-risk sources **[VERIFY]**. |

## 3. Fail-closed behavior (by design)

* Missing/revoked/wrong-scope consent: no call. Stale disclosure version: recorded as **not granted**.
* Any failed lookup of consent, DNC, preferences, attempts or quiet hours: the call is deferred 2 minutes, never placed.
* Network timeout placing a call: never retried automatically; parked as `needs_review` for a human.
* Leads that cannot be called (no consent, stale, expired, unreachable) always create a "needs a human" item and notification so no lead is silently lost. Note: a **human** following up manually is outside the AI-voice consent analysis but still subject to DNC; the UI shows the DNC state before calling.

## 4. Known gaps / not implemented (for counsel and product to decide)

1. Inbound revocations by SMS STOP or email do not yet write to the consent ledger (they use existing channel-specific suppression).
2. No automated review of call transcripts for disclosure and opt-out compliance.
3. No per-state rule table (hours, caps, recording consent beyond the existing `recordingConsent.ts`); the default is conservative nationwide.
4. No Canadian (CRTC) rules, no TCPA safe-harbor reassigned-numbers database check (RND). Reassigned numbers are a real exposure for consent captured by a previous subscriber **[VERIFY]**.
5. DSAR/deletion tooling (`_shared/compliance/ownedTables.ts`) is not updated for the new tables.
6. The intake IP is the form backend's unless the backend forwards `ip_address` and `user_agent`; counsel to decide if forwarding is mandatory evidence.

## 5. Questions for counsel

1. Is the default disclosure sufficient for prior express written consent for AI-voice calls, and does an unchecked checkbox satisfy E-SIGN in each target state?
2. Which state rules apply when residency is unknown (area-code presumption)? Strictest-nationwide vs. per-state tables?
3. Is the 5-year retention with deletion-request exemption defensible?
4. Do we need an RND check, double opt-in, or a registry scrub before launch?
5. Is an AI voicemail permitted under the same consent, or must the agent hang up on voicemail?
6. Should human callbacks use a separate, lighter flow, and how is that documented?

## 6. Operational checklist before enabling for a customer

- [ ] Counsel approved disclosure text and version recorded.
- [ ] Source form shows that exact text beside an **unchecked** checkbox; consent not required to submit.
- [ ] Form backend forwards `submission_id`, `submitted_at`, `ip_address`, `user_agent`, `page_url`.
- [ ] Vapi assistant prompt contains `{{speed_to_lead_context}}` and `{{recording_consent_context}}`.
- [ ] Registry scrub decision made; `CRON_SECRET`, `VAPI_PRIVATE_KEY` set; cron scheduled.
- [ ] Test with an internal number: consent, DNC, quiet hours and revocation each verified.
