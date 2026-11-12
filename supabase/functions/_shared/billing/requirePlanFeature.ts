// Edge-function guard for plan-gated features.
//   const denied = await requirePlanFeature(admin, ownerId, "accountingSync", corsHeaders);
//   if (denied) return denied;
// `ownerId` MUST be the account owner resolved from the verified JWT / DB row, never a request-body value.
// `admin` is a service-role client. Fails closed: if the check itself errors the call is refused (503).
import { featureDecision, isPlanTier, type FeatureKey, type PlanTier } from "./entitlements.ts";

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export async function requirePlanFeature(
  admin: RpcClient,
  ownerId: string,
  feature: FeatureKey,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  try {
    const [allowed, tier] = await Promise.all([
      admin.rpc("plan_feature_allowed", { p_owner: ownerId, p_feature: feature }),
      admin.rpc("plan_effective_tier", { p_owner: ownerId }),
    ]);
    if (allowed.error || typeof allowed.data !== "boolean") return respond(503, { error: { code: "PLAN_CHECK_UNAVAILABLE" } });
    if (allowed.data) return null;
    const t: PlanTier = isPlanTier(tier.data) ? tier.data : "free";
    return respond(402, { error: featureDecision(t, feature).error ?? { code: "PLAN_LIMIT", key: feature, limit: 0, current: 0, upgradeTo: null } });
  } catch {
    return respond(503, { error: { code: "PLAN_CHECK_UNAVAILABLE" } });
  }
}
