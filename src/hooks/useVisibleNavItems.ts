import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useEntitlements } from '@/hooks/useEntitlement';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { usePartsSourcingEnabled } from '@/hooks/usePartsSourcingEnabled';
import { usePestOpsAccess } from '@/hooks/usePestOpsAccess';
import { useLandscapingAccess } from '@/lib/landscapingApi';
import { ACCOUNT_ITEMS, PRIMARY_ITEMS, filterItems } from '@/components/DashboardNav';
import { audienceFor, groupByPillar } from '@/lib/surface/surface';

/**
 * Every menu entry the signed-in person may open, grouped by pillar, with NO simple-mode trimming and Labs included.
 * It applies exactly the same gates as the sidebar (it calls the sidebar's own `filterItems`, so permissions, owner-only,
 * feature flags, modules and entitlements cannot drift apart) plus the same audience rule (technicians keep their own
 * world). Used by the Navigation Center so that nothing the sidebar can ever show is unreachable from one place.
 */
export function useVisibleNavItems() {
  const { has: hasModule } = useEntitlements();
  const { isOwner, permissions } = useAuth();
  const { enabled: partsSourcingOn } = usePartsSourcingEnabled();
  const pestOps = usePestOpsAccess();
  const landscaping = useLandscapingAccess();
  const { isEnabled: isFlagOn } = useFeatureFlags();

  const partsOn = Boolean(partsSourcingOn);
  const pestOn = Boolean(pestOps.enabled);
  const landscapingOk = Boolean(landscaping.allowed);
  const canViewAllJobs = Boolean(permissions.can_view_all_jobs);

  return useMemo(() => {
    const enabledModules: ReadonlySet<string> = new Set([...(partsOn ? ['parts_sourcing'] : []), ...(pestOn ? ['pest_ops'] : [])]);
    const gates = { landscaping: landscapingOk };
    const items = [
      ...filterItems(PRIMARY_ITEMS, isOwner, permissions, gates, isFlagOn, enabledModules, hasModule),
      ...filterItems(ACCOUNT_ITEMS, isOwner, permissions, gates, isFlagOn, enabledModules, hasModule),
    ];
    const audience = audienceFor(isOwner, canViewAllJobs);
    const groups = groupByPillar(items, { audience, showLabs: true });
    return { groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
    // `permissions`, `isFlagOn` and `hasModule` are rebuilt by their providers when the underlying data changes.
  }, [isOwner, permissions, isFlagOn, hasModule, partsOn, pestOn, landscapingOk, canViewAllJobs]);
}
