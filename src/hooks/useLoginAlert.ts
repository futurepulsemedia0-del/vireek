import { useEffect } from 'react';
import { reportLoginForCurrentSession } from '@/lib/loginAlerts';

/** Reports the active session once it is known to be a completed, authenticated one. */
export function useLoginAlert(hasSession: boolean): void {
  useEffect(() => {
    if (hasSession) void reportLoginForCurrentSession();
  }, [hasSession]);
}
