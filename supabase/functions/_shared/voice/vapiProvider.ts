// supabase/functions/_shared/voice/vapiProvider.ts
//
// VapiProvider — the Vapi adapter behind VoiceProvider.
//
// BEHAVIOR-PRESERVING by construction:
//   * startOutboundCall delegates to the existing VapiEngine.startCall (same URL, headers, body key order).
//   * parseWebhook / verifyWebhookSignature reuse the existing pure helpers parseVapiBody / verifyVapiSecret.
//   * vapi-webhook/index.ts and every existing call site are UNCHANGED. Migrating them is a separate step.
//
// VERIFICATION STATUS of each operation (honest):
//   fetchCall            GET  /call/{id}              — same call already used in repo (pci/ports.ts, audit/providers.ts).
//   updateAssistant      PATCH /assistant/{id}        — same call already used in voice-studio-sync.
//   startOutboundCall    POST /call                   — same call already used in outbound-dialer (via VapiEngine).
//   createAssistant      POST /assistant              — NOT used anywhere in this repo: UNVERIFIED against live Vapi.
//   listPhoneNumbers     GET  /phone-number           — NOT used anywhere in this repo: UNVERIFIED against live Vapi.
//   endCall              POST monitor.controlUrl {type:"end-call"} — transfer uses the same channel with type:"transfer"
//                        (live-call-control); the "end-call" message type is UNVERIFIED against live Vapi.

import { parseVapiBody, verifyVapiSecret } from "../voice-hardening/webhookAuth.ts";
import { VapiEngine } from "../voice-engine/vapiEngine.ts";
import {
  errResult, errorFromStatus, errorFromThrown, notConfigured, okResult,
  type AssistantRef, type AssistantSpec, type CallContext, type CallRef, type CallSnapshot, type NormalizedToolCall,
  type ParsedWebhook, type PhoneNumberInfo, type ProviderResult, type StartOutboundCallInput, type VoiceEvent, type VoiceProvider,
  type WebhookRequestMeta,
} from "./provider.ts";

