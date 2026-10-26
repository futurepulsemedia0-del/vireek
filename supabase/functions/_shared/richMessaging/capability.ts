// supabase/functions/_shared/richMessaging/capability.ts
//
// Per-recipient capability detection + channel routing. Pure module.
//
//   RCS  - capability is looked up per phone number (aggregator capability query, cached).
//   AMB  - Apple lets ONLY the customer start a conversation, and identifies them with an
//          opaque id, not a phone. So "capable" == "an active Apple Messages thread exists".

import type { CapabilityRecord, CapabilityStatus, ProviderStatus, RichAccount, RichChannel, RichConversationRef } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** How long a capability answer is trusted. Failures invalidate the cache sooner (see send.ts). */
export const CAPABILITY_TTL_MS: Record<CapabilityStatus, number> = {
  capable: 72 * HOUR,
  not_capable: 12 * HOUR,
  unknown: 15 * MIN,
};

export function expiryFor(status: CapabilityStatus, now: Date): string {
  return new Date(now.getTime() + CAPABILITY_TTL_MS[status]).toISOString();
}

export function isFresh(rec: CapabilityRecord | null, now: Date): rec is CapabilityRecord {
  return !!rec && new Date(rec.expiresAt).getTime() > now.getTime();
}

export type RouteReason =
  | "amb_thread"
  | "rcs_capable"
  | "rcs_unknown_attempt"
  | "rcs_not_capable"
  | "rcs_unknown_sms"
  | "rcs_unavailable"
  | "amb_unavailable";

export interface RouteDecision {
  route: RichChannel | "sms";
  reason: RouteReason;
  /** Arm automatic SMS fallback for this send. */
  armFallback: boolean;
  /** Fire a capability query so the cache is warm for next time. */
  probe: boolean;
}

export interface RouteInput {
  account: RichAccount | null;
  /** Existing rich thread when replying inside one. */
  conversation: RichConversationRef | null;
  phone: string | null;
  capability: CapabilityRecord | null;
  now: Date;
}

const approved = (s: ProviderStatus) => s === "approved";

export function rcsUsable(a: RichAccount | null): a is RichAccount {
  return !!a && a.rcsEnabled && approved(a.rcsStatus) && !!a.providerAppId;
}

export function ambUsable(a: RichAccount | null): a is RichAccount {
  return !!a && a.ambEnabled && approved(a.ambStatus) && !!a.providerAppId;
}

export function pickRoute(i: RouteInput): RouteDecision {
  const { account, conversation: conv, phone, now } = i;
  const canFallback = !!account?.fallbackToSms && !!(phone ?? conv?.phone);

  // Replying inside an Apple Messages thread: the ONLY way to reach this customer on Apple.
  if (conv?.channel === "amb") {
    if (ambUsable(account) && !conv.customerClosedAt) {
      return { route: "amb", reason: "amb_thread", armFallback: canFallback, probe: false };
    }
    return { route: "sms", reason: "amb_unavailable", armFallback: false, probe: false };
  }

  if (!rcsUsable(account)) return { route: "sms", reason: "rcs_unavailable", armFallback: false, probe: false };

  const fresh = isFresh(i.capability, now);
  const status: CapabilityStatus = fresh ? i.capability!.status : "unknown";
  const probe = !fresh;

  if (status === "capable") return { route: "rcs", reason: "rcs_capable", armFallback: canFallback, probe };
  if (status === "not_capable") return { route: "sms", reason: "rcs_not_capable", armFallback: false, probe };
  if (account.attemptOnUnknown) return { route: "rcs", reason: "rcs_unknown_attempt", armFallback: canFallback, probe };
  return { route: "sms", reason: "rcs_unknown_sms", armFallback: false, probe };
}
