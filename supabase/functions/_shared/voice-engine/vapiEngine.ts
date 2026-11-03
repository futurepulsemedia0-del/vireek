// supabase/functions/_shared/voice-engine/vapiEngine.ts
//
// VapiEngine — thin adapter over behavior that ALREADY exists in the repo.
//
// startCall   : byte-for-byte the request outbound-dialer used to send inline
//               (URL, headers, body key order, error-note text, `json.id ?? null`).
//               Network/JSON errors are deliberately NOT caught here: the caller's
//               existing try/catch keeps handling them exactly as before.
// handleEvent : vapi-webhook stays the ONLY handler of Vapi events (it is not touched).
//               This method only classifies; it never executes tools or writes data.
// applyVoice  : the repo has no code that pushes a voice to a Vapi assistant
//               (clone-voice only stores business_profile.custom_voice_id), so this is
//               an explicit "unsupported" rather than an invented Vapi call.
// endCall     : the repo has no end-call path (live-call-control only transfers), so
//               also "unsupported". NOT VERIFIED against Vapi docs; intentionally not guessed.

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

export const VAPI_CALL_URL = "https://api.vapi.ai/call";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VapiEngineOptions {
  apiKey: string | null | undefined;
  /** Injectable for tests. Defaults to the global fetch (resolved at call time). */
  fetchImpl?: FetchLike;
}

/** Maps a Vapi `message.type` to the neutral kind. Unknown types -> "other". */
export function classifyVapiEvent(type: string): EngineEvent["kind"] {
  switch (type) {
    case "assistant-request":
      return "assistant-request";
    case "tool-calls":
      return "tool-calls";
    case "transfer-destination-request":
      return "transfer-destination-request";
    case "end-of-call-report":
    case "status-update":
      return "call-lifecycle";
    default:
      return "other";
  }
}

export class VapiEngine implements VoiceEngine {
  readonly id = "vapi" as const;
  private readonly apiKey: string | null | undefined;
  private readonly fetchImpl?: FetchLike;

  constructor(opts: VapiEngineOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl;
  }

  isReady(): boolean {
    return !!this.apiKey;
  }

  async startCall(input: StartCallInput): Promise<StartCallResult> {
    const doFetch: FetchLike = this.fetchImpl ?? ((u, i) => fetch(u, i));
    const res = await doFetch(VAPI_CALL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: input.assistantId,
        phoneNumberId: input.phoneNumberId,
        customer: { number: input.customerNumber },
        assistantOverrides: { variableValues: input.variableValues },
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      return { ok: false, engine: "vapi", status: res.status, note: `Vapi error ${res.status}: ${bodyText.slice(0, 300)}` };
    }

    const json = await res.json();
    return { ok: true, engine: "vapi", callId: json.id ?? null };
  }

  applyVoice(_input: ApplyVoiceInput): Promise<EngineOpResult> {
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no existing Vapi voice-apply path in repo" });
  }

  handleEvent(event: EngineEvent): Promise<HandleEventResult> {
    if (event.engine !== "vapi") return Promise.resolve({ handled: false, reason: "unrecognized_event" });
    return Promise.resolve({ handled: false, reason: "owned_by_existing_webhook" });
  }

  endCall(_input: EndCallInput): Promise<EngineOpResult> {
    return Promise.resolve({ ok: false, reason: "unsupported", detail: "no existing Vapi end-call path in repo" });
  }
}