export const VAPI_BASE_URL = "https://api.vapi.ai";
/** Same pattern synthetic/metrics.ts already uses to recognise PROVIDER-side failures in `endedReason`. */
export const VAPI_PROVIDER_FAILURE_REASON =
  /^(assistant-(not-found|not-valid|request-failed|request-returned-(error|invalid-assistant|unspeakable-error)|error)|pipeline-error-|unknown-error|call\.start\.error|assistant-.*-failed)/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VapiProviderOptions {
  apiKey: string | null | undefined;
  /** Shared secret expected in the `x-vapi-secret` header. Missing => every webhook is rejected (fail closed). */
  webhookSecret: string | null | undefined;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function isVapiProviderFailure(endedReason: string | null | undefined): boolean {
  return !!endedReason && VAPI_PROVIDER_FAILURE_REASON.test(endedReason);
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function durationFrom(msg: Record<string, unknown>, call: Record<string, unknown>): number | null {
  if (typeof msg.durationSeconds === "number" && Number.isFinite(msg.durationSeconds)) return msg.durationSeconds;
  const s = typeof call.startedAt === "string" ? Date.parse(call.startedAt) : NaN;
  const e = typeof call.endedAt === "string" ? Date.parse(call.endedAt) : NaN;
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? Math.round((e - s) / 1000) : null;
}

/**
 * Pure mapping of ONE Vapi `message` object to the normalized model.
 * Vapi does not expose a per-delivery event id (UNVERIFIED that none exists), so dedupeKey is DERIVED:
 *   end-of-call-report -> "<callId>:ended"            (once per call)
 *   status-update      -> "<callId>:status:<status>"   (incl. "ended": deliberately NOT the report's key)
 *   transcript         -> "<callId>:transcript:<role>:<final|partial>:<sha-free text length+prefix>"
 *   tool-calls         -> "<callId>:tools:<sorted toolCallIds>"
 */
export function mapVapiMessage(message: Record<string, unknown> & { type: string }): VoiceEvent | { type: "ignored"; provider: "vapi"; providerType: string } {
  const call = rec(message.call);
  const callId = str(call.id);
  const base = { provider: "vapi" as const, providerCallId: callId, raw: message };
  const at = (v: unknown) => str(v);
  const cid = callId ?? "no-call-id";

  switch (message.type) {
    case "status-update": {
      const status = str(message.status) ?? "unknown";
      if (status === "in-progress" || status === "ringing" || status === "queued") {
        const t = str(call.type) ?? "";
        const direction = t.startsWith("inbound") ? "inbound" : t.startsWith("outbound") ? "outbound" : "unknown";
        return { ...base, type: "call.started", direction, dedupeKey: `${cid}:status:${status}`, occurredAt: at(call.startedAt) };
      }
      if (status === "ended") {
        return {
          // Distinct from the end-of-call-report key ON PURPOSE: this thin event carries no transcript/summary, so
          // it must never "claim" the logical event and cause the rich report to be discarded as a duplicate.
          ...base, type: "call.ended", dedupeKey: `${cid}:status:ended`, occurredAt: at(call.endedAt),
          endedReason: str(message.endedReason) ?? str(call.endedReason),
          providerFailure: isVapiProviderFailure(str(message.endedReason) ?? str(call.endedReason)),
          durationSeconds: durationFrom(message, call), transcript: null, summary: null, recordingUrl: null,
        };
      }
      return { type: "ignored", provider: "vapi", providerType: `status-update:${status}` };
    }
    case "end-of-call-report": {
      const artifact = rec(message.artifact);
      const analysis = rec(message.analysis);
      const reason = str(message.endedReason);
      return {
        ...base, type: "call.ended", dedupeKey: `${cid}:ended`, occurredAt: at(call.endedAt),
        endedReason: reason, providerFailure: isVapiProviderFailure(reason),
        durationSeconds: durationFrom(message, call),
        transcript: str(artifact.transcript) ?? str(message.transcript),
        summary: str(analysis.summary) ?? str(message.summary),
        recordingUrl: str(artifact.recordingUrl) ?? str(message.recordingUrl),
      };
    }
    case "transcript": {
      const role = message.role === "assistant" || message.role === "user" ? message.role : "unknown";
      const text = str(message.transcript) ?? "";
      const final = message.transcriptType === "final";
      return {
        ...base, type: "call.transcript", role, text, final, occurredAt: null,
        dedupeKey: `${cid}:transcript:${role}:${final ? "final" : "partial"}:${text.length}:${text.slice(0, 24)}`,
      };
    }
    case "tool-calls": {
      const list = (Array.isArray(message.toolCalls) ? message.toolCalls : Array.isArray(message.toolCallList) ? message.toolCallList : []) as unknown[];
      const toolCalls: NormalizedToolCall[] = list.map((t, i) => {
        const o = rec(t);
        const fn = rec(o.function);
        return { id: str(o.id) ?? str(o.toolCallId) ?? `idx-${i}`, name: str(fn.name) ?? "", args: parseArgs(fn.arguments) };
      });
      return {
        ...base, type: "call.tool_call", toolCalls, occurredAt: null,
        dedupeKey: `${cid}:tools:${toolCalls.map((t) => t.id).sort().join(",")}`,
      };
    }
    default:
      return { type: "ignored", provider: "vapi", providerType: message.type };
  }
}

export class VapiProvider implements VoiceProvider {
  readonly id = "vapi" as const;
  private readonly apiKey: string | null | undefined;
  private readonly webhookSecret: string | null | undefined;
  private readonly fetchImpl?: FetchLike;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly engine: VapiEngine;

  constructor(opts: VapiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.webhookSecret = opts.webhookSecret;
    this.fetchImpl = opts.fetchImpl;
    this.base = opts.baseUrl ?? VAPI_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.engine = new VapiEngine({ apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
  }

  isReady(): boolean {
    return !!this.apiKey;
  }

  private f(): FetchLike {
    return this.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async call(op: string, path: string, init: RequestInit): Promise<ProviderResult<unknown>> {
    if (!this.apiKey) return notConfigured("vapi");
    try {
      const res = await this.f()(`${this.base}${path}`, { ...init, headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return errResult(errorFromStatus(res.status, "vapi", op));
      return okResult(await res.json().catch(() => ({})));
    } catch (e) {
      return errResult(errorFromThrown(e, "vapi", op));
    }
  }

  async createAssistant(_ctx: CallContext, spec: AssistantSpec): Promise<ProviderResult<AssistantRef>> {
    const r = await this.call("createAssistant", "/assistant", { method: "POST", body: JSON.stringify({ name: spec.name, ...spec.config }) });
    if (!r.ok) return r;
    const id = str(rec(r.value).id);
    return id ? okResult({ assistantId: id }) : errResult({ kind: "invalid_payload", status: 0, message: "vapi: createAssistant returned no id", retryable: false });
  }

  async updateAssistant(_ctx: CallContext, assistantId: string, patch: Record<string, unknown>): Promise<ProviderResult<AssistantRef>> {
    const r = await this.call("updateAssistant", `/assistant/${encodeURIComponent(assistantId)}`, { method: "PATCH", body: JSON.stringify(patch) });
    return r.ok ? okResult({ assistantId }) : r;
  }

  async startOutboundCall(_ctx: CallContext, input: StartOutboundCallInput): Promise<ProviderResult<CallRef>> {
    if (!this.apiKey) return notConfigured("vapi");
    try {
      const r = await this.engine.startCall({
        ownerId: _ctx.tenantId, assistantId: input.assistantId, phoneNumberId: input.phoneNumberId,
        customerNumber: input.customerNumber, variableValues: input.variableValues,
      });
      if (!r.ok) return errResult(errorFromStatus(r.status, "vapi", "startOutboundCall"));
      if (!r.callId) return errResult({ kind: "invalid_payload", status: 0, message: "vapi: startOutboundCall returned no call id", retryable: false });
      return okResult({ callId: r.callId });
    } catch (e) {
      return errResult(errorFromThrown(e, "vapi", "startOutboundCall"));
    }
  }

  async endCall(_ctx: CallContext, callId: string): Promise<ProviderResult<void>> {
    const lookup = await this.call("endCall.lookup", `/call/${encodeURIComponent(callId)}`, { method: "GET" });
    if (!lookup.ok) return lookup;
    const controlUrl = str(rec(rec(lookup.value).monitor).controlUrl);
    if (!controlUrl) return errResult({ kind: "not_found", status: 0, message: "vapi: call has no live control channel", retryable: false });
    let url: URL;
    try {
      url = new URL(controlUrl);
    } catch {
      return errResult({ kind: "invalid_payload", status: 0, message: "vapi: unparseable control URL", retryable: false });
    }
    // Same guard as live-call-control: only ever POST to Vapi's own control host.
    if (url.protocol !== "https:" || !url.hostname.endsWith(".vapi.ai")) {
      return errResult({ kind: "invalid_payload", status: 0, message: "vapi: unexpected control URL host", retryable: false });
    }
    try {
      const res = await this.f()(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "end-call" }), signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok ? okResult(undefined) : errResult(errorFromStatus(res.status, "vapi", "endCall"));
    } catch (e) {
      return errResult(errorFromThrown(e, "vapi", "endCall"));
    }
  }

  async fetchCall(_ctx: CallContext, callId: string): Promise<ProviderResult<CallSnapshot>> {
    const r = await this.call("fetchCall", `/call/${encodeURIComponent(callId)}`, { method: "GET" });
    if (!r.ok) return r;
    const c = rec(r.value);
    const artifact = rec(c.artifact);
    const analysis = rec(c.analysis);
    const status = c.status === "ended" || c.endedAt ? "ended" : c.status === "ringing" ? "ringing" : c.status === "queued" ? "queued" : c.status ? "in_progress" : "unknown";
    return okResult({
      callId: str(c.id) ?? callId, status, endedReason: str(c.endedReason),
      startedAt: str(c.startedAt), endedAt: str(c.endedAt), durationSeconds: durationFrom({}, c),
      transcript: str(artifact.transcript) ?? str(c.transcript), summary: str(analysis.summary) ?? str(c.summary), raw: c,
    });
  }

  async listPhoneNumbers(_ctx: CallContext): Promise<ProviderResult<PhoneNumberInfo[]>> {
    const r = await this.call("listPhoneNumbers", "/phone-number", { method: "GET" });
    if (!r.ok) return r;
    const rows = Array.isArray(r.value) ? r.value : [];
    return okResult(rows.map((x) => rec(x)).filter((x) => str(x.id)).map((x) => ({ id: String(x.id), number: str(x.number), assistantId: str(x.assistantId) })));
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const p = parseVapiBody(rawBody);
    if (!p.ok) return p;
    return { ok: true, event: mapVapiMessage(p.message) };
  }

  verifyWebhookSignature(req: WebhookRequestMeta): boolean {
    return verifyVapiSecret(req.headers["x-vapi-secret"], this.webhookSecret);
  }
}
