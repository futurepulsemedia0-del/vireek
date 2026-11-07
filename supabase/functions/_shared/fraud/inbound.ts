// supabase/functions/_shared/fraud/inbound.ts
//
// Free-plan inbound minute hard stop. Called by vapi-webhook's assistant-request handler BEFORE the AI connects
// (the same place the suspended-account stop lives). Paid accounts are never blocked here (overage is billed).
//
// When a free account has used up its minutes the caller is NOT dropped if the owner has a valid domestic
// forwarding number: the call is forwarded there (emergency lane, domestic only). Otherwise the caller hears a
// short message. Fail-open on infrastructure errors: inbound answering must never break because the fraud store did.

import { guardOutbound, type FraudDb } from "./guard.ts";

export interface InboundAllowance {
  allowed: boolean;
  free: boolean;
  used?: number;
  included?: number;
  mode?: "monthly" | "lifetime";
}

export function parseAllowance(data: unknown): InboundAllowance {
  if (data && typeof data === "object" && typeof (data as { allowed?: unknown }).allowed === "boolean") {
    return data as InboundAllowance;
  }
  return { allowed: true, free: false }; // unknown shape => fail open
}

export async function checkInboundAllowance(db: FraudDb, userId: string): Promise<InboundAllowance> {
  try {
    const { data, error } = await db.rpc("fraud_inbound_allowance", { p_user: userId });
    if (error) return { allowed: true, free: false };
    return parseAllowance(data);
  } catch {
    return { allowed: true, free: false };
  }
}

export type ExhaustedResponse =
  | { destination: { type: "number"; number: string; message: string } }
  | { error: string };

/** What assistant-request should return when the free minutes are exhausted. */
export async function exhaustedResponse(db: FraudDb, userId: string, forwardingNumber: string | null): Promise<ExhaustedResponse> {
  if (forwardingNumber) {
    const g = await guardOutbound(db, { userId, kind: "call", to: forwardingNumber, purpose: "emergency", source: "inbound-free-exhausted" });
    if (g.ok && g.e164) {
      return { destination: { type: "number", number: g.e164, message: "Connecting you with the business now." } };
    }
  }
  return { error: "This business's free answering minutes have been used. Please call back later or contact them directly." };
}
