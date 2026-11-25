// supabase/functions/_shared/licensing/gate.ts
//
// Server-side licensing gate for lending / BNPL / escrow / money-movement capabilities.
// Source of truth: public.licensing_gate (see 20290312000000_licensing_gate.sql).
// FAIL CLOSED: an unreadable gate, an RPC error or an unexpected payload all mean "not allowed".
//
// Any new edge function that creates a loan offer, holds funds in escrow or moves money for a
// third party MUST call requireLicensingGate() before doing anything with side effects.

export const LICENSING_CAPABILITIES = [
  "bnpl_legacy",
  "financing_partners",
  "pay_instant_payouts",
  "pay_earned_wage_access",
  "pay_spend_cards",
  "pay_capital",
  "escrow",
] as const;
export type LicensingCapability = (typeof LICENSING_CAPABILITIES)[number];

export interface LicensingDecision {
  allowed: boolean;
  /** null when allowed. Otherwise: licensing_not_confirmed | killed | unknown_capability | gate_unreadable. */
  reason: string | null;
}

/** Minimal client shape so this module has no SDK dependency (and is testable under node). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Pure: only an explicit `allowed: true` opens the gate. */
export function parseLicensingDecision(data: unknown): LicensingDecision {
  if (typeof data !== "object" || data === null) return { allowed: false, reason: "gate_unreadable" };
  const d = data as Record<string, unknown>;
  if (d.allowed === true) return { allowed: true, reason: null };
  return { allowed: false, reason: typeof d.reason === "string" && d.reason ? d.reason : "licensing_not_confirmed" };
}

export async function checkLicensingGate(db: RpcClient, capability: LicensingCapability): Promise<LicensingDecision> {
  if (!(LICENSING_CAPABILITIES as readonly string[]).includes(capability)) return { allowed: false, reason: "unknown_capability" };
  try {
    const { data, error } = await db.rpc("licensing_gate_state", { p_capability: capability });
    if (error) return { allowed: false, reason: "gate_unreadable" };
    return parseLicensingDecision(data);
  } catch {
    return { allowed: false, reason: "gate_unreadable" };
  }
}

/** Returns a 403 Response when the gate is closed, or null when the caller may continue. */
export async function requireLicensingGate(
  db: RpcClient,
  capability: LicensingCapability,
  headers: Record<string, string>,
): Promise<Response | null> {
  const decision = await checkLicensingGate(db, capability);
  if (decision.allowed) return null;
  console.warn(JSON.stringify({ event: "licensing_gate_closed", capability, reason: decision.reason }));
  return new Response(
    JSON.stringify({ error: "licensing_not_confirmed", reason: decision.reason, message: "This feature isn't available yet." }),
    { status: 403, headers: { ...headers, "Content-Type": "application/json" } },
  );
}
