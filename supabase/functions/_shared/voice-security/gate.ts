// supabase/functions/_shared/voice-security/gate.ts
//
// THE choke point: guardToolCall() runs before every voice tool handler. The model never decides authorization -
// this function does, from server-side state (verification, rate counters, kill switch, anomaly score).
//
// Failure model: if the security backend is unreachable, every tool above "safety" FAILS CLOSED (a security
// outage must not become an open door); safety tools (emergency, human transfer) FAIL OPEN (a security outage
// must never stop someone reaching help).

import { scoreCall, type CallSignals } from "./anomaly.ts";
import { CANARY_TOKEN_RE, filterToolResult, type FilterOptions, type InjectionScanner } from "./outputFilter.ts";
import { computeLevel } from "./stepUp.ts";
import {
  getToolSpec, levelAtLeast, samePhone, sanitizeArgs, SPOKEN, stricterMode, tierAllowedInMode, type ToolSpec,
} from "./toolPolicy.ts";
import type { AuditRecord, CallRef, CallSecurityState, SecurityMode, Severity, VerificationLevel } from "./types.ts";

export interface StateDelta {
  counters?: Record<string, number>;
  risk?: number;
  restricted?: boolean;
  locked?: boolean;
}

export type PendingResult = "ok" | "missing" | "expired" | "too_soon" | "mismatch";

/** Everything the gate needs from the outside world. Implemented over Supabase RPCs in ports.ts, and in memory for tests. */
export interface VoiceSecurityPorts {
  nowMs(): number;
  getMode(tenantId: string): Promise<SecurityMode>;
  getCallState(tenantId: string, call: CallRef): Promise<CallSecurityState>;
  bumpCallState(tenantId: string, call: CallRef, delta: StateDelta): Promise<void>;
  /** Atomic fixed-window counter. Resolves true while the caller is within `limit`. */
  rateConsume(tenantId: string, key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** HMAC-SHA256 hex with a server secret. Used for caller hashes and parameter hashes (no raw numbers in keys). */
  hmac(message: string): Promise<string>;
  /** Append to the immutable audit trail; high/critical records must also raise an alert. Must not throw on its own failure. */
  audit(tenantId: string, rec: AuditRecord): Promise<void>;
  scanInjection: InjectionScanner;
  /** True when any value is a registered decoy (canary) identifier for this tenant. */
  isCanary(tenantId: string, values: readonly string[]): Promise<boolean>;
  pendingCreate(tenantId: string, callId: string, tool: string, paramsHash: string, summary: string, ttlSeconds: number): Promise<string>;
  pendingConsume(tenantId: string, callId: string, tool: string, paramsHash: string, id: string, minAgeMs: number): Promise<PendingResult>;
}

export interface GateInput {
  tenantId: string;
  tool: string;
  rawArgs: Record<string, unknown>;
  call: CallRef;
}

export type GateResult =
  | { allow: false; code: string; spoken: string }
  | { allow: true; args: Record<string, unknown>; level: VerificationLevel; minimal: boolean; spec: ToolSpec; filter: FilterOptions };

export const CONFIRM_MIN_AGE_MS = 2_000;
export const CONFIRM_TTL_SECONDS = 180;
const INJECTION_BLOCK_SCORE = 45;
const INJECTION_SIGNAL_SCORE = 25;
const TENANT_BURST_PER_MINUTE = 300;
const VERIFY_TOOLS = new Set(["request_verification", "verify_caller"]);

const deny = (code: string, spoken: string): GateResult => ({ allow: false, code, spoken });

function flattenStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) flattenStrings(x, out);
  return out;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function guardToolCall(p: VoiceSecurityPorts, input: GateInput): Promise<GateResult> {
  const spec = getToolSpec(input.tool);
  try {
    return await evaluate(p, input, spec);
  } catch (err) {
    console.error(JSON.stringify({ event: "voice_gate_error", tool: input.tool.slice(0, 40), error: err instanceof Error ? err.message : String(err) }));
    if (spec?.tier === "safety") {
      const { args } = sanitizeArgs(spec.args, input.rawArgs, p.nowMs());
      return { allow: true, args, level: "none", minimal: true, spec, filter: { level: "none", allowPhones: [input.call.callerNumber] } };
    }
    return deny("security_unavailable", SPOKEN.unavailable);
  }
}

