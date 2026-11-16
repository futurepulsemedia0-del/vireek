// supabase/functions/_shared/voice/livekitProvider.ts
//
// LiveKitProvider — STUB. isReady() is ALWAYS false, so no router may select it, and every operation
// returns { ok:false, kind:"unsupported" }. It performs no network I/O and reads no secrets.
//
// WHY A STUB: it proves the VoiceProvider interface is not Vapi-shaped, and gives the migration a landing
// spot. Nothing here has been run against LiveKit. See docs/voice/ENGINE_DECISION.md for the (unverified) analysis.
//
// What a real adapter must solve (each is a TODO, none is implemented):
//   TODO(livekit-1) Telephony: LiveKit SIP trunk + dispatch rule so inbound PSTN reaches a room (needs a SIP trunk
//                   provider; today's Twilio number would be re-pointed). Replaces voice-front-door's <Sip> hand-off.
//   TODO(livekit-2) Agent worker: LiveKit Agents (Python/Node) runs as a LONG-LIVED process. It CANNOT run inside a
//                   Supabase Edge Function (request-scoped). Needs a host (container/VM) + autoscaling + deploys.
//   TODO(livekit-3) Tools: re-implement the ~25 tool handlers in vapi-webhook (book_appointment, check_availability...)
//                   as agent tools calling the same Supabase functions, preserving tenant scoping.
//   TODO(livekit-4) Webhooks: LiveKit signs webhooks with a JWT in the Authorization header; implement
//                   verifyWebhookSignature with the API secret and map room_finished/participant_* to CallEnded/CallStarted.
//   TODO(livekit-5) STT/LLM/TTS selection, barge-in tuning, latency measurement on staging.
//   TODO(livekit-6) Voice cloning: ElevenLabs clone ids (business_profile.custom_voice_id) must map to the TTS plugin.

import {
  unsupported,
  type AssistantRef, type CallRef, type CallSnapshot, type ParsedWebhook, type PhoneNumberInfo, type ProviderResult, type VoiceProvider,
} from "./provider.ts";

export class LiveKitProvider implements VoiceProvider {
  readonly id = "livekit" as const;
  isReady(): boolean { return false; }
  createAssistant(): Promise<ProviderResult<AssistantRef>> { return Promise.resolve(unsupported("createAssistant", "livekit")); }
  updateAssistant(): Promise<ProviderResult<AssistantRef>> { return Promise.resolve(unsupported("updateAssistant", "livekit")); }
  startOutboundCall(): Promise<ProviderResult<CallRef>> { return Promise.resolve(unsupported("startOutboundCall", "livekit")); }
  endCall(): Promise<ProviderResult<void>> { return Promise.resolve(unsupported("endCall", "livekit")); }
  fetchCall(): Promise<ProviderResult<CallSnapshot>> { return Promise.resolve(unsupported("fetchCall", "livekit")); }
  listPhoneNumbers(): Promise<ProviderResult<PhoneNumberInfo[]>> { return Promise.resolve(unsupported("listPhoneNumbers", "livekit")); }
  parseWebhook(): ParsedWebhook { return { ok: false, status: 400, error: "livekit adapter not implemented" }; }
  verifyWebhookSignature(): boolean { return false; } // fail closed until TODO(livekit-4) is done
}
