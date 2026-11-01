import { useEffect } from 'react';
import { adjustTabLiveCalls } from '@/lib/brand/tabIdentity';

/** While `active`, the tab title shows "● Live call ·" and the favicon gets a copper dot. */
export function useTabLiveCall(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    adjustTabLiveCalls(1);
    return () => adjustTabLiveCalls(-1);
  }, [active]);
}