async function evaluate(p: VoiceSecurityPorts, input: GateInput, spec: ToolSpec | null): Promise<GateResult> {
  const { tenantId, call } = input;
  const now = p.nowMs();
  const state = await p.getCallState(tenantId, call);
  const local: Record<string, number> = { ...state.counters };

  /** Records a signal, re-scores the call and applies restrict / lock. Never throws into the caller path. */
  const signal = async (key: keyof CallSignals, rec: AuditRecord | null, extraRisk = 0) => {
    local[key] = (local[key] ?? 0) + 1;
    const verdict = scoreCall(local as Partial<CallSignals>);
    const delta: StateDelta = { counters: { [key]: 1 }, risk: Math.max(verdict.score, extraRisk) };
    if (verdict.action === "restrict" && !state.restricted) delta.restricted = true;
    if (verdict.action === "lock" && !state.locked) delta.locked = true;
    await p.bumpCallState(tenantId, call, delta);
    if (rec) await p.audit(tenantId, rec);
    if (delta.locked || delta.restricted) {
      await p.audit(tenantId, { kind: "call_risk_escalated", severity: delta.locked ? "critical" : "high", callId: call.callId, tool: input.tool.slice(0, 40), decision: "info", code: delta.locked ? "call_locked" : "call_restricted", detail: { score: verdict.score } });
    }
  };
  const rec = (kind: string, severity: Severity, decision: AuditRecord["decision"], code: string, detail?: AuditRecord["detail"]): AuditRecord =>
    ({ kind, severity, callId: call.callId, tool: input.tool.slice(0, 40), decision, code, detail });

  if (!spec) {
    await signal("unknown_tool", rec("tool_denied", "medium", "deny", "unknown_tool"));
    return deny("unknown_tool", SPOKEN.deny);
  }
  if (spec.tier === "voice_never") {
    await signal("unknown_tool", rec("tool_denied", "high", "deny", "voice_never"), 40);
    return deny("voice_never", SPOKEN.voiceNever);
  }
  if (!spec.kinds.includes(call.kind)) {
    await signal("denied", rec("tool_denied", "low", "deny", "kind_not_allowed", { kind: call.kind }));
    return deny("kind_not_allowed", SPOKEN.deny);
  }

  // ---- kill switch / call restriction -------------------------------------------------------
  let mode: SecurityMode = await p.getMode(tenantId);
  if (state.restricted) mode = stricterMode(mode, "restricted");
  if (state.locked) mode = stricterMode(mode, "lockdown");
  if (!tierAllowedInMode(spec.tier, mode)) {
    await p.audit(tenantId, rec("tool_denied", "low", "deny", `mode_${mode}`));
    return deny(`mode_${mode}`, state.locked && VERIFY_TOOLS.has(input.tool) ? SPOKEN.locked : SPOKEN.deny);
  }

  // ---- argument allowlist ---------------------------------------------------------------------
  const { args, dropped, invalid } = sanitizeArgs(spec.args, input.rawArgs, now);
  if (dropped.length) await signal("dropped_args", null);
  void invalid; // invalid values are simply absent: handlers already ask the caller again

  // ---- spoken / stored injection in arguments -------------------------------------------------
  const texts = flattenStrings(args);
  if (texts.length) {
    const scan = p.scanInjection(texts.join("\n"));
    if (scan.score >= INJECTION_BLOCK_SCORE) {
      await signal("injection", rec("tool_denied", "high", "deny", "injection_in_args", { score: scan.score, rules: scan.rules.join(",").slice(0, 120) }));
      return deny("injection_in_args", SPOKEN.injection);
    }
    if (scan.score >= INJECTION_SIGNAL_SCORE) await signal("injection", null);
    if (texts.some((t) => CANARY_TOKEN_RE.test(t))) {
      CANARY_TOKEN_RE.lastIndex = 0;
      await signal("canary", rec("canary_hit", "critical", "deny", "prompt_canary_in_args"), 100);
      return deny("canary", SPOKEN.deny);
    }
    CANARY_TOKEN_RE.lastIndex = 0;
  }
  const identifiers = [args.phone, args.adjuster_phone, args.email, args.name, args.customer_name, args.address].filter((x): x is string => typeof x === "string");
  if (identifiers.length && (await p.isCanary(tenantId, identifiers))) {
    await signal("canary", rec("canary_hit", "critical", "deny", "decoy_identifier_requested"), 100);
    return deny("canary", SPOKEN.deny);
  }

  // ---- caller binding: tools about "this customer" act on the CALLER'S number only -------------
  if (spec.bindCaller) {
    if (!call.callerNumber) {
      await signal("denied", rec("tool_denied", "low", "deny", "no_caller_id"));
      return deny("no_caller_id", SPOKEN.deny);
    }
    if (typeof args.phone === "string" && !samePhone(args.phone, call.callerNumber)) {
      await signal("cross_customer", rec("cross_customer_attempt", "high", "deny", "phone_not_caller"), 40);
      return deny("cross_customer", SPOKEN.deny);
    }
    if ("phone" in spec.args) args.phone = call.callerNumber;
  }

  // ---- identity level ---------------------------------------------------------------------------
  const level = computeLevel(state, call.callerNumber, now);
  let minimal = false;
  if (!levelAtLeast(level, spec.min)) {
    if (spec.below === "deny") {
      const needs = level === "none" ? "no_caller_id" : "needs_step_up";
      await p.audit(tenantId, rec("verification_required", "info", "challenge", needs));
      return deny(needs, level === "none" ? SPOKEN.deny : SPOKEN.needsVerification);
    }
    minimal = spec.min !== "none";
  }

  // ---- rate limits (per call, per caller, per tenant). Evaluated AFTER identity so a refused unverified attempt
  //      does not eat the legitimate caller's budget. Safety tools are never rate-blocked. ------
  const callerHash = call.callerNumber ? await p.hmac(`caller|${call.callerNumber.replace(/\D/g, "").slice(-10)}`) : "anon";
  if (spec.tier !== "safety") {
    const checks: [string, number, number][] = [
      [`c:${call.callId ?? "nocall"}:${input.tool}`, spec.perCall, 4 * 3600],
      [`n:${callerHash}:${input.tool}`, spec.perCallerDay, 86_400],
      [`t:tool`, TENANT_BURST_PER_MINUTE, 60],
    ];
    for (const [key, limit, windowSeconds] of checks) {
      if (!(await p.rateConsume(tenantId, key, limit, windowSeconds))) {
        await signal(input.tool === "lookup_price" ? "price_probe" : "rate_limited", rec("tool_denied", "medium", "deny", "rate_limited", { scope: key.split(":")[0] }));
        return deny("rate_limited", SPOKEN.rateLimited);
      }
    }
  }
  if (typeof args.phone === "string" && call.callerNumber && !samePhone(args.phone, call.callerNumber) && !spec.bindCaller) {
    // booking / claim for a DIFFERENT callback number is legitimate once or twice; many numbers = spam / SMS harassment
    const n = await p.rateConsume(tenantId, `c:${call.callId ?? "nocall"}:distinct_phone:${await p.hmac(`ph|${args.phone}`)}`, 1, 4 * 3600);
    if (n) await signal("multi_phone", null);
  }

  // ---- confirm-before-write ----------------------------------------------------------------------
  if (spec.confirm) {
    const callId = call.callId ?? "nocall";
    const { confirmation_id: confirmationId, ...material } = args;
    const paramsHash = await p.hmac(`params|${input.tool}|${canonical(material)}`);
    if (typeof confirmationId !== "string") {
      const summary = `${input.tool}: ${Object.keys(material).sort().join(", ") || "no parameters"}`;
      const id = await p.pendingCreate(tenantId, callId, input.tool, paramsHash, summary, CONFIRM_TTL_SECONDS);
      await p.audit(tenantId, rec("confirmation_requested", "info", "challenge", "confirmation_required"));
      return deny("confirmation_required", `Nothing has been changed yet. Read the exact details back to the caller and ask them to confirm. Only if they clearly say yes, call ${input.tool} again with exactly the same details and confirmation_id=${id}.`);
    }
    const outcome = await p.pendingConsume(tenantId, callId, input.tool, paramsHash, confirmationId, CONFIRM_MIN_AGE_MS);
    if (outcome !== "ok") {
      await signal("denied", rec("tool_denied", "medium", "deny", `confirmation_${outcome}`));
      return deny(`confirmation_${outcome}`, outcome === "too_soon" ? "Wait for the caller's spoken answer before confirming. Ask them to confirm the details first." : SPOKEN.deny);
    }
    delete args.confirmation_id;
  }

  if (spec.tier === "sensitive_read" || spec.tier === "record_write" || spec.tier === "money") {
    await p.audit(tenantId, rec("tool_allowed", "info", minimal ? "minimal" : "allow", minimal ? "minimal_unverified" : "ok", { level }));
  }
  return {
    allow: true, args, level, minimal, spec,
    filter: { level, allowPhones: [call.callerNumber], sensitiveTool: spec.tier === "sensitive_read", canaries: [] },
  };
}

