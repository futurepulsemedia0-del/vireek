import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { parseImpersonationClaim, secondsRemaining, type ImpersonationClaim } from '@/lib/impersonation';

export interface ImpersonationState {
  active: boolean;
  claim: ImpersonationClaim | null;
  secondsLeft: number;
  ending: boolean;
  end: () => Promise<void>;
}

/** Display state for a Vireek Support session. Signs the browser out the moment the countdown reaches zero. */
export function useImpersonation(): ImpersonationState {
  const { session, signOut } = useAuth();
  const claim = useMemo(() => parseImpersonationClaim(session?.access_token), [session?.access_token]);
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    if (!claim) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [claim]);

  const secondsLeft = claim ? secondsRemaining(claim, now) : 0;

  useEffect(() => {
    if (claim && secondsLeft <= 0) void signOut();
  }, [claim, secondsLeft, signOut]);

  const end = useCallback(async () => {
    if (!claim || ending) return;
    setEnding(true);
    try {
      await supabase.rpc('impersonation_end_current');
    } finally {
      await signOut(); // always leave the customer's session, even if the RPC failed (the server also expires it)
    }
  }, [claim, ending, signOut]);

  return { active: !!claim, claim, secondsLeft, ending, end };
}
