# Runbook: voice provider outage (Vapi / Twilio / ElevenLabs)

Related: `docs/runbooks/voice-resilience.md`, `voice-fmea.md`, `incident-response.md`. Ladder: L0 full AI → L1 reduced AI → L2 voicemail + alert → L3 forward to human → L4 static message. Automation steps down in ~1–3 min (`voice-health-tick`); recovery is slow by design.

## 1. Detect (any one)
Alerts `answer_rate_*`, `provider_error_high`, `webhook_5xx_high`; Ladder panel not L0; vendor status page; customer reports.

## 2. Confirm scope (5 min)
| Check | Where | Meaning |
|---|---|---|
| Ladder level + component health | dashboard Ladder panel / table `voice_ladder_state` | automation already degraded? |
| Vapi vs Twilio | vendor status pages + `voice_provider_outcomes` (provider_id, ok, error_code) | which vendor |
| Missing calls | run `voice-reconcile` (or wait for cron) | calls that never produced a webhook |

## 3. Act
- **Vapi down, Twilio up (most likely):** ladder reaches L2 automatically (callers hear the voicemail prompt; emergency key forwards to on-call). If not yet at L2, pin it: `voice-resilience-admin` (operator pin) to L2 or L3 for the duration. Do NOT wait for automation if callers are being dropped.
- **Twilio down:** our TwiML cannot run. Only carrier-side conditional forwarding to the owner's mobile helps (wizard: `carrierForwarding`). Tell affected tenants to enable it; status page update.
- **ElevenLabs/TTS down:** calls end with `pipeline-error-*`; they are recorded as missed calls + owner alert. Switch tenants to a built-in voice (voice-studio) if the vendor outage is long.
- **Both SMS providers down:** owner alerts fall back to in-app; consider pinning L3 (forward) so a human answers.

## 4. Verify mitigation
Place a test call to a staging/own number: expect voicemail prompt (L2) or forward (L3), never silence. Check a `calls` row (`source_channel='voice_fallback'`) and an owner alert were created.

## 5. Recover
Vendor green ≥ 15 min → automation recovers one level at a time (≥ 3 min per step, flap guard). Unpin manually only after a successful live test call. Then run `voice-reconcile`; confirm `unrecovered = 0`. Replay `dead` rows in `voice_webhook_events`.

## 6. Communications templates
**Status page (investigating):** "Some calls to AI-answered lines are being routed to voicemail while we work with our telephony provider. No calls are being lost: voicemails and missed-call alerts are being captured. Next update in 30 minutes."
**Customer email (resolved):** "Between {start} and {end} your AI receptionist was unavailable because of an upstream provider outage. Calls during this time went to voicemail or your on-call number. {N} calls are listed in your dashboard as 'voicemail/missed'. Please call them back. We are reviewing how to shorten our failover time."
**Internal Slack:** "SEV{n} voice provider outage. Vendor: {x}. Ladder: L{n}. IC: {name}. Next update {time}."
Do not state an uptime or recovery time that has not been measured.

## 7. After
Postmortem within 5 working days; record detect/mitigate/recover minutes next to the gameday numbers.