/** Run on every handler result before it is returned to the model. A canary in a result is a critical leak signal. */
export async function finalizeToolResult(p: VoiceSecurityPorts, input: GateInput, g: Extract<GateResult, { allow: true }>, text: string, extra?: { allowEmails?: string[]; canaries?: string[] }): Promise<string> {
  const f = filterToolResult(text, { ...g.filter, allowEmails: extra?.allowEmails, canaries: extra?.canaries });
  const canary = f.findings.find((x) => x.kind === "canary");
  const secret = f.findings.find((x) => x.kind === "secret");
  if (canary || secret) {
    try {
      await p.bumpCallState(input.tenantId, input.call, { counters: { canary: 1 }, risk: 100, locked: Boolean(canary) });
      await p.audit(input.tenantId, { kind: canary ? "canary_hit" : "secret_in_tool_result", severity: "critical", callId: input.call.callId, tool: input.tool.slice(0, 40), decision: "info", code: canary ? "canary_in_tool_result" : "secret_in_tool_result" });
    } catch { /* the filtered text is still returned */ }
  } else if (f.findings.length) {
    try {
      await p.audit(input.tenantId, { kind: "tool_result_filtered", severity: "low", callId: input.call.callId, tool: input.tool.slice(0, 40), decision: "info", code: "pii_filtered", detail: { kinds: f.findings.map((x) => x.kind).join(",").slice(0, 100) } });
    } catch { /* best effort */ }
  }
  return f.text;
}
