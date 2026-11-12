import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { FeatureKey, PlanTier } from '@/lib/planLimits';

export interface PlanSnapshot {
  tier: PlanTier;
  /** 'shadow' = plan features are logged but not blocked yet; 'enforce' = blocked. */
  featuresMode: 'shadow' | 'enforce';
  recordingsEnabled: boolean;
  limits: Record<string, { limit: number | null; used: number | null }>;
  overLimit: string[];
  features: Record<string, boolean>;
}

export type PlanState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; plan: PlanSnapshot };

const TTL_MS = 60_000;
let cache: { uid: string; at: number; plan: PlanSnapshot } | null = null;

/** Plan snapshot for the signed-in account (team members get their owner's). UI convenience only: the server enforces. */
export function usePlanEntitlements(): PlanState {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const [state, setState] = useState<PlanState>(() => (cache && cache.uid === uid && Date.now() - cache.at < TTL_MS ? { status: 'ready', plan: cache.plan } : { status: 'loading' }));

  useEffect(() => {
    if (!uid) return;
    if (cache && cache.uid === uid && Date.now() - cache.at < TTL_MS) {
      setState({ status: 'ready', plan: cache.plan });
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc('get_plan_entitlements');
      if (cancelled) return;
      if (error || !data) return setState({ status: 'error' });
      const plan = data as PlanSnapshot;
      cache = { uid, at: Date.now(), plan };
      setState({ status: 'ready', plan });
    })();
    return () => { cancelled = true; };
  }, [uid]);

  return state;
}

/** True when the UI should block this feature. Fails OPEN while loading or on error (the server is the authority). */
export function featureBlocked(state: PlanState, feature: FeatureKey): boolean {
  return state.status === 'ready' && state.plan.featuresMode === 'enforce' && state.plan.features[feature] === false;
}
