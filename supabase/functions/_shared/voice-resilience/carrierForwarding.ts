// Carrier-level safety net: "forward on no-answer / unreachable" from the customer's OWN carrier to Vireek, and back.
// Codes below are dialed by the customer on the phone that owns the business number. They are a GUIDE, never proof:
// the only proof is the test-call wizard (evaluateForwardTest), which sees a real call arrive with ForwardedFrom.

export type CarrierFamily = "gsm_standard" | "verizon" | "landline_voip_pbx";
export type ForwardKind = "no_answer" | "unreachable" | "busy";

export const E164 = /^\+[1-9]\d{6,14}$/;

export interface ForwardCode {
  family: CarrierFamily;
  kind: ForwardKind;
  activate: string;
  cancel: string;
  status: string | null;
  /** How sure we are this dials correctly on that family. The wizard always requires the test call regardless. */
  confidence: "standard" | "commonly_documented" | "ask_carrier";
  note: string;
}

const clampRing = (s: number): number => Math.min(30, Math.max(5, Math.round(s / 5) * 5));

/**
 * Builds dial codes. `ringSeconds` applies to no_answer on GSM only. Recommended 20 s so forwarding fires BEFORE the
 * carrier's own voicemail (typically 25-30 s); the customer should also switch carrier voicemail off for this line.
 */
export function buildForwardCode(family: CarrierFamily, kind: ForwardKind, vireekNumber: string, ringSeconds = 20): ForwardCode | null {
  if (!E164.test(vireekNumber)) return null;
  const digits = vireekNumber; // keep the +; GSM networks accept international format
  if (family === "gsm_standard") {
    const base = { family, confidence: "standard" as const };
    if (kind === "no_answer")
      return { ...base, kind, activate: `**61*${digits}**${clampRing(ringSeconds)}#`, cancel: "##61#", status: "*#61#", note: "3GPP standard (AT&T, T-Mobile, most GSM/LTE/VoLTE). Ring delay is rounded to 5-30 s." };
    if (kind === "unreachable")
      return { ...base, kind, activate: `**62*${digits}#`, cancel: "##62#", status: "*#62#", note: "Fires when the phone is off, out of coverage or in airplane mode." };
    return { ...base, kind, activate: `**67*${digits}#`, cancel: "##67#", status: "*#67#", note: "Fires when the line is busy." };
  }
  if (family === "verizon") {
    // Verizon documents *71 (busy/no answer) and *73 (cancel). Marked commonly_documented: confirm with the carrier.
    if (kind === "no_answer" || kind === "busy")
      return { family, kind, activate: `*71${vireekNumber.replace(/^\+1/, "")}`, cancel: "*73", status: null, confidence: "commonly_documented", note: "Verizon combines busy and no-answer under one code and does not let you set the ring delay. Dial the 10-digit number." };
    return { family, kind, activate: "", cancel: "", status: null, confidence: "ask_carrier", note: "Ask Verizon to set 'unreachable' forwarding (or use the carrier account portal)." };
  }
  return { family, kind, activate: "", cancel: "", status: null, confidence: "ask_carrier", note: "Landlines, VoIP and PBX systems have no universal code. Set 'forward on no answer / when unreachable' in the provider portal or PBX admin; then run the test call." };
}

export function planFor(family: CarrierFamily, vireekNumber: string, ringSeconds = 20): ForwardCode[] {
  return (["no_answer", "unreachable", "busy"] as const).map((k) => buildForwardCode(family, k, vireekNumber, ringSeconds)).filter((c): c is ForwardCode => c !== null);
}

// ---------------------------------------------------------------------------------------------
// Test-call wizard: pure verification rules
// ---------------------------------------------------------------------------------------------

export type CheckKind = "forward_on" | "forward_off";
export type CheckStatus = "pending" | "passed" | "failed" | "answered_by_human" | "expired" | "error";

export interface ForwardCheck {
  id: string;
  kind: CheckKind;
  /** The customer's own business number we ring (E.164). */
  businessNumber: string;
  /** The Vireek number the carrier should forward to. */
  vireekNumber: string;
  /** The number our outbound test call came from (E.164). */
  probeFrom: string;
  startedAt: number;
  /** When we stop waiting (ring window + forward latency + margin). */
  expiresAt: number;
  /** Final status of the outbound test call as reported by the carrier, once known. */
  outboundStatus?: "ringing" | "in-progress" | "completed" | "no-answer" | "busy" | "failed" | "canceled" | null;
}

export interface InboundArrival {
  to: string;
  from: string;
  forwardedFrom?: string | null;
  at: number;
}

export const norm = (n: string | null | undefined): string => (n ?? "").replace(/[^\d+]/g, "");
const sameNumber = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.slice(-10) === y.slice(-10);
};

export function arrivalMatches(check: ForwardCheck, a: InboundArrival): boolean {
  if (a.at < check.startedAt || a.at > check.expiresAt) return false;
  if (!sameNumber(a.to, check.vireekNumber)) return false;
  // Strongest evidence: the carrier tells us which number it forwarded from. Fallback: caller ID is our probe.
  return sameNumber(a.forwardedFrom, check.businessNumber) || (!a.forwardedFrom && sameNumber(a.from, check.probeFrom));
}

export function evaluateForwardTest(check: ForwardCheck, arrivals: InboundArrival[], now: number): CheckStatus {
  if (check.outboundStatus === "failed") return "error";
  const matched = arrivals.some((a) => arrivalMatches(check, a));
  if (check.kind === "forward_on") {
    if (matched) return "passed";
    // A human picking up the business phone means no forward could happen: retry without answering.
    if (check.outboundStatus === "in-progress" || check.outboundStatus === "completed") return "answered_by_human";
    return now >= check.expiresAt ? "failed" : "pending";
  }
  // forward_off: after cancelling, the call must ring out on the customer's phone and NOT reach Vireek.
  if (matched) return "failed";
  if (now < check.expiresAt) return "pending";
  return check.outboundStatus === "no-answer" || check.outboundStatus === "completed" || check.outboundStatus === "busy" ? "passed" : "expired";
}

/** Window = ring delay + generous forwarding latency. */
export function expiryFor(startedAt: number, ringSeconds: number): number {
  return startedAt + (ringSeconds + 35) * 1000;
}
