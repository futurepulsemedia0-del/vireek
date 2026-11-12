import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { featureBlocked, usePlanEntitlements } from '@/hooks/usePlanEntitlements';
import { FEATURE_MIN_PLAN, featureLabel, PLAN_LABELS, type FeatureKey } from '@/lib/planLimits';

/**
 * Wrap a route element whose feature is plan-gated:
 *   <ProtectedRoute><PlanFeatureGate feature="dispatchBoard"><DispatchBoardPage /></PlanFeatureGate></ProtectedRoute>
 * Blocks only when plan_enforcement_config.features_mode = 'enforce'. Convenience layer: the data layer must also check.
 */
export function PlanFeatureGate({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const plan = usePlanEntitlements();
  const navigate = useNavigate();
  if (!featureBlocked(plan, feature)) return <>{children}</>;
  return (
    <div role="status" className="mx-auto flex min-h-[40vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <Lock size={28} className="text-accent" aria-hidden="true" />
      <h1 className="text-lg font-bold text-text-primary">{featureLabel(feature)} is not in your plan</h1>
      <p className="text-sm text-text-secondary">Available on {PLAN_LABELS[FEATURE_MIN_PLAN[feature]]} and above.</p>
      <button type="button" onClick={() => navigate('/dashboard/billing')} className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">View plans</button>
    </div>
  );
}
