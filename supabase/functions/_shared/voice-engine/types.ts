// supabase/functions/_shared/voice-engine/types.ts
//
// Vireek Voice Engine — shared contracts. Zero runtime logic, no imports.
// Mirrors the provider-router idea of _shared/ai-core, but for LIVE VOICE.
//
// Vapi is the default engine and stays the only engine that is ever selected
// today. OpenAI Realtime is a stub behind a flag (see resolve.ts).

export type VoiceEngineId = "vapi" | "openai_realtime";

export const VOICE_ENGINE_IDS: readonly VoiceEngineId[] = ["vapi", "openai_realtime"];

export function isVoiceEngineId(v: unknown): v is VoiceEngineId {
  return v === "vapi" || v === "openai_realtime";
}

/** Everything an engine needs to place ONE outbound call. */
export interface StartCallInput {
  /** Tenant (business_profile.user_id). Never trust a value coming from a browser. */
  ownerId: string;
  /** Engine-side assistant reference. For Vapi: business_profile.vapi_assistant_id. */
  assistantId: string;
  /** Engine-side caller-ID/number reference. For Vapi: the vapi phone number id. */
  phoneNumberId: string;
  /** Callee in E.164. */
  customerNumber: string;
  /** Variables injected into the assistant prompt (key order is preserved on the wire). */
  variableValues: Record<string, string>;
}

export type StartCallResult =
  | { ok: true; engine: VoiceEngineId; callId: string | null }
  | {
      ok: false;
      engine: VoiceEngineId;
      /** HTTP status from the provider, or 0 when the failure is not HTTP (e.g. not implemented). */
      status: number;
      /** Ready-to-store text for outbound_calls.outcome_notes (already truncated). */
      note: string;
    };

export interface ApplyVoiceInput {
  ownerId: string;
  assistantId: string;
  /** Provider voice id (e.g. a cloned voice id). */
  voiceId: string;
}

export interface EndCallInput {
  ownerId: string;
  /** Engine-side call id (Vapi call id / OpenAI call_id). */
  callId: string;
}

/** Generic outcome for side-effect operations that may be unsupported. */
export type EngineOpResult =
  | { ok: true }
  | { ok: false; reason: "not_implemented" | "unsupported" | "provider_error"; detail?: string };

/** Provider-neutral view of an inbound provider event. `raw` is never dropped. */
export interface EngineEvent {
  engine: VoiceEngineId;
  kind:
    | "assistant-request"
    | "tool-calls"
    | "transfer-destination-request"
    | "call-lifecycle"
    | "other";
  /** Provider event name, e.g. Vapi `message.type`. */
  type: string;
  raw: unknown;
}

export type HandleEventResult =
  | { handled: true; response?: unknown }
  | { handled: false; reason: "owned_by_existing_webhook" | "not_implemented" | "unrecognized_event" };

export interface VoiceEngine {
  readonly id: VoiceEngineId;
  /**
   * True only when the engine can really place/handle calls. The resolver NEVER
   * selects an engine whose isReady() is false, so a stub can never take traffic.
   */
  isReady(): boolean;
  startCall(input: StartCallInput): Promise<StartCallResult>;
  applyVoice(input: ApplyVoiceInput): Promise<EngineOpResult>;
  handleEvent(event: EngineEvent): Promise<HandleEventResult>;
  endCall(input: EndCallInput): Promise<EngineOpResult>;
}
