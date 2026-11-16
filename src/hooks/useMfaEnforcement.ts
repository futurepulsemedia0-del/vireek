import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { decideMfaEnforcement, parseMfaEnforcementState, type MfaEnforcementState } from '@/lib/mfaEnforcementLogic';

/** Fails OPEN on network errors (the server-side checks, e.g. staff-impersonate AAL2, stay authoritative). */
export function useMfaEnforcement(userId: string | null) {
  const [res, setRes] = useState<{ loading: boolean; state: MfaEnforcementState | null }>({ loading: true, state: null });

  useEffect(() => {
    if (!userId) {
      setRes({ loading: false, state: null });
      return;
    }
    let cancelled = false;
    setRes((p) => ({ ...p, loading: true }));
    supabase.rpc('mfa_enforcement_state').then(
      ({ data, error }) => {
        if (!cancelled) setRes({ loading: false, state: error ? null : parseMfaEnforcementState(data) });
      },
      () => {
        if (!cancelled) setRes({ loading: false, state: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { loading: res.loading, state: res.state, decision: decideMfaEnforcement(res.state) };
}
