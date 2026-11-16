// supabase/functions/_shared/price-book/stOnboardingPolicy.ts
//
// ServiceTitan "tunneling" policy: collecting a customer's own App Key / Client Secret is only allowed
//   (a) while the flag `servicetitan_app_key_onboarding` is ON for the tenant (default OFF), or
//   (b) for tenants that already have a live ServiceTitan connection (grandfathered: status connected | error).
// A tenant that disconnected is treated as new. Pure function so it can be unit-tested.

export const ST_FLAG_KEY = "servicetitan_app_key_onboarding";
export const ST_PENDING_CODE = "servicetitan_certified_pending";
export const ST_PENDING_MESSAGE =
  "ServiceTitan certified connection is coming soon. Vireek does not collect ServiceTitan App Keys for new connections.";

export type StConnectDecision =
  | { allow: true; reason: "flag" | "grandfathered" }
  | { allow: false; code: typeof ST_PENDING_CODE; message: string };

export function decideServiceTitanConnect(input: { flagOn: boolean; existingStatus: string | null | undefined }): StConnectDecision {
  if (input.existingStatus === "connected" || input.existingStatus === "error") return { allow: true, reason: "grandfathered" };
  if (input.flagOn === true) return { allow: true, reason: "flag" };
  return { allow: false, code: ST_PENDING_CODE, message: ST_PENDING_MESSAGE };
}
