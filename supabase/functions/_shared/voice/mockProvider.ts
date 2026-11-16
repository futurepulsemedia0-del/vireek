// supabase/functions/_shared/voice/mockProvider.ts
//
// NullProvider: ready=false, every operation "unsupported". Safe default / placeholder.
// MockProvider: scriptable in-memory provider for unit tests and the chaos harness (scripts/chaos/voice-*.ts).
// Neither performs network I/O or reads secrets.

import {
  errResult, okResult, unsupported,
  type AssistantRef, type AssistantSpec, type CallContext, type CallRef, type CallSnapshot, type ParsedWebhook,
  type PhoneNumberInfo, type ProviderError, type ProviderResult, type StartOutboundCallInput, type VoiceProvider, type WebhookRequestMeta,
} from "./provider.ts";
import { mapVapiMessage } from "./vapiProvider.ts";
import { parseVapiBody } from "../voice-hardening/webhookAuth.ts";

export class NullProvider implements VoiceProvider {
  readonly id = "null" as const;
  isReady(): boolean { return false; }
  createAssistant(): Promise<ProviderResult<AssistantRef>> { return Promise.resolve(unsupported("createAssistant", "null")); }
  updateAssistant(): Promise<ProviderResult<AssistantRef>> { return Promise.resolve(unsupported("updateAssistant", "null")); }
  startOutboundCall(): Promise<ProviderResult<CallRef>> { return Promise.resolve(unsupported("startOutboundCall", "null")); }
  endCall(): Promise<ProviderResult<void>> { return Promise.resolve(unsupported("endCall", "null")); }
  fetchCall(): Promise<ProviderResult<CallSnapshot>> { return Promise.resolve(unsupported("fetchCall", "null")); }
  listPhoneNumbers(): Promise<ProviderResult<PhoneNumberInfo[]>> { return Promise.resolve(unsupported("listPhoneNumbers", "null")); }
  parseWebhook(): ParsedWebhook { return { ok: false, status: 400, error: "null provider cannot parse webhooks" }; }
  verifyWebhookSignature(): boolean { return false; } // fail closed
}

export type MockFault = "5xx" | "timeout" | "network" | "auth" | "rate_limited";

const FAULT_ERRORS: Record<MockFault, ProviderError> = {
  "5xx": { kind: "provider_5xx", status: 503, message: "mock: injected 5xx", retryable: true },
  timeout: { kind: "timeout", status: 0, message: "mock: injected timeout", retryable: true },
  network: { kind: "network", status: 0, message: "mock: injected network error", retryable: true },
  auth: { kind: "auth", status: 401, message: "mock: injected auth failure", retryable: false },
  rate_limited: { kind: "rate_limited", status: 429, message: "mock: injected 429", retryable: true },
};

export interface MockProviderOptions {
  /** Shared secret for verifyWebhookSignature (header x-vapi-secret, mirroring Vapi so Vapi-shaped fixtures work). */
  webhookSecret?: string;
}

/** Records every call so tests can assert on it. Faults can be injected per operation or globally. */
export class MockProvider implements VoiceProvider {
  readonly id = "mock" as const;
  readonly calls: { op: string; args: unknown[] }[] = [];
  private fault: MockFault | null = null;
  private faultOps: Set<string> | null = null;
  private seq = 0;
  private readonly secret: string;

  constructor(opts: MockProviderOptions = {}) {
    this.secret = opts.webhookSecret ?? "mock-secret";
  }

  isReady(): boolean { return true; }

  /** Inject a fault for the given operations (all operations when `ops` is omitted). */
  injectFault(fault: MockFault | null, ops?: string[]): void {
    this.fault = fault;
    this.faultOps = ops ? new Set(ops) : null;
  }

  private gate(op: string, args: unknown[]): ProviderError | null {
    this.calls.push({ op, args });
    if (!this.fault) return null;
    if (this.faultOps && !this.faultOps.has(op)) return null;
    return FAULT_ERRORS[this.fault];
  }

  createAssistant(_c: CallContext, spec: AssistantSpec): Promise<ProviderResult<AssistantRef>> {
    const e = this.gate("createAssistant", [spec]);
    return Promise.resolve(e ? errResult(e) : okResult({ assistantId: `mock-asst-${++this.seq}` }));
  }
  updateAssistant(_c: CallContext, assistantId: string, patch: Record<string, unknown>): Promise<ProviderResult<AssistantRef>> {
    const e = this.gate("updateAssistant", [assistantId, patch]);
    return Promise.resolve(e ? errResult(e) : okResult({ assistantId }));
  }
  startOutboundCall(_c: CallContext, input: StartOutboundCallInput): Promise<ProviderResult<CallRef>> {
    const e = this.gate("startOutboundCall", [input]);
    return Promise.resolve(e ? errResult(e) : okResult({ callId: `mock-call-${++this.seq}` }));
  }
  endCall(_c: CallContext, callId: string): Promise<ProviderResult<void>> {
    const e = this.gate("endCall", [callId]);
    return Promise.resolve(e ? errResult(e) : okResult(undefined));
  }
  fetchCall(_c: CallContext, callId: string): Promise<ProviderResult<CallSnapshot>> {
    const e = this.gate("fetchCall", [callId]);
    return Promise.resolve(
      e ? errResult(e) : okResult({ callId, status: "ended", endedReason: "customer-ended-call", startedAt: null, endedAt: null, durationSeconds: null, transcript: null, summary: null, raw: {} }),
    );
  }
  listPhoneNumbers(): Promise<ProviderResult<PhoneNumberInfo[]>> {
    const e = this.gate("listPhoneNumbers", []);
    return Promise.resolve(e ? errResult(e) : okResult([]));
  }

  /** Accepts Vapi-shaped fixtures so webhook tests can reuse real payload shapes. */
  parseWebhook(rawBody: string): ParsedWebhook {
    const p = parseVapiBody(rawBody);
    if (!p.ok) return p;
    const ev = mapVapiMessage(p.message);
    return { ok: true, event: ev.type === "ignored" ? ev : { ...ev, provider: "mock" } };
  }

  verifyWebhookSignature(req: WebhookRequestMeta): boolean {
    const got = req.headers["x-vapi-secret"];
    return typeof got === "string" && got.length > 0 && got === this.secret;
  }
}
