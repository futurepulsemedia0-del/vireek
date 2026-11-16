import { useCallback, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { SHOW_ALL_STORAGE_KEY, isSimpleModeActive } from '@/lib/simpleMode';

function readShowAll(): boolean {
  try { return localStorage.getItem(SHOW_ALL_STORAGE_KEY) === '1'; } catch { return false; }
}

/** New-owner "simple mode" (lean dashboard + short menu). The choice to see everything is remembered per browser. */
export function useSimpleMode() {
  const { profile, isOwner } = useAuth();
  const { isEnabled } = useFeatureFlags();
  const [showEverything, setShow] = useState(readShowAll);

  const setShowEverything = useCallback((v: boolean) => {
    setShow(v);
    try { localStorage.setItem(SHOW_ALL_STORAGE_KEY, v ? '1' : '0'); } catch { /* storage blocked: choice lasts for this visit */ }
  }, []);

  const eligible = isSimpleModeActive({ isOwner, createdAt: profile?.created_at, fullNavigationFlag: isEnabled('full_navigation'), showEverything: false });
  return { active: eligible && !showEverything, eligible, showEverything, setShowEverything };
}
