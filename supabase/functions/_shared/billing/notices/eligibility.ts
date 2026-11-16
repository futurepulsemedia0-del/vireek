// supabase/functions/_shared/billing/notices/eligibility.ts
// Pure "who may receive this notice" rules.

export const NOTICEABLE_STATUSES: readonly string[] = ["active", "past_due", "trialing"];

export interface NoticeProfile {
  id: string;
  email: string | null;
  plan: string | null;
  status: string | null;
  subscription_status: string | null;
  created_at?: string | null;
}

export interface PriceNoticeScope {
  planId: string;
  noticeCreatedAt: string;
}

/** Affected accounts only: same plan, live subscription, existed before the notice, not grandfathered, not canceling. */
export function isEligibleForPriceNotice(
  p: NoticeProfile,
  scope: PriceNoticeScope,
  grandfathered: ReadonlySet<string>,
  subscriptionCanceling: boolean,
): boolean {
  if (!p.email || p.plan !== scope.planId) return false;
  if (!p.subscription_status || !NOTICEABLE_STATUSES.includes(p.subscription_status)) return false;
  if (p.status === "suspended") return false;
  if (grandfathered.has(p.id) || subscriptionCanceling) return false;
  if (p.created_at && Date.parse(p.created_at) > Date.parse(scope.noticeCreatedAt)) return false;
  return true;
}
