// supabase/functions/_shared/voice-engine/openAiRealtimeEngine.ts
//
// OpenAiRealtimeEngine — STUB. Never ready, never selected, never calls OpenAI.
// It exists so the interface, the flag and the resolver can be reviewed and
// tested before any audio path is built. See docs/voice-engines.md for the
// intended architecture (direct SIP + a sideband handler that must NOT run in
// a Supabase Edge Function).
//
// No secrets are read here. When this becomes real, OPENAI_API_KEY and
// OPENAI_WEBHOOK_SECRET must come from `supabase secrets` / the worker env only.

import type {
  ApplyVoiceInput,
  EndCallInput,
  EngineEvent,
  EngineOpResult,
  HandleEventResult,
  StartCallInput,
  StartCallResult,
  VoiceEngine,
} from "./types.ts";

const NOT_IMPLEMENTED = "OpenAI Realtime engine is not implemented yet.";

export class OpenAiRealtimeEngine implements VoiceEngine {
  readonly id = "openai_realtime" as const;

  isReady(): boolean {
    return false;
  }

  startCall(_input: StartCallInput): Promise<StartCallResult> {
    return Promise.resolve({ ok: false, engine: "openai_realtime", status: 0, note: NOT_IMPLEMENTED });
  }

  applyVoice(_input: ApplyVoiceInput): Promise<EngineOpResult> {
    return Promise.resolve({ ok: false, reason: "not_implemented", detail: NOT_IMPLEMENTED });
  }

  handleEvent(_event: EngineEvent): Promise<HandleEventResult> {
    return Promise.resolve({ handled: false, reason: "not_implemented" });
  }

  endCall(_input: EndCallInput): Promise<EngineOpResult> {
    return Promise.resolve({ ok: false, reason: "not_implemented", detail: NOT_IMPLEMENTED });
  }
}
