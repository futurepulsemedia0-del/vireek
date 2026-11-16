# Voice provider coupling map

Generated from the working tree by grep (see commands at the bottom). "Difficulty" is a judgment: **L** = swap an adapter, **M** = re-implement a flow against another vendor, **H** = architectural (needs new infrastructure).
Scope: non-test code in `supabase/functions`, `src`, `api`, `worker`, `services`. Counts: **177** non-test code files in `supabase/functions` + `src` mention "vapi" (306 files repo-wide incl. docs/tests/patches; the "~187" in the task brief is the same order of magnitude, not an exact match). Most mentions are column names (`vapi_call_id`, `vapi_assistant_id`) and comments, not API calls.

## A. Files that call a vendor API host directly

| File | Vendor | Purpose | Difficulty |
|---|---|---|---|
| `_shared/voice-engine/vapiEngine.ts` | Vapi | `POST /call` outbound dial (used by outbound-dialer) | L (already an adapter) |
| `_shared/voice-resilience/adapters.ts` | Vapi, Twilio, Telnyx | health probes, call listing for reconcile, SMS failover | L (already ports) |
| `_shared/voice/vapiProvider.ts` (new) | Vapi | `VoiceProvider` implementation | L |
| `functions/first-call-start` | Vapi | `POST /call` first-call experience | L once migrated to `VoiceProvider.startOutboundCall` |
| `functions/followup-agent-dispatcher` | Vapi, Twilio | outbound follow-up calls | L |
| `functions/workflow-engine-executor` | Vapi | outbound call step in workflows | L |
| `functions/interpreter` | Vapi | interpreter call leg | M (live conversation semantics) |
| `functions/synthetic-probe` | Vapi | synthetic test call + metrics | L |
| `_shared/speed-to-lead/runtime.ts` | Vapi | speed-to-lead outbound call | L |
| `_shared/ovb/runtime.ts` | Vapi | OVB outbound call | L |
| `_shared/audit/providers.ts`, `_shared/audit/script.ts` | Vapi | missed-call audit test calls (transient inline assistant) | M (inline-assistant payload is Vapi-specific) |
| `functions/live-call-control`, `functions/csr-call-transfer` | Vapi | live transfer via `monitor.controlUrl` | M (control channel is Vapi-specific) |
| `functions/voice-studio-sync` | Vapi | `PATCH /assistant/{id}` voice settings (marked NOT LIVE-VERIFIED in source) | M (assistant schema is Vapi-specific) |
| `functions/ai-disclosure-drift-scan` | Vapi | reads assistants to detect disclosure drift | M |
| `_shared/pci/ports.ts` | Vapi, Twilio | pause/redact recording during card capture | H (compliance-critical, provider-specific) |
| `_shared/compliance/providerErasure.ts` | Vapi, ElevenLabs | erasure requests to vendors | M |
| `functions/vapi-webhook` | Vapi (inbound) | ALL inbound events: tool-calls, end-of-call-report, assistant-request; ~25 tool handlers; 2,801 lines | **H** (the biggest coupling; contains business logic, not just parsing) |
| `functions/clone-voice`, `_shared/voice/elevenLabs.ts`, `_shared/voice/tts.ts`, `functions/voice-studio-preview`, `functions/voice-consent` | ElevenLabs | voice cloning, TTS preview | M (clone ids are stored per tenant) |
| `_shared/messaging/sendSms.ts`, `_shared/notify/deliver.ts`, `functions/sms-webhook`, `functions/register-a2p-brand`, `_shared/agent-run/twilioLookup.ts` | Twilio | SMS, A2P registration, number lookup | M (A2P/10DLC registration is carrier-bound) |
| `_shared/pbx/twilio.ts`, `functions/voice-front-door` (host-grepped files only; `pbx-voice`, `call-bridge-voice`, `proxy-call-bridge` are Twilio flows by name, not host-grepped) | Twilio | TwiML call flows, bridging, degraded-mode front door | M |
| `_shared/pci/twilio.ts` | Twilio | PCI pay-by-phone | H |
| `src/lib/telephony.ts` | Twilio/Vapi (client) | client-side telephony helpers | L |

## B. Coupling that is NOT a call site (migration cost lives here)
- Schema: `calls.vapi_call_id` is the idempotency key for ALL calls, including non-Vapi ones (`twilio:<CallSid>` namespacing is used by the degraded path). `business_profile.vapi_assistant_id`, `voice_webhook_events.vapi_call_id`. A second provider can reuse the columns by namespacing ids, but a rename is a large, risky migration.
- Phone numbers: Twilio numbers point at Vapi via SIP/phone-number import (`VOICE_ENGINE_SIP_URI`); re-pointing is operational, not code.
- Prompts/tools: assistant config + 25 tool definitions live in Vapi's schema.

## C. What this change does about it
New `VoiceProvider` interface + `VapiProvider` + `MockProvider`/`NullProvider` + `LiveKitProvider` stub in `_shared/voice/`. **No existing call site is migrated yet** (zero-regression constraint). Suggested migration order, lowest risk first: `synthetic-probe` → `first-call-start` → `workflow-engine-executor` → `speed-to-lead` → `outbound-dialer` → `vapi-webhook` parsing (via `parseWebhook`) last.

## Reproduce
```
grep -rEl "api\.vapi\.ai|api\.twilio\.com|api\.elevenlabs\.io|api\.telnyx\.com" supabase/functions src api worker services | grep -v "\.test\."
grep -rIil vapi supabase/functions src --include=*.ts --include=*.tsx | grep -v "\.test\." | wc -l
```
