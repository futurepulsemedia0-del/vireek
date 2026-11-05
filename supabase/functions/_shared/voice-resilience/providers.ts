// Provider-agnostic ports for the call path + the pure selection policy (failover, per-org override,
// manual switch, canary switch-back). No I/O here; adapters live in adapters.ts.

import { allowRequest, type BreakerState } from "./circuitBreaker.ts";

/** "tools" is a health-only pseudo-capability (CRM/calendar/booking tool calls); it is never selectable as a provider. */
export type Capability = "voice_engine" | "carrier" | "asr" | "tts" | "sms" | "tools";

export interface PortHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface ProviderCallRef {
  providerCallId: string;
  /** Dialed (our) number, E.164 when known. */
  to: string | null;
  from: string | null;
  startedAt: string | null; // ISO
  endedAt: string | null;
  status: "in_progress" | "ended" | "unknown";
  durationSeconds: number | null;
}

interface PortBase {
  readonly id: string;
  healthCheck(): Promise<PortHealth>;
}

/** The AI conversation engine (today: Vapi). */
export interface VoiceEnginePort extends PortBase {
  readonly capability: "voice_engine";
  listCalls(q: { since: Date; until: Date; limit: number }): Promise<ProviderCallRef[]>;
  /** Raw provider call object, used to rebuild an end-of-call-report. */
  getCall(providerCallId: string): Promise<Record<string, unknown> | null>;
  transfer(providerCallId: string, toE164: string): Promise<void>;
}

/** The telephone carrier / SIP layer (today: Twilio). */
export interface CarrierPort extends PortBase {
  readonly capability: "carrier";
  listCalls(q: { since: Date; until: Date; limit: number }): Promise<ProviderCallRef[]>;
  placeCall(p: { to: string; from: string; twiml: string; timeoutSeconds?: number; statusCallback?: string }): Promise<{ callSid: string }>;
}

export interface AsrPort extends PortBase {
  readonly capability: "asr";
  transcribe(p: { audio: Uint8Array; mimeType: string; language?: string }): Promise<{ text: string; confidence: number | null }>;
}

export interface TtsPort extends PortBase {
  readonly capability: "tts";
  synthesize(p: { text: string; voice?: string; language?: string }): Promise<{ audio: Uint8Array; mimeType: string }>;
}

export interface SmsPort extends PortBase {
  readonly capability: "sms";
  send(p: { to: string; body: string; from?: string }): Promise<{ providerMessageId: string | null }>;
}

export type AnyPort = VoiceEnginePort | CarrierPort | AsrPort | TtsPort | SmsPort;

// ---------------------------------------------------------------------------------------------
// Selection policy
// ---------------------------------------------------------------------------------------------

export interface ProviderEntry {
  id: string;
  capability: Capability;
  /** Lower = preferred. */
  priority: number;
  enabled: boolean;
}

export interface ProviderHealthRow {
  providerId: string;
  capability: Capability;
  state: BreakerState;
  score: number;
}

export interface OrgOverride {
  capability: Capability;
  /** pin: use exactly this provider (even if unhealthy); prefer: put first when allowed; block: never use. */
  mode: "pin" | "prefer" | "block";
  providerId: string;
}

export interface PlatformSwitch {
  capability: Capability;
  forceProviderId: string;
  until: number; // epoch ms
}

export interface SelectInput {
  capability: Capability;
  /** Stable per call (call SID / vapi id): keeps canary membership consistent across retries. */
  callKey: string;
  now: number;
  providers: ProviderEntry[];
  health: ProviderHealthRow[];
  orgOverrides?: OrgOverride[];
  platformSwitch?: PlatformSwitch | null;
  canaryPercent?: number;
}

export interface Selection {
  providerId: string | null;
  reason: "org_pin" | "platform_switch" | "healthy_primary" | "failover" | "canary_switch_back" | "none_available";
  /** Ordered fallbacks to try if the chosen one fails at call time. */
  fallbacks: string[];
  usedCanary: boolean;
}

export function selectProvider(i: SelectInput): Selection {
  const canary = i.canaryPercent ?? 5;
  const mine = i.providers.filter((p) => p.capability === i.capability && p.enabled).sort((a, b) => a.priority - b.priority);
  const ov = (i.orgOverrides ?? []).filter((o) => o.capability === i.capability);
  const blocked = new Set(ov.filter((o) => o.mode === "block").map((o) => o.providerId));
  const stateOf = (id: string): BreakerState => i.health.find((h) => h.providerId === id && h.capability === i.capability)?.state ?? "closed";

  const pin = ov.find((o) => o.mode === "pin");
  if (pin && mine.some((p) => p.id === pin.providerId) && !blocked.has(pin.providerId)) {
    return { providerId: pin.providerId, reason: "org_pin", fallbacks: mine.map((p) => p.id).filter((id) => id !== pin.providerId && !blocked.has(id)), usedCanary: false };
  }

  const sw = i.platformSwitch;
  if (sw && sw.capability === i.capability && sw.until > i.now && mine.some((p) => p.id === sw.forceProviderId) && !blocked.has(sw.forceProviderId)) {
    return { providerId: sw.forceProviderId, reason: "platform_switch", fallbacks: mine.map((p) => p.id).filter((id) => id !== sw.forceProviderId && !blocked.has(id)), usedCanary: false };
  }

  const preferred = ov.filter((o) => o.mode === "prefer").map((o) => o.providerId);
  const ordered = [...mine].sort((a, b) => {
    const pa = preferred.includes(a.id) ? 0 : 1;
    const pb = preferred.includes(b.id) ? 0 : 1;
    return pa - pb || a.priority - b.priority;
  }).filter((p) => !blocked.has(p.id));

  const usable: { id: string; canary: boolean }[] = [];
  for (const p of ordered) {
    const st = stateOf(p.id);
    if (st === "closed") usable.push({ id: p.id, canary: false });
    else if (st === "half_open" && allowRequest("half_open", `${i.callKey}:${p.id}`, canary)) usable.push({ id: p.id, canary: true });
  }
  if (usable.length === 0) {
    // Everything open: last resort is the first non-blocked provider anyway (a failing try beats no try); caller falls to the ladder on failure.
    const any = ordered[0];
    return { providerId: any?.id ?? null, reason: any ? "failover" : "none_available", fallbacks: ordered.slice(1).map((p) => p.id), usedCanary: false };
  }
  const first = usable[0];
  const primaryId = ordered[0]?.id;
  const reason: Selection["reason"] = first.canary ? "canary_switch_back" : first.id === primaryId ? "healthy_primary" : "failover";
  return { providerId: first.id, reason, fallbacks: ordered.map((p) => p.id).filter((id) => id !== first.id), usedCanary: first.canary };
}
