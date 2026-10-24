# PCI-safe pay-by-phone

## How it works
1. AI agent (Vapi tool `collect_card_payment`) or staff (Live Calls -> "Collect card by phone") starts a session.
2. Server derives the amount from the job's open balance (never from the caller, AI or browser).
3. Twilio call recording is paused and VERIFIED. If it cannot be confirmed, capture is blocked (fail closed).
4. The caller's leg moves to Twilio `<Pay>` (DTMF only). The AI/STT pipeline is detached from that leg.
5. Twilio's Stripe Pay Connector tokenizes the card; Vireek receives only a token + masked brand/last4.
6. Vireek charges the token on the Stripe Connect destination, finalizes the payment request, resumes recording, audits every step.

Card data never enters Vireek's AI, transcripts, logs, recordings or database. Safety nets: `_shared/pci/cardData.ts` (TS) and `pci_redact_text()` triggers (DB). You remain responsible for your own PCI SAQ; confirm scope with your QSA.

## Required setup
| Item | Where |
|---|---|
| Twilio Pay Connector for Stripe, named e.g. `Vireek_Stripe` | Twilio Console -> Voice -> Pay Connectors |
| Twilio Pay enabled on the account (PCI Mode recommended) | Twilio Console |
| Business number is a Twilio number IMPORTED into Vapi (BYO Twilio) | Vapi -> Phone Numbers |
| Secrets below | `supabase secrets set ...` |

| Secret | Purpose |
|---|---|
| `TWILIO_PAY_CONNECTOR` | connector name |
| `PCI_SESSION_HMAC_SECRET` | 32+ random bytes; signs callback URLs |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | already used by the project |
| `VAPI_PRIVATE_KEY`, `STRIPE_SECRET_KEY` | already used |
| `STRIPE_PHONE_MOTO_ENABLED` | `true` only after Stripe enabled MOTO on your account |
| `TWILIO_PAY_TOKEN_TYPE` | optional: `one-time` (default) or `payment-method` |
| `PHONE_PAYMENT_WEBHOOK_URL` | optional override of `<SUPABASE_URL>/functions/v1/phone-payment-webhook` |

Deploy: `supabase functions deploy phone-payment-control` and `supabase functions deploy phone-payment-webhook --no-verify-jwt`, then `supabase db push`.

## Vapi tool (add to the assistant)
```json
{
  "type": "function",
  "async": false,
  "messages": [{ "type": "request-start", "content": "One moment, I'm moving you to our secure payment line. Please enter your card on your phone keypad." }],
  "function": {
    "name": "collect_card_payment",
    "description": "Start a secure keypad card payment for the caller's open invoice. Never ask for or repeat card details.",
    "parameters": { "type": "object", "properties": { "job_id": { "type": "string", "description": "Optional job id if known" } } }
  }
}
```
Add to the system prompt: "Never ask for, accept, or repeat card numbers, expiry dates or security codes aloud. If the caller wants to pay by card, call collect_card_payment. If they start reading digits, stop them and call the tool."

## First live test (not verified against your accounts)
1. Test call -> payment from Live Calls -> confirm: recording pauses, you cannot hear DTMF, status reaches Paid, Phone Payments shows "Chain verified".
2. Check Twilio `<Pay>` attributes against current docs; confirm `phoneCallProviderId` is returned by Vapi for your number.
3. Call with a non-Twilio (Vapi-native) number: expect the "secure payment link" fallback, no capture.

## Runbook: card number found
`calls.pci_spoken_card_detected = true` means a caller read digits aloud. The transcript is already redacted; purge that call's audio recording in Vapi/Twilio and note it in your incident log.

## Not covered (follow-ups)
Inbound SMS bodies are not scrubbed; audit-row retention purge job; 3-D Secure cannot be done by phone (MOTO needed).
