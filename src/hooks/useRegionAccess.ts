import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { fetchMyModuleKeys } from '@/lib/regionConfig/entitlementsApi';
import { REGION_CONFIG_MODULE, resolveRegionAccess, type RegionAccess } from '@/lib/regionConfig/gate';

/**
 * Whether NEW regional capabilities may act on `country` for this account.
 * US (default region) → always allowed. Anything else → needs the `regional_config`
 * flag AND the `regional_config` module entitlement; loading/error = OFF (fail closed).
 */
export function useRegionAccess(country: string | null | undefined): RegionAccess & { loading: boolean } {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const flagEnabled = useFeatureFlag('regional_config');
  const [entitled, setEntitled] = useState<{ uid: string; value: boolean } | null>(null);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    fetchMyModuleKeys()
      .then((keys) => { if (!cancelled) setEntitled({ uid, value: keys.has(REGION_CONFIG_MODULE) }); })
      .catch(() => { if (!cancelled) setEntitled({ uid, value: false }); });
    return () => { cancelled = true; };
  }, [uid]);

  const known = entitled !== null && entitled.uid === uid; // never reuse another user's answer
  const access = resolveRegionAccess({ country, flagEnabled, moduleEntitled: known ? entitled.value : false });
  return { ...access, loading: Boolean(uid) && !known };
}
