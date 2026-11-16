// supabase/functions/_shared/voice/provider.ts
//
// Provider-neutral voice contract (anti lock-in). PURE: no Deno / npm imports, no I/O, no secrets.
//
// Relationship to existing code (verified in repo):
//   * _shared/voice-engine/types.ts  = narrow contract used by outbound-dialer (startCall/applyVoice/endCall).
//     It is NOT replaced; VoiceProvider is the wider contract the other call sites will migrate to.
//   * _shared/voice-resilience/providers.ts = health/ladder ports (healthCheck/listCalls). Unchanged.
//   * vapi-webhook/index.ts still parses Vapi payloads itself. It is NOT touched by this change.

export type VoiceProviderId = "vapi" | "livekit" | "pipecat" | "mock" | "null";

export interface CallContext {
  /** Tenant (business_profile.user_id / profiles.id). Never trust a value coming from a browser. */
  tenantId: string;
  /** Propagated into every log line / provider metadata when the provider supports it. */
  correlationId?: string;
}

// ------------------------------------------------------------------ errors / results

export type ProviderErrorKind =
  | "unsupported" // adapter does not implement this operation (never silently faked)
  | "not_configured" // missing credentials / base URL
  | "auth" // 401 / 403
  | "not_found" // 404
  | "rate_limited" // 429
  | "bad_request" // other 4xx
  | "provider_5xx" // 5xx
  | "timeout"
  | "network"
  | "invalid_payload";

export interface ProviderError {
  kind: ProviderErrorKind;
  /** HTTP status, or 0 when not HTTP. */
  status: number;
  /** Safe to log: never contains a request/response body, phone number or secret. */
  message: string;
  /** True when retrying the SAME request later can plausibly succeed (5xx, 429, timeout, network). */
  retryable: boolean;
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export const okResult = <T>(value: T): ProviderResult<T> => ({ ok: true, value });
export const errResult = (error: ProviderError): ProviderResult<never> => ({ ok: false, error });

export function unsupported(op: string, provider: VoiceProviderId): ProviderResult<never> {
  return errResult({ kind: "unsupported", status: 0, message: `${provider}: ${op} is not supported`, retryable: false });
}

export function notConfigured(provider: VoiceProviderId): ProviderResult<never> {
  return errResult({ kind: "not_configured", status: 0, message: `${provider}: credentials not configured`, retryable: false });
}

export function errorFromStatus(status: number, provider: VoiceProviderId, op: string): ProviderError {
  const kind: ProviderErrorKind =
    status === 401 || status === 403 ? "auth"
    : status === 404 ? "not_found"
    : status === 429 ? "rate_limited"
    : status >= 500 ? "provider_5xx"
    : "bad_request";
  const retryable = kind === "provider_5xx" || kind === "rate_limited" || status === 408;
  return { kind, status, message: `${provider}: ${op} failed with HTTP ${status}`, retryable };
}

export function errorFromThrown(e: unknown, provider: VoiceProviderId, op: string): ProviderError {
  const name = e instanceof Error ? e.name : "";
  const timeout = name === "TimeoutError" || name === "AbortError";
  return {
    kind: timeout ? "timeout" : "network",
    status: 0,
    message: `${provider}: ${op} ${timeout ? "timed out" : "network error"}`,
    retryable: true,
  };
}

// ------------------------------------------------------------------ normalized event model

interface BaseEvent {
  provider: VoiceProviderId;
  /** Provider-side call id (Vapi call.id). null only when the payload carried none. */
  providerCallId: string | null;
  /**
   * Stable idempotency key for THIS logical event. Same event redelivered => same key.
   * Providers that expose a real event id use it; otherwise it is derived (see each adapter).
   */
  dedupeKey: string;
  /** ISO timestamp when the provider says it happened; null when absent. */
  occurredAt: string | null;
  /** Original payload. Contains PII (transcript, phone numbers): NEVER log it. */
  raw: unknown;
}

export interface CallStartedEvent extends BaseEvent {
  type: "call.started";
  direction: "inbound" | "outbound" | "unknown";
}

export interface TranscriptEvent extends BaseEvent {
  type: "call.transcript";
  role: "assistant" | "user" | "unknown";
  text: string;
  final: boolean;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  /** Parsed object when the provider sent JSON text; {} when absent/unparseable. */
  args: Record<string, unknown>;
}

export interface ToolCallEvent extends BaseEvent {
  type: "call.tool_call";
  toolCalls: NormalizedToolCall[];
}

export interface CallEndedEvent extends BaseEvent {
  type: "call.ended";
  endedReason: string | null;
  /** True when the call ended because the PROVIDER/pipeline failed (not because the caller hung up). */
  providerFailure: boolean;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
}

export interface ErrorEvent extends BaseEvent {
  type: "call.error";
  code: string;
  message: string;
}

export type VoiceEvent = CallStartedEvent | TranscriptEvent | ToolCallEvent | CallEndedEvent | ErrorEvent;

/** Event kinds the platform does not model (speech-update, hang, etc.). Never an error: callers ignore them. */
export interface IgnoredEvent {
  type: "ignored";
  provider: VoiceProviderId;
  providerType: string;
}

export type ParsedWebhook =
  | { ok: true; event: VoiceEvent | IgnoredEvent }
  | { ok: false; status: 400 | 413; error: string };

// ------------------------------------------------------------------ operation inputs / outputs

export interface AssistantSpec {
  name: string;
  /** Provider-specific config blob. The adapter owns its shape; business code must not read it back. */
  config: Record<string, unknown>;
}

export interface AssistantRef {
  assistantId: string;
}

export interface StartOutboundCallInput {
  assistantId: string;
  phoneNumberId: string;
  /** E.164. */
  customerNumber: string;
  variableValues: Record<string, string>;
}

export interface CallRef {
  callId: string;
}

export interface CallSnapshot {
  callId: string;
  status: "queued" | "ringing" | "in_progress" | "ended" | "unknown";
  endedReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  raw: unknown;
}

export interface PhoneNumberInfo {
  id: string;
  /** E.164 when the provider exposes it. */
  number: string | null;
  assistantId: string | null;
}

export interface WebhookRequestMeta {
  /** Raw request headers, lower-cased keys. */
  headers: Record<string, string | null | undefined>;
}

// ------------------------------------------------------------------ the interface

export interface VoiceProvider {
  readonly id: VoiceProviderId;
  /** False => the platform must never route traffic here (stubs return false). */
  isReady(): boolean;

  createAssistant(ctx: CallContext, spec: AssistantSpec): Promise<ProviderResult<AssistantRef>>;
  updateAssistant(ctx: CallContext, assistantId: string, patch: Record<string, unknown>): Promise<ProviderResult<AssistantRef>>;
  startOutboundCall(ctx: CallContext, input: StartOutboundCallInput): Promise<ProviderResult<CallRef>>;
  endCall(ctx: CallContext, callId: string): Promise<ProviderResult<void>>;
  fetchCall(ctx: CallContext, callId: string): Promise<ProviderResult<CallSnapshot>>;
  listPhoneNumbers(ctx: CallContext): Promise<ProviderResult<PhoneNumberInfo[]>>;

  /** Pure: raw body text -> normalized event. Never throws, never performs I/O. */
  parseWebhook(rawBody: string): ParsedWebhook;
  /** Pure: fail-closed authentication of an inbound webhook. */
  verifyWebhookSignature(req: WebhookRequestMeta): boolean;
}

/** True when two deliveries are the same logical event (replay / duplicate). */
export function isSameEvent(a: { dedupeKey: string }, b: { dedupeKey: string }): boolean {
  return a.dedupeKey === b.dedupeKey;
}
