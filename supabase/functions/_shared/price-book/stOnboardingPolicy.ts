// supabase/functions/_shared/price-book/stOnboardingPolicy.ts
//

export const ST_FLAG_KEY = "servicetitan_app_key_onboarding";
export const ST_PENDING_CODE = "servicetitan_certified_pending";
// TODO(owner): approve the customer-facing wording (for example whether to say a certified connection is coming).
export const ST_PENDING_MESSAGE =
  "New ServiceTitan connections are not available right now. Vireek does not collect ServiceTitan App Keys for new accounts.";
export type StBlockReason = "flag_off" | "new_signup";

export type StConnectDecision =
  | { allow: true; reason: "flag" | "grandfathered" }
  | { allow: false; code: typeof ST_PENDING_CODE; reason: StBlockReason; message: string };

export interface StConnectInput {
  /** flag_evaluate(ST_FLAG_KEY, accountOwnerId) */
  flagOn: boolean;
  /** price_book_connections.status for provider service_titan, if a row exists */
  existingStatus: string | null | undefined;
  /** account existed when the default-ON migration ran (table servicetitan_app_key_legacy_tenants) */
  legacyTenant: boolean;
  /** staff set feature_flag_overrides.state = 'on' for this account */
  explicitOn: boolean;
}

export function isLiveStConnection(status: string | null | undefined): boolean {
  return status === "connected" || status === "error";
}

export function decideServiceTitanConnect(input: StConnectInput): StConnectDecision {
  if (isLiveStConnection(input.existingStatus)) return { allow: true, reason: "grandfathered" };
  if (input.flagOn !== true) return { allow: false, code: ST_PENDING_CODE, reason: "flag_off", message: ST_PENDING_MESSAGE };
  if (input.legacyTenant === true || input.explicitOn === true) return { allow: true, reason: "flag" };
  return { allow: false, code: ST_PENDING_CODE, reason: "new_signup", message: ST_PENDING_MESSAGE };
}
