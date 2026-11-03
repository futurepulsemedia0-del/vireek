# Voice engines: Vapi (default) and OpenAI Realtime (optional, stub)

Status: design note + interface + stub. **No customer-visible change.** Vapi is the only engine that can take traffic today.
Research date: 2026-11-03. Items marked **UNVERIFIED** were not confirmed from a primary source and must be checked before launch.

## 1. What exists in the repo (verified by reading the code)
- Outbound calls: `outbound-dialer` POSTs `https://api.vapi.ai/call`. Inbound/events: the single `vapi-webhook` Edge Function (assistant-request, tool-calls, end-of-call-report). Live takeover/transfer: `live-call-control` (Vapi `controlUrl`). Twilio is used elsewhere (SMS, `pbx-voice`, `call-bridge-voice`).
- `vapi_call_id` / `vapi_assistant_id` / `vapi_phone_number_id` are baked into many tables and functions. Generalising them is a **separate, later** migration (Section 6).

## 2. What this change adds
`_shared/voice-engine/`: `VoiceEngine` interface (`startCall`, `applyVoice`, `handleEvent`, `endCall`), `VapiEngine` (byte-identical to the old inline dialer request, pinned by a characterization test), `OpenAiRealtimeEngine` (stub, `isReady() === false`), and `resolveVoiceEngine`.
OpenAI is selected only if ALL are true: env `VOICE_OPENAI_REALTIME_ENABLED=true`; a row in `voice_engine_flags` (service-role-only table) says `openai_realtime`; the engine reports `isReady()`. Any error means Vapi. With the env switch off, the flag table is never queried.

## 3. OpenAI voice options (primary docs, read 2026-11-03)
- Two lines exist: **Realtime API** (`gpt-realtime-2.1`, `-mini`; `/v1/realtime`) and **GPT-Live** (`gpt-live-1`; `/v1/live/sessions`, a voice front end that delegates reasoning/tools to your backend). The engine id `openai_realtime` is generic; choosing between them is an open decision (assumption: Realtime first, as requested).
- Telephony, **direct SIP** (recommended): Twilio Elastic SIP Trunk origination URI `sip:<PROJECT_ID>@sip.api.openai.com;transport=tls` (EU: `sip-eu.api.openai.com`). OpenAI sends a signed `realtime.call.incoming` webhook; the backend verifies the signature, dedupes, then `POST /v1/realtime/calls/{call_id}/accept` with model, instructions, voice and tools. Optional **sideband** WebSocket `wss://api.openai.com/v1/realtime?call_id=...` for events/tools/commands. `refer` (transfer) and `hangup` endpoints exist. Call audio never passes through Vireek servers.
- Alternative, **WebSocket audio bridge** (Twilio Media Streams <-> our server <-> OpenAI): works, but we would relay all audio, own jitter/barge-in and scale per call. Not recommended as the first path.
- Voices: `marin` appears in the docs. A full voice list per model was **not** read: **UNVERIFIED**. Mapping Vireek's cloned ElevenLabs voice to OpenAI is **not possible by this design**; OpenAI "custom voices" exists as a doc page but was not read: **UNVERIFIED**.

## 4. Where the long-lived WebSocket must run
- Supabase Edge Functions are a poor fit for a call-length socket: wall-clock limit is 150 s (Free) / 400 s (paid), CPU and wall clock are independent, and a worker can be retired early ("EarlyDrop") when it looks idle after the WebSocket upgrade; `EdgeRuntime.waitUntil` prevents early retirement but does not raise the hard wall-clock limit. Phone calls routinely exceed 400 s.
- Fits Edge: the **webhook + accept** step (short, stateless, idempotent by `call_id`).
- Cheapest safe options, in order:
  1. **Spike first (UNVERIFIED):** Realtime "Tools and MCP" (remote MCP tools) could let OpenAI call a stateless Edge Function directly, with no sideband socket at all. I did not read that page; verify tool-call latency, auth and error handling before relying on it.
  2. **Fallback (verified approach):** one small always-on worker (e.g. a container with min 1 instance) that holds one sideband socket per active call and calls the existing Edge Functions for tools. Hosting price: **UNVERIFIED**.
- Exactly one handler per side effect (tool/transfer): the docs warn that duplicate webhook deliveries or events seen on two connections can run a tool twice.

## 5. Cost per minute (planning numbers, measure before pricing customers)
| Item | Rate | Source quality |
|---|---|---|
| `gpt-live-1` voice layer | $0.05/min, billed per second, **plus** backend model/tool tokens | primary (model page) |
| `gpt-realtime-2.1` | $32 / $0.40 cached / $64 per 1M audio tokens (in / cached in / out); mini $10 / $0.30 / $20 | secondary sites quoting the price list; re-check on the pricing page |
| Realtime effective per minute | ~$0.05 raw at 50/50 talk, ~$0.06-$0.10 with context re-reads and caching | vendor estimate, secondary |
| Data residency (eligible models released after 2026-03-05) | +10% | primary (data controls page) |
| Twilio SIP trunk minutes + numbers | not looked up | **UNVERIFIED** |
| Vapi today (platform fee + providers) | take it from your Vapi invoice | **UNVERIFIED** |

## 6. Data and compliance
- API data is not used for training by default. Abuse-monitoring logs: up to 30 days by default. `/v1/realtime` is ZDR-eligible; `/v1/live/sessions` is ZDR-eligible with limits (application state none, or 30 days if stored). EU processing: `eu.api.openai.com` / `sip-eu`, requires an approved Modified Abuse Monitoring or ZDR agreement (sales-gated). BAA/HIPAA for voice: **UNVERIFIED**.
- **Parity gaps that block enabling for real tenants:** (a) call recording and the seal policy used by `vapi-webhook` come from Vapi; an OpenAI-SIP call has no equivalent yet (Twilio trunk recording is an option, **UNVERIFIED**); (b) `ai-disclosure-drift-scan` and the disclosure proof ledger read the **Vapi assistant** first message, so OpenAI calls would be invisible to them; (c) `live-call-control`, `synthetic-probe`, `speed-to-lead`, `workflow-engine-executor`, `call_dispositions`, `live_calls` all key on `vapi_call_id`; (d) tool implementations live inside `vapi-webhook` in Vapi's message format and must be extracted to shared code (not done here, by instruction).

## 7. Risks
Model/product churn (three model names seen in the docs in one afternoon: `gpt-realtime`, `gpt-realtime-2.1`, `gpt-live-1`); quota is concurrent sessions for GPT-Live; double execution of tools on retried webhooks; PSTN-to-SIP codec/SRTP/TLS trunk settings; EU residency approval lead time; losing the disclosure/recording evidence trail (Section 6); cost surprises from long idle sessions.

## 8. Rollout gates (all required before the flag may be turned on for any tenant)
1. Section 6 (a)-(d) closed. 2. Tool extraction with tenant-isolation tests. 3. Sideband/MCP spike result recorded here. 4. Real-call test on a test number with recording + disclosure verified. 5. Counsel review of recording/AI-disclosure wording for OpenAI-routed calls.
