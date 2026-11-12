// supabase/functions/_shared/usage-alerts/notifyLimitReached.ts
// Shared helper for the entitlements work: tell the account owner a seat/location/phone-number limit was hit.
// At most once per (owner, UTC month, kind). In-app + email only (no SMS/push for limits).

import { buildLimitAlert, type AlertAccount } from "./copy.ts";
import { usagePeriodKey, type LimitKind } from "./core.ts";
import { deliverAlert, type AlertPorts, type DeliveryResult } from "./dispatch.ts";

export type LimitOwner = Pick<AlertAccount, "id" | "email" | "plan">;

export async function notifyLimitReached(
  ports: AlertPorts,
  owner: LimitOwner,
  kind: LimitKind,
  current: number,
  limit: number,
  opts: { now?: Date; siteUrl: string },
): Promise<DeliveryResult> {
  const periodKey = usagePeriodKey(opts.now ?? new Date());
  const acct: AlertAccount = {
    id: owner.id, email: owner.email, plan: owner.plan,
    full_name: null, company_name: null, phone: null, minutes_used_this_month: null, minutes_included: null,
  };
  return deliverAlert(ports, acct, kind, buildLimitAlert(kind, acct, current, limit, periodKey), { periodKey, siteUrl: opts.siteUrl });
}
