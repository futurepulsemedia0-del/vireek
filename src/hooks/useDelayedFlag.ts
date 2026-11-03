import { useEffect, useState } from 'react';

/**
 * Returns true only after `active` has stayed true for `delayMs`.
 * Used so skeletons appear only for loads that are actually slow (>300ms),
 * which avoids a flash of placeholder on fast responses.
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const id = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(id);
  }, [active, delayMs]);
  return active && shown;
}
